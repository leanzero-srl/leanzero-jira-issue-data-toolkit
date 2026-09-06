# sync_issue_comments

Inject missing DC Jira comments into Cloud for issues matching a JQL. Comment **visibility** (JSM `sd.public.comment` internal/public flag, plus classic role/group `visibility`) is preserved per-comment with the same fidelity DC reports.

Designed for post-JCMA cleanup on JSM projects where some Cloud issues lost comments. Safely re-runnable: every comment we create is tagged with `migration.dc_comment_id` so the next run skips it.

## Setup

```bash
cd jira/jira-data/sync_issue_comments
npm install
cp .env.example .env   # or: ln -s ../recover_truncated_content/.env .env
```

The same credentials as `mend_comments` / `recover_truncated_content` work.

## Workflow

```bash
# 1. Smoke-test notification suppression on a single ticket
node main/sync_issue_comments.js notify-test --issue TEST-1

# 2. PLAN — JQL→Cloud issues, pair with DC, propose injects
node main/sync_issue_comments.js plan --issue JSM-123                       # one issue
node main/sync_issue_comments.js plan --projects JSM --limit 10             # smoke
node main/sync_issue_comments.js plan --projects JSM                        # full

# 3. AUDIT — human-readable CSV + Markdown
node main/sync_issue_comments.js audit

# 4. APPLY — dry-run first; mute defaults ON
node main/sync_issue_comments.js apply --dry-run
node main/sync_issue_comments.js apply --apply
```

## Flags

| Flag | Phase | Default | Purpose |
|---|---|---|---|
| `--projects K1,K2` | plan | all | Restrict JQL to Cloud project keys |
| `--issue KEY` | plan | none | Single Cloud issue |
| `--keys K1,K2` | plan | none | Comma list of Cloud issue keys |
| `--limit N` | plan | 0 (unlimited) | Cap issues processed |
| `--concurrency N` | plan/apply | 5/3 | Parallel workers |
| `--newest` | plan | off | ORDER BY created DESC |
| `--user-map-cache PATH` | plan | logs/user_map_cache.json | Persistent user cache (shared with mend_comments) |
| `--plan-file PATH` | audit, apply | latest in logs/ | Specific plan |
| `--emit csv\|md\|both` | audit | both | Audit output format |
| `--dry-run` | apply | off | Log payloads, no POSTs |
| `--apply` | apply | required | Explicit go-ahead for live writes |
| `--resume` | apply | off | Skip already-completed issues |
| `--retry-failed` | apply | off | Re-attempt failed issues |
| `--no-mute-notifications` | apply | mute ON | Disable per-project notification scheme swap |
| `--strict-visibility` | apply | off | Promote `visibility_unknown` from default-internal to hard-skip |
| `--restore-only-notifications` | apply | off | Crash-recovery: restore pending notification snapshots |

## How it decides what to inject

A DC comment is created in Cloud only when:

1. No Cloud comment carries a `migration.dc_comment_id` property equal to the DC comment id (we did not already inject it).
2. No Cloud comment can be paired with it by (created within ~±65s, author email matches) — JCMA's own counterpart, if present, takes precedence.

The result is the `unmatchedDc` set from `mend_comments/src/commentPairer.js` minus anything tagged by a prior run.

## Oversized comments (auto-split)

Cloud silently truncates any comment whose serialized ADF body exceeds **32,767 characters** (`JSON.stringify(body).length` — the same cap `recover_truncated_content` detects). Rather than truncate or off-load to a `.docx` attachment, this script **splits** an oversized comment into multiple sequential comments. A comment `B` that is too large becomes `B1, B2, B3` posted consecutively, so the issue's comment stream reads `A, B1, B2, B3, C`.

- Splitting happens in the **plan** phase (`src/adfSplitter.js`), targeting ≤ 30,000 chars per part to leave headroom for the attribution line, the part marker, and Cloud-side ADF normalization. It splits on block boundaries first (paragraphs, list items, code-block lines, blockquote blocks), and falls back to splitting inside a single huge paragraph/code block when one block alone exceeds the budget.
- **Part 1** keeps the `> Originally posted by @user on <date>` attribution; **parts 2..N** start with an italic `(continued — part N of M)` marker.
- The split is **deterministic** — identical input yields identical part boundaries every run.
- Each part is tagged with `migration.dc_comment_id` (same value for every part) plus `migration.part_index` / `migration.part_total`. A re-run treats a comment as fully migrated only when **all** of its parts exist; if a prior run created only some parts (e.g. it failed mid-comment), the next plan/apply **tops up the missing parts in order** rather than duplicating or leaving a broken chain. Apply stops at the first failed part so the posted parts always form an unbroken prefix.
- A split that couldn't fall on clean structural boundaries (e.g. a heading demoted to paragraphs, or a paragraph chopped mid-text) is flagged `migration.fidelity = "adf_partial_split"`. The audit shows `split into N parts` per affected comment and a `partTotal` column in the CSV.

Pure-function tests: `node src/adfSplitter.test.js` and `node src/commentDiffer.test.js`.

## Visibility fidelity (JSM)

Source-of-truth chain per DC comment:

1. **DC comment property `sd.public.comment`** with `{internal:true|false}` — fetched via `?expand=properties` on the comment endpoint.
2. **JSM Service Desk API fallback** — `/rest/servicedeskapi/request/{key}/comment` exposes a `public:bool` per comment; we cross-check when the property is missing.
3. **Default-to-internal** when both sources are empty. Each such write is logged as `visibilityFallback: "default_internal"` and is invisible to the customer portal. `--strict-visibility` flips this default into a hard skip.

Classic role/group `visibility` (rare on JSM) is passed through untouched on the POST.

## What is preserved vs lost

| Aspect | Preserved? |
|---|---|
| Body text + basic formatting (paragraphs, headings, lists, blockquote, code, bold/italic, links) | Yes |
| @mentions (re-resolved via DC user email → Cloud accountId) | Yes when the user exists in Cloud; otherwise rendered as plain text |
| JSM internal/public flag | Yes (with fallback rules above) |
| Role/group `visibility` | Yes (passthrough) |
| Original author identity | Recorded as a blockquote prefix `> Originally posted by @user on <date>`. Cloud will list the API user as the actual author. |
| Inline attachments / wiki macros / panels | Not in v0.1 — flagged as `migration.fidelity = "plaintext_fallback"` if a comment can't be cleanly converted |
| Comments larger than Cloud's 32,767-char body cap | Yes — auto-split into `B1, B2, B3` sequential comments (see *Oversized comments* above) instead of being truncated |

## Strict scope

- **Only** creates new Cloud comments. Never edits, never deletes existing ones.
- **Only** comments on issues matched by the user-supplied JQL.
- The `mend_comments` script is the right tool for editing already-migrated comments — this one is its complement, not a replacement.
