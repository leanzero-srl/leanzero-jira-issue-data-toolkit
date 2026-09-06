# Sync Security Levels: DC to Cloud — Handover Document

## Purpose

Syncs issue security levels from Jira Datacenter (DC) to Jira Cloud. After migration, some Cloud issues may be missing their security levels. This script identifies gaps and sets the correct security level on Cloud issues based on what DC has.

## Current State

The script is **functional** for setting security levels on Cloud issues when:
- The project exists in both DC and Cloud
- The Cloud project has a security scheme assigned
- The security level exists in the Cloud scheme (matched by name)

There is a **known limitation** around creating missing security levels (see below).

## Architecture

```
sync_security_levels/
  main/sync_security_levels.js     Entry point, CLI, orchestration
  src/datacenterClient.js          DC REST API v2 client (Basic Auth)
  src/cloudJiraClient.js           Cloud REST API v3 client (Basic Auth)
  src/securityLevelProcessor.js    Core logic: discovery, mapping, plan building, execution
  src/planManager.js               Plan file persistence (stream-write for large files)
  test_scenarios.js                Standalone test script for single-issue verification
  config/members_config.json.example   Example config (not currently used, see limitation)
  .env.example                     Environment config template
  .env                             Actual credentials (not committed)
```

## How It Works

### Phase 1: Plan Building (`--plan-only`)

1. **Discover projects** — Fetches ALL DC projects, checks which have security schemes via `/rest/api/2/project/{key}/issuesecuritylevelscheme`. This found 81 projects with schemes, 69 with actual security-level issues.

2. **Build mappings** — Fetches all security schemes and levels from both DC and Cloud. Maps DC levels to Cloud levels **by name** within each project's scheme context. A project's DC scheme may have a different name than its Cloud scheme — matching is done per-project (DC project's scheme levels vs Cloud project's scheme levels).

3. **Check for missing levels** — If any DC level names don't exist in the corresponding Cloud scheme, the script writes a CSV report (`logs/missing_levels_<timestamp>.csv`) and **stops**. The user must create those levels manually in Cloud before proceeding (see Known Limitation below).

4. **Count-based comparison** — For each project, compares `level is not EMPTY` issue counts between DC and Cloud. If Cloud count >= DC count, the project is skipped (likely in sync).

5. **Cloud-first gap finding** — For projects where Cloud count < DC count, fetches Cloud issues with `level is EMPTY`, then cross-checks each against DC. Only issues where DC has a security level but Cloud doesn't are added to the plan.

6. **Save plan** — JSON file in `logs/` with per-issue entries.

### Phase 2: Execution

- Loads the plan and PUTs each issue: `PUT /rest/api/3/issue/{key}` with `{fields: {security: {id: cloudLevelId}}}`
- Concurrent (default 5), with periodic progress saves for resume support

## CLI Options

```
--dry-run           Preview without making changes
--limit <n>         Limit number of projects processed
--plan-only         Build plan, don't execute
--execute-only      Load existing plan and execute (alias: --resume)
--plan-file <path>  Path to specific master index JSON
--concurrency <n>   Max parallel PUTs (default: 5)
--retry-failed      Reprocess failed issues from previous run
```

## API Endpoints Used

### DC (REST API v2)
| Endpoint | Purpose |
|----------|---------|
| `GET /rest/api/2/project` | List all projects |
| `GET /rest/api/2/project/{key}/issuesecuritylevelscheme` | Get project's security scheme |
| `GET /rest/api/2/project/{key}/securitylevel` | Get security levels for project |
| `GET /rest/api/2/issuesecurityschemes` | List all security schemes |
| `GET /rest/api/2/issuesecurityschemes/{id}` | Get scheme with levels |
| `GET /rest/api/2/search?jql=...` | Search issues |
| `GET /rest/api/2/issue/{key}?fields=security` | Get single issue's security level |

### Cloud (REST API v3)
| Endpoint | Purpose |
|----------|---------|
| `GET /rest/api/3/issuesecurityschemes` | List all security schemes |
| `GET /rest/api/3/issuesecurityschemes/level?schemeId=...` | Get levels (paginated) |
| `GET /rest/api/3/issuesecurityschemes/project` | Get project-scheme associations |
| `GET /rest/api/3/project/{key}` | Get project by key |
| `GET /rest/api/3/search/jql?jql=...` | Search issues |
| `PUT /rest/api/3/issue/{key}` | Update issue security level |

