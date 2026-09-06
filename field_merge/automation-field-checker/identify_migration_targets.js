#!/usr/bin/env node

/**
 * Identify Migration Targets - Enhanced Version
 *
 * This script identifies which fields need data migration by:
 * 1. Fetching ALL custom fields from Jira
 * 2. Finding fields that have both original and "(migrated)" versions
 * 3. Checking which fields (original OR migrated) are used in automations
 * 4. Querying Jira to count issues with data in each field
 * 5. Breaking down issue counts by project
 * 6. Generating a comprehensive merge action plan
 *
 * Usage:
 *   node identify_migration_targets.js \
 *     --email your-email@company.com \
 *     --token your-api-token \
 *     --site-url yourcompany.atlassian.net
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

// ============================================================================
// SAFETY FILTERS - Based on official Jira API documentation
// ============================================================================

/**
 * Filter patterns for dangerous field types that should never be modified.
 * Based on official Atlassian REST API documentation and Jira system fields.
 */
const DANGEROUS_FIELD_PATTERNS = [
  "com.atlassian.jira.ext.charting", // Chart/built-in fields (e.g., firstresponsedate)
  "com.atlassian.jira.plugin.system.customfieldtypes:priority", // Priority system field
  "com.atlassian.jira.plugin.system.customfieldtypes:resolution", // Resolution system field
  "com.atlassian.jira.plugin.system.customfieldtypes:status", // Status system field
];

/**
 * Safely checks if a field should be processed.
 * @param {Object} field - Field object from Jira API
 * @returns {boolean} - True if field is safe to process, false otherwise
 */
function isSafeField(field) {
  // Must be an actual custom field (not system field)
  if (!field || field.custom !== true) return false;

  // Check for dangerous field type patterns
  const fieldType = field.schema?.type || "";
  const fieldCustom = field.schema?.custom || "";

  return !DANGEROUS_FIELD_PATTERNS.some(
    (pattern) => fieldType.includes(pattern) || fieldCustom.includes(pattern),
  );
}

// ============================================================================
// JIRA API CLIENT
// ============================================================================

function makeJiraRequest(
  email,
  apiToken,
  siteUrl,
  endpoint,
  method = "GET",
  body = null,
) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
    const url = new URL(endpoint, `https://${siteUrl}`);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: method,
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

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

async function fetchAllCustomFields(email, apiToken, siteUrl) {
  console.log("Fetching all custom fields from Jira...");

  try {
    const fields = await makeJiraRequest(
      email,
      apiToken,
      siteUrl,
      "/rest/api/3/field",
    );

    // Filter out system fields and only keep actual custom fields
    // Filter for actual custom fields only (not system fields)
    const customFields = fields.filter(
      (f) => f.id.startsWith("customfield_") && f.custom === true,
    );

    console.log(`Found ${customFields.length} custom fields.`);

    // Filter out dangerous field types that should never be modified
    const safeFields = customFields.filter(isSafeField);

    console.log(
      `Filtered out ${customFields.length - safeFields.length} potentially dangerous fields`,
    );

    // Safety verification: double-check that all fields returned are actually custom
    const verifiedCustomFields = safeFields.filter((f) => f.custom === true);
    if (verifiedCustomFields.length !== safeFields.length) {
      console.log(
        `⚠️ SAFETY: Filtered out ${safeFields.length - verifiedCustomFields.length} non-custom fields`,
      );
    }

    console.log(
      `Verified ${verifiedCustomFields.length} safe custom fields.\n`,
    );

    return verifiedCustomFields;
  } catch (error) {
    console.error(`Error fetching fields: ${error.message}`);
    throw error;
  }
}

async function getApproximateCount(email, apiToken, siteUrl, fieldId) {
  // Extract field number for JQL (customfield_12345 -> cf[12345])
  const fieldMatch = fieldId.match(/customfield_(\d+)/);
  const fieldRef = fieldMatch ? `cf[${fieldMatch[1]}]` : fieldId;
  const jql = `${fieldRef} is not EMPTY`;
  const endpoint = `/rest/api/3/search/approximate-count`;

  try {
    const result = await makeJiraRequest(
      email,
      apiToken,
      siteUrl,
      endpoint,
      "POST",
      { jql },
    );
    return result.count || 0;
  } catch (error) {
    console.error(`  Error getting count for ${fieldId}: ${error.message}`);
    return null;
  }
}

