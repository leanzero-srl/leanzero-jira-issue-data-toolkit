# Installation Guide

## Prerequisites

Before installing and using the Jira Field Data Merger, ensure you have:

### System Requirements
- **Node.js** version 14.0 or higher (recommended: LTS version)
- **npm** or **yarn** package manager
- Command line/terminal access

### Jira Requirements
- At least one **Jira Cloud** instance with API access
- Valid **API token(s)** for authentication ([Generate here](https://id.atlassian.com/manage-profile/security/api-tokens))
- **Edit Issues** permission for the target field/project
- Field IDs for both source and target fields

## Quick Installation

### 1. Install Dependencies

```bash
cd /path/to/field_merge

# Install with npm
npm install commander

# Or with yarn
yarn add commander
```

### 2. Install as Global Package (Optional)

```bash
# Make the script available globally on your system
npm install -g .
```

## Dependency Management

### Using package.json (Recommended)
The included `package.json` defines all dependencies:

```json
{
  "dependencies": {
    "commander": "^11.0.0"
  },
  "engines": {
    "node": ">=14.0.0"
  }
}
```

### Manual Installation
If you prefer not to use `package.json`:

```bash
# Install commander directly
npm install commander@11.0.0

# Verify installation
node -e "require('commander'); console.log('✅ Commander installed successfully')"
```

## Environment Setup

### Option 1: Environment Variables (Recommended)

Create a `.env` file from the example:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:
```bash
JIRA_URL=https://your-company.atlassian.net
JIRA_EMAIL=admin@company.com
JIRA_TOKEN=your-api-token-here
JIRA_SOURCE_FIELD=customfield_10001
JIRA_TARGET_FIELD=customfield_10002
```

Add `.env` to your `.gitignore`:
```bash
echo ".env" >> .gitignore
```

### Option 2: Command Line Arguments

You can pass all credentials via command line (not recommended for production):

```bash
node merge_field_data.js \
  --url https://your-company.atlassian.net \
  --email admin@company.com \
  --token your-api-token-here \
  --source-field customfield_10001 \
  --target-field customfield_10002
```

## Verify Installation

### Test Basic Functionality

```bash
# Test with a dry run on a single issue
node merge_field_data.js \
  --url https://your-company.atlassian.net \
  --email admin@company.com \
  --token your-api-token-here \
  --source-field customfield_10001 \
  --target-field customfield_10002 \
  --issue-keys "TEST-1" \
  --dry-run
```

Expected output:
```
🔄 JIRA FIELD DATA MERGER
=====================================
✅ Script completed successfully!
```

### Check Node.js Version

```bash
node --version
# Expected: v14.x or higher
```

## Troubleshooting Installation

### Common Issues

| Issue | Solution |
|-------|----------|
| **commander not found** | Run `npm install commander` in the script directory |
| **Node.js version too old** | Upgrade Node.js: `nvm install 18` or download from nodejs.com |
| **Permission denied** | Run with `sudo npm install -g` for global installs, or check user permissions |
| **Network issues** | Verify internet connectivity and proxy settings |

### Verification Commands

```bash
# Check Node.js installation
node --version && npm --version

# Verify commander is installed
npm list commander

# Test script help
node merge_field_data.js --help

# Test basic connectivity (replace with your actual URL)
curl -I https://your-company.atlassian.net
```

## Security Configuration

### Secure Environment Setup

1. **Never commit credentials** to version control
2. **Use environment variables** instead of command line arguments in production
3. **Limit token permissions** to only what's needed (Edit Issues)
4. **Rotate tokens regularly** (recommended every 90 days)

### Example Secure Setup

```bash
# Set environment variables (for current session)
export JIRA_URL="https://secure-company.atlassian.net"
export JIRA_EMAIL="automation@company.com" 
export JIRA_TOKEN="secure-api-token-here"

# Then run securely
node merge_field_data.js --url "$JIRA_URL" --email "$JIRA_EMAIL" --token "$JIRA_TOKEN"

# Add to your shell profile for persistence
echo 'export JIRA_URL="https://secure-company.atlassian.net"' >> ~/.bashrc
echo 'export JIRA_EMAIL="automation@company.com"' >> ~/.bashrc  
```

## Docker Installation (Optional)

For containerized deployments, create a `Dockerfile`:

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY . .
RUN npm install commander

# Set environment variables at runtime
ENV JIRA_URL=
ENV JIRA_EMAIL= 
ENV JIRA_TOKEN=

CMD ["node", "merge_field_data.js"]
```

Build and run:
```bash
docker build -t jira-field-merger .
docker run --rm -e JIRA_URL=... jira-field-merger --help
```

## Next Steps

Once installation is complete, proceed with:

1. [Finding Custom Field IDs](../README.md#finding-custom-field-ids)
2. [Basic Usage Examples](../README.md#usage)  
3. [Configuration Options](../README.md#command-line-options)
4. [Performance Tuning](../README.md#performance-tuning)

## Support

If you encounter installation issues:

1. Check this guide for troubleshooting steps
2. Verify your Node.js and npm versions
3. Ensure you have proper network connectivity to Jira
4. Check that your API token has the correct permissions
5. Review the [main README](../README.md) for additional documentation

## Version Compatibility

| Node.js | Commander | Support Status |
|---------|-----------|----------------|
| v14.x   | ^11.0.0   | ✅ Supported  |
| v16.x   | ^11.0.0   | ✅ Recommended |
| v18.x   | ^11.0.0   | ✅ Recommended |
| v20.x   | ^11.0.0   | ⚠ Testing    |
