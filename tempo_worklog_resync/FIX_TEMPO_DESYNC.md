# fix_tempo_desync.js — re-sync Tempo after a Jira-only worklog move

## What problem this fixes

The original `src/index.js` move used Jira's REST `…/worklog/move` API (Jira-core only).
**Tempo never saw those moves**, leaving a 3-way mess per moved issue:

- **Archive issue** (a manual "Copy of …" clone): holds the moved worklogs as **Jira-only copies**
  authored by the Tempo app account `557058:295406f3-…` ("Timesheets by Tempo") — **wrong author**,
  and **0 records in Tempo** (so they never show in the Tempo UI / timesheets).
- **Source issue**: still holds the originals as **Tempo orphans** — correct (real) author, but their
  backing Jira worklog was deleted, so they have **no Jira shadow**.

This script redoes the move **through Tempo** so Jira and Tempo agree on both issues and the **real
employee author is preserved**. It only ever moves the **OLDEST** worklogs (the exact set the prior
move took, identified precisely via the archive copy's `tempo` property — never the newest).

## Prerequisites (don't skip — these are the gotchas that cost hours)

1. **`.env`** must have `CLOUD_BASE_URL`, `CLOUD_API_TOKEN` (Jira basic-auth) and
   **`TEMPO_API_TOKEN`** (Tempo Cloud Bearer; host is `api.eu.tempo.io/4` for this instance).
2. **Tempo "Override Mode" must be ENABLED** (Tempo Settings, admin UI). It already is on
   the tenant. Without it, every closed-period write fails `403 "Period is closed"`.
3. The whole approach relies on `bypassPeriodClosuresAndApprovals` — the Tempo-native equivalent of
   Jira's override flag. **Do NOT try to reopen periods/approvals instead** — the global Period
   Management "Closed for all" lock is admin/UI-only (the `/4/periods-configuration` endpoint is 403
   for this token) and reopening per-user approvals is *not enough* (the global lock still blocks).

### Three quirks the script already handles correctly — keep them if you edit it
- Tempo **CREATE**: bypass goes in the **request body** (`bypassPeriodClosuresAndApprovals: true`).
- Tempo **DELETE**: bypass MUST be a **query param** (`?bypassPeriodClosuresAndApprovals=true`).
  In the body it is silently ignored → `403 "Period is closed"`.
- Deleting the wrong-author **Jira copies**: use a **plain Jira DELETE, NO `overrideEditableFlag`**.
  The override flag requires a Connect/Forge app (basic-auth token gets 403); a plain delete of these
  app-authored copies works.
- Bypass does **NOT** skip the per-user **8h/day** limit → the script deletes the source orphan
  **first** (frees the day) **then** creates on the archive. Don't reorder those two steps.

## Usage

```bash
node fix_tempo_desync.js <SOURCE> <ARCHIVE> --dry-run     # build worklist, write plan, no changes
node fix_tempo_desync.js <SOURCE> <ARCHIVE> --limit 1     # canary: migrate the single oldest
node fix_tempo_desync.js <SOURCE> <ARCHIVE>               # full run
```

Per-worklog transaction (logged to `logs/tempo_fix_<SRC>_<ts>.jsonl`):
1. delete the Tempo orphan on SOURCE (bypass query)
2. create it on ARCHIVE via Tempo (bypass body, real author, exact date/time/seconds/billable/desc)
   - on failure → self-heal: recreate the orphan back on SOURCE, skip, log it
3. plain-delete the wrong-author Jira copy on ARCHIVE

**Resumable**: the worklist is rebuilt from current state each run, so already-migrated worklogs
(their archive copy is gone) are naturally excluded. Re-running after an interruption is safe.

## Status — DONE 2026-06-17

Both cap-migration pairs fully re-synced (3,000 worklogs, **0 failures**):

| Source → Archive | Result |
|---|---|
| OPS-3300 → OPS-5973 | 1500/1500, archive Jira≡Tempo, 344 real authors (0 app-account) |
| OPS-3302 → OPS-5974 | 1500/1500, archive Jira≡Tempo, 61 real authors (0 app-account) |

## ⚠️ Known leftover on OPS-3302 — intentionally NOT migrated (read before re-running)

OPS-3302 has **14 Tempo worklogs with no Jira shadow** that are **pre-existing and unrelated to the
cap move** (the source started 1,511 over, not 1,500 — these are the extra 11-ish). They have **no
archive copy**, so the script correctly **excludes them from the worklist** — they show up in the
dry-run as part of **`unmatched/skipped`**. **This is expected, not an error.** They are real
worklogs that live only in Tempo (deleting them would lose data), so they were deliberately left.
As of 2026-06-17, OPS-3302 reads `tempo 6911 / jira-core 6900` because of them.

The 14 (mostly a 2025-03 cluster from a separate event, + 1 recent):

```
tempoWorklogId  date        author
952871          2025-03-18  712020:00000000-0000-0000-0000-000000000000
952952          2025-03-18  712020:00000000-0000-0000-0000-000000000000
952821          2025-03-18  712020:00000000-0000-0000-0000-000000000000
952996          2025-03-18  634e9637548f1fe6f0c3c341
952953          2025-03-19  712020:00000000-0000-0000-0000-000000000000
952872          2025-03-19  712020:00000000-0000-0000-0000-000000000000
952822          2025-03-19  712020:00000000-0000-0000-0000-000000000000
953032          2025-03-19  634e9637548f1fe6f0c3c341
952873          2025-03-20  712020:00000000-0000-0000-0000-000000000000
952823          2025-03-20  712020:00000000-0000-0000-0000-000000000000
952874          2025-03-21  712020:00000000-0000-0000-0000-000000000000
952824          2025-03-21  712020:00000000-0000-0000-0000-000000000000
953047          2025-03-21  634e9637548f1fe6f0c3c341
1383545         2026-06-12  70121:00000008-0000-4000-8000-000000000008  (empty description)
```

If you ever decide to act on them: investigate the Jira issue history around those dates first
(why the Jira side was deleted) before recreating shadows or deleting the Tempo records.