async function getIssueCountByProject(email, apiToken, siteUrl, fieldId) {
  // Extract field number for JQL (customfield_12345 -> cf[12345])
  const fieldMatch = fieldId.match(/customfield_(\d+)/);
  const fieldRef = fieldMatch ? `cf[${fieldMatch[1]}]` : fieldId;

  try {
    // 1. Get total count using approximate-count endpoint
    const totalCount = await getApproximateCount(
      email,
      apiToken,
      siteUrl,
      fieldId,
    );

    // 2. Get sample issues for project breakdown using search/jql endpoint
    const jql = `${fieldRef} is not EMPTY ORDER BY created DESC`;
    const endpoint = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=project`;
    const result = await makeJiraRequest(email, apiToken, siteUrl, endpoint);

    // 3. Count issues by project from sample
    const projectCounts = {};
    if (result.issues && result.issues.length > 0) {
      result.issues.forEach((issue) => {
        const projectKey = issue.fields.project.key;
        projectCounts[projectKey] = (projectCounts[projectKey] || 0) + 1;
      });

      return {
        total: totalCount, // From approximate-count
        projects: projectCounts, // From sample
        sample: result.issues ? result.issues.length : 0,
      };
    }
  } catch (error) {
    console.error(`\n  ERROR ${fieldId}: ${error.message}`);
    return { total: null, projects: {}, sample: 0 };
  }
}

// ============================================================================
// FIELD PAIRING LOGIC
// ============================================================================

function findFieldPairs(allFields) {
  const pairs = [];
  const migratedFields = [];
  const originalFields = [];

  // Separate migrated and original fields
  allFields.forEach((field) => {
    if (field.name.includes("(migrated)")) {
      migratedFields.push(field);
    } else {
      originalFields.push(field);
    }
  });
  // Apply safety filtering to all field sets
  const safeOriginalFields = originalFields.filter(isSafeField);
  const safeMigratedFields = migratedFields.filter(isSafeField);

  console.log(`Filtered to ${safeOriginalFields.length} safe original fields`);
  console.log(
    `Filtered to ${safeMigratedFields.length} safe migrated fields\n`,
  );

  // Use filtered arrays for pairing (fallback to original if no safe fields found)
  const finalOriginalFields =
    safeOriginalFields.length > 0 ? safeOriginalFields : originalFields;
  const finalMigratedFields =
    safeMigratedFields.length > 0 ? safeMigratedFields : migratedFields;

  console.log(`Found ${finalOriginalFields.length} original fields`);
  console.log(`Found ${finalMigratedFields.length} migrated fields\n`);

  // Try to pair them up
  finalMigratedFields.forEach((migratedField) => {
    const baseName = migratedField.name
      .replace(/\s*\(migrated\)\s*$/i, "")
      .trim();

    const migratedType = migratedField.schema?.custom || "unknown";

    // Find matching original field by name AND type
    const matchingOriginal = finalOriginalFields.find((origField) => {
      const origType = origField.schema?.custom || "unknown";
      return origField.name === baseName && origType === migratedType;
    });

    // Add type property for easier access in reporting
    const pairData = {
      baseName: baseName,
      original: matchingOriginal
        ? {
            ...matchingOriginal,
            type: matchingOriginal.schema?.custom || "unknown",
          }
        : null,
      migrated: {
        ...migratedField,
        type: migratedField.schema?.custom || "unknown",
      },
    };

    pairs.push(pairData);
  });

  console.log(`Found ${pairs.length} field pairs after safety filtering\n`);

  return pairs;
}

// ============================================================================
// LOAD AUTOMATION USAGE DATA - PARSE DIRECTLY FROM automation_rules.json
// ============================================================================

function parseAutomationRules(fieldMapping) {
  const automationPath = path.join(__dirname, "..", "automation_rules.json");

  if (!fs.existsSync(automationPath)) {
    console.error(
      `ERROR: automation_rules.json not found at ${automationPath}`,
    );
    return {};
  }

  console.log(`Parsing automation rules from: ${automationPath}`);

  const content = fs.readFileSync(automationPath, "utf8");
  const automationData = JSON.parse(content);

  const usage = {};

  // Helper function to recursively search for field references
  function searchForFields(obj, ruleName, path = "") {
    if (!obj || typeof obj !== "object") return;

    const objStr = JSON.stringify(obj);

    // Search for each field by ID and NAME
    Object.keys(fieldMapping).forEach((fieldId) => {
      const fieldName = fieldMapping[fieldId];

      // Search by field ID
      if (objStr.includes(fieldId)) {
        if (!usage[fieldId]) {
          usage[fieldId] = {
            name: fieldName,
            rules: new Set(),
            occurrences: 0,
            locations: [],
          };
        }
        usage[fieldId].rules.add(ruleName);
        usage[fieldId].occurrences++;
        usage[fieldId].locations.push({
          rule: ruleName,
          path: path,
        });
      }

      // Search by field NAME (if we have it)
      if (fieldName && objStr.includes(fieldName)) {
        if (!usage[fieldId]) {
          usage[fieldId] = {
            name: fieldName,
            rules: new Set(),
            occurrences: 0,
            locations: [],
          };
        }
        usage[fieldId].rules.add(ruleName);
        usage[fieldId].occurrences++;
        usage[fieldId].locations.push({
          rule: ruleName,
          path: path,
        });
      }
    });

    // Recurse into nested objects/arrays
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        searchForFields(obj[key], ruleName, path ? `${path}.${key}` : key);
      }
    }
  }

  // Process all automation rules
  if (Array.isArray(automationData)) {
    automationData.forEach((rule) => {
      const ruleName = rule.name || "Unnamed Rule";
      searchForFields(rule, ruleName);
    });
  } else if (automationData.rules && Array.isArray(automationData.rules)) {
    automationData.rules.forEach((rule) => {
      const ruleName = rule.name || "Unnamed Rule";
      searchForFields(rule, ruleName);
    });
  }

  // Convert Sets to arrays and also store the count
  Object.keys(usage).forEach((fieldId) => {
    const ruleSet = usage[fieldId].rules;
    usage[fieldId].ruleNames = Array.from(ruleSet); // Keep the actual rule names
    usage[fieldId].rules = ruleSet.size; // Keep the count for backward compatibility
  });

  console.log(
    `Found ${Object.keys(usage).length} fields used in automations\n`,
  );

  return usage;
}

// ============================================================================
// QUERY ISSUE DATA
// ============================================================================

async function enrichPairsWithIssueData(pairs, email, apiToken, siteUrl) {
  console.log("Querying issue data for each field pair...\n");

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    process.stdout.write(`[${i + 1}/${pairs.length}] ${pair.baseName}...`);

    // Query original field if it exists
    if (pair.original) {
      const originalData = await getIssueCountByProject(
        email,
        apiToken,
        siteUrl,
        pair.original.id,
      );
      pair.original.issueCount = originalData.total;
      pair.original.projects = originalData.projects;
      pair.original.sampleSize = originalData.sample;
    }

    // Query migrated field
    const migratedData = await getIssueCountByProject(
      email,
      apiToken,
      siteUrl,
      pair.migrated.id,
    );
    pair.migrated.issueCount = migratedData.total;
    pair.migrated.projects = migratedData.projects;
    pair.migrated.sampleSize = migratedData.sample;

    const origCount = pair.original?.issueCount || 0;
    const migrCount = pair.migrated.issueCount || 0;
    console.log(` Original: ${origCount}, Migrated: ${migrCount}`);
  }

  console.log("\n");
}

// ============================================================================
// GENERATE MIGRATION PLAN
// ============================================================================

function calculateTimeEstimate(
  issueCount,
  automationRules,
  includeCommandCraftingTime = true,
) {
  let totalMinutes = 0;

  // Data merge time: 1.2s per issue
  const mergeTimeSeconds = issueCount * 1.2;
  let mergeTimeMinutes = mergeTimeSeconds / 60;

  // Apply multipliers for larger datasets
  if (issueCount >= 10000) {
    // 10k+ tickets: apply 1.3 multiplier on top of 1.2 multiplier
    mergeTimeMinutes *= 1.2 * 1.3;
  } else if (issueCount >= 500) {
    // 500+ tickets: apply 1.2 multiplier
    mergeTimeMinutes *= 1.2;
  }

  totalMinutes += mergeTimeMinutes;

  // Automation update time: 10 min per rule until 50 min, then 5 min per rule
  if (automationRules > 0) {
    let automationMinutes = 0;

    // First 5 rules: 10 min each (0-50 min)
    const firstBatch = Math.min(automationRules, 5);
    automationMinutes += firstBatch * 10;

    // Remaining rules: 5 min each (after 50 min)
    if (automationRules > 5) {
      const remainingRules = automationRules - 5;
      automationMinutes += remainingRules * 5;
    }

    totalMinutes += automationMinutes;
  }

  // Command crafting time: 1 min per command
  if (includeCommandCraftingTime && issueCount > 0) {
    totalMinutes += 1;
  }

  return totalMinutes;
}

function generateMigrationPlan(pairs, usageData) {
  const deleteOnly = [];
  const mergeOriginalToMigrated = [];
  const mergeMigratedToOriginal = [];
  const noActionNeeded = [];
  const alreadyMigrated = [];
  const noOriginal = [];
  const notUsed = [];

  pairs.forEach((pair) => {
    if (!pair.original) {
      // No original field exists
      const migratedUsed = usageData[pair.migrated.id];
      const migratedHasData = pair.migrated.issueCount > 0;

      if (migratedUsed || migratedHasData) {
        alreadyMigrated.push({
          ...pair,
          migratedUsage: migratedUsed || null,
        });
      } else {
        noOriginal.push(pair);
      }
      return;
    }

    const originalUsed = usageData[pair.original.id];
    const migratedUsed = usageData[pair.migrated.id];
    const originalHasData = pair.original.issueCount > 0;
    const migratedHasData = pair.migrated.issueCount > 0;

    // Skip calculated fields: original count equals migrated count
    if (
      originalHasData &&
      migratedHasData &&
      pair.original.issueCount === pair.migrated.issueCount
    ) {
      noActionNeeded.push({
        ...pair,
        originalUsage: originalUsed || null,
        migratedUsage: migratedUsed || null,
        action: "CALCULATED_FIELD_NO_MERGE_NEEDED",
      });
      return;
    }

    // No data and no usage
    if (
      !originalUsed &&
      !migratedUsed &&
      !originalHasData &&
      !migratedHasData
    ) {
      notUsed.push(pair);
      return;
    }

    // Original is used in automation
    if (originalUsed) {
      if (!migratedHasData) {
        // Scenario 1: Original in automation, migrated has NO issues → DELETE migrated
        deleteOnly.push({
          ...pair,
          originalUsage: originalUsed,
          migratedUsage: migratedUsed || null,
          action: "DELETE_MIGRATED",
          timeEstimate: 0, // No merge needed, just delete
        });
      } else if (originalHasData) {
        // Scenario 2: Original in automation, BOTH have issues → Merge smaller to bigger
        const mergeSource =
          pair.original.issueCount <= pair.migrated.issueCount
            ? pair.original
            : pair.migrated;
        const mergeTarget =
          mergeSource === pair.original ? pair.migrated : pair.original;
        const issuesToMerge = mergeSource.issueCount;

        if (mergeSource === pair.original) {
          // Merge original → migrated
          mergeOriginalToMigrated.push({
            ...pair,
            originalUsage: originalUsed,
            migratedUsage: migratedUsed || null,
            action: "MERGE_ORIGINAL_TO_MIGRATED",
            issuesToMerge: issuesToMerge,
            timeEstimate: calculateTimeEstimate(issuesToMerge, 0), // No automation change needed
          });
        } else {
          // Merge migrated → original (keep original since it's in automation)
          mergeMigratedToOriginal.push({
            ...pair,
            originalUsage: originalUsed,
            migratedUsage: migratedUsed || null,
            action: "MERGE_MIGRATED_TO_ORIGINAL",
            issuesToMerge: issuesToMerge,
            timeEstimate: calculateTimeEstimate(issuesToMerge, 0), // No automation change needed
          });
        }
      } else {
        // Scenario 3: Original in automation, original has NO issues, migrated HAS issues
        // → Merge migrated → original + Update automation
        mergeMigratedToOriginal.push({
          ...pair,
          originalUsage: originalUsed,
          migratedUsage: migratedUsed || null,
          action: "MERGE_MIGRATED_TO_ORIGINAL_UPDATE_AUTOMATION",
          issuesToMerge: pair.migrated.issueCount,
          automationRulesToUpdate: originalUsed.rules,
          timeEstimate: calculateTimeEstimate(
            pair.migrated.issueCount,
            originalUsed.rules,
          ),
        });
      }
    } else {
      // Original NOT in automation
      if (originalHasData || migratedHasData) {
        // Has data but not in automation
        if (originalHasData && !migratedHasData) {
          // Original has data, migrated is empty, no automation usage
          // RECOMMENDATION: Delete migrated field, keep using original
          deleteOnly.push({
            ...pair,
            originalUsage: null,
            migratedUsage: migratedUsed || null,
            action: "DELETE_MIGRATED_KEEP_ORIGINAL",
            timeEstimate: 0,
          });
        } else if (!originalHasData && migratedHasData) {
          noActionNeeded.push({
            ...pair,
            originalUsage: null,
            migratedUsage: migratedUsed || null,
            action: "ALREADY_IN_MIGRATED",
          });
        } else if (originalHasData && migratedHasData) {
          // Both have data, merge smaller to bigger
          const mergeSource =
            pair.original.issueCount <= pair.migrated.issueCount
              ? pair.original
              : pair.migrated;

          if (mergeSource === pair.original) {
            mergeOriginalToMigrated.push({
              ...pair,
              originalUsage: null,
              migratedUsage: migratedUsed || null,
              action: "MERGE_ORIGINAL_TO_MIGRATED",
              issuesToMerge: pair.original.issueCount,
              timeEstimate: calculateTimeEstimate(pair.original.issueCount, 0),
            });
          } else {
            mergeMigratedToOriginal.push({
              ...pair,
              originalUsage: null,
              migratedUsage: migratedUsed || null,
              action: "MERGE_MIGRATED_TO_ORIGINAL",
              issuesToMerge: pair.migrated.issueCount,
              timeEstimate: calculateTimeEstimate(pair.migrated.issueCount, 0),
            });
          }
        }
      } else {
        noActionNeeded.push({
          ...pair,
          originalUsage: null,
          migratedUsage: migratedUsed || null,
          action: "NO_DATA",
        });
      }
    }
  });

  return {
    deleteOnly,
    mergeOriginalToMigrated,
    mergeMigratedToOriginal,
    noActionNeeded,
    alreadyMigrated,
    noOriginal,
    notUsed,
  };
}

// ============================================================================
// REPORT GENERATION
// ============================================================================

function formatProjectBreakdown(projects, total, sampleSize) {
  if (Object.keys(projects).length === 0) {
    return "No projects";
  }

  const sorted = Object.entries(projects).sort((a, b) => b[1] - a[1]);
  let result = "";

  sorted.forEach(([key, count]) => {
    result += `${key}: ${count} issues`;
    if (sampleSize < total) {
      result += " (from sample)";
    }
    result += ", ";
  });

  if (sampleSize < total) {
    result += `... (showing ${sampleSize} of ${total} total)`;
  } else {
    result = result.slice(0, -2); // Remove trailing comma
  }

  return result;
}

function formatTime(minutes) {
  if (minutes < 1) {
    return `${Math.round(minutes * 60)} seconds`;
  } else if (minutes < 60) {
    return `${Math.round(minutes)} minutes`;
  } else {
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    return `${hours}h ${mins}m`;
  }
}

function formatAutomationUsage(usageData) {
  if (!usageData || !usageData.ruleNames || usageData.ruleNames.length === 0) {
    return "";
  }

  let output = `   ⚠️  ORIGINAL in automations: ${usageData.rules} rules, ${usageData.occurrences} occurrences\n`;

  // Show up to 10 rule names, then indicate if there are more
  const displayLimit = 10;
  const ruleNames = usageData.ruleNames.slice(0, displayLimit);

  output += `      Automation Rules:\n`;
  ruleNames.forEach((ruleName, idx) => {
    output += `         ${idx + 1}. ${ruleName}\n`;
  });

  if (usageData.ruleNames.length > displayLimit) {
    output += `         ... and ${usageData.ruleNames.length - displayLimit} more rules\n`;
  }

  return output;
}

function generateReport(plan) {
  let report = "";

  report += "=".repeat(80) + "\n";
  report += "FIELD MIGRATION ANALYSIS - ENHANCED\n";
  report += "=".repeat(80) + "\n\n";

  report += `Generated: ${new Date().toISOString()}\n\n`;

  report += "IMPORTANT NOTES:\n";
  report += "-".repeat(80) + "\n";
  report +=
    "• Fields are matched by NAME AND TYPE - different types won't be paired\n";
  report +=
    "• Automation rule names are listed for fields used in automations\n";
  report +=
    "• Type mismatches require manual intervention and client decision\n\n";

  // Calculate total time estimates
  const totalDeleteTime = 0; // Instant
  const totalMergeOrigToMigTime = plan.mergeOriginalToMigrated.reduce(
    (sum, item) => sum + (item.timeEstimate || 0),
    0,
  );
  const totalMergeMigToOrigTime = plan.mergeMigratedToOriginal.reduce(
    (sum, item) => sum + (item.timeEstimate || 0),
    0,
  );
  const totalTime = totalMergeOrigToMigTime + totalMergeMigToOrigTime;

  // Summary
  report += "SUMMARY\n";
  report += "-".repeat(80) + "\n";
  report += `Delete migrated field only: ${plan.deleteOnly.length} fields\n`;
  report += `Merge original → migrated: ${plan.mergeOriginalToMigrated.length} fields (${formatTime(totalMergeOrigToMigTime)})\n`;
  report += `Merge migrated → original: ${plan.mergeMigratedToOriginal.length} fields (${formatTime(totalMergeMigToOrigTime)})\n`;
  report += `No action needed: ${plan.noActionNeeded.length} fields\n`;
  report += `Already migrated (no original): ${plan.alreadyMigrated.length} fields\n`;
  report += `No data/usage: ${plan.notUsed.length} fields\n`;
  report += `\nTOTAL ESTIMATED TIME: ${formatTime(totalTime)}\n\n`;

  // Category 1: DELETE MIGRATED FIELD ONLY
  if (plan.deleteOnly.length > 0) {
    report += "\n" + "=".repeat(80) + "\n";
    report += "🗑️  DELETE MIGRATED FIELD ONLY\n";
    report += "=".repeat(80) + "\n";
    report += "Migrated field is empty and should be deleted.\n";
    report += "Keep using the original field.\n\n";

    plan.deleteOnly
      .sort(
        (a, b) => (b.originalUsage?.rules || 0) - (a.originalUsage?.rules || 0),
      )
      .forEach((item, idx) => {
        report += `${idx + 1}. ${item.baseName}\n`;
        report += `   ${"─".repeat(76)}\n`;
        report += `   Original: ${item.original.id} (${item.original.name}) [Type: ${item.original.type}]\n`;
        report += `   Migrated: ${item.migrated.id} (${item.migrated.name}) [Type: ${item.migrated.type}]\n\n`;

        if (item.originalUsage) {
          report += formatAutomationUsage(item.originalUsage);
          report += `   Reason: Original is used in automations, migrated is empty\n`;
        } else {
          report += `   Reason: Original has data, migrated is empty, no automation usage\n`;
        }

        report += `   Original field data: ${item.original.issueCount || 0} issues\n`;
        if (item.original.issueCount > 0) {
          report += `      Projects: ${formatProjectBreakdown(item.original.projects, item.original.issueCount, item.original.sampleSize)}\n`;
        }
        report += `   Migrated field data: 0 issues\n\n`;

        report += `   ✅ ACTION: Delete migrated field (${item.migrated.id}), keep original\n`;
        report += `   ⏱️  Time: Instant\n\n`;
      });
  }

  // Category 2: MERGE ORIGINAL → MIGRATED
  if (plan.mergeOriginalToMigrated.length > 0) {
    report += "\n" + "=".repeat(80) + "\n";
    report += "📥 MERGE ORIGINAL → MIGRATED\n";
    report += "=".repeat(80) + "\n";
    report += "Merge data from original to migrated field.\n";
    report += "Original field used in automations will continue working.\n\n";

    plan.mergeOriginalToMigrated
      .sort((a, b) => (b.timeEstimate || 0) - (a.timeEstimate || 0))
      .forEach((item, idx) => {
        report += `${idx + 1}. ${item.baseName}\n`;
        report += `   ${"─".repeat(76)}\n`;
        report += `   Original: ${item.original.id} (${item.original.name}) [Type: ${item.original.type}]\n`;
        report += `   Migrated: ${item.migrated.id} (${item.migrated.name}) [Type: ${item.migrated.type}]\n\n`;

        if (item.originalUsage) {
          report += formatAutomationUsage(item.originalUsage);
        }

        report += `   Original field data: ${item.original.issueCount || 0} issues\n`;
        if (item.original.issueCount > 0) {
          report += `      Projects: ${formatProjectBreakdown(item.original.projects, item.original.issueCount, item.original.sampleSize)}\n`;
        }

        report += `   Migrated field data: ${item.migrated.issueCount || 0} issues\n`;
        if (item.migrated.issueCount > 0) {
          report += `      Projects: ${formatProjectBreakdown(item.migrated.projects, item.migrated.issueCount, item.migrated.sampleSize)}\n`;
        }

        report += `\n   ✅ ACTION: Merge ${item.issuesToMerge} issues from original → migrated\n`;
        report += `   ⏱️  Time: ${formatTime(item.timeEstimate)}\n\n`;
      });
  }

  // Category 3: MERGE MIGRATED → ORIGINAL (may include automation updates)
  if (plan.mergeMigratedToOriginal.length > 0) {
    report += "\n" + "=".repeat(80) + "\n";
    report += "📤 MERGE MIGRATED → ORIGINAL\n";
    report += "=".repeat(80) + "\n";
    report += "Merge data from migrated to original field.\n";
    report +=
      "May require automation updates if original is used in automation.\n\n";

    plan.mergeMigratedToOriginal
      .sort((a, b) => (b.timeEstimate || 0) - (a.timeEstimate || 0))
      .forEach((item, idx) => {
        report += `${idx + 1}. ${item.baseName}\n`;
        report += `   ${"─".repeat(76)}\n`;
        report += `   Original: ${item.original.id} (${item.original.name}) [Type: ${item.original.type}]\n`;
        report += `   Migrated: ${item.migrated.id} (${item.migrated.name}) [Type: ${item.migrated.type}]\n\n`;

        if (item.originalUsage) {
          report += formatAutomationUsage(item.originalUsage);
        }

        report += `   Original field data: ${item.original.issueCount || 0} issues\n`;
        if (item.original.issueCount > 0) {
          report += `      Projects: ${formatProjectBreakdown(item.original.projects, item.original.issueCount, item.original.sampleSize)}\n`;
        }

        report += `   Migrated field data: ${item.migrated.issueCount || 0} issues\n`;
        if (item.migrated.issueCount > 0) {
          report += `      Projects: ${formatProjectBreakdown(item.migrated.projects, item.migrated.issueCount, item.migrated.sampleSize)}\n`;
        }

        report += `\n   ✅ ACTION: Merge ${item.issuesToMerge} issues from migrated → original\n`;

        if (item.automationRulesToUpdate) {
          report += `   🔧 UPDATE AUTOMATION: ${item.automationRulesToUpdate} rules need updating\n`;
        }

        report += `   ⏱️  Time: ${formatTime(item.timeEstimate)}`;

        if (item.automationRulesToUpdate) {
          const mergeTime = calculateTimeEstimate(item.issuesToMerge, 0);
          const autoTime = item.timeEstimate - mergeTime;
          report += ` (${formatTime(mergeTime)} merge + ${formatTime(autoTime)} automation)\n`;
        } else {
          report += `\n`;
        }

        report += `\n`;
      });
  }

  // Category 4: NO ACTION NEEDED
  if (plan.noActionNeeded.length > 0) {
    report += "\n" + "=".repeat(80) + "\n";
    report += "✅ NO ACTION NEEDED\n";
    report += "=".repeat(80) + "\n";
    report += "These fields are already in the correct state.\n\n";

    plan.noActionNeeded.forEach((item, idx) => {
      report += `${idx + 1}. ${item.baseName}\n`;
      report += `   Original: ${item.original.id} - ${item.original.issueCount || 0} issues\n`;
      report += `   Migrated: ${item.migrated.id} - ${item.migrated.issueCount || 0} issues\n`;
      report += `   Status: ${item.action}\n\n`;
    });
  }

  // Already migrated
  if (plan.alreadyMigrated.length > 0) {
    report += "\n" + "=".repeat(80) + "\n";
    report += "✅ ALREADY MIGRATED (Verify Only)\n";
    report += "=".repeat(80) + "\n";
    report +=
      "These migrated fields are in use but no original version found.\n\n";

    plan.alreadyMigrated.forEach((item, idx) => {
      report += `${idx + 1}. ${item.baseName}\n`;
      report += `   Migrated: ${item.migrated.id} (${item.migrated.name})\n`;
      if (item.migratedUsage) {
        report += `   Automation usage: ${item.migratedUsage.rules} rules, ${item.migratedUsage.occurrences} occurrences\n`;
      }
      report += `   Issues: ${item.migrated.issueCount || 0}\n`;
      if (item.migrated.issueCount > 0) {
        report += `   Projects: ${formatProjectBreakdown(item.migrated.projects, item.migrated.issueCount, item.migrated.sampleSize)}\n`;
      }
      report += `   Action: No merge needed - verify data integrity\n\n`;
    });
  }

  // Not used
  if (plan.notUsed.length > 0) {
    report += "\n" + "=".repeat(80) + "\n";
    report += "⚪ NO DATA / NO USAGE\n";
    report += "=".repeat(80) + "\n";
    report += "These field pairs have no data and aren't used anywhere.\n\n";

    plan.notUsed.forEach((item, idx) => {
      report += `${idx + 1}. ${item.baseName} - Original: ${item.original.id}, Migrated: ${item.migrated.id}\n`;
    });
    report += `\n`;
  }

  // No original
  if (plan.noOriginal.length > 0) {
    report += "\n" + "=".repeat(80) + "\n";
    report += "ℹ️  MIGRATED FIELDS WITHOUT ORIGINAL\n";
    report += "=".repeat(80) + "\n\n";

    plan.noOriginal.forEach((item, idx) => {
      report += `${idx + 1}. ${item.baseName} - ${item.migrated.id}\n`;
    });
  }

  return report;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("Field Migration Target Identifier - Enhanced");
  console.log("=".repeat(80) + "\n");

  // Parse arguments
  const args = process.argv.slice(2);
  let email, apiToken, siteUrl;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--email") email = args[++i];
    else if (args[i] === "--token") apiToken = args[++i];
    else if (args[i] === "--site-url")
      siteUrl = args[++i].replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  if (!email || !apiToken || !siteUrl) {
    console.error("ERROR: Missing required arguments");
    console.error("\nUsage:");
    console.error("  node identify_migration_targets.js \\");
    console.error("    --email your-email@company.com \\");
    console.error("    --token your-api-token \\");
    console.error("    --site-url yourcompany.atlassian.net\n");
    process.exit(1);
  }

  try {
    // Step 1: Fetch all custom fields from Jira
    const allFields = await fetchAllCustomFields(email, apiToken, siteUrl);

    // Step 2: Build field mapping (ID -> Name) for ALL custom fields
    console.log("Building field mapping...");
    const fieldMapping = {};

    allFields.forEach((field) => {
      fieldMapping[field.id] = field.name;
    });
    console.log(`Mapped ${Object.keys(fieldMapping).length} custom fields`);

    // Step 3: Find field pairs (original + migrated)
    console.log("Analyzing field pairs...");

    // Safety check: ensure all fields are custom and safe before processing
    const safeFieldsForPairing = allFields.filter(isSafeField);

    console.log(
      `Safety filtered ${allFields.length} to ${safeFieldsForPairing.length} safe fields`,
    );

    const pairs = findFieldPairs(safeFieldsForPairing);
    console.log(`Found ${pairs.length} field pairs after safety filtering\n`);

    // Step 4: Parse automation rules directly
    console.log("Analyzing automation rules...");
    const usageData = parseAutomationRules(fieldMapping);
    console.log(
      `Loaded usage data for ${Object.keys(usageData).length} fields\n`,
    );

    // Step 5: Query issue data for each field
    await enrichPairsWithIssueData(pairs, email, apiToken, siteUrl);

    // Step 6: Generate migration plan
    console.log("Generating migration plan...\n");
    const plan = generateMigrationPlan(pairs, usageData);

    // Step 7: Generate report
    const report = generateReport(plan);

    // Output to console
    console.log(report);

    // Save to file
    const reportPath = path.join(
      __dirname,
      "reports",
      "migration_plan_" + new Date().toISOString().split("T")[0] + ".txt",
    );

    fs.writeFileSync(reportPath, report, "utf8");
    console.log(`\nReport saved to: ${reportPath}`);

    // Also save field pairs as JSON for reference
    const pairsPath = path.join(__dirname, "config", "field_pairs.json");
    fs.writeFileSync(pairsPath, JSON.stringify(pairs, null, 2), "utf8");
    console.log(`Field pairs saved to: ${pairsPath}`);
  } catch (error) {
    console.error(`\nFatal error: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
