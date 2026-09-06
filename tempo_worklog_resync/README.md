# tempo_worklog_resync

Re-synchronises **Tempo Timesheets** after worklogs were moved with Jira's own REST API — which Tempo
never sees.

> The full incident write-up, with the exact three-way state and the recovery reasoning, is in
> [`FIX_TEMPO_DESYNC.md`](./FIX_TEMPO_DESYNC.md). Read it before running anything.

## The problem

Jira core exposes `POST /rest/api/3/issue/{key}/worklog/move`. It works, and it is invisible to Tempo.
After using it you are left with a three-way inconsistency per issue:

| Where | State |
|---|---|
| **Target issue** | Holds the moved worklogs as **Jira-only copies**, authored by the Tempo app account — wrong author, and **zero** records in Tempo, so they never appear in a timesheet. |
| **Source issue** | Still holds the originals as **Tempo orphans** — correct human author, but the backing Jira worklog is gone, so there is no Jira shadow. |
| **Timesheets** | Disagree with Jira in both directions. |

This is the shape you get when an issue hits Jira's 10,000-worklog ceiling and someone moves the
oldest entries off to an archive issue to get under it.

## What this script does

Redoes the move **through Tempo**, so Jira and Tempo agree on both issues and the **real employee
author is preserved**.

- Identifies the exact set that the earlier Jira-only move took, via the archive copy's `tempo`
  property — a precise cross-walk, not a heuristic.
- Only ever moves the **oldest** worklogs. Never the newest.
- Deletes the orphan before creating the replacement, so a day never exceeds its hour cap mid-run.

## Prerequisites — these are the parts that cost hours

1. `.env` with `CLOUD_BASE_URL`, `CLOUD_API_TOKEN` (Jira Basic auth) and a **Tempo OAuth 2.0 token**.
2. **Override Mode must be ON** in Tempo, and the create/delete calls must send
   `bypassPeriodClosuresAndApprovals: true` — otherwise every write into a closed period fails with
   `403 "Period is closed"`.
3. Delete the orphan **before** creating its replacement. Tempo enforces a per-day hour cap and will
   reject the create if both exist at once.

## Run

```bash
cd tempo_worklog_resync
npm install
cp .env.example .env

node fix_tempo_desync.js --dry-run --issue ABC-123
node fix_tempo_desync.js --issue ABC-123
```

Start with one issue. Confirm the timesheet in the Tempo UI, for the right person, in the right
period, before running a second.

## Verify it in Tempo, not in Jira

A worklog can exist in Jira and be absent from every timesheet — that is the entire bug. The only
valid verification is opening the affected user's Tempo timesheet for the affected period and
confirming the hours and the author are right on **both** issues.
