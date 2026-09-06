# Jira Field Scripts

A collection of powerful Node.js scripts for managing Jira custom fields, automations, and data migrations.

## 📚 Additional Resources

- **[Installation Guide](docs/installation.md)** - Detailed setup and dependency management
- **[Configuration Examples](examples/config-examples.js)** - Ready-to-use migration patterns  
- **[Environment Variables](.env.example)** - Secure credential management example
- **[Package Dependencies](package.json)** - Node.js package specifications


## Tools in This Directory

### 🔍 [automation-field-checker/](./automation-field-checker/)
**Check which custom fields are used in automation rules**

Essential before deleting or modifying fields! Searches automation rules for field references by both ID and name.
- ✅ Searches by field ID AND field name (catches 100% of usage)
- ✅ Works with local JSON files (no API calls needed)
- ✅ Detailed reports showing exact automation rules and locations
- ✅ Currently configured with 48 fields from your migration

[See automation-field-checker/README.md](./automation-field-checker/README.md)

### 📋 Field Data Merger Scripts

A powerful Node.js script to copy/merge field data between fields in Jira Cloud. Supports both same-instance field migrations and cross-instance data transfers.

## Features

- ✅ **Same-Instance Field Migration**: Copy data from one field to another within the same Jira instance
- ✅ **Cross-Instance Merging**: Transfer field data between different Jira instances
- ✅ **Flexible Filtering**: Use JQL, project keys, or specific issue keys
- ✅ **Smart Overwrite Control**: Choose whether to overwrite existing values
- ✅ **Empty Value Handling**: Option to skip empty source values
- ✅ **Batch Processing**: Process issues in configurable batch sizes
- ✅ **Dry Run Mode**: Preview changes without modifying data
- ✅ **Rate Limiting**: Built-in exponential backoff for API rate limits
- ✅ **Comprehensive Statistics**: Detailed progress tracking and reporting
- ✅ **Error Recovery**: Continues processing even if individual issues fail

## Use Cases

- **Field Consolidation**: Merge data from deprecated fields to new fields
- **Custom Field Migration**: Move data between custom fields during field cleanup
- **Instance Migration**: Transfer field data when migrating between Jira instances
- **Data Backup**: Copy field data to backup fields before making changes
- **Field Standardization**: Consolidate multiple fields into a single standardized field
- **Data Cleanup**: Copy clean data while filtering out problematic issues

## Prerequisites

