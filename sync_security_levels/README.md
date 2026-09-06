# sync_security_levels

Restores **issue security levels** on Cloud issues from their Data Center counterparts.

> A longer design/handover write-up, including the known limitation around creating missing levels,
> is in [`HANDOVER.md`](./HANDOVER.md).

## Why it exists

Security level is an attribute of the issue that points at a level inside a scheme. Both the scheme
and the level get new ids on Cloud, and where a level did not migrate at all, the issue arrives with
no security level.

That failure is dangerous in the direction nobody notices: the issues become **more** visible, not
less. An HR or security project that was restricted on DC can land wide open on Cloud, and no error
is raised, because "no security level" is a perfectly valid state.

## What it does, and what it refuses to do

**Does:** for every Cloud issue in the DC scan, look up the DC security level by **name**, find the
matching level in the Cloud project's assigned scheme, and set it.

**Refuses:** to create levels that do not exist on Cloud. Where a name has no Cloud equivalent, the
issue is skipped and written to a CSV report listing exactly which levels must be created by hand,
in which schemes, first. Creating security levels programmatically and then filling them is how you
end up with a scheme nobody designed.

The script works when the project exists on both sides, the Cloud project has a security scheme
assigned, and the level name exists in that scheme.

## Setup

```bash
cd sync_security_levels
npm install
cp .env.example .env      # DC_BASE_URL, DC_USERNAME, DC_PASSWORD, CLOUD_BASE_URL, CLOUD_API_TOKEN
```

## Run

```bash
# 1. Plan. Produces the "missing levels" CSV — read it before anything else.
node main/sync_security_levels.js --plan-only --limit 200

# 2. Create any missing levels in the Cloud admin UI, then re-plan.

# 3. Dry run, then apply.
node main/sync_security_levels.js --dry-run
node main/sync_security_levels.js

# 4. Resume after interruption.
node main/sync_security_levels.js --resume --retry-failed
```

`test_scenarios.js` verifies a single issue end to end and is the fastest way to confirm credentials
and mapping before committing to a full run.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--dry-run` | off | Preview without writing. |
| `--limit <n>` | none | Cap DC issues scanned. |
| `--plan-only` | off | Build and save the plan, then stop. |
| `--execute-only` / `--resume` | off | Run an existing plan. |
| `--plan-file <path>` | latest | Master index JSON to resume from. |
| `--concurrency <n>` | 5 | Parallel Cloud `PUT`s. |
| `--retry-failed` | off | Also re-run rows whose status is `failed`. |
| `--help` | — | Usage. |

## Verify by absence

The right check is not "did the writes succeed". It is: log in as an account that should **not** see
a restricted issue, and confirm it cannot. A count of successful `PUT`s proves nothing about who can
now read what.
