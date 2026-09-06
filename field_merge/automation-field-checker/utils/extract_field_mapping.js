#!/usr/bin/env node

/**
 * Extract Field Mapping from Automation Rules
 *
 * This script analyzes the automation_rules.json file and attempts to extract
 * field ID to field name mappings by looking at field references in the rules.
 *
 * Usage:
 *   node extract_field_mapping.js
 *
 * Output:
 *   Creates field_mappings.json with the extracted mappings
 */

const fs = require("fs");
const path = require("path");

const AUTOMATION_RULES_FILE = path.join(
  __dirname,
  "..",
  "automation_rules.json",
);
const OUTPUT_FILE = path.join(__dirname, "..", "config", "field_mappings.json");

function extractFieldMappings(obj, mappings = {}) {
  if (obj === null || obj === undefined) {
    return mappings;
  }

  // Check if this is a field object with fieldType and ID/name
  if (typeof obj === "object" && !Array.isArray(obj)) {
    // Pattern 1: sourceField with fieldType
    if (
      obj.sourceField &&
      obj.sourceField.type === "NAME" &&
      obj.sourceField.value &&
      obj.sourceField.fieldType
    ) {
      const fieldType = obj.sourceField.fieldType;
      const fieldName = obj.sourceField.value;

      // Try to find the ID in smart values or other references
      // This pattern doesn't directly give us the ID, but we can note the field name
      // We'll use another pattern to get IDs
    }

    // Pattern 2: field object with type NAME and fieldType
    if (
      obj.field &&
      obj.field.type === "NAME" &&
      obj.field.value &&
      obj.fieldType
    ) {
      const fieldName = obj.field.value;
      // Store potential field names for later ID matching
      if (!mappings._fieldNames) {
        mappings._fieldNames = new Set();
      }
      mappings._fieldNames.add(fieldName);
    }

    // Pattern 3: Smart values containing customfield IDs
    if (typeof obj === "object") {
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === "string") {
          // Look for smart value patterns like {{issue.customfield_12345}}
          const smartValueMatch = value.match(
            /\{\{issue\.(customfield_\d+)(?:\.(\w+))?\}\}/g,
          );
          if (smartValueMatch) {
            smartValueMatch.forEach((match) => {
              const fieldIdMatch = match.match(/customfield_\d+/);
              if (fieldIdMatch) {
                const fieldId = fieldIdMatch[0];
                // Store for later - we found a field ID but need to find its name
                if (!mappings._fieldIds) {
                  mappings._fieldIds = new Set();
                }
                mappings._fieldIds.add(fieldId);
              }
            });
          }
        }
      }
    }

    // Recursively search nested objects
    for (const value of Object.values(obj)) {
      extractFieldMappings(value, mappings);
    }
  } else if (Array.isArray(obj)) {
    // Recursively search array elements
    obj.forEach((item) => extractFieldMappings(item, mappings));
  }

  return mappings;
}

/**
 * More advanced extraction that looks for field operations
 */
function extractFromOperations(rules) {
  const mappings = {};

  rules.forEach((rule) => {
    // Look through all components for field operations
    if (rule.components && Array.isArray(rule.components)) {
      rule.components.forEach((component) => {
        extractFromComponent(component, mappings);
      });
    }

    // Check trigger for field references
    if (rule.trigger) {
      extractFromTrigger(rule.trigger, mappings);
    }
  });

  return mappings;
}

