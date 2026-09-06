# sync_issue_links

Recreates **issue-to-issue links** that exist on Data Center but are missing on the Cloud copy,
preserving link type and direction.

## Why it exists

Links are the part of an issue that lives *between* two records, so they are the part a per-issue
migration is most likely to drop — typically when only one endpoint made it across in the first pass,
or when issues were backfilled later. The result is a Cloud site where "blocks", "relates to" and
"duplicates" are quietly thinner than the source.

## The deduplication problem

A single physical link shows up on **both** endpoint issues. Walking a JQL result set naively
therefore sees every link twice, and creating it twice produces a duplicate on Cloud.

Every raw entry is normalised to a canonical **directed triple** — `(typeName, outwardKey, inwardKey)`
— and deduplicated globally before anything is planned. Each link is planned and created exactly
once, regardless of how many times the walk encountered it.

## Setup

```bash
cd sync_issue_links
npm install
cp .env.example .env    # or: ln -s ../sync_issue_parents/.env .env
```

Needs `DC_BASE_URL`, `DC_USERNAME` + `DC_PASSWORD` (or `DC_PAT`), `CLOUD_BASE_URL`, `CLOUD_API_TOKEN`.

## The two phases

**Phase 1 — plan.** Walk the Cloud JQL results, read DC and Cloud links, reduce to canonical triples,
then validate each one: the link type must exist on Cloud, both endpoints must exist on Cloud, and
the link must not already be there. Everything rejected is written to a skip report with its reason.

**Phase 2 — execute.** `POST /rest/api/3/issueLink` per pending triple, with a live pre-flight
re-check. Resumable.

## Notification muting

Creating a link notifies watchers on both issues. Doing that a few thousand times will flood a
mailbox and, on a real site, get the migration account rate-limited or blocked.

By default the script **clones each affected project's notification scheme, strips it, assigns the
stripped copy for the duration of the run, and restores the original afterwards**, taking a snapshot
first. If a run dies mid-flight, `--restore-only` re-applies the snapshots without doing any other
work. Run it before anything else if a previous run was interrupted.

## Run

```bash
# 1. One issue, read-only.
node main/sync_issue_links.js --jql 'key = PROJ-123' --dry-run

# 2. Plan a slice and read the skip report.
node main/sync_issue_links.js --plan-only --limit 50

# 3. Full run.
node main/sync_issue_links.js

# 4. Resume, retrying failures.
node main/sync_issue_links.js --resume --retry-failed

# If a run was interrupted, restore notification schemes FIRST.
node main/sync_issue_links.js --restore-only
```

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--jql <string>` | migration-creator JQL | Cloud JQL selecting the issues to inspect. |
| `--dry-run` | off | Plan only, create nothing. |
| `--limit <n>` | none | Truncate the Cloud search to N issues. |
| `--plan-only` | off | Build the plan and stop. |
| `--execute-only` / `--resume` | off | Run an existing plan. |
| `--plan-file <path>` | latest | Master index JSON to resume from. |
| `--concurrency <n>` | 5 | Parallel link `POST`s. |
| `--retry-failed` | off | Also re-run rows whose status is `failed`. |
| `--no-mute-notifications` | off | Leave notification schemes alone. Expect mail. |
| `--restore-only` | off | Restore pending notification-scheme snapshots and exit. |
