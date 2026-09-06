# sync_traffic_light_fields

Copies **traffic-light / Health status field** values from Data Center to Cloud, translating the
Data Center option string into the shape Cloud expects.

## Why it needs its own script

Traffic-light fields are not plain selects. On Data Center the stored value is a string that encodes
the lamp positions, e.g. `(,,red) Red`. On Cloud the app stores a structured object:

```json
{ "shape": "🔴⚪⚪", "label": "Red" }
```

A generic field copier sees a string on one side and an object on the other, decides the types are
incompatible, and skips the field — or worse, writes the raw DC string and leaves a field that
renders as garbage. The translation is a lookup, not an inference, so it lives in a config file you
review rather than in code that guesses.

## The mapping file

`config/field_mappings.json` — one entry per field:

```json
{
  "fields": [
    {
      "name": "Delivery Confidence",
      "dcFieldId": "customfield_19951",
      "cloudFieldId": "customfield_11251",
      "options": [
        { "shape": "🔴⚪⚪", "label": "Red" },
        { "shape": "⚪🟠⚪", "label": "Amber" },
        { "shape": "⚪⚪🟢", "label": "Green" }
      ]
    }
  ]
}
```

Fill in your own field ids and the exact option labels your Cloud app produces. Create one value by
hand in the Cloud UI and read it back over REST if you are unsure — do not guess the shape string.

## Setup

```bash
cd sync_traffic_light_fields
npm install
cp .env.example .env       # DC_BASE_URL, DC_USERNAME, DC_PASSWORD, CLOUD_BASE_URL, CLOUD_API_TOKEN
# then edit config/field_mappings.json
```

## The two phases

**Phase 1 — plan.** Scan the DC values for each configured field, map them to Cloud shapes, and write
an execution plan. Any DC option with no mapping entry is reported and never written.

**Phase 2 — execute.** Concurrent `PUT`s to Cloud, resumable from the plan.

## Run

```bash
node main/sync_traffic_light_fields.js --dry-run --limit 20
node main/sync_traffic_light_fields.js --plan-only
node main/sync_traffic_light_fields.js
node main/sync_traffic_light_fields.js --resume
```

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--dry-run` | off | Preview without writing. |
| `--limit <n>` | none | Cap tickets processed per field. |
| `--plan-only` | off | Build and save the plan, then stop. |
| `--execute-only` / `--resume` | off | Run an existing plan. |
| `--plan-file <path>` | latest | Master index JSON to resume from. |
| `--concurrency <n>` | 10 | Parallel Cloud `PUT`s. |
| `--help` | — | Usage. |

## Verify it properly

Open two or three issues in the Cloud UI after the first batch. A traffic-light field that stored an
almost-right shape string writes without error and renders wrong — the API will not tell you, only
the browser will.
