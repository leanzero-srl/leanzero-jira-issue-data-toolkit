#!/usr/bin/env node

/**
 * Merge Field Data Between Jira Instances or Fields
 *
 * This script copies field data from a source field to a target field.
 * Supports both cross-instance merging and same-instance field-to-field merging.
 *
 * Usage:
 *   # Cross-instance merge with different tokens
 *   node merge_field_data.js \
 *     --source-url https://source.atlassian.net \
 *     --target-url https://target.atlassian.net \
 *     --source-email user@company.com \
 *     --target-email user@company.com \
 *     --source-token source-api-token \
 *     --target-token target-api-token \
 *     --source-field customfield_10001 \
 *     --target-field customfield_10002
 *
 *   # Same instance with single token
 *   node merge_field_data.js \
 *     --url https://your-instance.atlassian.net \
 *     --email user@company.com \
 *     --token api-token \
 *     --source-field "customfield_10001" \
 *     --target-field "customfield_10002"
 *
 * Requirements:
 *   npm install commander
 *
 * Based on official Atlassian Jira Cloud REST API documentation:
 * - GET /rest/api/3/search (Search issues with JQL)
 * - PUT /rest/api/3/issue/{issueIdOrKey} (Update issue)
 * - GET /rest/api/3/issue/{issueIdOrKey}/editmeta (Get edit metadata)
 */

const https = require("https");
const { program } = require("commander");

/**
 * INTELLIGENT DATA SANITIZER
 * Handles the specific JSON format required for each Jira field type.
 */
class DataSanitizer {
  static sanitize(data) {
    // 1. Handle Null/Undefined/Empty
    if (data === null || data === undefined) return null;
    if (Array.isArray(data) && data.length === 0) return null;

    // 2. Handle Arrays (Multi-Selects, Checkboxes, Versions, Users, Labels)
    if (Array.isArray(data)) {
      // 2a. Labels are just an array of strings - pass them through
      if (data.length > 0 && typeof data[0] === "string") {
        return data;
      }
      // 2b. Complex objects - sanitize each item
      return data
        .map((item) => this.sanitizeObject(item))
        .filter((i) => i !== null);
    }

    // 3. Handle Objects (Single Select, User, Group, Version, ADF)
    if (typeof data === "object") {
      return this.sanitizeObject(data);
    }

    // 4. Handle Primitives (String, Number, Date Strings, URL)
    return data;
  }

  static sanitizeObject(obj) {
    if (!obj || typeof obj !== "object") return obj;

    // --- TYPE 1: Rich Text / Paragraph (ADF) ---
    // Detects Atlassian Document Format. Must pass complete structure.
    if (obj.type === "doc" && Array.isArray(obj.content)) {
      return obj;
    }

    // --- TYPE 2: Users (User Picker) ---
    // Jira Cloud REQUIRES 'accountId'. 'name' and 'key' are not accepted.
    // We strip 'emailAddress', 'avatarUrls', etc. to avoid schema errors.
    if (obj.accountId) {
      return { accountId: obj.accountId };
    }

    // --- TYPE 3: Cascading Select ---
    // Structure: { "value": "Parent", "child": { "value": "Child" } }
    // We must strip 'id' from both levels.
    if (obj.value && obj.child) {
      return {
        value: obj.value,
        child: this.sanitizeObject(obj.child),
      };
    }

    // --- TYPE 4: Options (Select, Radio, Checkbox) ---
    // We must send ONLY 'value'. Sending 'id' causes 400 errors if IDs differ.
    if (obj.value) {
      return { value: obj.value };
    }

    // --- TYPE 5: Named Entities (Versions, Components, Priorities) ---
    // These fields accept 'name'. We prefer 'name' over 'id' for cross-instance merging.
    if (obj.name && obj.self && obj.self.includes("/version/")) {
      return { name: obj.name };
    }
    if (obj.name && obj.self && obj.self.includes("/component/")) {
      return { name: obj.name };
    }

    // --- TYPE 6: Groups (Group Picker) ---
    // Group Pickers use 'name'.
    // (Note: Jira is moving to groupId, but 'name' is still the standard for mutations
    // and crucial for cross-instance where group IDs (UUIDs) won't match).
    if (obj.name) {
      return { name: obj.name };
    }

    // Fallback: If it has a 'name' but we aren't sure, try sending just name.
    // This covers Priorities, Resolutions, etc.
    if (obj.name) {
      return { name: obj.name };
    }

    // If we can't identify it, return as-is (risk of error, but safer than dropping)
    const { self, id, ...cleanObj } = obj;
    return cleanObj;
  }
}

