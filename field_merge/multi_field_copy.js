#!/usr/bin/env node

/**
 * Multi-Field Copy Script
 *
 * This script copies a value from one source field to multiple target fields,
 * but ONLY if the target fields are empty. It never overwrites existing values.
 *
 * There are 6 JQL sequences, each with its own source field and target fields.
 *
 * Usage:
 *   node multi_field_copy.js \
 *     --url https://your-instance.atlassian.net \
 *     --email user@company.com \
 *     --token api-token \
 *     --dry-run
 *
 * API Endpoints Used (Jira Cloud REST API v3):
 *   - GET /rest/api/3/search/jql - Search for issues using JQL
 *   - PUT /rest/api/3/issue/{issueIdOrKey} - Update issue fields
 *
 * Requirements:
 *   npm install commander (optional, only for original merge_field_data.js)
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

// ============================================================================
// CONFIGURATION - 6 JQL SEQUENCES
// ============================================================================

const SEQUENCES = [
  // ── EDIT THIS FOR YOUR INSTANCE ──────────────────────────────────────────
  // One entry per copy job. `jql` selects the issues, `sourceField` is read,
  // and its value is written to every id in `targetFields`.
  // Find your ids with: GET /rest/api/3/field
  {
    name: "Example: copy one source field into three targets",
    jql: "cf[10001] is not EMPTY",
    sourceField: "customfield_10001",
    targetFields: [
      "customfield_10002",
      "customfield_10003",
      "customfield_10004",
    ],
  },
];

// ============================================================================
// DATA SANITIZER
// Handles the specific JSON format required for each Jira field type.
// Copied from merge_field_data.js for consistency.
// ============================================================================

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
    if (obj.accountId) {
      return { accountId: obj.accountId };
    }

    // --- TYPE 3: Cascading Select ---
    // Structure: { "value": "Parent", "child": { "value": "Child" } }
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
    if (obj.name && obj.self && obj.self.includes("/version/")) {
      return { name: obj.name };
    }
    if (obj.name && obj.self && obj.self.includes("/component/")) {
      return { name: obj.name };
    }

    // --- TYPE 6: Groups (Group Picker) ---
    if (obj.name) {
      return { name: obj.name };
    }

    // Fallback: Strip self and id, keep the rest
    const { self, id, ...cleanObj } = obj;
    return cleanObj;
  }
}

// ============================================================================
// LOGGER - For detailed rollback logging
// ============================================================================

class Logger {
  constructor(logDir) {
    this.logDir = logDir;
    this.timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.logFile = path.join(logDir, `multi_field_copy_${this.timestamp}.log`);
    this.rollbackFile = path.join(logDir, `rollback_${this.timestamp}.json`);
    this.rollbackData = [];

    // Ensure log directory exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Initialize log file
    this.writeToFile(this.logFile, `Multi-Field Copy Script Log\n`);
    this.writeToFile(this.logFile, `Started: ${new Date().toISOString()}\n`);
    this.writeToFile(this.logFile, `${"=".repeat(80)}\n\n`);
  }

  writeToFile(file, content) {
    fs.appendFileSync(file, content);
  }

  log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    console.log(message);
    this.writeToFile(this.logFile, logMessage);
  }

  logFieldChange(
    issueKey,
    sourceFieldId,
    targetFieldId,
    previousValue,
    newValue,
  ) {
    const timestamp = new Date().toISOString();
    const prevStr =
      previousValue === null || previousValue === undefined
        ? "NULL"
        : JSON.stringify(previousValue);
    const newStr = JSON.stringify(newValue);

    const logMessage = `[${timestamp}] FIELD_CHANGE | Issue: ${issueKey} | Source: CF[${sourceFieldId}] | Target: CF[${targetFieldId}] | Previous: ${prevStr} | New: ${newStr}\n`;
    this.writeToFile(this.logFile, logMessage);

    // Add to rollback data
    this.rollbackData.push({
      timestamp,
      issueKey,
      sourceFieldId,
      targetFieldId: `customfield_${targetFieldId}`,
      previousValue,
      newValue,
    });
  }

  logSkip(issueKey, targetFieldId, reason, existingValue) {
    const timestamp = new Date().toISOString();
    const existingStr =
      existingValue === null || existingValue === undefined
        ? "NULL"
        : JSON.stringify(existingValue);
    const logMessage = `[${timestamp}] SKIPPED | Issue: ${issueKey} | Target: CF[${targetFieldId}] | Reason: ${reason} | ExistingValue: ${existingStr}\n`;
    this.writeToFile(this.logFile, logMessage);
  }

  saveRollbackData() {
    const rollbackContent = JSON.stringify(this.rollbackData, null, 2);
    fs.writeFileSync(this.rollbackFile, rollbackContent);
    this.log(`Rollback data saved to: ${this.rollbackFile}`);
    this.log(
      `Total changes recorded for rollback: ${this.rollbackData.length}`,
    );
  }

  finalize() {
    this.writeToFile(this.logFile, `\n${"=".repeat(80)}\n`);
    this.writeToFile(this.logFile, `Completed: ${new Date().toISOString()}\n`);
    this.saveRollbackData();
  }
}

// ============================================================================
// MAIN MULTI-FIELD COPIER CLASS
// ============================================================================

class MultiFieldCopier {
  constructor(config) {
    this.url = config.url.replace(/\/$/, "");
    this.auth = Buffer.from(`${config.email}:${config.token}`).toString(
      "base64",
    );
    this.dryRun = config.dryRun || false;
    this.batchSize = config.batchSize || 50;

    const logDir = path.join(__dirname, "logs");
    this.logger = new Logger(logDir);

    this.stats = {
      totalIssuesProcessed: 0,
      totalFieldsUpdated: 0,
      totalFieldsSkipped: 0,
      totalErrors: 0,
      errors: [],
      bySequence: {},
    };

    this.startTime = Date.now();
  }

  /**
   * Extract field number from customfield_XXXXX format
   */
  extractFieldNumber(fieldId) {
    const match = fieldId.match(/customfield_(\d+)/);
    return match ? match[1] : fieldId;
  }

  /**
   * Check if field value is empty (null, undefined, empty string, empty array, empty object)
   */
  isEmptyValue(value) {
    if (value === null || value === undefined) return true;
    if (typeof value === "string" && value.trim() === "") return true;
    if (Array.isArray(value) && value.length === 0) return true;
    if (typeof value === "object" && Object.keys(value).length === 0)
      return true;
    return false;
  }

  /**
   * Make API call with retry logic and exponential backoff
   * Based on merge_field_data.js makeApiCall implementation
   */
  async makeApiCall(
    endpoint,
    method = "GET",
    body = null,
    retryCount = 0,
    maxRetries = 5,
  ) {
    return new Promise((resolve, reject) => {
      const hostname = this.url.replace(/^https?:\/\//, "").replace(/\/$/, "");

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
            // Handle 204 No Content (successful update)
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
            this.logger.log(
              `   Rate limited (429), retrying in ${backoffTime / 1000}s (attempt ${retryCount + 1}/${maxRetries})...`,
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
          } else if (res.statusCode === 403) {
            // Enhanced permission error handling (from merge_field_data.js)
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

  /**
   * Search for issues using JQL
   * Endpoint: GET /rest/api/3/search/jql
   *
   * Note: The 'key' field is automatically returned, no need to include it in fields param
   */
  async searchIssues(jql, fieldsToFetch, nextPageToken = null) {
    const maxResults = this.batchSize;
    const fieldsParam = fieldsToFetch.join(",");
    // Build endpoint similar to merge_field_data.js searchIssues method
    let endpoint = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=${fieldsParam},summary`;

    // Add nextPageToken if provided (for pagination)
    if (nextPageToken) {
      endpoint += `&nextPageToken=${encodeURIComponent(nextPageToken)}`;
    }

    return await this.makeApiCall(endpoint, "GET");
  }

  /**
   * Fetch all issues for a given sequence
   * Uses pagination via nextPageToken (Jira Cloud API v3 pattern)
   */
  async getAllIssuesForSequence(sequence) {
    this.logger.log(`Fetching issues for: ${sequence.name}`);
    this.logger.log(`JQL: ${sequence.jql}`);

    // Build fields to fetch: source field + all target fields
    const fieldsToFetch = [sequence.sourceField, ...sequence.targetFields];

    this.logger.log(
      `Fields requested: ${fieldsToFetch.length} fields (source + ${sequence.targetFields.length} targets)`,
    );

    const allIssues = [];
    let nextPageToken = null;
    let pageCount = 0;

    do {
      try {
        const response = await this.searchIssues(
          sequence.jql,
          fieldsToFetch,
          nextPageToken,
        );
        const issues = response.issues || [];

        if (issues.length > 0) {
          allIssues.push(...issues);
          this.logger.log(
            `   Fetched ${allIssues.length} issues so far... (page ${pageCount + 1})`,
          );
        }

        // Check if there's a next page
        // The API returns nextPageToken as null/undefined when there are no more pages
        nextPageToken = response.nextPageToken || null;
        pageCount++;

        // Safety check to prevent infinite loops (same as merge_field_data.js)
        if (pageCount > 200) {
          this.logger.log(
            "   Reached 200 page limit (10,000 issues). Consider refining JQL.",
          );
          break;
        }
      } catch (error) {
        // Handle 404 errors gracefully - some issues might not be accessible
        // (error handling pattern from merge_field_data.js lines 463-485)
        if (error.message.includes("HTTP 404")) {
          this.logger.log(`   Warning: ${error.message}`);
          this.logger.log(
            `   Error occurred on page ${pageCount + 1}${nextPageToken ? ` (nextPageToken: ${nextPageToken})` : ""}`,
          );
          this.logger.log(
            `   Continuing with ${allIssues.length} issues fetched so far...`,
          );

          // Log the error for tracking
          this.stats.errors.push({
            context: "pagination",
            sequence: sequence.name,
            page: pageCount + 1,
            nextPageToken: nextPageToken,
            error: error.message,
          });

          // Break out of the loop but don't throw - we have partial results
          break;
        }
        // For other errors, still throw
        this.logger.log(`   Error fetching issues: ${error.message}`);
        throw error;
      }
    } while (nextPageToken !== null);

    this.logger.log(
      `Total issues found for ${sequence.name}: ${allIssues.length}`,
    );
    return allIssues;
  }

  /**
   * Update an issue's fields
   * Endpoint: PUT /rest/api/3/issue/{issueIdOrKey}
   *
   * Makes a single PUT request with all fields to update in one call.
   * Returns 204 No Content on success.
   */
  async updateIssue(issueKey, fieldsToUpdate) {
    const endpoint = `/rest/api/3/issue/${issueKey}`;
    const body = { fields: fieldsToUpdate };

    try {
      await this.makeApiCall(endpoint, "PUT", body);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Process a single sequence (JQL + source field + target fields)
   */
  async processSequence(sequence) {
    this.logger.log("");
    this.logger.log("=".repeat(80));
    this.logger.log(`PROCESSING SEQUENCE: ${sequence.name}`);
    this.logger.log("=".repeat(80));

    const sourceFieldNum = this.extractFieldNumber(sequence.sourceField);
    const targetFieldNums = sequence.targetFields.map((f) =>
      this.extractFieldNumber(f),
    );

    this.logger.log(
      `Source Field: CF[${sourceFieldNum}] (${sequence.sourceField})`,
    );
    this.logger.log(
      `Target Fields: ${targetFieldNums.map((n) => `CF[${n}]`).join(", ")}`,
    );
    this.logger.log("");

    // Initialize sequence stats
    this.stats.bySequence[sequence.name] = {
      issuesProcessed: 0,
      fieldsUpdated: 0,
      fieldsSkipped: 0,
      errors: 0,
    };

    const issues = await this.getAllIssuesForSequence(sequence);

    if (issues.length === 0) {
      this.logger.log("No issues found for this sequence.");
      return;
    }

    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      const issueKey = issue.key;
      const sourceValue = issue.fields[sequence.sourceField];

      this.logger.log("");
      this.logger.log(`[${i + 1}/${issues.length}] Processing: ${issueKey}`);

      // Double-check source value is not empty (JQL should already filter, but be safe)
      if (this.isEmptyValue(sourceValue)) {
        this.logger.log(
          `   Source field CF[${sourceFieldNum}] is empty. Skipping issue.`,
        );
        this.stats.bySequence[sequence.name].issuesProcessed++;
        this.stats.totalIssuesProcessed++;
        continue;
      }

      this.logger.log(
        `   Source CF[${sourceFieldNum}] value: ${JSON.stringify(sourceValue).substring(0, 100)}${JSON.stringify(sourceValue).length > 100 ? "..." : ""}`,
      );

      // Check each target field and build update payload
      const fieldsToUpdate = {};
      const changesLog = [];
      const skipsLog = [];

      for (const targetField of sequence.targetFields) {
        const targetFieldNum = this.extractFieldNumber(targetField);
        const targetValue = issue.fields[targetField];

        if (!this.isEmptyValue(targetValue)) {
          // Target has a value - DO NOT OVERWRITE under any circumstance
          skipsLog.push({
            field: targetField,
            fieldNum: targetFieldNum,
            existingValue: targetValue,
          });
          this.logger.logSkip(
            issueKey,
            targetFieldNum,
            "Target field has existing value - NOT overwriting",
            targetValue,
          );
          this.stats.bySequence[sequence.name].fieldsSkipped++;
          this.stats.totalFieldsSkipped++;
        } else {
          // Target is empty - add to update payload
          const sanitizedValue = DataSanitizer.sanitize(sourceValue);
          fieldsToUpdate[targetField] = sanitizedValue;
          changesLog.push({
            field: targetField,
            fieldNum: targetFieldNum,
            previousValue: targetValue,
            newValue: sanitizedValue,
          });
        }
      }

      // Log skips summary
      if (skipsLog.length > 0) {
        this.logger.log(
          `   SKIPPED ${skipsLog.length} fields (already have values - will NOT overwrite):`,
        );
        for (const skip of skipsLog) {
          const valStr = JSON.stringify(skip.existingValue).substring(0, 50);
          this.logger.log(
            `      - CF[${skip.fieldNum}]: ${valStr}${JSON.stringify(skip.existingValue).length > 50 ? "..." : ""}`,
          );
        }
      }

      // Check if there are any fields to update
      if (Object.keys(fieldsToUpdate).length === 0) {
        this.logger.log(
          `   No fields to update (all target fields already have values).`,
        );
        this.stats.bySequence[sequence.name].issuesProcessed++;
        this.stats.totalIssuesProcessed++;
        continue;
      }

      // Log changes preview
      const changeFieldNums = changesLog
        .map((c) => `CF[${c.fieldNum}]`)
        .join(", ");
      this.logger.log(
        `   UPDATING ${changesLog.length} fields: ${changeFieldNums}`,
      );

      if (this.dryRun) {
        this.logger.log(`   [DRY RUN] Would update fields: ${changeFieldNums}`);
        for (const change of changesLog) {
          this.logger.log(
            `      - CF[${change.fieldNum}]: NULL -> ${JSON.stringify(change.newValue).substring(0, 50)}...`,
          );
          this.logger.logFieldChange(
            issueKey,
            sourceFieldNum,
            change.fieldNum,
            change.previousValue,
            change.newValue,
          );
        }
        this.stats.bySequence[sequence.name].fieldsUpdated += changesLog.length;
        this.stats.totalFieldsUpdated += changesLog.length;
      } else {
        // Make single PUT request with all field updates (efficient - one call per issue)
        const result = await this.updateIssue(issueKey, fieldsToUpdate);

        if (result.success) {
          this.logger.log(
            `   SUCCESS - Updated ${changesLog.length} fields in single request`,
          );
          for (const change of changesLog) {
            this.logger.log(
              `      - CF[${change.fieldNum}]: NULL -> ${JSON.stringify(change.newValue).substring(0, 50)}...`,
            );
            this.logger.logFieldChange(
              issueKey,
              sourceFieldNum,
              change.fieldNum,
              change.previousValue,
              change.newValue,
            );
          }
          this.stats.bySequence[sequence.name].fieldsUpdated +=
            changesLog.length;
          this.stats.totalFieldsUpdated += changesLog.length;
        } else {
          this.logger.log(`   ERROR - Failed to update: ${result.error}`);
          this.stats.bySequence[sequence.name].errors++;
          this.stats.totalErrors++;
          this.stats.errors.push({
            context: "update",
            issueKey: issueKey,
            sequence: sequence.name,
            error: result.error,
          });
        }
      }

      this.stats.bySequence[sequence.name].issuesProcessed++;
      this.stats.totalIssuesProcessed++;

      // Small delay to avoid rate limiting (same pattern as merge_field_data.js)
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Print final summary of all operations
   */
  printFinalSummary() {
    const totalTime = Math.round((Date.now() - this.startTime) / 1000);

    this.logger.log("");
    this.logger.log("=".repeat(80));
    this.logger.log("FINAL SUMMARY");
    this.logger.log("=".repeat(80));
    this.logger.log("");
    this.logger.log(
      `Total Issues Processed: ${this.stats.totalIssuesProcessed}`,
    );
    this.logger.log(`Total Fields Updated: ${this.stats.totalFieldsUpdated}`);
    this.logger.log(
      `Total Fields Skipped (had values - NOT overwritten): ${this.stats.totalFieldsSkipped}`,
    );
    this.logger.log(`Total Errors: ${this.stats.totalErrors}`);
    this.logger.log(
      `Total Time: ${Math.floor(totalTime / 60)}m${totalTime % 60}s`,
    );

    if (totalTime > 0 && this.stats.totalIssuesProcessed > 0) {
      const issuesPerMinute = Math.round(
        (this.stats.totalIssuesProcessed / totalTime) * 60,
      );
      this.logger.log(`Processing Rate: ~${issuesPerMinute} issues/min`);
    }

    this.logger.log("");
    this.logger.log("BY SEQUENCE:");

    for (const [seqName, seqStats] of Object.entries(this.stats.bySequence)) {
      this.logger.log(`  ${seqName}:`);
      this.logger.log(`    - Issues Processed: ${seqStats.issuesProcessed}`);
      this.logger.log(`    - Fields Updated: ${seqStats.fieldsUpdated}`);
      this.logger.log(`    - Fields Skipped: ${seqStats.fieldsSkipped}`);
      this.logger.log(`    - Errors: ${seqStats.errors}`);
    }

    // Print error details if any
    if (this.stats.errors.length > 0) {
      this.logger.log("");
      this.logger.log("ERROR DETAILS:");
      for (const error of this.stats.errors.slice(0, 10)) {
        if (error.issueKey) {
          this.logger.log(`   ${error.issueKey}: ${error.error}`);
        } else {
          this.logger.log(`   ${error.context}: ${error.error}`);
        }
      }
      if (this.stats.errors.length > 10) {
        this.logger.log(
          `   ... and ${this.stats.errors.length - 10} more errors`,
        );
      }
    }

    if (this.dryRun) {
      this.logger.log("");
      this.logger.log("[DRY RUN MODE] - No actual changes were made to Jira");
    }
  }

  /**
   * Main execution entry point
   */
  async run() {
    this.logger.log("MULTI-FIELD COPY SCRIPT");
    this.logger.log("=".repeat(80));
    this.logger.log(`Instance: ${this.url}`);
    this.logger.log(`Dry Run: ${this.dryRun ? "YES" : "NO"}`);
    this.logger.log(`Batch Size: ${this.batchSize}`);
    this.logger.log("");
    this.logger.log("IMPORTANT: This script NEVER overwrites existing values.");
    this.logger.log(
      "Target fields are only updated if they are currently empty.",
    );
    this.logger.log("");
    this.logger.log(`Number of sequences to process: ${SEQUENCES.length}`);
    this.logger.log("");

    try {
      // Process each sequence
      for (let i = 0; i < SEQUENCES.length; i++) {
        const sequence = SEQUENCES[i];
        this.logger.log(
          `\n>>> Starting Sequence ${i + 1}/${SEQUENCES.length}: ${sequence.name}`,
        );
        await this.processSequence(sequence);
      }

      this.printFinalSummary();
      this.logger.finalize();

      this.logger.log("");
      this.logger.log("Script completed successfully!");
      this.logger.log(`Log file: ${this.logger.logFile}`);
      this.logger.log(`Rollback file: ${this.logger.rollbackFile}`);
    } catch (error) {
      this.logger.log("");
      this.logger.log(`FATAL ERROR: ${error.message}`);
      console.error(error.stack);
      this.logger.finalize();
      process.exit(1);
    }
  }
}

// ============================================================================
// COMMAND LINE INTERFACE
// Simple argument parsing without external dependencies
// ============================================================================

const args = process.argv.slice(2);

function getArg(name) {
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1]) {
    return args[index + 1];
  }
  return null;
}

function hasFlag(name) {
  return args.includes(`--${name}`);
}

// Parse arguments
const url = getArg("url");
const email = getArg("email");
const token = getArg("token");
const dryRun = hasFlag("dry-run");
const batchSize = parseInt(getArg("batch-size") || "50", 10);

// Validate required arguments
if (!url || !email || !token) {
  console.log("Multi-Field Copy Script");
  console.log("");
  console.log(
    "This script copies a source field value to multiple target fields,",
  );
  console.log(
    "but ONLY if the target fields are EMPTY. It NEVER overwrites existing values.",
  );
  console.log("");
  console.log("Usage:");
  console.log("  node multi_field_copy.js \\");
  console.log("    --url https://your-instance.atlassian.net \\");
  console.log("    --email user@company.com \\");
  console.log("    --token your-api-token \\");
  console.log("    [--dry-run] \\");
  console.log("    [--batch-size 50]");
  console.log("");
  console.log("Options:");
  console.log("  --url          Jira Cloud instance URL (required)");
  console.log("  --email        Email for authentication (required)");
  console.log("  --token        API token for authentication (required)");
  console.log("  --dry-run      Preview changes without making them");
  console.log("  --batch-size   Number of issues per page (default: 50)");
  console.log("");
  console.log("API Endpoints Used:");
  console.log("  GET /rest/api/3/search/jql - Search for issues");
  console.log("  PUT /rest/api/3/issue/{key} - Update issue fields");
  console.log("");
  console.log("Sequences configured:");
  for (const seq of SEQUENCES) {
    const srcNum = seq.sourceField.match(/customfield_(\d+)/)?.[1];
    const tgtNums = seq.targetFields
      .map((f) => f.match(/customfield_(\d+)/)?.[1])
      .join(", ");
    console.log(`  - ${seq.name}`);
    console.log(`    JQL: ${seq.jql}`);
    console.log(`    Source: CF[${srcNum}], Targets: CF[${tgtNums}]`);
  }
  console.log("");
  console.log(
    "Generate API token from: https://id.atlassian.com/manage-profile/security/api-tokens",
  );
  process.exit(1);
}

// Run the script
const copier = new MultiFieldCopier({
  url,
  email,
  token,
  dryRun,
  batchSize,
});

copier.run().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
