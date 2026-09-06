# sync_issue_parents

Rebuilds **parent-child relationships** — and, optionally, `reporter` and `assignee` — on Cloud issues
from their Data Center counterparts.

## Why it exists

Hierarchy is stored as a reference to another issue's internal id, and internal ids do not survive a
migration. When the parent moves across in a different batch from the child, or the child is created
by a later backfill, the reference cannot be resolved and the child arrives orphaned. Boards look
right, but every roll-up, epic burndown and portfolio view under it is wrong.

The script recovers all three parent shapes:

- sub-task `parent`
- Story-under-Epic (the classic **Epic Link** custom field)
- team-managed / next-gen `parent`

## Safety rules baked in

- **Never overwrites.** A Cloud issue that already has a parent is skipped, always.
- **Never invents.** If the DC parent does not exist on Cloud, the row goes to a missing-parents
  report instead of being guessed at.
- **Re-checks at write time**, so a plan built yesterday cannot act on a state that changed today.

## Setup

```bash
cd sync_issue_parents
npm install
cp .env.example .env
```

Needs `DC_BASE_URL`, `DC_USERNAME` + `DC_PASSWORD` (or `DC_PAT`), `CLOUD_BASE_URL`, `CLOUD_API_TOKEN`.

## Run

```bash
# 1. Plan a small slice. No writes.
node main/sync_issue_parents.js --jql 'project = ABC' --plan-only --limit 50

# 2. Dry execute against that plan.
node main/sync_issue_parents.js --resume --plan-file ./logs/master_<ts>.json --dry-run

# 3. Full run.
node main/sync_issue_parents.js --jql 'project = ABC'

# 4. Same machinery, different field.
node main/sync_issue_parents.js --field reporter --jql 'project = ABC'
```

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--field <name>` | `parent` | `parent`, `reporter` or `assignee`. |
| `--jql <string>` | — | Cloud JQL selecting issues to fix. Required unless `--resume`. |
| `--dry-run` | off | Preview the `PUT`s without sending them. |
| `--limit <n>` | none | Truncate the Cloud search to N issues. |
| `--plan-only` | off | Build the plan and stop. |
| `--execute-only` / `--resume` | off | Run an existing plan. |
| `--plan-file <path>` | latest | Master index JSON to resume from. |
| `--concurrency <n>` | 5 | Parallel Cloud `PUT`s. |
| `--retry-failed` | off | Also re-run rows whose status is `failed`. |
| `--epic-link-field <id>` | auto | DC Epic Link custom field id (auto-discovered if omitted). |
| `--parent-link-field <id>` | auto | DC Parent Link custom field id (auto-discovered if omitted). |

## The companion scripts

Written while proving the main run and kept because they are the fastest way to answer "did it
actually work":

| Script | Purpose |
|---|---|
| `main/sanitize_subtask_parent_ids.js` | Rewrites the `Parent id` column of a DC-exported CSV from DC internal ids to **Cloud** internal ids, so Jira Cloud's CSV importer can accept it. Unresolved values are blanked and listed in a companion `.unresolved.csv`. |
| `verify_parent_mapping.js`, `verify_plan.js`, `batched_verify.js` | Re-read Cloud and confirm the plan landed. |
| `dc_match_audit.js`, `explore_dc_relations.js` | Inspect what DC actually holds for a sample, before trusting the plan. |
| `check_dupes_and_structure.js`, `count_still_missing.js`, `probe_still_missing.js` | Post-run gap analysis. |

Run the verifiers. A plan that reports 100% applied and a Cloud site that shows the parents are two
different claims.