class JiraFieldMerger {
  constructor(config) {
    // Validate required configuration
    if (!config.sourceUrl || !config.targetUrl) {
      throw new Error("Source and target URLs are required");
    }
    if (!config.sourceEmail || !config.targetEmail) {
      throw new Error("Source and target emails are required");
    }
    if (!config.sourceToken || !config.targetToken) {
      throw new Error("Source and target tokens are required");
    }
    if (!config.sourceField || !config.targetField) {
      throw new Error("Source and target fields are required");
    }

    this.sourceUrl = config.sourceUrl.replace(/\/$/, "");
    this.targetUrl = config.targetUrl.replace(/\/$/, "");
    this.sourceAuth = Buffer.from(
      `${config.sourceEmail}:${config.sourceToken}`,
    ).toString("base64");
    this.targetAuth = Buffer.from(
      `${config.targetEmail}:${config.targetToken}`,
    ).toString("base64");
    this.sourceField = config.sourceField;
    this.targetField = config.targetField;

    // Validate field ID format
    if (
      !this.sourceField.startsWith("customfield_") &&
      !this.isSystemField(this.sourceField)
    ) {
      console.warn(
        `⚠ Warning: Source field ID format may be invalid: ${this.sourceField}`,
      );
    }
    if (
      !this.targetField.startsWith("customfield_") &&
      !this.isSystemField(this.targetField)
    ) {
      console.warn(
        `⚠ Warning: Target field ID format may be invalid: ${this.targetField}`,
      );
    }

    this.options = {
      jql: config.jql || "",
      batchSize: config.batchSize || 50,
      dryRun: config.dryRun || false,
      overwriteExisting: config.overwriteExisting || false,
      skipEmpty: config.skipEmpty !== false,
      projectKey: config.projectKey || null,
      issueKeys: config.issueKeys || null,
    };
    this.stats = {
      totalIssues: 0,
      processedIssues: 0,
      skippedEmpty: 0,
      skippedExisting: 0,
      successfulUpdates: 0,
      failedUpdates: 0,
      errors: [],
    };

    // Track processing time for performance monitoring
    this.startTime = Date.now();
  }

  /**
   * Check if a field is a system field (built-in Jira field)
   */
  isSystemField(fieldId) {
    const systemFields = [
      "summary",
      "description",
      "priority",
      "issuetype",
      "status",
      "resolution",
      "created",
      "updated",
      "duedate",
      "assignee",
      "reporter",
      "creator",
      "project",
      "key",
    ];
    return systemFields.includes(fieldId.toLowerCase());
  }

  /**
   * Calculate estimated time of completion
   */
  calculateETA() {
    const processed = this.stats.processedIssues;
    const total = this.stats.totalIssues;

    if (processed === 0 || total <= processed) return null;

    const elapsedMs = Date.now() - this.startTime;
    const avgTimePerIssue = elapsedMs / processed;
    const remainingIssues = total - processed;

    return Math.round((avgTimePerIssue * remainingIssues) / 1000); // Return in seconds
  }