### Cloud (available but not used in main script, used in test_scenarios.js)
| Endpoint | Purpose |
|----------|---------|
| `POST /rest/api/3/issuesecurityschemes` | Create security scheme |
| `PUT /rest/api/3/issuesecurityschemes/{schemeId}/level` | Create security level |
| `PUT /rest/api/3/issuesecurityschemes/project` | Associate scheme to project (async) |
| `GET /rest/api/3/issuesecurityschemes/level/member` | Get level members |
| `PUT /rest/api/3/issuesecurityschemes/{schemeId}/level/{levelId}/member` | Add member to level |

## Known Limitation: Security Level Members

**DC REST API does not expose security level members.** There is no endpoint to get which groups/roles are assigned to a security level in DC. We exhaustively tested:
- All documented `/rest/api/2/` endpoints
- Undocumented paths (`/rest/internal/`, `/rest/admin/`, `/rest/globalconfig/`, `/rest/security/`)
- `?expand=members` on scheme and level endpoints
- Admin JSP pages (blocked by websudo)
- The DC is running Jira **10.3.6** — even this latest version has no member API

**Consequence:** When a security level needs to be **created** in Cloud, we cannot programmatically determine the correct members (groups/project roles). Creating a level without the right members makes issues invisible to users who should have access.

**Current approach:** The script detects missing levels, writes a CSV report, and stops. The user must:
1. Open the DC admin UI to see the correct members for each level
2. Create the levels manually in Cloud with those members
3. Re-run the script

**What the Cloud creation API expects for members:**
```json
{
  "levels": [{
    "name": "Normal",
    "description": "Internal & Customer access",
    "isDefault": false,
    "members": [
      { "type": "projectrole", "parameter": "10080" },
      { "type": "group", "parameter": "org-admins" }
    ]
  }]
}
```
Note: The creation API uses `projectrole` (lowercase), but the GET members API returns `projectRole` (camelCase). The `findLevelMembersByName` method in `cloudJiraClient.js` handles this mapping.

**Important:** Project role IDs differ between DC and Cloud for the same role name. If you ever implement automated member copying, you must map by role **name**, not ID.

## Potential Future Improvements

1. **Database-level member extraction** — If you have DC database access, the `schemeissuesecuritylevels` table contains member configurations. A SQL query could extract them and produce a config file.

2. **Config-file-driven member creation** — A `members_config.json` mapping `(schemeName, levelName) -> members[]` could be used to auto-create levels. An example file exists at `config/members_config.json.example`. Implementation would need to:
   - Read the config
   - Resolve project role names to Cloud role IDs via `GET /rest/api/3/project/{key}/role`
   - Call `PUT /rest/api/3/issuesecurityschemes/{schemeId}/level` with members

3. **Scheme creation + association** — `cloudJiraClient.js` already has `createSecurityScheme()`, `associateSchemeToProject()`, and `waitForTask()` methods. The `test_scenarios.js` has working code for the full flow (create scheme, associate, set level). This was removed from the main script but can be restored if the member problem is solved.

4. **Smarter gap detection** — Currently fetches ALL Cloud issues with `level is EMPTY` per project. For very large projects, could use pagination limits or JQL date filters.

## Test Script

`test_scenarios.js` is a standalone script for verifying individual operations:

```bash
# Auto-detect first actionable issue across all projects
node test_scenarios.js --scenario auto --dry-run

# Scenario 1: Find issue where Cloud level exists but is missing on issue
node test_scenarios.js --scenario 1 --dry-run

# Scenario 2: Find issue where Cloud level/scheme is missing entirely
node test_scenarios.js --scenario 2 --dry-run

# Filter to specific project
node test_scenarios.js --scenario auto --project P4 --dry-run
```

The test script uses the same smart discovery (project enumeration, count comparison, Cloud-first gap finding) but stops at the first actionable issue and operates on it alone.

## Environment

Tested against:
- DC: Jira 10.3.6
- Cloud: Jira Cloud (your-sandbox.atlassian.net)
- Node.js: v22.22.0
- Only dependency: `dotenv`

## Data Volumes Observed

- 143 DC projects total, 81 with security schemes, 69 with actual security-level issues
- Largest project: WIL with 76,629 issues with security levels
- 32 Cloud security schemes, 348 project-scheme associations
- Total DC issues with security levels: ~500k+
