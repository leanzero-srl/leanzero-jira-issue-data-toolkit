# LeanZero Jira Issue Data Toolkit

Twelve Node.js tools that **find and repair the issue data a Jira migration lost** — field values,
comments, links, parents, attachments, security levels and truncated bodies — using Data Center as
the source of truth.

Apache-2.0. Public REST only, over Node's built-in `https`. Nothing to install on a server.

---

## The problem this exists for

A bulk migration reports success at the level of *issues moved*. It says nothing about what is inside
them. The failures below are all real, all silent, and all found weeks later by a user rather than by
the migration report:

- A custom field exists on both sides under the same name, and arrives **empty** on Cloud, because
  the field ids differ and the mapping picked the wrong twin.
- The migration created a **`(migrated)`-suffixed duplicate** of a field, populated *that*, and left
  the field on your screens blank.
- **Comments** arrive with mangled escape sequences and `@unknown` where a mention used to be.
- **Descriptions and comments arrive truncated at exactly 32,767 characters** — Cloud's hard cap on
  the serialized ADF length.
- **Links, parents, attachments** are missing wherever only one end of the relationship migrated.
- **Security levels** are gone, which makes restricted issues *more* visible, not less.

---

## What is in the box

### Field values

| Tool | What it does |
|---|---|
| [`sync_custom_fields`](./sync_custom_fields) | Copies custom-field values DC → Cloud, DC as source of truth. Matches fields by **name**, refuses to guess when two writable Cloud targets share one, and reports the ambiguity for you to pin in a config file. |
| [`sync_same_instance_fields`](./sync_same_instance_fields) | Copies values from `(migrated)` duplicate fields into the real field, **on the same Cloud site**. Handles type translation and denylists the false twins. |
| [`sync_traffic_light_fields`](./sync_traffic_light_fields) | Traffic-light / Health fields, whose DC string value has to be translated into the `{shape, label}` object Cloud stores. |
| [`field_merge`](./field_merge) | Merges one field into another across all data types — same instance or cross instance — plus an **automation-field-checker** that tells you which automation rules reference a field *before* you delete it. |

### Issue content

| Tool | What it does |
|---|---|
| [`sync_issue_comments`](./sync_issue_comments) | Injects missing DC comments into Cloud, preserving per-comment visibility (JSM internal/public, plus classic role and group restrictions). Tags every comment it creates so re-runs skip it. |
| [`mend_comments`](./mend_comments) | Repairs comments that *did* migrate but arrived damaged: collapses escape-doubled `;;;;` runs back to what DC holds, and resolves `@unknown` mentions to real Cloud accounts by email. |
| [`recover_truncated_content`](./recover_truncated_content) | Finds every description/comment cut at exactly 32,767 characters, recovers the full text from DC, and attaches it as a `.docx` so nothing is lost while the field itself stays untouched. |
| [`sync_issue_attachments`](./sync_issue_attachments) | Re-uploads attachments present on DC and missing on Cloud, matched by filename + byte size. |

### Issue relationships and metadata

| Tool | What it does |
|---|---|
| [`sync_issue_parents`](./sync_issue_parents) | Rebuilds sub-task parents, Epic Links and next-gen parents. Never overwrites an existing parent; reports rather than guesses when the DC parent is not on Cloud. Also does `reporter` and `assignee`. |
| [`sync_issue_links`](./sync_issue_links) | Recreates missing issue links, preserving type and direction, with global deduplication so a link that appears on both endpoints is created exactly once. |
| [`sync_security_levels`](./sync_security_levels) | Restores issue security levels by level **name**. Refuses to create levels that do not exist on Cloud — it reports them for a human to create first. |
| [`tempo_worklog_resync`](./tempo_worklog_resync) | Repairs the Jira/Tempo desync left behind when worklogs are moved with Jira's own REST API, which Tempo never sees. |

---

## Start here

```bash
git clone https://github.com/leanzero-srl/leanzero-jira-issue-data-toolkit.git
cd leanzero-jira-issue-data-toolkit/sync_custom_fields
npm install
cp .env.example .env
```

`.env` is the same across every tool in this repo, so you can write it once and symlink:

```bash
DC_BASE_URL=https://jira-dc.example.com
DC_PAT=your-personal-access-token          # or DC_USERNAME + DC_PASSWORD
CLOUD_BASE_URL=https://your-site.atlassian.net
CLOUD_API_TOKEN=base64-of-email-colon-apitoken
```

```bash
ln -s ../sync_custom_fields/.env .env      # from any sibling directory
```

Then, always in this order:

```bash
node main/sync_custom_fields.js field-report --projects ABC --limit 10   # 1. what would map to what
node main/sync_custom_fields.js plan --projects ABC --limit 200          # 2. reviewable plan, no writes
node main/sync_custom_fields.js audit                                    # 3. seeded sample check
node main/sync_custom_fields.js apply --dry-run                          # 4. the run, without the PUT
node main/sync_custom_fields.js apply                                    # 5. for real
```

---

## How every tool in this repo behaves

**Four phases: report → plan → audit → apply.** The report tells you what the tool *thinks* maps to
what — this is where wrong field pairings are caught, on ten issues, not on ten thousand. The plan is
a JSON file you can read. The audit spot-checks a seeded sample. Only then does anything write.

**Names, not ids.** Custom field ids differ between DC and Cloud, so everything matches on name — and
therefore every tool has to handle duplicate names. The rule throughout is: **when two candidates are
equally valid, refuse and report.** You pin the answer in a config file. No tool guesses which
`Segment` you meant.

**Idempotent and resumable.** Every created object is tagged with its DC origin (a comment property,
a plan row), so a second run skips it. An interrupted run resumes from its plan file with
`--resume`, and `--retry-failed` re-runs only the rows that failed.

**Notifications are muted by default.** Writing to thousands of issues generates thousands of emails
and will get the migration account throttled. Tools that write clone the affected project's
notification scheme, strip it, use the stripped copy for the run, and restore the original
afterwards — with a snapshot, and a `--restore-only` mode for when a run dies mid-flight. Run that
first if a previous run was interrupted.

**Re-checked at write time.** A plan built yesterday is re-validated against live state before each
write, so it can never act on a state that has since changed.

---

## The rule that matters

**A green number is not a passing test.** "4,801 values written" is not "the field is populated" —
it is not even "the field is on the screen". Before you believe any run:

1. Open three issues in the browser and look at the field. A value written to a field that is not on
   the project's edit screen writes successfully and shows nothing.
2. Check the **whole** expected result, not the first field that worked.
3. For anything visibility-shaped, verify by *absence*: log in as someone who should not see a
   restricted issue and confirm they cannot.

Every one of these tools was written after a proxy metric said something was fine and it was not.

---

## Licence

Apache-2.0. See [LICENSE](./LICENSE).

Built by [LeanZero](https://leanzero.net) during real Atlassian Cloud migrations.