  /**
   * Print enhanced progress with ETA
   */
  printProgress(issueKey, status, details = "") {
    const eta = this.calculateETA();
    const progressPercentage = Math.round(
      (this.stats.processedIssues / this.stats.totalIssues) * 100,
    );

    const etaText = eta ? ` ETA: ${Math.floor(eta / 60)}m${eta % 60}s` : "";

    console.log(
      `🔄 [${this.stats.processedIssues}/${this.stats.totalIssues}][${progressPercentage}%] ${status}${etaText}`,
    );
    if (issueKey) {
      console.log(`   📝 ${issueKey}: ${details}`);
    }
  }

  // Make API call with retry logic and exponential backoff
  async makeApiCall(
    baseUrl,
    auth,
    endpoint,
    method = "GET",
    body = null,
    retryCount = 0,
    maxRetries = 5,
  ) {
    return new Promise((resolve, reject) => {
      // Parse the base URL to get hostname
      const hostname = baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");

      const options = {
        hostname: hostname,
        port: 443,
        path: endpoint,
        method: method,
        headers: {
          Authorization: `Basic ${auth}`,
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
            // Handle 204 No Content
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
            // Rate limited - implement exponential backoff
            const backoffTime = Math.min(1000 * Math.pow(2, retryCount), 32000);
            console.log(
              `   ⏳ Rate limited (429), retrying in ${backoffTime / 1000}s (attempt ${retryCount + 1}/${maxRetries})...`,
            );
            await new Promise((r) => setTimeout(r, backoffTime));

            try {
              const result = await this.makeApiCall(
                baseUrl,
                auth,
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
          } else if (res.statusCode === 403) {
            // Enhanced permission error handling
            const errorText = data.substring(0, 500);
            reject(
              new Error(
                `HTTP ${res.statusCode} (Permission Denied): ${errorText}. Check Edit Issues permission and field access.`,
              ),
            );
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
  async searchIssues(jql, nextPageToken = null) {
    const maxResults = this.options.batchSize;
    let endpoint = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=${this.sourceField},summary,key`;

    // Add nextPageToken if provided (for pagination)
    if (nextPageToken) {
      endpoint += `&nextPageToken=${encodeURIComponent(nextPageToken)}`;
    }

    return await this.makeApiCall(
      this.sourceUrl,
      this.sourceAuth,
      endpoint,
      "GET",
    );
  }

  // Get all issues matching the criteria
  async getAllIssues() {
    console.log("🔍 Fetching issues from source instance...");

    let jql = this.options.jql;

    // Build JQL based on options
    if (this.options.issueKeys) {
      const keys = this.options.issueKeys.split(",").map((k) => k.trim());
      jql = `key in (${keys.join(",")})`;
    } else if (this.options.projectKey) {
      jql = jql
        ? `project = ${this.options.projectKey} AND (${jql})`
        : `project = ${this.options.projectKey}`;
    }

    // Add filter for non-empty source field and empty target field
    // Extract the field number from customfield_XXXXX format
    const sourceFieldMatch = this.sourceField.match(/customfield_(\d+)/);
    const sourceFieldRef = sourceFieldMatch
      ? `cf[${sourceFieldMatch[1]}]`
      : this.sourceField;

    const targetFieldMatch = this.targetField.match(/customfield_(\d+)/);
    const targetFieldRef = targetFieldMatch
      ? `cf[${targetFieldMatch[1]}]`
      : this.targetField;

    // Build the field filter conditions
    let fieldConditions = [];

    // ALWAYS add source field is not EMPTY check (unless already in JQL)
    // This makes sense because we need source data to copy
    if (!jql.includes(sourceFieldRef) && !jql.includes(this.sourceField)) {
      fieldConditions.push(`${sourceFieldRef} is not EMPTY`);
    }

    // Add target field is EMPTY check (unless overwriting existing values or already in JQL)
    if (
      !this.options.overwriteExisting &&
      !jql.includes(targetFieldRef) &&
      !jql.includes(this.targetField)
    ) {
      fieldConditions.push(`${targetFieldRef} is EMPTY`);
    }

    // Combine field conditions with existing JQL
    if (fieldConditions.length > 0) {
      const fieldFilter = fieldConditions.join(" AND ");
      jql = jql ? `(${jql}) AND ${fieldFilter}` : fieldFilter;
    }

    // Fallback if no JQL was built
    if (!jql) {
      jql = `${sourceFieldRef} is not EMPTY AND ${targetFieldRef} is EMPTY`;
    }

    console.log(`📋 Using JQL: ${jql}`);

    const allIssues = [];
    let nextPageToken = null;
    let pageCount = 0;

    do {
      try {
        const response = await this.searchIssues(jql, nextPageToken);
        const issues = response.issues || [];

        if (issues.length > 0) {
          allIssues.push(...issues);
          console.log(
            `   📊 Fetched ${allIssues.length} issues so far... (page ${pageCount + 1})`,
          );
        }

        // Check if there's a next page
        // The API returns isLast: true when there are no more pages
        // Or nextPageToken will be null/undefined
        nextPageToken = response.nextPageToken || null;
        pageCount++;

        // Safety check to prevent infinite loops
        if (pageCount > 200) {
          console.warn(
            "⚠️  Reached 200 page limit (10,000 issues). Consider refining your JQL query.",
          );
          break;
        }
      } catch (error) {
        // Handle 404 errors gracefully - some issues might not be accessible
        if (error.message.includes("HTTP 404")) {
          console.warn(`⚠️  Warning: ${error.message}`);
          console.warn(
            `   Error occurred on page ${pageCount + 1}${nextPageToken ? ` (nextPageToken: ${nextPageToken})` : ""}`,
          );
          console.warn(
            `   Continuing with ${allIssues.length} issues fetched so far...`,
          );

          // Log the error for tracking
          this.stats.errors.push({
            context: "pagination",
            page: pageCount + 1,
            nextPageToken: nextPageToken,
            error: error.message,
          });

          // Break out of the loop but don't throw - we have partial results
          break;
        }
        // For other errors, still throw
        console.error(`❌ Error fetching issues: ${error.message}`);
        throw error;
      }
    } while (nextPageToken !== null);

    console.log(`✅ Total issues found: ${allIssues.length}`);
    this.stats.totalIssues = allIssues.length;
    return allIssues;
  }

  // Update a single issue's target field
  async updateIssueField(issueKey, fieldValue) {
    const endpoint = `/rest/api/3/issue/${issueKey}`;

    // Sanitize the field value before sending to prevent 400 errors
    const sanitizedValue = DataSanitizer.sanitize(fieldValue);

    const body = {
      fields: {
        [this.targetField]: sanitizedValue,
      },
    };

    try {
      await this.makeApiCall(
        this.targetUrl,
        this.targetAuth,
        endpoint,
        "PUT",
        body,
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Get issue from target instance to check existing value
  async getTargetIssue(issueKey) {
    const endpoint = `/rest/api/3/issue/${issueKey}?fields=${this.targetField}`;

    try {
      return await this.makeApiCall(
        this.targetUrl,
        this.targetAuth,
        endpoint,
        "GET",
      );
    } catch (error) {
      // Issue might not exist in target
      return null;
    }
  }

  // Check if field value is empty
  isEmptyValue(value) {
    if (value === null || value === undefined) return true;
    if (typeof value === "string" && value.trim() === "") return true;
    if (Array.isArray(value) && value.length === 0) return true;
    if (typeof value === "object" && Object.keys(value).length === 0)
      return true;
    return false;
  }

  // Process all issues
  async processIssues(issues) {
    console.log("");
    console.log("🔧 Processing issues...");

    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      const issueKey = issue.key;

      // Print progress for every 10th issue or last in batch
      if (i % 10 === 0 || i === issues.length - 1) {
        this.printProgress(
          issueKey,
          "Processing",
          `Issue ${i + 1}/${issues.length}`,
        );
      }

      const sourceValue = issue.fields[this.sourceField];
      console.log(`📦 Issue: ${issueKey} (${issue.fields.summary})`);

      // Skip if source field is empty
      if (this.options.skipEmpty && this.isEmptyValue(sourceValue)) {
        console.log(`   ⏭️  Skipped (source field is empty)`);
        this.stats.skippedEmpty++;
        this.stats.processedIssues++;
        continue;
      }

      // Check target issue if not overwriting
      if (!this.options.overwriteExisting) {
        const targetIssue = await this.getTargetIssue(issueKey);

        if (!targetIssue || !targetIssue.fields) {
          console.log(`   ⚠️  Issue not found in target instance, skipping...`);
          this.stats.skippedExisting++;
          this.stats.processedIssues++;
          continue;
        }

        const targetValue = targetIssue.fields[this.targetField];
        if (!this.isEmptyValue(targetValue)) {
          console.log(
            `   ⏭️  Skipped (target field already has value and overwrite is disabled)`,
          );
          this.stats.skippedExisting++;
          this.stats.processedIssues++;
          continue; // Add missing continue to prevent fallthrough
        }
      }

      // Handle dry run mode
      if (this.options.dryRun) {
        console.log(`   🔍 [DRY RUN] Would update ${this.targetField} with:`);
        console.log(
          `       ${JSON.stringify(sourceValue).substring(0, 100)}${JSON.stringify(sourceValue).length > 100 ? "..." : ""}`,
        );
        this.stats.successfulUpdates++;
        this.stats.processedIssues++;

        // Add small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }

      // Update the issue
      try {
        const result = await this.updateIssueField(issueKey, sourceValue);

        if (result.success) {
          console.log(`   ✅ Updated successfully`);
          this.stats.successfulUpdates++;
        } else {
          console.log(`   ❌ Failed: ${result.error}`);
          this.stats.failedUpdates++;
          this.stats.errors.push({
            issueKey,
            error: result.error,
          });
        }
      } catch (updateError) {
        console.log(`   ❌ Failed: ${updateError.message}`);
        this.stats.failedUpdates++;
        this.stats.errors.push({
          issueKey,
          error: updateError.message,
        });
      }

      this.stats.processedIssues++;

      // Add small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // Print final summary
  printFinalSummary() {
    console.log("");
    console.log("📊 SUMMARY");
    console.log("=====================================");
    console.log(`Total Issues Found: ${this.stats.totalIssues}`);
    console.log(`Processed Issues: ${this.stats.processedIssues}`);
    console.log(`Successful Updates: ${this.stats.successfulUpdates}`);
    console.log(`Skipped (Already Has Value): ${this.stats.skippedExisting}`);
    console.log(`Skipped (Empty Source): ${this.stats.skippedEmpty}`);
    console.log(`Failed Updates: ${this.stats.failedUpdates}`);

    const totalTime = Math.round((Date.now() - this.startTime) / 1000);
    if (totalTime > 0) {
      console.log(
        `⏱️  Total Time: ${Math.floor(totalTime / 60)}m${totalTime % 60}s`,
      );
      const successRate =
        this.stats.totalIssues > 0
          ? Math.round(
              (this.stats.successfulUpdates / this.stats.totalIssues) * 100,
            )
          : 0;
      console.log(`📝 Success Rate: ${successRate}%`);

      const issuesPerMinute = Math.round(
        (this.stats.successfulUpdates / totalTime) * 60,
      );
      if (issuesPerMinute > 0) {
        console.log(`📝 Processing Rate: ${issuesPerMinute} issues/min`);
      }
    }

    if (this.stats.errors.length > 0) {
      console.log("");
      console.log("📝 ERROR DETAILS:");
      for (const error of this.stats.errors.slice(0, 10)) {
        console.log(`   ❌ ${error.issueKey}: ${error.error}`);
      }
      if (this.stats.errors.length > 10) {
        console.log(`   ... and ${this.stats.errors.length - 10} more errors`);
      }
    }

    if (this.options.dryRun) {
      console.log("");
      console.log("🔍 DRY RUN MODE - No changes were made");
    }

    const overallSuccess = this.stats.failedUpdates === 0;
    console.log("");
  }

  // Main execution
  async run() {
    console.log("🚀 JIRA FIELD DATA MERGE");
    console.log("=====================================");
    console.log(`📤 Source Instance: ${this.sourceUrl}`);
    console.log(`📥 Target Instance: ${this.targetUrl}`);
    console.log(`🔄 Source Field: ${this.sourceField}`);
    console.log(`🎯 Target Field: ${this.targetField}`);
    console.log(
      `⚙️  Overwrite Existing: ${this.options.overwriteExisting ? "Yes" : "No"}`,
    );
    console.log(`⚙️  Skip Empty: ${this.options.skipEmpty ? "Yes" : "No"}`);
    if (this.options.dryRun) {
      console.log(`🔍 DRY RUN MODE ENABLED`);
    }
    console.log("");

    try {
      // Step 1: Get all issues from source
      const issues = await this.getAllIssues();

      if (issues.length === 0) {
        console.log("⚠️  No issues found matching the criteria.");
        return;
      }

      // Step 2: Process each issue
      await this.processIssues(issues);

      // Step 3: Print final summary
      this.printFinalSummary();

      console.log("✅ Script completed successfully!");
    } catch (error) {
      console.error("");
      console.error("❌ FATAL ERROR:");
      console.error(error);
      process.exit(1);
    }
  }
}

// Command line interface
program
  .name("merge-field-data")
  .description(
    "Merge field data between Jira instances or fields within the same instance",
  )
  .option("--url <url>", "Jira instance URL (for same-instance merges)")
  .option(
    "--source-url <url>",
    "Source Jira instance URL (for cross-instance merges)",
  )
  .option(
    "--target-url <url>",
    "Target Jira instance URL (for cross-instance merges)",
  )
  .option("--email <email>", "Email address for authentication (single token)")
  .option(
    "--source-email <email>",
    "Source email address for authentication (dual token)",
  )
  .option(
    "--target-email <email>",
    "Target email address for authentication (dual token)",
  )
  .option("--token <token>", "API token for authentication (single token)")
  .option(
    "--source-token <token>",
    "Source API token for authentication (dual token)",
  )
  .option(
    "--target-token <token>",
    "Target API token for authentication (dual token)",
  )
  .requiredOption(
    "--source-field <fieldId>",
    "Source field ID or key (e.g., customfield_10001)",
  )
  .requiredOption(
    "--target-field <fieldId>",
    "Target field ID or key (e.g., customfield_10002)",
  )
  .option(
    "--jql <query>",
    "JQL query to filter issues (default: all issues with non-empty source field)",
  )
  .option("--project-key <key>", "Process only issues from a specific project")
  .option(
    "--issue-keys <keys>",
    "Comma-separated list of specific issue keys to process",
  )
  .option(
    "--batch-size <size>",
    "Number of issues to fetch per batch (default: 50)",
    parseInt,
  )
  .option(
    "--overwrite-existing",
    "Overwrite target field even if it already has a value",
    false,
  )
  .option(
    "--no-skip-empty",
    "Process issues even if source field is empty",
    false,
  )
  .option("--dry-run", "Show what would be done without making changes", false)
  .addHelpText(
    "after",
    `
Examples:
  Same instance, single token:
    $ node merge_field_data.js \\
      --url https://your-instance.atlassian.net \\
      --email user@company.com \\
      --token your-api-token \\
      --source-field customfield_10001 \\
      --target-field customfield_10002

  Cross-instance, dual tokens:
    $ node merge_field_data.js \\
      --source-url https://source.atlassian.net \\
      --target-url https://target.atlassian.net \\
      --source-email user@company.com \\
      --target-email user@company.com \\
      --source-token source-token \\
      --target-token target-token \\
      --source-field customfield_10001 \\
      --target-field customfield_10002

  Same instance, single token, with project filter:
    $ node merge_field_data.js \\
      --url https://your-instance.atlassian.net \\
      --email user@company.com \\
      --token your-api-token \\
      --source-field customfield_10001 \\
      --target-field customfield_10002 \\
      --project-key DEMO

  Cross-instance with custom JQL and overwrite:
    $ node merge_field_data.js \\
      --source-url https://source.atlassian.net \\
      --target-url https://target.atlassian.net \\
      --source-email user@company.com \\
      --target-email user@company.com \\
      --source-token source-token \\
      --target-token target-token \\
      --source-field customfield_10001 \\
      --target-field customfield_10002 \\
      --jql "status = Done" \\
      --overwrite-existing

  Dry run to preview changes:
    $ node merge_field_data.js \\
      --url https://your-instance.atlassian.net \\
      --email user@company.com \\
      --token your-api-token \\
      --source-field customfield_10001 \\
      --target-field customfield_10002 \\
      --dry-run

  Merge specific issues:
    $ node merge_field_data.js \\
      --url https://your-instance.atlassian.net \\
      --email user@company.com \\
      --token your-api-token \\
      --source-field customfield_10001 \\
      --target-field customfield_10002 \\
      --issue-keys "PROJ-1,PROJ-2,PROJ-3"

Field IDs:
  - Custom fields use the format: customfield_XXXXX
  - System fields use their field names: summary, description, assignee, etc.
  - You can find field IDs in Jira Settings > Issues > Custom Fields

Generate API token from: https://id.atlassian.com/manage-profile/security/api-tokens
    `,
  );

program.parse();

const options = program.opts();

// Validate options
let sourceUrl, targetUrl, sourceEmail, targetEmail, sourceToken, targetToken;

if (options.url) {
  // Same instance mode
  if (!options.email || !options.token) {
    console.error("❌ When using --url, you must provide --email and --token");
    process.exit(1);
  }
  sourceUrl = targetUrl = options.url;
  sourceEmail = targetEmail = options.email;
  sourceToken = targetToken = options.token;
} else if (options.sourceUrl && options.targetUrl) {
  // Cross-instance mode
  if (options.sourceToken && options.targetToken) {
    // Dual token mode
    if (!options.sourceEmail || !options.targetEmail) {
      console.error(
        "❌ When using --source-token and --target-token, you must provide --source-email and --target-email",
      );
      process.exit(1);
    }
    sourceUrl = options.sourceUrl;
    targetUrl = options.targetUrl;
    sourceEmail = options.sourceEmail;
    targetEmail = options.targetEmail;
    sourceToken = options.sourceToken;
    targetToken = options.targetToken;
  } else if (options.email && options.token) {
    // Single token mode for cross-instance
    sourceUrl = options.sourceUrl;
    targetUrl = options.targetUrl;
    sourceEmail = targetEmail = options.email;
    sourceToken = targetToken = options.token;
  } else {
    console.error(
      "❌ When using --source-url and --target-url, you must provide either:",
    );
    console.error(
      "   1. --email and --token (single token for both instances)",
    );
    console.error(
      "   2. --source-email, --source-token, --target-email, and --target-token (dual tokens)",
    );
    process.exit(1);
  }
} else {
  console.error("❌ You must provide either:");
  console.error("   1. --url (for same-instance merges)");
  console.error(
    "   2. --source-url and --target-url (for cross-instance merges)",
  );
  process.exit(1);
}

// Create merger instance
const merger = new JiraFieldMerger({
  sourceUrl,
  targetUrl,
  sourceEmail,
  targetEmail,
  sourceToken,
  targetToken,
  sourceField: options.sourceField,
  targetField: options.targetField,
  jql: options.jql,
  batchSize: options.batchSize,
  dryRun: options.dryRun,
  overwriteExisting: options.overwriteExisting,
  skipEmpty: options.skipEmpty,
  projectKey: options.projectKey,
  issueKeys: options.issueKeys,
});

// Run the merger
merger.run().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
