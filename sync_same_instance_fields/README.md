# sync_same_instance_fields

Sync custom-field values from `(migrated)` source fields to their non-`(migrated)` target fields on the **same** Jira Cloud instance.

## Use Case

After JCMA migration, fields on Cloud have `(migrated)` suffix duplicates alongside the original system fields:

```
Source:  "Segment (migrated)"  (customfield_12345) — populated with data
Target:  "Segment"             (customfield_67890) — empty, needs data
```

This script copies values from source → target, handling type translation, validation, and audit reporting.

## Setup

```bash
cd jira/jira-data/sync_same_instance_fields
cp .env.example .env
# Edit .env with your CLOUD_BASE_URL and CLOUD_API_TOKEN
npm install
```

## Usage

```bash
node main/sync_same_instance_fields.js <phase> [options]
```

### Phases

| Phase | Description |
|-------|-------------|
| `field-report` | Read-only. Sample N issues, discover `(migrated)` → target pairs, report ambiguities |
| `prepare` | Make target fields writable (run this BEFORE `plan` on a fresh instance). Dry-run by default; `--apply` to execute, `--restore` to undo |
| `plan` | Read-only. Scan all matching issues, compute per-field diffs, write plan |
| `audit` | Render plan as CSV + Markdown |
| `apply` | Execute planned writes. Requires `--dry-run` or `--apply` |

### `prepare` — making targets writable

The `plan`/`apply` phases only act on fields that are **settable on an issue's edit
screen** (`editmeta`). On a freshly-migrated instance the native target fields usually
aren't yet — for up to four independent reasons. `prepare` detects and (where safe)
fixes them per resolved twin pair:

| Layer | What | Action |
|-------|------|--------|
| 1. Context applicability | The field's context must cover the project + issue type | **Detect & warn** by default; with `--extend-contexts`, auto-extends an existing context (add issue type / add project) — opt-in, reversible |
| 2. Field-config visibility | Field must not be *hidden* in the project's field configuration | Auto un-hide (reversible). *Locked Atlassian/JSM fields can't be reconfigured — reported as `locked`, harmless* |
| 3. Select options | Source option values must exist in the target context | Adds **all** missing options (reversible until an issue uses one) |
| 4. Screen presence | Field must be on the Edit screen | Adds to the screen's first tab (reversible) |

```bash
node main/sync_same_instance_fields.js prepare              # dry-run: print the plan, change nothing
node main/sync_same_instance_fields.js prepare --apply      # execute; writes logs/prepare_manifest_<runId>.json
node main/sync_same_instance_fields.js prepare --extend-contexts          # dry-run incl. context extensions
node main/sync_same_instance_fields.js prepare --extend-contexts --apply  # also extend contexts
node main/sync_same_instance_fields.js prepare --restore    # undo (latest manifest, or --manifest PATH)
```

**Context extension (`--extend-contexts`, opt-in).** When a target field's context
doesn't cover a project/issue-type that has data, by default `prepare` only *warns*
(and notes how many such gaps are auto-remediable). With `--extend-contexts` it instead
performs the **minimal, non-destructive** edit to an existing context: prefer *adding the
missing issue type* to the project's own context; else *add the project* to a context that
already covers the issue type. It **never** touches a global context or narrows an
`isAnyIssueType` context, and declines (warns) when no safe single edit exists. Reversible
via `--restore`.

> **Option-add has no false-twin guard.** It adds *every* missing source option to the
> target — so a name-collision twin (e.g. a legacy "Impact level" with values `Standard`/`Urgent`
> mapped onto native `Critical/High/Medium/Low`) would get those bogus options injected.
> The **`fieldDenylist` is your only protection** — denylist such false twins before running.

### Selection

```bash
--jql "<JQL>"          Cloud JQL (overrides config.jql)
--projects A,B         restrict to these project keys
--issue KEY            single issue
--keys K1,K2           explicit issue list
--limit N              cap issues scanned
```

### Apply

