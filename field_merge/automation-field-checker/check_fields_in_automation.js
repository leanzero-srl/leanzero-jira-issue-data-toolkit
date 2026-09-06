#!/usr/bin/env node

/**
 * Check Custom Field Usage in Automation Rules (Enhanced Version)
 *
 * This script checks if specified custom field IDs are being used in automation rules.
 * It parses the automation_rules.json file and searches for field references by BOTH:
 * - Field ID (e.g., "customfield_13207")
 * - Field NAME (e.g., "Health Status")
 *
 * This is critical because Jira automations can reference fields by either their ID or name.
 *
 * Usage (fetches field names automatically from Jira):
 *   node check_fields_in_automation.js \
 *     --email your-email@company.com \
 *     --token your-api-token \
 *     --site-url yourcompany.atlassian.net
 *
 * Usage with manual field mapping file (optional fallback):
 *   node check_fields_in_automation.js \
 *     --mapping-file field_mappings.json
 *
 * Usage without field names (ID only search - not recommended):
 *   node check_fields_in_automation.js
 *
 * Configuration:
 *   - Edit the CUSTOM_FIELDS array below to specify which fields to check
 *   - Place automation_rules.json in the same folder as this script
 *
 * Output:
 *   - Generates a report showing which fields are used and which are not
 *   - For used fields, shows the automation rule names and locations where they appear
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

// ============================================================================
// CONFIGURATION
// ============================================================================

// Add the custom field IDs you want to check here
const CUSTOM_FIELDS = [
  // ── EDIT THIS FOR YOUR INSTANCE ──────────────────────────────────────────
  // The custom-field ids you are about to delete or merge. Find them with
  // GET /rest/api/3/field. These placeholders will not match your tenant.
  "customfield_10001",
  "customfield_10002",
  "customfield_10003",
];

// Path to the automation rules JSON file (should be in the same folder)
const AUTOMATION_RULES_FILE = path.join(__dirname, "automation_rules.json");

// Path to config directory
const CONFIG_DIR = path.join(__dirname, "config");

// Path to reports directory
const REPORTS_DIR = path.join(__dirname, "reports");

// ============================================================================
// JIRA API CLIENT
// ============================================================================

/**
 * Make an HTTPS request to Jira API
 */
