# sync_custom_fields

Copy Jira **custom-field values** from Data Center (DC) to Cloud, treating **DC
as the source of truth**. Run a JQL against Cloud, fetch each issue's DC
counterpart (same key), and for every custom field with DC data, overwrite the
Cloud value when it is **missing or different**.

Phased like its siblings (`sync_issue_comments`, `sync_issue_links`):
**field-report → plan → audit → apply**, with `--dry-run`, idempotency,
resumability, and notification muting.

## Why it's careful

- **Field IDs differ between DC and Cloud**, so fields are matched by **name**
  (e.g. "Segment" = DC `customfield_23954` → Cloud `customfield_10305`).
- Both instances carry **duplicate field names**, and JCMA created
  `(migrated)`-suffixed duplicate Cloud fields. When two writable Cloud targets
  share a name, the script **refuses to guess** and reports the ambiguity — you
  pin the right pair in `config/field_overrides.json`.
- Only fields **writable on the issue's edit screen** (`editmeta`, with a `set`
  operation) are touched.
- Each field type is translated by a schema-driven handler. **Unknown / app /
  computed types are skipped by default** (fail-safe) — Sprint, Rank,
  Development, Assets/CMDB, SLA, traffic-light, etc.
- **Rich text is guarded.** DC→ADF conversion is lossy (it can't reproduce the
  ADF tables/lists JCMA already built), so by default rich-text fields are only
  **filled when empty**, never overwritten — see `richTextOverwrite`.
- **DC-empty never blanks Cloud.** Only present DC data is copied.

## Setup

```bash
npm install
cp .env.example .env   # fill in DC + Cloud credentials
```

`.env`:
- `DC_BASE_URL`, and either `DC_PAT` or `DC_USERNAME`+`DC_PASSWORD`
- `CLOUD_BASE_URL`, `CLOUD_API_TOKEN` (base64 of `email:api_token`)

## Usage

```bash
# 1. Read-only: resolved DC<->Cloud field map + ambiguities for sample issues
node main/sync_custom_fields.js field-report --projects ABC --limit 10

# 2. Read-only: compute per-field diffs -> logs/plan_<runId>.json + reports
node main/sync_custom_fields.js plan --issue ABC-2080
node main/sync_custom_fields.js plan --projects ABC,DEF --limit 200

# 3. Render the latest plan as CSV + Markdown
node main/sync_custom_fields.js audit

# 4. Dry-run the writes (no mutations)
node main/sync_custom_fields.js apply --dry-run

# 5. Apply for real (notification muting on by default)
node main/sync_custom_fields.js apply --apply --resume
```

### Status restore (separate concern)

Status is a **system field** changed only via workflow **transitions**, so it has
its own phase. It moves Cloud issues back to their DC (original) status along a
configured hop path (`statusPaths` in config, e.g.
`"Reopened->Closed": ["Resolved","Closed"]`), matching transitions by their
destination status. Idempotent, resumable, notification-muted.

```bash
node main/sync_custom_fields.js status-restore --jql "project = SD AND ..." --dry-run
node main/sync_custom_fields.js status-restore --plan-file logs/status_plan_<runId>.json --apply --resume
```

**⚠ Service-desk (JSM) projects:** transitioning a JSM request fires **customer
notifications** (configured under Project settings → Customer notifications) that
the internal notification muter does **not** suppress. Disable customer
notifications for the project during the run, and disable any automation that
caused the wrong status, before applying. The original `resolutiondate` cannot be
restored via transition (it is set to the transition time); resolution itself is
restored if the workflow exposes/sets it (verify with a single-ticket test).

### Selection
`--jql "<JQL>"` (overrides config), `--projects A,B`, `--issue KEY`,
`--keys K1,K2`, `--limit N`.

### Apply
`--dry-run` | `--apply`, `--resume` (skip completed), `--retry-failed`,
`--recheck`/`--no-recheck` (re-read Cloud before writing; default on),
`--no-mute-notifications`, `--restore-only-notifications` (recover muted schemes
after a crash), `--plan-file PATH`.

## Config (`config/config.json`)

| key | meaning |
|---|---|
| `jql` | default Cloud issue selection |
| `concurrency` | `{ plan, apply }` worker counts |
| `fieldDenylist` | field NAMES to never sync (e.g. Sprint, Rank, Story Points) |
| `richTextOverwrite` | `missing_only` (default) \| `high_fidelity` \| `all` |
| `recheckBeforeApply` | re-read Cloud and drop now-matching fields at apply time |
| `muteNotifications` | clone+mute "Issue Updated" per project during writes |
| `allowClearWhenDcEmpty` | (default false) never blank Cloud when DC empty |

- `config/field_overrides.json` — pin ambiguous DC↔Cloud field pairs:
  `{ "overrides": [{ "name": "PIR Status", "dcFieldId": "customfield_22626", "cloudFieldId": "customfield_10233" }] }`
- `config/option_value_map.json` — per-field option-label remaps when DC and
  Cloud labels differ: `{ "maps": { "<Field>": { "<dcValue>": "<cloudValue>" } } }`

## Supported field types

select / radio, multiselect / multicheckbox, cascading select, number, date,
datetime, single-line text, url, multi-line/rich text (→ ADF), labels,
user picker, multi-user picker, group picker, version / multiversion.
User pickers map DC user → Cloud `accountId` via email (`mend_comments`
`UserMapper`). Option values are validated against the Cloud field's
`editmeta.allowedValues` before writing (mismatches are skipped + reported).

## Outputs

- `logs/plan_<runId>.json` — the plan (per-issue field plans + skips + ambiguities)
- `reports/field_resolution_<runId>.md` — ambiguities to resolve via overrides
- `reports/audit_<runId>.csv` / `.md` — per-field change rows + summary
- `logs/user_map_cache.json`, `logs/field_index_cache.json` — caches
- `logs/notification_snapshots.jsonl` — muting recovery snapshots

## Idempotency

Value-based: plan and apply both compare DC-normalized vs Cloud-normalized
values, so a field already correct is left alone and re-runs converge. Resume via
the plan's per-issue status.