```bash
--dry-run              log intended PUTs, write nothing
--apply                perform the writes
--resume               skip issues already completed
--retry-failed         also re-run failed issues
--recheck/--no-recheck re-read target before writing (default: config)
--no-mute-notifications do NOT mute "Issue Updated" (watchers WILL be emailed)
```

### Example

```bash
# 1. Discover pairs on 10 sample issues
node main/sync_same_instance_fields.js field-report --jql "project = ABC ORDER BY updated DESC" --limit 10

# 2. Review reports/field_resolution_*.md, add pins to config/field_overrides.json if needed

# 3. Plan all matching issues
node main/sync_same_instance_fields.js plan --jql "project = ABC ORDER BY updated DESC"

# 4. Review audit
node main/sync_same_instance_fields.js audit

# 5. Dry run
node main/sync_same_instance_fields.js apply --dry-run

# 6. Apply
node main/sync_same_instance_fields.js apply --apply
```

## Configuration

### config.json

```json
{
  "jql": "project = ABC ORDER BY updated DESC",
  "concurrency": { "plan": 5, "apply": 3 },
  "fieldPairs": [
    { "sourceName": "Segment (migrated)", "targetName": "Segment" }
  ],
  "fieldDenylist": ["Sprint", "Rank", "Story Points"],
  "richTextOverwrite": "missing_only",
  "recheckBeforeApply": true,
  "muteNotifications": true
}
```

- `fieldPairs` is optional. When absent, all `(migrated)` → base-name pairs are auto-discovered.
- `fieldDenylist` prevents syncing fields that would cause issues (Sprint, Rank, etc.).
- `richTextOverwrite` controls rich-text overwrite policy: `"missing_only"`, `"high_fidelity"`, or `"all"`.

### field_overrides.json

Pin ambiguous matches:

```json
{
  "overrides": [
    { "sourceFieldId": "customfield_12345", "targetFieldId": "customfield_67890", "sourceName": "Segment (migrated)", "targetName": "Segment" }
  ]
}
```

## File Structure

```
sync_same_instance_fields/
  main/
    sync_same_instance_fields.js     -- CLI entry point, 4 phases
  src/
    cloudJiraClient.js               -- extends base client with getFields, getEditMeta, etc.
    fieldResolver.js                 -- (migrated) → base-name pair resolution
    fieldDiffer.js                   -- same-instance diff engine
    auditWriter.js                   -- CSV/MD report rendering
    baseCloudJiraClient.js           -- vendored: HTTP client, retries, search, updateIssue
    typeRegistry.js                  -- vendored: per-type translate/normalize/compare handlers
    planManager.js                   -- vendored: streaming plan persistence (JSONL → plan.json)
    notificationMuter.js             -- vendored: per-project mute/restore on apply
  config/
    config.json                      -- JQL, options, field pairs
    field_overrides.json             -- explicit field pinning
  logs/                              -- plan files, logs (auto-created)
  reports/                           -- audit reports (auto-created)
  package.json
  .env
  .env.example
```

## Vendored Components (self-contained)

This script is **standalone** — it has no cross-directory dependencies and the
only npm dependency is `dotenv`. The following modules were originally shared
with sibling scripts and are now vendored into `src/`:

| Vendored file | Originally from |
|---|---|
| `src/typeRegistry.js` | `sync_custom_fields/src/typeRegistry.js` |
| `src/baseCloudJiraClient.js` | `sync_issue_links/src/cloudJiraClient.js` |
| `src/notificationMuter.js` | `sync_issue_links/src/notificationMuter.js` |
| `src/planManager.js` | `mend_comments/src/planManager.js` |

> Each vendored file depends only on Node built-ins. If a bug is fixed upstream
> in a sibling script, re-copy the corresponding file here to stay in sync.
> Note: this script's own Approvers/user-field handling lives in
> `src/fieldDiffer.js` (a same-instance accountId copy), **not** in the vendored
> `typeRegistry.js` — so the vendored registry can be refreshed safely.