- Node.js (v14 or higher)
- Jira Cloud instance(s)
- Jira API token(s) ([Generate here](https://id.atlassian.com/manage-profile/security/api-tokens))
- **Edit Issues** permission for target issues

## Installation

### Quick Setup
```bash
cd jira/jira-data/field-merge-script
npm install commander
```

### For Detailed Instructions
See: **[Installation Guide](docs/installation.md)**

**Required Dependencies:**
- `commander ^11.0.0` - Command-line argument parsing

### Dependencies

This script requires the `commander` package for command-line argument parsing:

```bash
npm install commander
```

 or using yarn:
```bash
yarn add commander
```

## Finding Custom Field IDs

Custom fields in Jira have IDs like `customfield_10001`.

### Method 1: Via Issue View
1. Open any issue in Jira
2. Right-click and "Inspect Element" on the custom field
3. Look for `customfield_XXXXX` in the HTML

### Method 2: Via API
```bash
curl -u email@example.com:your-api-token \
  https://your-instance.atlassian.net/rest/api/3/field | jq
```

This returns all fields with their IDs.

### Method 3: Via Field Configuration
1. Go to **Jira Settings** > **Issues** > **Fields**
2. Click on the custom field
3. The ID is shown in the URL or field details

## Usage

### Same-Instance Field Migration

Copy data from one field to another within the same Jira instance:

```bash
node merge_field_data.js \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --source-field customfield_10001 \
  --target-field customfield_10002
```

### Cross-Instance Migration

Transfer field data between different Jira instances:

```bash
node merge_field_data.js \
  --source-url https://source-instance.atlassian.net \
  --target-url https://target-instance.atlassian.net \
  --source-email user@source.com \
  --target-email user@target.com \
  --source-token source-api-token \
  --target-token target-api-token \
  --source-field customfield_10001 \
  --target-field customfield_10002
```

### Filter by Project

Process only issues from a specific project:

```bash
node merge_field_data.js \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --source-field customfield_10001 \
  --target-field customfield_10002 \
  --project-key DEMO
```

### Filter by Issue Keys

Process only specific issues:

```bash
node merge_field_data.js \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --source-field customfield_10001 \
  --target-field customfield_10002 \
  --issue-keys "DEMO-1,DEMO-2,DEMO-3"
```

### Custom JQL Query

Use advanced JQL filtering:

```bash
node merge_field_data.js \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --source-field customfield_10001 \
  --target-field customfield_10002 \
  --jql "project = DEMO AND status = Done AND created >= -30d"
```

### Overwrite Existing Values

By default, the script skips issues where the target field already has a value. To overwrite:

```bash
node merge_field_data.js \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --source-field customfield_10001 \
  --target-field customfield_10002 \
  --overwrite-existing
```

### Include Empty Values

By default, issues with empty source fields are skipped. To include them:

```bash
node merge_field_data.js \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --source-field customfield_10001 \
  --target-field customfield_10002 \
  --no-skip-empty
```

### Dry Run Mode

Preview what would be changed without making modifications:

```bash
node merge_field_data.js \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --source-field customfield_10001 \
  --target-field customfield_10002 \
  --dry-run
```

### Batch Size

Adjust the number of issues processed per batch (default: 50):

```bash
node merge_field_data.js \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --source-field customfield_10001 \
  --target-field customfield_10002 \
  --batch-size 100
```

## Command Line Options

### Authentication Options

| Option | Required | Description |
|--------|----------|-------------|
| `--url` | Conditional* | Jira instance URL (for same-instance merges) |
| `--source-url` | Conditional* | Source Jira instance URL (for cross-instance) |
| `--target-url` | Conditional* | Target Jira instance URL (for cross-instance) |
| `--email` | Conditional* | Email for authentication (single token) |
| `--source-email` | Conditional* | Source instance email (cross-instance) |
| `--target-email` | Conditional* | Target instance email (cross-instance) |
| `--token` | Conditional* | API token (single token, raw format) |
| `--source-token` | Conditional* | Source instance API token |
| `--target-token` | Conditional* | Target instance API token |

*Use either (`--url`, `--email`, `--token`) OR (`--source-url`, `--target-url`, `--source-email`, `--target-email`, `--source-token`, `--target-token`)

### Field Options

| Option | Required | Description |
|--------|----------|-------------|
| `--source-field` | Yes | Source field ID (e.g., `customfield_10001`) |
| `--target-field` | Yes | Target field ID (e.g., `customfield_10002`) |

### Filtering Options

| Option | Required | Description |
|--------|----------|-------------|
| `--jql` | No | Custom JQL query to filter issues |
| `--project-key` | No | Process only issues from specific project |
| `--issue-keys` | No | Comma-separated list of issue keys |

### Processing Options

| Option | Required | Description |
|--------|----------|-------------|
| `--batch-size` | No | Number of issues per batch (default: 50) |
| `--overwrite-existing` | No | Overwrite existing target field values |
| `--no-skip-empty` | No | Process issues with empty source values |
| `--dry-run` | No | Preview changes without making modifications |

## Output

### Console Output

```
🔄 JIRA FIELD DATA MERGER
=====================================
📂 Source Field: customfield_10001
📂 Target Field: customfield_10002
🌐 Instance: your-instance.atlassian.net
🔍 DRY RUN MODE: No changes will be made

🔍 Searching for issues...
✅ Found 150 issues to process

📊 Processing issues...

✅ [1/150] DEMO-123: Updated
   Source: "Old Value"
   Target: "New Value"

⏭️  [2/150] DEMO-124: Skipped (target field already has value)

⏭️  [3/150] DEMO-125: Skipped (empty source value)

❌  [4/150] DEMO-126: Failed - Permission denied (HTTP 403)

📊 SUMMARY
=====================================
Total Issues Found: 150
Processed Issues: 150
Successful Updates: 75
Skipped (Already Has Value): 50
Skipped (Empty Source): 25
Failed Updates: 1

⏱️  Total Time: 45.3 seconds
📝 Success Rate: 50.0%

✅ Script completed successfully!
```

### Status Indicators

- `✅` - Successfully updated
- `⏭️` - Skipped (various reasons)
- `❌` - Failed to update
- `🔍` - Dry run mode

## Common Workflows

### Workflow 1: Safe Field Migration

```bash
# Step 1: Test with a single issue
node merge_field_data.js \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --source-field customfield_10001 \
  --target-field customfield_10002 \
  --issue-keys "DEMO-1" \
  --dry-run

# Step 2: Test with a project (dry run)
node merge_field_data.js \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --source-field customfield_10001 \
  --target-field customfield_10002 \
  --project-key DEMO \
  --dry-run

# Step 3: Execute for the project
node merge_field_data.js \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --source-field customfield_10001 \
  --target-field customfield_10002 \
  --project-key DEMO

# Step 4: Process all remaining projects
node merge_field_data.js \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --source-field customfield_10001 \
  --target-field customfield_10002
```

### Workflow 2: Cross-Instance Data Transfer

```bash
# Step 1: Test with dry run
node merge_field_data.js \
  --source-url https://old-instance.atlassian.net \
  --target-url https://new-instance.atlassian.net \
  --source-email user@old.com \
  --target-email user@new.com \
  --source-token old-token \
  --target-token new-token \
  --source-field customfield_10001 \
  --target-field customfield_10002 \
  --project-key DEMO \
  --dry-run

# Step 2: Execute transfer
node merge_field_data.js \
  --source-url https://old-instance.atlassian.net \
  --target-url https://new-instance.atlassian.net \
  --source-email user@old.com \
  --target-email user@new.com \
  --source-token old-token \
  --target-token new-token \
  --source-field customfield_10001 \
  --target-field customfield_10002 \
  --project-key DEMO
```

### Workflow 3: Selective Merge with JQL

```bash
# Merge only for resolved issues from the last quarter
node merge_field_data.js \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --source-field customfield_10001 \
  --target-field customfield_10002 \
  --jql "status = Resolved AND resolved >= -90d"
```

## How It Works

1. **Query Issues**: Uses JQL to find issues matching your criteria
2. **Pagination**: Fetches issues in batches (default 50 per page)
3. **Field Extraction**: Gets the value from the source field for each issue
4. **Filtering**: Skips issues based on your settings:
   - Empty source values (if `--skip-empty`)
   - Existing target values (unless `--overwrite-existing`)
5. **Update**: Writes the source value to the target field
6. **Statistics**: Tracks success, failures, and skipped issues

## Field Type Support

The script supports most Jira field types:

- ✅ **Text Fields**: Single line, multi-line text
- ✅ **Number Fields**: Integer, decimal
- ✅ **Date Fields**: Date, datetime
- ✅ **Select Fields**: Single select, multi-select
- ✅ **User Fields**: User picker, multi-user picker
- ✅ **URL Fields**: URL links
- ✅ **Labels**: Label arrays
- ⚠️ **Complex Fields**: May require custom handling

## Error Handling

The script includes comprehensive error handling:

- **Rate Limiting**: Automatic exponential backoff (up to 5 retries, max 32s delay)
- **Field Not Found**: Validates fields exist before processing
- **Permission Errors**: Reports issues where you lack edit permissions
- **Network Errors**: Retries with backoff on transient failures
- **Invalid Data**: Logs issues with incompatible field values

All errors are:
1. Displayed in the console with context
2. Included in the summary statistics
3. Script continues processing remaining issues

## Performance

- **Batch Processing**: Issues are processed in configurable batches (default 50)
- **Rate Limiting**: Automatic handling of API rate limits
- **Sequential Processing**: Each batch is processed sequentially for stability
- **Typical Performance**: 
  - Small instances (< 1,000 issues): 1-3 minutes
  - Medium instances (1,000-10,000 issues): 5-15 minutes
  - Large instances (10,000+ issues): 20-60 minutes

### Performance Tuning

For large datasets or instances with rate limits:

- **Reduced Batch Size**: Use `--batch-size 25` for instances with strict rate limiting
- **Memory Usage**: Monitor RAM usage - script processes issues in memory during each batch
- **Progress Tracking**: Real-time progress shows `[current/total]` completion percentage

### Field Type Compatibility

| Source Field | Target Field | Notes |
|--------------|-------------|-------|
| Single Text | Multi-line | ✅ Works seamlessly |
| Date | DateTime | ⚠ Time component may be lost |
| Single Select | Multi-select | ❌ Not compatible - manual conversion needed |
| User Picker | Group Picker | ❌ Different data structures |

**Note**: Complex field types may require additional validation during migration.

## API Endpoints Used

This script uses the following Jira Cloud REST API endpoints:

- [GET /rest/api/3/search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-get) - Search for issues using JQL
- [PUT /rest/api/3/issue/{issueIdOrKey}](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-put) - Update issue fields
- [GET /rest/api/3/issue/{issueIdOrKey}](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-get) - Get issue details (for target validation)

## Troubleshooting

### "Field not found"
**Solution:** 
- Verify the field ID is correct (e.g., `customfield_10001`)
- Check that the field exists in the project
- Ensure you're using the field ID, not the field name

### "HTTP 403" permission errors
**Solution:**
- Verify you have **Edit Issues** permission
- Check you have access to the specific project
- Ensure the field is editable (not locked or restricted)

### "Field type mismatch"
**Solution:**
- Ensure source and target fields are compatible types
- Check if the target field accepts the source field's data format
- Use `--dry-run` to test before making changes

### "Too many requests (429)"
**Solution:** 
- The script automatically handles rate limiting
- Consider reducing `--batch-size` for large operations
- The script will retry automatically with exponential backoff

### Issues being skipped
**Solution:**
- Check if target field already has values (use `--overwrite-existing`)
- Check if source field is empty (use `--no-skip-empty`)
- Review the console output for skip reasons

## Security Configuration

### Environment Variables (Recommended)

Never pass credentials directly in command line arguments. Use environment variables instead:

```bash
# Set environment variables
export JIRA_URL="https://your-company.atlassian.net"
export JIRA_EMAIL="admin@company.com" 
export JIRA_TOKEN="your-api-token"

# Then run with environment references
node merge_field_data.js \
  --url "$JIRA_URL" \
  --email "$JIRA_EMAIL" \
  --token "$JIRA_TOKEN" \
  --source-field customfield_10001 \
  --target-field customfield_10002
```

### Security Best Practices

- **Never commit API tokens** to version control or share them in logs
- **Use environment variables** for all authentication credentials
- **Rotate API tokens regularly** (recommended: every 90 days)
- **Use dedicated service accounts** with minimal required permissions
- **Basic Authentication**: Script uses HTTPS for secure credential transmission
- **Token Scope**: Generate tokens with only the minimum required permissions (Edit Issues)
- **Regular Audits**: Period review of automation accounts and their permissions

### API Token Management
Generate tokens from: https://id.atlassian.com/manage-profile/security/api-tokens

Each token should have:
- Descriptive name (e.g., "field-migration-script")
- Limited scope to specific projects if possible
- Regular rotation schedule

## Examples

### Example 1: Basic Field Migration
```bash
node merge_field_data.js \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token ATBBt7xh9k3mP8qRsT2uV5wX \
  --source-field customfield_10001 \
  --target-field customfield_10002
```

### Example 2: Project-Specific Migration
```bash
node merge_field_data.js \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token ATBBt7xh9k3mP8qRsT2uV5wX \
  --source-field customfield_10001 \
  --target-field customfield_10002 \
  --project-key DEMO
```

### Example 3: Force Overwrite All Values
```bash
node merge_field_data.js \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token ATBBt7xh9k3mP8qRsT2uV5wX \
  --source-field customfield_10001 \
  --target-field customfield_10002 \
  --overwrite-existing
```

### Example 4: Custom JQL with Dry Run
```bash
node merge_field_data.js \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token ATBBt7xh9k3mP8qRsT2uV5wX \
  --source-field customfield_10001 \
  --target-field customfield_10002 \
  --jql "project = DEMO AND status != Done" \
  --dry-run
```

## 📚 Migration Patterns & Examples

### Ready-to-Use Configurations

For common migration scenarios, see **[Configuration Examples](examples/config-examples.js)**:

- Basic same-instance migrations
- Cross-instance data transfers  
- Safe 3-step migration process
- Advanced JQL filtering
- Large dataset optimization
- Environment variable setup
- Error recovery patterns

### Example: Safe Migration Pattern
```bash
# Step 1: Test with single issue (dry run)
node merge_field_data.js \
  --url https://your-instance.atlassian.net \
  --email admin@company.com \
  --token your-token \
  --source-field customfield_10001 \
  --target-field customfield_10002 \
  --issue-keys "PROJ-1" \
  --dry-run

# Step 2: Process entire project
node merge_field_data.js \
  --url https://your-instance.atlassian.net \
  --email admin@company.com \
  --token your-token \
  --source-field customfield_10001 \
  --target-field customfield_10002 \
  --project-key DEMO
```

## Troubleshooting Guide

### Common Error Scenarios & Solutions

| Error Code | Description | Solution |
|------------|-------------|----------|
| **403 Forbidden** | Permission denied | Verify Edit Issues permission and field accessibility |
| **400 Bad Request** | Field not found or type mismatch | Check field IDs and compatibility using --dry-run |
| **429 Too Many Requests** | Rate limit exceeded | Reduce batch-size with `--batch-size 25` |
| **404 Not Found** | Invalid issue key or field ID | Verify issue keys and custom field IDs |
| **Network Errors** | Connection issues | Check network connectivity and proxy settings |

### Debugging Workflow

1. **Test with Single Issue**:
   ```bash
   node merge_field_data.js --issue-keys "PROJ-1" --dry-run
   ```

2. **Validate Field IDs**:
   ```bash
   curl -u email:token https://instance.atlassian.net/rest/api/3/field | jq '.[] | select(.id|contains("customfield_"))'
   ```

3. **Check Project Permissions**:
   - Verify access to target project
   - Confirm Edit Issues permission for automation account

4. **Review Log Output**:
   - Look for detailed error messages
   - Check issue-specific failure reasons

## License

ISC

## Support & Contributing

## Getting Help

For issues or questions:
1. Check the [Jira Cloud REST API documentation](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)
2. Review the error messages in the console output
3. Verify field IDs and permissions in Jira
4. Test with `--dry-run` before making bulk changes

### Documentation Resources
- **[Installation Guide](docs/installation.md)** - Comprehensive setup instructions
- **[Configuration Examples](examples/config-examples.js)** - Migration patterns and templates  
- **[Package Dependencies](package.json)** - Version requirements
- **[Environment Setup](.env.example)** - Secure credential management

### Community Support
- File issues with detailed reproduction steps and error logs
- Include environment details (Node.js version, Jira instance type)
- Redact sensitive credentials when sharing logs

### Getting Help

- **Community Support**: File issues on the project repository
- **Official Documentation**: [Jira Cloud REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)
- **Performance Issues**: Consider reducing batch size for large operations

### Contributing

Found a bug or want to improve the script? Please:
1. Create an issue with detailed reproduction steps
2. Include console output and error messages (redact sensitive data)
3. Provide environment details (Jira version, field types involved)
