# Enhanced Custom Field Usage Checker - SOLUTION

## The Problem We Solved

The original script (`check_fields_in_automation.js`) only searched for custom field **IDs** like `customfield_13207`. However, Jira automation rules often reference fields by their **NAME** instead of ID. For example:

```json
{
  "field": {
    "type": "NAME",
    "value": "Health Status"
  }
}
```

This meant fields like "Health Status" (customfield_13207) were showing as "NOT USED" even though they were actually used in multiple automation rules.

## The Solution

The enhanced version (`check_fields_in_automation_v2.js`) searches for fields using **BOTH** their ID and their name, giving you complete coverage.

## Quick Start

### Option 1: Use the Manual Mapping File (Recommended for Your Setup)

We've already created a mapping file for your migrated fields:

```bash
node check_fields_in_automation_v2.js --mapping-file manual_field_mappings.json
```

### Option 2: Fetch Field Names from Jira API (Most Accurate)

```bash
node check_fields_in_automation_v2.js \
  --email your-email@company.com \
  --token your-api-token \
  --site-url yourcompany.atlassian.net
```

### Option 3: ID-Only Search (Limited Coverage)

```bash
node check_fields_in_automation_v2.js
```

**Note:** This will miss fields referenced by name only.

## Results Summary

With the enhanced script and field name mapping, we found:

### ✅ **9 Fields ARE in Use:**

1. **customfield_10728** - 1 rule, 1 occurrence
2. **customfield_13316** - 1 rule, 1 occurrence  
3. **customfield_13152 (Domain)** - 2 rules, 11 occurrences
4. **customfield_13224 (Effort)** - 1 rule, 2 occurrences
5. **customfield_13378 (Email Address)** - 1 rule, 1 occurrence
6. **customfield_13466 (Last Comment)** - 5 rules, 5 occurrences
7. **customfield_13207 (Health Status)** - 7 rules, 32 occurrences ⭐
8. **customfield_13182 (Reach)** - 1 rule, 2 occurrences
9. **customfield_13178 (Target Implementation Date)** - 6 rules, 6 occurrences

### ✗ **39 Fields are NOT in Use**

All other fields from your list are safe from an automation perspective.

## Key Findings

- **Health Status** is heavily used (32 occurrences across 7 automation rules!)
- **Domain** is used in 2 rules with 11 total references
- **Target Implementation Date** is used in 6 different rules
- **Last Comment** is referenced in 5 automation rules

## Files in This Directory

- `check_fields_in_automation_v2.js` - Enhanced script with field name search
- `check_fields_in_automation.js` - Original script (ID-only search)
- `manual_field_mappings.json` - Pre-built field ID to name mapping
- `field_usage_report_2025-11-18.txt` - Full detailed report
- `automation_rules.json` - Symlink to your automation rules file

## How Field Name Mapping Works

The manual mapping file contains:

```json
{
  "customfield_13207": "Health Status",
  "customfield_13178": "Target Implementation Date",
  ...
}
```

The script then searches for:
1. The field ID: `customfield_13207`
2. The field name: `Health Status`
3. Smart values: `{{issue.customfield_13207}}`

This ensures complete coverage regardless of how the field is referenced.

## Updating the Field List

To check different fields, edit the `CUSTOM_FIELDS` array in `check_fields_in_automation_v2.js`:

```javascript
const CUSTOM_FIELDS = [
  "customfield_12345",
  "customfield_67890",
  // Add more...
];
```

## Adding More Field Mappings

To add more field name mappings, edit `manual_field_mappings.json`:

```json
{
  "customfield_12345": "My Custom Field Name",
  "customfield_67890": "Another Field"
}
```

**Important:** The field name must match EXACTLY as it appears in the automation rules (case-sensitive, no extra spaces).

## Fetching Field Mappings from Jira

For the most accurate results, fetch field data directly from Jira:

```bash
node check_fields_in_automation_v2.js \
  --email your-email@company.com \
  --token your-api-token \
  --site-url yourcompany.atlassian.net
```

This will:
1. Connect to your Jira instance via REST API
2. Fetch all custom field definitions
3. Build a complete ID→Name mapping
4. Search using both IDs and names

## Understanding the Report

### Summary Section
Shows quick stats:
- Total fields checked
- How many are in use vs not in use
- Whether field name mapping is enabled

### Detailed Reports
For each field found, you'll see:
- The automation rule name and ID
- Whether the rule is ENABLED or DISABLED
- Exact locations where the field appears
- The context (is it in a trigger, action, or condition?)

Example:
```
Field: customfield_13207 (Health Status)
✓ USED - Found in 7 automation rule(s)

1. Rule: "Health Status [Claims - Scheduled]"
   ID: 26493838
   State: ENABLED
   Occurrences: 5
   1) Location: components[0].children[0].children[0].value.operations[0].field.value
      Type: field_name_value
      Value: Health Status
```

## Performance

- Processes 172 automation rules in seconds
- Checks 48 custom fields across all rules
- No API calls needed (when using mapping file)
- Generates comprehensive report automatically

## Best Practices

1. **Always use field name mapping** for accurate results
2. **Run before deleting or modifying fields** to avoid breaking automations
3. **Check both ENABLED and DISABLED rules** (the script checks both)
4. **Review the detailed report** not just the summary
5. **Keep the report file** for documentation and audit purposes

## Troubleshooting

### "Field showing as not used but I know it is used"

Make sure:
1. The field name in the mapping file matches EXACTLY
2. Remove any "(migrated)" suffixes - use the actual field name
3. Try fetching from Jira API to get the exact names

### "Cannot find automation_rules.json"

The file should be in the same directory as the script. Create a symlink:
```bash
ln -s /path/to/your/automation_rules.json automation_rules.json
```

### "Field name mapping: DISABLED"

This means you ran without `--mapping-file` or Jira credentials. The script will only search by field ID, which will miss many references.

## Next Steps

1. ✅ Review the full report: `field_usage_report_2025-11-18.txt`
2. ✅ Identify which fields are safe to modify/remove
3. ✅ Document the automation rules that use critical fields
4. ✅ Plan your field migration accordingly

## Support

If you need to check additional fields or create new mappings, simply:
1. Update the `CUSTOM_FIELDS` array in the script
2. Add entries to `manual_field_mappings.json` if needed
3. Run the script again

The report file is timestamped, so you won't overwrite previous runs.
