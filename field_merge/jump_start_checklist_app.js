#!/usr/bin/env node

/**
 * Hardcoded Field Update Test Script
 *
 * This script updates cf[12936] by:
 * 1. GET current value
 * 2. PUT to append _X
 * 3. PUT to remove _X
 *
 * Test modes:
 * - TEST_MODE = 'single' : Test with SVC-1540 only
 * - TEST_MODE = 'limited' : Test with cf[13353] is not EMPTY and maxResults=1
 * - TEST_MODE = 'full' : Run with full JQL cf[13353] is not EMPTY
 */

const https = require("https");

// ========================
// CONFIGURATION - EDIT THESE
// ========================
const CONFIG = {
  // Change this to switch modes: 'single', 'limited', 'full'
  TEST_MODE: "full", // Start with 'single', then 'limited', then 'full'

  // Jira instance details
  JIRA_URL: "https://your-site.atlassian.net", // EDIT THIS
  EMAIL: "you@example.com", // EDIT THIS
  API_TOKEN: "xxxxxxxxxxx", // EDIT THIS

  // Field to update
  TARGET_FIELD: "customfield_1xxxx", // cf[12936]

  // JQL queries for different modes
  JQL: {
    single: "key = SVC-1540",
    limited: "cf[13353] is not EMPTY",
    full: "cf[13353] is not EMPTY",
  },

  // Max results for different modes
  MAX_RESULTS: {
    single: 1,
    limited: 1,
    full: 50, // Batch size for full run
  },
};

// ========================
// SCRIPT LOGIC - NO NEED TO EDIT BELOW
// ========================

class FieldUpdater {
  constructor(config) {
    this.baseUrl = config.JIRA_URL.replace(/\/$/, "");
    this.auth = Buffer.from(`${config.EMAIL}:${config.API_TOKEN}`).toString(
      "base64",
    );
    this.targetField = config.TARGET_FIELD;
    this.testMode = config.TEST_MODE;
    this.jql = config.JQL[config.TEST_MODE];
    this.maxResults = config.MAX_RESULTS[config.TEST_MODE];

    this.stats = {
      totalIssues: 0,
      processed: 0,
      successful: 0,
      failed: 0,
      errors: [],
    };
  }

