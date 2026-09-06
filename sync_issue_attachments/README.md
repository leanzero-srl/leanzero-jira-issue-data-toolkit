# sync_issue_attachments

Re-uploads **attachments** that exist on a Data Center issue but are missing from its Cloud
counterpart (same issue key).

## Why it exists

Attachment loss is the most common silent casualty of a bulk migration. A file over the Cloud size
cap, a transfer that timed out, an issue created by a later backfill — the issue arrives, the file
does not, and nothing in the migration report says so.

Matching is by **filename + byte size**, which is precise enough to avoid re-uploading a file that is
already there and loose enough to survive the timestamp and author rewriting that migration does.

## Setup

```bash
cd sync_issue_attachments
npm install
cp .env.example .env    # or: ln -s ../sync_issue_parents/.env .env
```

`.env` needs `DC_BASE_URL`, `DC_USERNAME` + `DC_PASSWORD` (or `DC_PAT`), `CLOUD_BASE_URL`, and
`CLOUD_API_TOKEN` (base64 of `email:api_token`). The same file the sibling `sync_*` scripts use.

## The two phases

**Phase 1 — plan.** Walk the Cloud JQL result set. For every issue read the DC attachment list and
the Cloud attachment list, diff them, and write a plan plus a missing-attachments report. Read-only.

**Phase 2 — execute.** For each pending row, download the DC file to a temp path and
`POST /rest/api/3/issue/{key}/attachments`. Resumable, and every row is re-checked live before the
upload so a stale plan cannot duplicate a file.

## Run

```bash
# 1. One known issue, no writes. Always start here.
node main/sync_issue_attachments.js --jql 'key = PROJ-123' --dry-run

# 2. Build a plan over a slice and read the report.
node main/sync_issue_attachments.js --plan-only --limit 50

# 3. Execute the whole thing.
node main/sync_issue_attachments.js

# 4. Resume after an interruption, retrying rows that failed.
node main/sync_issue_attachments.js --resume --retry-failed
```

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--jql <string>` | migration-creator JQL | Cloud JQL selecting the issues to inspect. |
| `--dry-run` | off | Plan and report, download and upload nothing. |
| `--limit <n>` | none | Truncate the Cloud search to N issues. |
| `--plan-only` | off | Build the plan and stop. |
| `--execute-only` / `--resume` | off | Skip planning, run an existing plan. |
| `--plan-file <path>` | latest | Master index JSON to resume from. |
| `--concurrency <n>` | 3 | Parallel issues in flight. |
| `--retry-failed` | off | Also re-run rows whose status is `failed`. |
| `--max-bytes <n>` | Cloud's value | Override the reported max attachment size. |
| `--keep-temp` | off | Keep downloaded files after upload, for inspection. |

## Limits worth knowing

Cloud enforces a per-file attachment size cap that is usually lower than DC's. Files over it are
reported, not uploaded — they need a manual decision (link to external storage, or raise the cap).
Attachment **author and creation date** are set by Cloud to the uploading account and now; the
original values cannot be set over REST.
