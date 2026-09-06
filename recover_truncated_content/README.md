# recover_truncated_content

After a Jira DC → Cloud migration (typically via JCMA), some descriptions and comments arrive **truncated at exactly 32,767 characters** — Cloud's hard cap on the serialized ADF JSON length for these fields. This script:

1. **Scans** every Cloud issue across every project and flags any description / comment whose `JSON.stringify(body).length === 32767`.
2. **Recovers** the full text from the matching Data Center issue (using `expand=renderedFields` to get HTML for rich-text fidelity).
3. **Generates** `.docx` files on disk:
   - `reports/docx/{KEY}_description.docx` — when the description was truncated.
   - `reports/docx/{KEY}_comment.docx` — when **any** comment on the issue was truncated; the docx contains **all** comments on that issue in chronological order so the reviewer sees full context.
   - Files larger than 10 MB split into `{KEY}_comment_1.docx`, `_2.docx`, ...
4. **In apply mode** (`--apply`), uploads each docx as an attachment on the matching Cloud issue. The Cloud description/comment bodies themselves are **not** modified.

## Setup

```bash
cd recover_truncated_content
npm install
cp .env.example .env       # then fill in DC + Cloud credentials
```

`.env` needs:
- `DC_BASE_URL`
- `DC_PAT` (preferred) **OR** `DC_USERNAME` + `DC_PASSWORD`
- `CLOUD_BASE_URL`
- `CLOUD_API_TOKEN` (base64-encoded `email:api_token` — `echo -n "email:token" | base64`)

## Usage

### Plan mode (default — safe, no Cloud writes)

```bash
# Smoke test against one issue
node main/recover_truncated_content.js --projects PROJ --limit 1

# Single project, all issues
node main/recover_truncated_content.js --projects PROJ

# Full instance scan (resumable via logs/checkpoint.jsonl)
node main/recover_truncated_content.js
```

Outputs:
- `reports/docx/{KEY}_description.docx`, `reports/docx/{KEY}_comment[_n].docx`
- `logs/master_<runId>.json` — plan metadata + stats
- `logs/plan_<runId>.json` — per-issue plan with file paths + upload status
- `logs/truncation_summary_<runId>.csv` — one row per affected issue
- `logs/checkpoint.jsonl` — per-project completion record (for resume)
- `logs/recover_<timestamp>.log` — append-only run log

### Apply mode (uploads docx as attachments on the Cloud issues)

```bash
# Dry-run first — walks the latest plan, logs what would upload, no writes
node main/recover_truncated_content.js --apply --dry-run

# Real apply (uses the latest master_*.json by default)
node main/recover_truncated_content.js --apply

# Apply a specific plan, retry rows previously marked failed
node main/recover_truncated_content.js --apply --plan-file logs/master_1719340000000.json --retry-failed
```

`--apply` requires an existing plan from a prior plan-mode run.

### CLI reference

| Flag | Default | Purpose |
|---|---|---|
| `--projects K1,K2` | all projects | Restrict scan to specific Cloud project keys |
| `--limit N` | 0 (unlimited) | Cap issues per project — for smoke tests |
| `--apply` | false | Switch from plan-mode to apply-mode (uploads docx) |
| `--plan-file PATH` | latest master | Specific plan to apply/resume |
| `--resume` | false | Continue an existing plan |
| `--retry-failed` | false | Re-attempt issues with status `failed` |
| `--concurrency N` | 3 | Worker count for apply phase |
| `--dry-run` | false | With `--apply`: log uploads without executing |
| `--key-map FILE` | none | JSON `{ "CLOUD-KEY": "DC-KEY" }` for issues whose keys differ between DC and Cloud (JCMA preserves keys by default) |
| `--max-docx-bytes N` | 10485760 | Split threshold (clamped to Cloud `maxAttachmentSize` at runtime) |

## How detection works

Cloud's 32,767-character cap applies to the **serialized ADF JSON** of the description / comment body, not to the rendered plain text. So a truncated description does NOT necessarily have 32,767 visible characters — it has 32,767 characters of `JSON.stringify(adfBody)`.

Helper (`src/truncationDetector.js`):

```js
function adfJsonLength(body) {
  if (body == null) return 0;
  if (typeof body === "string") return body.length;     // very old Cloud sites return strings
  return JSON.stringify(body).length;
}
function isTruncated(body) { return adfJsonLength(body) === 32767; }
```

If your migration produced a slightly different boundary (e.g., the converter stopped at the last ADF node boundary just under 32,767), edit the predicate to `>= 32767` and re-run plan-mode.

## DC ↔ Cloud key mapping

JCMA preserves issue keys by default — `PROJ-123` in DC is `PROJ-123` in Cloud. If your migration deviated, pass `--key-map` with a JSON object:

```json
{
  "NEWPROJ-1": "OLDPROJ-1",
  "NEWPROJ-2": "OLDPROJ-2"
}
```

## Known v1 limitations

1. **Embedded images are not downloaded.** DC images in descriptions/comments use authenticated `/secure/attachment/...` URLs. v1 strips `<img>` tags and substitutes `<em>[Image: filename.png]</em>` text placeholders so the docx renders cleanly. A future `--embed-images` flag could pre-download via the DC client.
2. **Complex Atlassian macros** (`<ac:structured-macro>`, `<ac:link>`, ...) inside DC renderedFields HTML may render as plain text in the docx. Common cases work; obscure macros may need defensive unwrap rules added to `src/docxBuilder.js`.
3. **Cloud bodies are not modified.** v1 only attaches the recovery docx files. If you want the Cloud body to be replaced with a pointer comment (e.g., "Full description in attachment X"), that's a future v2 feature.
4. **Comment matching is not 1:1 with DC.** The docx for an issue contains all DC comments in chronological order — the reviewer compares them against the Cloud comments themselves. We don't try to match Cloud comment IDs to DC comment IDs.

## Architecture notes

- Self-contained — no shared libs. `package.json` adds only `dotenv` + `html-to-docx`.
- DC + Cloud REST clients use Node's built-in `https`/`http` with manual retry/backoff (429: exponential up to 120s/60s, honoring `Retry-After`; 5xx: exponential up to 30s/10s).
- Two-phase plan/apply mirrors `../sync_issue_attachments/` so behaviors and flag names are familiar.
- Per-project `checkpoint.jsonl` (compatible with `../find_missing_issues/`) makes plan-mode resumable.
- Manual worker pool (no `p-limit`) for apply concurrency.

## Verification path

1. **Smoke**: `--projects PROJ --limit 1` against an issue you know is truncated. Open the resulting `.docx` in Word/Pages. Then `--apply --dry-run` against the plan, then real apply, then verify the attachment in Cloud.
2. **One project**: `--projects PROJ`. Spot-check ~5 docx files, confirm the checkpoint line, then apply.
3. **Full instance**: no flags. Resumable via Ctrl-C. Review `truncation_summary_<runId>.csv` before applying.
4. **Full apply**: `--apply --plan-file logs/master_<runId>.json`.