  // Make API call with retry logic
  async makeApiCall(
    endpoint,
    method = "GET",
    body = null,
    retryCount = 0,
    maxRetries = 3,
  ) {
    return new Promise((resolve, reject) => {
      const hostname = this.baseUrl
        .replace(/^https?:\/\//, "")
        .replace(/\/$/, "");

      const options = {
        hostname: hostname,
        port: 443,
        path: endpoint,
        method: method,
        headers: {
          Authorization: `Basic ${this.auth}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      };

      const req = https.request(options, async (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", async () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            if (res.statusCode === 204) {
              resolve({ success: true });
              return;
            }

            try {
              const parsed = data ? JSON.parse(data) : {};
              resolve(parsed);
            } catch (e) {
              resolve({ success: true });
            }
          } else if (res.statusCode === 429 && retryCount < maxRetries) {
            const backoffTime = Math.min(1000 * Math.pow(2, retryCount), 8000);
            console.log(
              `   ⏳ Rate limited, retrying in ${backoffTime / 1000}s...`,
            );
            await new Promise((r) => setTimeout(r, backoffTime));

            try {
              const result = await this.makeApiCall(
                endpoint,
                method,
                body,
                retryCount + 1,
                maxRetries,
              );
              resolve(result);
            } catch (retryError) {
              reject(retryError);
            }
          } else {
            const errorText = data.substring(0, 500);
            reject(new Error(`HTTP ${res.statusCode}: ${errorText}`));
          }
        });
      });

      req.on("error", (error) => {
        reject(error);
      });

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  // Search for issues using JQL
  async searchIssues(nextPageToken = null) {
    let endpoint = `/rest/api/3/search/jql?jql=${encodeURIComponent(this.jql)}&maxResults=${this.maxResults}&fields=${this.targetField},summary,key`;

    if (nextPageToken) {
      endpoint += `&nextPageToken=${encodeURIComponent(nextPageToken)}`;
    }

    return await this.makeApiCall(endpoint, "GET");
  }

  // Get issue field value
  async getIssueFieldValue(issueKey) {
    const endpoint = `/rest/api/3/issue/${issueKey}?fields=${this.targetField}`;
    const response = await this.makeApiCall(endpoint, "GET");
    return response.fields[this.targetField];
  }

  // Update issue field
  async updateIssueField(issueKey, fieldValue) {
    const endpoint = `/rest/api/3/issue/${issueKey}`;
    const body = {
      fields: {
        [this.targetField]: fieldValue,
      },
    };

    try {
      await this.makeApiCall(endpoint, "PUT", body);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Process a single issue with the 3-step update
  async processIssue(issue) {
    const issueKey = issue.key;
    const summary = issue.fields.summary || "No summary";

    console.log(`\n📦 Processing: ${issueKey} - ${summary}`);

    try {
      // Step 1: GET current value
      console.log(`   1️⃣  Getting current value of ${this.targetField}...`);
      const currentValue = await this.getIssueFieldValue(issueKey);

      if (!currentValue) {
        console.log(`   ⚠️  Field ${this.targetField} is empty, skipping...`);
        this.stats.processed++;
        return;
      }

      console.log(`   ✅ Current value: ${JSON.stringify(currentValue)}`);

      // Step 2: PUT to append _X
      let updatedValue;
      if (typeof currentValue === "string") {
        updatedValue = currentValue + "_X";
      } else if (
        typeof currentValue === "object" &&
        currentValue.type === "doc"
      ) {
        // Atlassian Document Format - add a paragraph with _X
        updatedValue = JSON.parse(JSON.stringify(currentValue)); // Deep clone
        updatedValue.content.push({
          type: "paragraph",
          content: [{ type: "text", text: "_X" }],
        });
      } else if (typeof currentValue === "object" && currentValue.value) {
        // For select/option fields
        updatedValue = { ...currentValue, value: currentValue.value + "_X" };
      } else if (typeof currentValue === "object" && currentValue.name) {
        // For user/group fields
        updatedValue = { ...currentValue, name: currentValue.name + "_X" };
      } else {
        console.log(`   ⚠️  Unsupported field type: ${typeof currentValue}`);
        console.log(
          `   Field value structure: ${JSON.stringify(currentValue)}`,
        );
        this.stats.processed++;
        return;
      }

      console.log(`   2️⃣  Appending _X...`);
      const appendResult = await this.updateIssueField(issueKey, updatedValue);

      if (!appendResult.success) {
        console.log(`   ❌ Failed to append _X: ${appendResult.error}`);
        this.stats.failed++;
        this.stats.errors.push({
          issueKey,
          step: "append",
          error: appendResult.error,
        });
        return;
      }

      console.log(`   ✅ Appended _X successfully`);

      // Small delay between updates
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Step 3: PUT to remove _X (restore original)
      console.log(`   3️⃣  Removing _X (restoring original value)...`);
      const restoreResult = await this.updateIssueField(issueKey, currentValue);

      if (!restoreResult.success) {
        console.log(
          `   ❌ Failed to restore original value: ${restoreResult.error}`,
        );
        console.log(`   ⚠️  WARNING: Issue ${issueKey} may have _X appended!`);
        this.stats.failed++;
        this.stats.errors.push({
          issueKey,
          step: "restore",
          error: restoreResult.error,
        });
        return;
      }

      console.log(`   ✅ Restored original value successfully`);
      console.log(`   ✅ Issue ${issueKey} completed successfully!`);

      this.stats.processed++;
      this.stats.successful++;
    } catch (error) {
      console.log(`   ❌ Error processing issue: ${error.message}`);
      this.stats.failed++;
      this.stats.errors.push({
        issueKey,
        step: "general",
        error: error.message,
      });
    }

    // Add delay between issues
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Main execution
  async run() {
    console.log("🚀 FIELD UPDATE TEST SCRIPT");
    console.log("=====================================");
    console.log(`🎯 Mode: ${this.testMode.toUpperCase()}`);
    console.log(`📍 Jira Instance: ${this.baseUrl}`);
    console.log(`🔧 Target Field: ${this.targetField}`);
    console.log(`📋 JQL: ${this.jql}`);
    console.log(`📊 Max Results per page: ${this.maxResults}`);
    console.log("");

    try {
      console.log("🔍 Fetching issues...");

      let allIssues = [];
      let nextPageToken = null;
      let pageCount = 0;

      // Fetch all issues (with pagination)
      do {
        const response = await this.searchIssues(nextPageToken);
        const issues = response.issues || [];

        if (issues.length > 0) {
          allIssues.push(...issues);
          console.log(
            `   📊 Fetched ${allIssues.length} issues so far... (page ${pageCount + 1})`,
          );
        }

        // Check if there's a next page
        nextPageToken = response.nextPageToken || null;
        pageCount++;

        // For single/limited modes, stop after first page
        if (this.testMode !== "full" && pageCount >= 1) {
          break;
        }

        // Safety check to prevent infinite loops
        if (pageCount > 200) {
          console.warn(
            "⚠️  Reached 200 page limit (10,000 issues). Consider refining your JQL query.",
          );
          break;
        }
      } while (nextPageToken !== null);

      this.stats.totalIssues = allIssues.length;
      console.log(`\n✅ Total issues found: ${allIssues.length}`);

      if (allIssues.length === 0) {
        console.log("⚠️  No issues found matching the criteria.");
        return;
      }

      console.log("\n🔧 Starting updates...");
      console.log("=====================================");

      // Process each issue
      for (const issue of allIssues) {
        await this.processIssue(issue);
      }

      // Print summary
      this.printSummary();

      console.log("\n✅ Script completed!");
    } catch (error) {
      console.error("\n❌ FATAL ERROR:");
      console.error(error);
      process.exit(1);
    }
  }

  printSummary() {
    console.log("\n");
    console.log("📊 SUMMARY");
    console.log("=====================================");
    console.log(`Total Issues Found: ${this.stats.totalIssues}`);
    console.log(`Successfully Processed: ${this.stats.successful}`);
    console.log(`Failed: ${this.stats.failed}`);
    console.log("");

    if (this.stats.errors.length > 0) {
      console.log("❌ ERRORS:");
      for (const error of this.stats.errors) {
        console.log(`   ${error.issueKey} (${error.step}): ${error.error}`);
      }
      console.log("");
    }
  }
}

// Validate configuration
if (CONFIG.JIRA_URL.includes("your-instance")) {
  console.error("❌ ERROR: Please edit the JIRA_URL in the CONFIG section");
  process.exit(1);
}

if (CONFIG.EMAIL.includes("your-email")) {
  console.error("❌ ERROR: Please edit the EMAIL in the CONFIG section");
  process.exit(1);
}

if (CONFIG.API_TOKEN.includes("your-api-token")) {
  console.error("❌ ERROR: Please edit the API_TOKEN in the CONFIG section");
  process.exit(1);
}

if (!["single", "limited", "full"].includes(CONFIG.TEST_MODE)) {
  console.error("❌ ERROR: TEST_MODE must be 'single', 'limited', or 'full'");
  process.exit(1);
}

// Run the updater
const updater = new FieldUpdater(CONFIG);
updater.run().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
