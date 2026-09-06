# mend_comments

Mend JCMA-migrated Cloud Jira **comments** (not descriptions, never any other field) for issues created by specific service/bot accounts. Two defects are repaired:

1. **Excessive `;` runs** — JCMA escape-doubling turned single `;` into `;;;;` in some comment bodies. The DC comment body is the source of truth; we collapse Cloud runs to match DC.
2. **`@unknown` mentions** — DC `[~username]` mentions came across as unresolved mention nodes in Cloud ADF. We resolve them by DC user email (`GET /rest/api/2/user?username=...` → email → Cloud `/user/search?query=<email>` → exact email match → accountId) and rewrite the ADF mention node. Unresolvable mentions are replaced with plain text `@<displayName>` and logged.

Every Cloud comment update is sent with `?notifyUsers=false` so watchers are not spammed.

## Setup

```bash
cd jira/jira-data/mend_comments
npm install
cp .env.example .env   # or: ln -s ../recover_truncated_content/.env .env
```

The same credentials as `recover_truncated_content` work. Either copy that script's `.env` or symlink it.

## Workflow (3 phases)

```bash
# 1. Smoke-test notification suppression on a single ticket (before any real work)
node main/mend_comments.js notify-test --issue TEST-1

# 2. PLAN — scan Cloud, diff against DC, write proposed edits to logs/plan_<runId>.json
node main/mend_comments.js plan --projects ONE_KEY --limit 10            # smoke run
node main/mend_comments.js plan                                          # full run

# 3. AUDIT — emit human-readable CSV + MD of proposed edits
node main/mend_comments.js audit

# 4. APPLY — dry-run first (no Cloud writes), then real
node main/mend_comments.js apply --dry-run
node main/mend_comments.js apply --apply
```

### Flags

| Flag | Phase | Default | Purpose |
|---|---|---|---|
| `--projects K1,K2` | plan | all projects | Scope JQL to specific Cloud project keys |
| `--limit N` | plan | 0 (unlimited) | Cap issues processed |
| `--creators ID1,ID2` | plan | env `MEND_CREATOR_ACCOUNT_IDS` | Override the creator accountIds |
| `--issue KEY` | plan | none | Restrict plan to a single Cloud issue key |
| `--concurrency N` | plan | 5 | Parallel workers iterating issues |
| `--max-user-search-concurrency N` | plan | 2 | Cap on parallel Cloud /user/search calls |
| `--user-map-cache PATH` | plan | logs/user_map_cache.json | Persistent user resolution cache |
| `--probe` | plan | off | Dump mention shapes + JCMA properties for spot-check |
| `--plan-file PATH` | audit, apply | latest in logs/ | Specific plan to operate on |
| `--emit csv\|md\|both` | audit | both | Audit output format |
| `--dry-run` | apply | false | Log payloads, do NOT PUT |
| `--apply` | apply | required | Explicit go-ahead for live writes |
| `--resume` | apply | off | Skip already-completed issues |
| `--retry-failed` | apply | off | Re-attempt issues marked failed |

## How it decides what to change

A Cloud comment is touched only if:

- The owning issue's `creator.accountId` matches one of `--creators`.
- A DC counterpart comment can be paired (same key issue, within ±1s of `created`, same author email when resolvable).
- The mended ADF differs from the original (after the per-comment hash is recomputed).

If the comment was edited in Cloud between PLAN and APPLY (hash mismatch), apply skips it and logs `skipped_drift`.

## Strict scope

- **Only** Cloud comment bodies.
- Issue descriptions, summaries, custom fields, attachments — untouched.
- Only the two creator accountIds in `MEND_CREATOR_ACCOUNT_IDS` (override via `--creators`).
- Email-exact match for user resolution — no displayName / username-prefix fallback.
