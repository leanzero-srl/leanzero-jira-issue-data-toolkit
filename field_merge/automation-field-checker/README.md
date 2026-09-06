# Automation Field Checker

Check which custom fields are being used in Jira automation rules.

## Directory Structure

```
automation-field-checker/
├── check_fields_in_automation.js    # Main script
├── automation_rules.json            # Symlink to automation rules file
├── config/
│   └── manual_field_mappings.json   # Field ID → Name mappings
├── reports/
│   └── field_usage_report_*.txt     # Generated reports (timestamped)
├── utils/
│   └── extract_field_mapping.js     # Helper to extract field references
└── docs/
    └── README.md                     # Detailed documentation
```

## Quick Start

```bash
cd field-merge-script/automation-field-checker

# RECOMMENDED: Fetch field names from Jira API (most accurate)
node check_fields_in_automation.js \
  --email your-email@company.com \
  --token your-api-token \
  --site-url yourcompany.atlassian.net

# Fallback: Use manual mapping file (if API not available)
node check_fields_in_automation.js --mapping-file manual_field_mappings.json

# Not recommended: ID-only search (misses fields referenced by name)
node check_fields_in_automation.js
```

## What It Does

Searches for custom field usage in automation rules by checking:
- ✅ Field IDs (e.g., `customfield_13207`)
- ✅ Field Names (e.g., `"Health Status"`)
- ✅ Smart values (e.g., `{{issue.customfield_13207}}`)

**Why both?** Jira automations can reference fields by either ID or name. Searching by ID only misses 80%+ of actual usage!

## Configuration

### Edit Fields to Check

Edit `check_fields_in_automation.js` and modify the `CUSTOM_FIELDS` array:

```javascript
const CUSTOM_FIELDS = [
  "customfield_10001",
  "customfield_10002",
  // Add your fields here
];
```

### Update Field Mappings (Optional)

The script fetches field names automatically from Jira API when you provide credentials.

If you need to run offline, you can create a manual mapping file in `config/manual_field_mappings.json`:

```json
{
  "customfield_13207": "Health Status",
  "customfield_13178": "Target Implementation Date"
}
```

**Important:** Field names must match EXACTLY (case-sensitive, no "(migrated)" suffix).

**Note:** Manual mapping file is now optional - using Jira API is recommended for accuracy.

## Output

Reports are saved to `reports/field_usage_report_YYYY-MM-DD.txt` with:
- Summary of used vs unused fields
- Detailed list of automation rules using each field
- Exact locations and context of each reference

## Use Cases

- ✅ Check which fields are safe to delete/archive
- ✅ Impact analysis before field changes
- ✅ Migration planning
- ✅ Audit field usage across automations

## Full Documentation

See `docs/README.md` for:
- Detailed usage examples
- API integration guide
- Troubleshooting
- Advanced features

## Current Results (48 fields checked)

- **9 fields in use** across 172 automation rules
- **39 fields not used** (safe to modify)
- Top used field: **Health Status** (32 occurrences in 7 rules)

See latest report in `reports/` directory.