function extractFromComponent(component, mappings) {
  // Recursively search component and children
  if (component.children && Array.isArray(component.children)) {
    component.children.forEach((child) =>
      extractFromComponent(child, mappings),
    );
  }

  // Look for field operations
  if (
    component.value &&
    component.value.operations &&
    Array.isArray(component.value.operations)
  ) {
    component.value.operations.forEach((op) => {
      if (
        op.field &&
        op.field.type === "NAME" &&
        op.field.value &&
        op.fieldType
      ) {
        // We have a field name and field type, but not the ID
        // Store it for reference
        const fieldName = op.field.value;
        if (!mappings._namedFields) {
          mappings._namedFields = {};
        }
        if (!mappings._namedFields[fieldName]) {
          mappings._namedFields[fieldName] = op.fieldType;
        }
      }

      // Check if the operation value contains customfield references
      if (op.value && typeof op.value === "string") {
        const customFieldMatches = op.value.match(/customfield_\d+/g);
        if (customFieldMatches) {
          customFieldMatches.forEach((fieldId) => {
            if (!mappings._foundFieldIds) {
              mappings._foundFieldIds = new Set();
            }
            mappings._foundFieldIds.add(fieldId);
          });
        }
      }
    });
  }

  // Look in conditions
  if (component.conditions && Array.isArray(component.conditions)) {
    component.conditions.forEach((condition) => {
      extractFromComponent(condition, mappings);
    });
  }
}

function extractFromTrigger(trigger, mappings) {
  // Look for field changed triggers
  if (
    trigger.value &&
    trigger.value.fields &&
    Array.isArray(trigger.value.fields)
  ) {
    trigger.value.fields.forEach((field) => {
      if (field.type === "fieldName" && field.value) {
        const fieldName = field.value;
        if (!mappings._namedFields) {
          mappings._namedFields = {};
        }
        if (!mappings._namedFields[fieldName]) {
          mappings._namedFields[fieldName] = "trigger_field";
        }
      }
    });
  }

  if (trigger.children && Array.isArray(trigger.children)) {
    trigger.children.forEach((child) => extractFromComponent(child, mappings));
  }
}

function main() {
  console.log("Extracting Field Mappings from Automation Rules");
  console.log("=".repeat(80));

  // Check if file exists
  if (!fs.existsSync(AUTOMATION_RULES_FILE)) {
    console.error(
      `ERROR: automation_rules.json not found at ${AUTOMATION_RULES_FILE}`,
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

  // Extract mappings
  console.log("Extracting field references...");
  const mappings = extractFromOperations(automationData.rules);

  const fieldNames = mappings._namedFields || {};
  const fieldIds = mappings._foundFieldIds
    ? Array.from(mappings._foundFieldIds)
    : [];

  console.log(`\nFound ${Object.keys(fieldNames).length} unique field names`);
  console.log(`Found ${fieldIds.length} unique field IDs\n`);

  console.log(
    "NOTE: This extraction shows field names and IDs found separately.",
  );
  console.log(
    "To create a complete mapping, you need to fetch field data from Jira API.",
  );
  console.log("Run the enhanced script with Jira credentials:\n");
  console.log("  node check_fields_in_automation_v2.js \\");
  console.log("    --email your-email@company.com \\");
  console.log("    --token your-api-token \\");
  console.log("    --site-url yourcompany.atlassian.net\n");

  // Save what we found
  const output = {
    note: "Extracted from automation rules. For complete ID->Name mapping, use Jira API.",
    fieldNamesFound: Object.keys(fieldNames).sort(),
    fieldIdsFound: fieldIds.sort(),
    fieldNameDetails: fieldNames,
  };

  try {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");
    console.log(`Extracted data saved to: ${OUTPUT_FILE}\n`);
  } catch (error) {
    console.error(`Error saving output: ${error.message}`);
  }

  console.log("Field Names Found:");
  console.log("-".repeat(80));
  Object.keys(fieldNames)
    .sort()
    .slice(0, 20)
    .forEach((name) => {
      console.log(`  - ${name}`);
    });
  if (Object.keys(fieldNames).length > 20) {
    console.log(`  ... and ${Object.keys(fieldNames).length - 20} more`);
  }

  console.log("\nField IDs Found:");
  console.log("-".repeat(80));
  fieldIds
    .sort()
    .slice(0, 20)
    .forEach((id) => {
      console.log(`  - ${id}`);
    });
  if (fieldIds.length > 20) {
    console.log(`  ... and ${fieldIds.length - 20} more`);
  }
}

main();