function makeJiraRequest(email, apiToken, siteUrl, endpoint) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
    const url = new URL(endpoint, `https://${siteUrl}`);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(new Error(`Failed to parse JSON: ${error.message}`));
          }
        } else {
          reject(
            new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`),
          );
        }
      });
    });

    req.on("error", (error) => {
      reject(error);
    });

    req.end();
  });
}

/**
 * Fetch all custom fields from Jira and create a mapping
 */
async function fetchFieldMapping(email, apiToken, siteUrl) {
  console.log("Fetching custom fields from Jira API...");

  try {
    const fields = await makeJiraRequest(
      email,
      apiToken,
      siteUrl,
      "/rest/api/3/field",
    );

    const customFields = fields.filter((f) => f.id.startsWith("customfield_"));
    const mapping = {};

    customFields.forEach((field) => {
      mapping[field.id] = field.name;
    });

    console.log(
      `Fetched ${Object.keys(mapping).length} custom fields from Jira.\n`,
    );
    return mapping;
  } catch (error) {
    console.error(`Error fetching fields from Jira: ${error.message}`);
    console.error(
      "Continuing with ID-only search (field names will not be checked).\n",
    );
    return {};
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Recursively search for custom field references in an object
 * Searches for both field ID and field name
 * @param {*} obj - The object to search
 * @param {string} fieldId - The custom field ID to search for
 * @param {string} fieldName - The custom field name to search for (optional)
 * @param {string} path - The current path in the object (for debugging)
 * @returns {Array} - Array of locations where the field was found
 */
function findFieldInObject(obj, fieldId, fieldName, currentPath = "") {
  const findings = [];

  if (obj === null || obj === undefined) {
    return findings;
  }

  // Check if this is a string that contains the field ID or field name
  if (typeof obj === "string") {
    if (obj.includes(fieldId)) {
      findings.push({
        path: currentPath,
        value: obj,
        type: "field_id_reference",
      });
    } else if (fieldName && obj === fieldName) {
      findings.push({
        path: currentPath,
        value: obj,
        type: "field_name_reference",
      });
    }
    return findings;
  }

  // Check arrays
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      const results = findFieldInObject(
        item,
        fieldId,
        fieldName,
        `${currentPath}[${index}]`,
      );
      findings.push(...results);
    });
    return findings;
  }

  // Check objects
  if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj)) {
      const newPath = currentPath ? `${currentPath}.${key}` : key;

      // Direct field ID match in object keys or values
      if (key === "fieldId" && value === fieldId) {
        findings.push({
          path: newPath,
          value: value,
          type: "field_id_property",
        });
      } else if (key === "value" && value === fieldId) {
        findings.push({
          path: newPath,
          value: value,
          type: "field_id_value",
        });
      } else if (fieldName && key === "value" && value === fieldName) {
        findings.push({
          path: newPath,
          value: value,
          type: "field_name_value",
        });
      } else {
        // Recursively search nested objects
        const results = findFieldInObject(value, fieldId, fieldName, newPath);
        findings.push(...results);
      }
    }
  }

  return findings;
}

/**
 * Search for a custom field in a single automation rule
 * @param {Object} rule - The automation rule object
 * @param {string} fieldId - The custom field ID to search for
 * @param {string} fieldName - The custom field name to search for (optional)
 * @returns {Object} - Object containing rule info and findings
 */
function searchRuleForField(rule, fieldId, fieldName) {
  const findings = [];

  // Search in trigger
  if (rule.trigger) {
    const triggerFindings = findFieldInObject(
      rule.trigger,
      fieldId,
      fieldName,
      "trigger",
    );
    findings.push(...triggerFindings);
  }

  // Search in components (actions, conditions, branches, etc.)
  if (rule.components && Array.isArray(rule.components)) {
    rule.components.forEach((component, index) => {
      const componentFindings = findFieldInObject(
        component,
        fieldId,
        fieldName,
        `components[${index}]`,
      );
      findings.push(...componentFindings);
    });
  }

  // Search in any other properties (just in case)
  const otherKeys = Object.keys(rule).filter(
    (k) => k !== "trigger" && k !== "components",
  );
  otherKeys.forEach((key) => {
    const otherFindings = findFieldInObject(rule[key], fieldId, fieldName, key);
    findings.push(...otherFindings);
  });

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    ruleState: rule.state,
    findings: findings,
  };
}

/**
 * Generate a detailed report for a field
 * @param {string} fieldId - The custom field ID
 * @param {string} fieldName - The custom field name (if available)
 * @param {Array} results - Array of search results
 * @returns {string} - Formatted report
 */
function generateFieldReport(fieldId, fieldName, results) {
  const usedInRules = results.filter((r) => r.findings.length > 0);

  let report = `\n${"=".repeat(80)}\n`;
  report += `Field: ${fieldId}`;
  if (fieldName) {
    report += ` (${fieldName})`;
  }
  report += `\n`;
  report += `${"=".repeat(80)}\n`;

  if (usedInRules.length === 0) {
    report += `✗ NOT USED - This field is not referenced in any automation rules\n`;
  } else {
    report += `✓ USED - Found in ${usedInRules.length} automation rule(s)\n\n`;

    usedInRules.forEach((ruleResult, index) => {
      report += `${index + 1}. Rule: "${ruleResult.ruleName}"\n`;
      report += `   ID: ${ruleResult.ruleId}\n`;
      report += `   State: ${ruleResult.ruleState}\n`;
      report += `   Occurrences: ${ruleResult.findings.length}\n`;

      ruleResult.findings.forEach((finding, fIndex) => {
        report += `   ${fIndex + 1}) Location: ${finding.path}\n`;
        report += `      Type: ${finding.type}\n`;
        if (finding.value.length < 200) {
          report += `      Value: ${finding.value}\n`;
        } else {
          report += `      Value: ${finding.value.substring(0, 200)}...\n`;
        }
      });
      report += `\n`;
    });
  }

  return report;
}

/**
 * Generate a summary report
 * @param {Object} fieldResults - Map of field IDs to results
 * @param {Object} fieldMapping - Map of field IDs to field names
 * @returns {string} - Formatted summary
 */
function generateSummary(fieldResults, fieldMapping) {
  let summary = `\n${"=".repeat(80)}\n`;
  summary += `SUMMARY\n`;
  summary += `${"=".repeat(80)}\n\n`;

  const usedFields = [];
  const unusedFields = [];

  for (const [fieldId, results] of Object.entries(fieldResults)) {
    const usedInRules = results.filter((r) => r.findings.length > 0);
    const fieldName = fieldMapping[fieldId] || null;

    if (usedInRules.length > 0) {
      usedFields.push({
        fieldId,
        fieldName,
        ruleCount: usedInRules.length,
        occurrenceCount: usedInRules.reduce(
          (sum, r) => sum + r.findings.length,
          0,
        ),
      });
    } else {
      unusedFields.push({ fieldId, fieldName });
    }
  }

  summary += `Total fields checked: ${CUSTOM_FIELDS.length}\n`;
  summary += `Fields in use: ${usedFields.length}\n`;
  summary += `Fields not in use: ${unusedFields.length}\n`;
  summary += `Field name mapping: ${Object.keys(fieldMapping).length > 0 ? "ENABLED" : "DISABLED"}\n\n`;

  if (usedFields.length > 0) {
    summary += `FIELDS IN USE:\n`;
    summary += `${"-".repeat(80)}\n`;
    usedFields.forEach((field) => {
      summary += `✓ ${field.fieldId}`;
      if (field.fieldName) {
        summary += ` (${field.fieldName})`;
      }
      summary += `\n`;
      summary += `  Used in ${field.ruleCount} rule(s) with ${field.occurrenceCount} total occurrence(s)\n`;
    });
    summary += `\n`;
  }

  if (unusedFields.length > 0) {
    summary += `FIELDS NOT IN USE:\n`;
    summary += `${"-".repeat(80)}\n`;
    unusedFields.forEach((field) => {
      summary += `✗ ${field.fieldId}`;
      if (field.fieldName) {
        summary += ` (${field.fieldName})`;
      }
      summary += `\n`;
    });
    summary += `\n`;
  }

  return summary;
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  console.log("Custom Field Usage Checker for Automation Rules (Enhanced)");
  console.log("=".repeat(80));

  // Parse command line arguments
  const args = process.argv.slice(2);
  let email = null;
  let apiToken = null;
  let siteUrl = null;
  let mappingFile = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--email" && args[i + 1]) {
      email = args[i + 1];
      i++;
    } else if (args[i] === "--token" && args[i + 1]) {
      apiToken = args[i + 1];
      i++;
    } else if (args[i] === "--site-url" && args[i + 1]) {
      siteUrl = args[i + 1].replace(/^https?:\/\//, "").replace(/\/$/, "");
      i++;
    } else if (args[i] === "--mapping-file" && args[i + 1]) {
      mappingFile = args[i + 1];
      i++;
    }
  }

  // Get field mapping (ID -> Name)
  let fieldMapping = {};

  // Priority 1: Try to fetch from Jira API if we have credentials
  if (email && apiToken && siteUrl) {
    fieldMapping = await fetchFieldMapping(email, apiToken, siteUrl);
  }
  // Priority 2: If API fetch failed or no credentials, try mapping file
  else if (mappingFile || Object.keys(fieldMapping).length === 0) {
    if (!mappingFile) {
      console.log(
        "No Jira credentials provided. Looking for manual mapping file...",
      );
      // Try to find manual_field_mappings.json in config directory
      const defaultMappingPath = path.join(
        CONFIG_DIR,
        "manual_field_mappings.json",
      );
      if (fs.existsSync(defaultMappingPath)) {
        mappingFile = "manual_field_mappings.json";
        console.log(`Found ${mappingFile} in config directory.`);
      }
    }

    if (mappingFile) {
      // Load from file - check if path is absolute or relative to config dir
      let mappingPath = mappingFile;
      if (!path.isAbsolute(mappingFile)) {
        // First try config directory, then current directory
        const configPath = path.join(CONFIG_DIR, mappingFile);
        if (fs.existsSync(configPath)) {
          mappingPath = configPath;
        } else {
          mappingPath = path.join(__dirname, mappingFile);
        }
      }

      console.log(`Loading field mapping from ${mappingPath}...`);
      try {
        const fileContent = fs.readFileSync(mappingPath, "utf8");
        fieldMapping = JSON.parse(fileContent);
        console.log(
          `Loaded ${Object.keys(fieldMapping).length} field mappings.\n`,
        );
      } catch (error) {
        console.error(`Error loading mapping file: ${error.message}`);
        console.error("Continuing with ID-only search.\n");
      }
    } else {
      console.log("No mapping file found.");
      console.log(
        "NOTE: Fields referenced by NAME will not be detected. For full coverage, provide:",
      );
      console.log("  --email, --token, --site-url (to fetch from Jira)\n");
    }
  }

  if (Object.keys(fieldMapping).length === 0) {
    console.log(
      "⚠️  WARNING: Searching by field ID only. This may miss fields referenced by name!",
    );
    console.log(
      "   For complete results, run with: --email <email> --token <token> --site-url <url>\n",
    );
  }

  console.log(`Checking ${CUSTOM_FIELDS.length} custom field(s)...`);
  console.log(`Automation rules file: ${AUTOMATION_RULES_FILE}\n`);

  // Check if automation rules file exists
  if (!fs.existsSync(AUTOMATION_RULES_FILE)) {
    console.error(
      `ERROR: automation_rules.json not found at ${AUTOMATION_RULES_FILE}`,
    );
    console.error(
      "Please place the automation_rules.json file in the same folder as this script.",
    );
    process.exit(1);
  }

  // Load automation rules
  console.log("Loading automation rules...");
  let automationData;
  try {
    const fileContent = fs.readFileSync(AUTOMATION_RULES_FILE, "utf8");
    automationData = JSON.parse(fileContent);
  } catch (error) {
    console.error(
      `ERROR: Failed to parse automation_rules.json: ${error.message}`,
    );
    process.exit(1);
  }

  if (!automationData.rules || !Array.isArray(automationData.rules)) {
    console.error(
      "ERROR: Invalid automation rules format. Expected 'rules' array.",
    );
    process.exit(1);
  }

  console.log(`Loaded ${automationData.rules.length} automation rules.\n`);

  // Search for each custom field
  const fieldResults = {};

  CUSTOM_FIELDS.forEach((fieldId) => {
    const fieldName = fieldMapping[fieldId] || null;
    console.log(
      `Searching for ${fieldId}${fieldName ? ` (${fieldName})` : ""}...`,
    );
    const results = [];

    automationData.rules.forEach((rule) => {
      const ruleResult = searchRuleForField(rule, fieldId, fieldName);
      results.push(ruleResult);
    });

    fieldResults[fieldId] = results;

    const usedCount = results.filter((r) => r.findings.length > 0).length;
    console.log(
      `  Found in ${usedCount} rule(s) out of ${automationData.rules.length} total rules`,
    );
  });

  // Generate report
  console.log("\n\nGenerating report...\n");

  let fullReport = "";

  // Summary first
  fullReport += generateSummary(fieldResults, fieldMapping);

  // Detailed reports for each field
  fullReport += `\n${"=".repeat(80)}\n`;
  fullReport += `DETAILED FIELD REPORTS\n`;
  fullReport += `${"=".repeat(80)}\n`;

  CUSTOM_FIELDS.forEach((fieldId) => {
    const fieldName = fieldMapping[fieldId] || null;
    fullReport += generateFieldReport(
      fieldId,
      fieldName,
      fieldResults[fieldId],
    );
  });

  // Output to console
  console.log(fullReport);

  // Save to file in reports directory
  // Ensure reports directory exists
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const reportFileName = `field_usage_report_${new Date().toISOString().split("T")[0]}.txt`;
  const reportPath = path.join(REPORTS_DIR, reportFileName);

  try {
    fs.writeFileSync(reportPath, fullReport, "utf8");
    console.log(`\nReport saved to: ${reportPath}`);
  } catch (error) {
    console.error(`Warning: Could not save report file: ${error.message}`);
  }

  console.log("\nDone!");
}

// Run the script
if (require.main === module) {
  main().catch((error) => {
    console.error(`Fatal error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { findFieldInObject, searchRuleForField };
