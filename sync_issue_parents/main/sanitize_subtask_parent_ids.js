#!/usr/bin/env node

/**
 * Sanitize sub-task `Parent id` column in a DC-exported CSV for Jira Cloud import.
 *
 * The DC export writes DC-internal numeric ids in the `Parent id` column. Jira
 * Cloud's importer accepts that column (it maps to "parent") but expects the
 * Cloud-internal numeric id, not DC's. This script:
 *
 *   1. Collects every unique value in `Parent id`.
 *   2. Looks up each DC id -> DC issue key via DC REST API.
 *   3. Looks up each Cloud issue key -> Cloud numeric id via Cloud REST API.
 *   4. Rewrites the CSV with `Parent id` overwritten to the Cloud id.
 *      Unresolved values are blanked in the output and listed in an
 *      `<input>.unresolved.csv` companion file.
 *
 * Usage:
 *   node main/sanitize_subtask_parent_ids.js <input.csv> [--out <out.csv>]
 *                                              [--concurrency 8] [--dry-run]
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DatacenterClient = require("../src/datacenterClient");
const CloudJiraClient = require("../src/cloudJiraClient");

// ─────────────────────────────────────────────────────────────────────────────
// RFC 4180 CSV reader/writer (handles quoted fields with commas / newlines /
// escaped double-quotes). Built inline so the script has no extra deps beyond
// what the existing sync_issue_parents tool already uses.
// ─────────────────────────────────────────────────────────────────────────────

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      // swallow; \n handles row break (and lone \r becomes a row break too)
      if (i + 1 < n && text[i + 1] === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        i += 2;
        continue;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // flush last field/row if file doesn't end with newline
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function serializeCsv(rows) {
  return rows.map((r) => r.map(csvEscape).join(",")).join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookup helpers — minimal wrappers around the existing clients.
// ─────────────────────────────────────────────────────────────────────────────

async function resolveDcIdToKey(dcClient, dcId) {
  try {
    const res = await dcClient.makeRequest(
      "GET",
      `/rest/api/2/issue/${encodeURIComponent(dcId)}?fields=summary`,
    );
    return { dcId, key: res.key || null, error: null };
  } catch (e) {
    return { dcId, key: null, error: e.message };
  }
}

async function resolveCloudKeyToId(cloudClient, key) {
  try {
    const res = await cloudClient.makeRequest(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`,
    );
    return { key, cloudId: res.id || null, error: null };
  } catch (e) {
    return { key, cloudId: null, error: e.message };
  }
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const cur = idx++;
      if (cur >= items.length) return;
      results[cur] = await worker(items[cur], cur);
    }
  });
  await Promise.all(runners);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { input: null, output: null, concurrency: 8, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out") opts.output = args[++i];
    else if (a === "--concurrency") opts.concurrency = parseInt(args[++i], 10) || 8;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node sanitize_subtask_parent_ids.js <input.csv> [--out <out.csv>] [--concurrency N] [--dry-run]",
      );
      process.exit(0);
    } else if (!a.startsWith("--") && !opts.input) {
      opts.input = a;
    } else {
      console.warn(`Unknown arg: ${a}`);
    }
  }
  if (!opts.input) {
    console.error("Missing required <input.csv> argument.");
    process.exit(2);
  }
  if (!opts.output) {
    const parsed = path.parse(opts.input);
    opts.output = path.join(parsed.dir, `${parsed.name}.parent-mapped${parsed.ext}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  const required = ["DC_BASE_URL", "DC_USERNAME", "DC_PASSWORD", "CLOUD_BASE_URL", "CLOUD_API_TOKEN"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(", ")}`);
    process.exit(2);
  }

  console.log(`Input : ${opts.input}`);
  console.log(`Output: ${opts.output}`);
  console.log(`Concurrency: ${opts.concurrency}`);

  const raw = fs.readFileSync(opts.input, "utf8");
  const rows = parseCsv(raw);
  if (rows.length < 2) {
    console.error("CSV has no data rows.");
    process.exit(2);
  }

  const header = rows[0];
  const idxParentId = header.findIndex((h) => h.trim().toLowerCase() === "parent id");
  const idxIssueKey = header.findIndex((h) => h.trim().toLowerCase() === "issue key");
  const idxIssueId = header.findIndex((h) => h.trim().toLowerCase() === "issue id");
  if (idxParentId === -1) {
    console.error('Could not find "Parent id" column in header.');
    process.exit(2);
  }

  // Collect unique non-empty parent ids
  const inFileIssueIds = new Set();
  for (let r = 1; r < rows.length; r++) {
    if (idxIssueId !== -1 && rows[r][idxIssueId]) inFileIssueIds.add(rows[r][idxIssueId].trim());
  }

  const uniqueParentIds = new Set();
  let rowsWithParent = 0;
  for (let r = 1; r < rows.length; r++) {
    const v = rows[r][idxParentId];
    if (v && v.trim()) {
      rowsWithParent++;
      uniqueParentIds.add(v.trim());
    }
  }
  console.log(`Data rows: ${rows.length - 1}`);
  console.log(`Rows with Parent id: ${rowsWithParent}`);
  console.log(`Unique parent DC ids: ${uniqueParentIds.size}`);

  // Note: parents that ARE in the same file would be resolvable via Issue id ->
  // Issue key inside the CSV, but the Cloud importer handles that case itself
  // (numeric Parent id matching a row's Issue id). We only need to translate
  // parents that live outside the CSV — i.e. already in Cloud.
  const externalParents = [...uniqueParentIds].filter((id) => !inFileIssueIds.has(id));
  const inFileParents = uniqueParentIds.size - externalParents.length;
  console.log(`  Parents inside this CSV (no lookup needed): ${inFileParents}`);
  console.log(`  Parents external (need DC+Cloud lookup):   ${externalParents.length}`);

  if (externalParents.length === 0) {
    console.log("Nothing to translate. Exiting without writing output.");
    return;
  }

  // ── Step 1: DC id -> DC issue key ───────────────────────────────────────
  const dcClient = new DatacenterClient(
    process.env.DC_BASE_URL,
    process.env.DC_USERNAME,
    process.env.DC_PASSWORD,
  );
  const cloudClient = new CloudJiraClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN);

  console.log("\nStep 1: Testing connections...");
  if (!(await dcClient.testConnection())) {
    console.error("DC connection failed.");
    process.exit(1);
  }
  if (!(await cloudClient.testConnection())) {
    console.error("Cloud connection failed.");
    process.exit(1);
  }
  console.log("  DC + Cloud OK");

  console.log(`\nStep 2: Resolving ${externalParents.length} DC ids -> DC issue keys...`);
  let done = 0;
  const dcResults = await runWithConcurrency(externalParents, opts.concurrency, async (dcId) => {
    const r = await resolveDcIdToKey(dcClient, dcId);
    done++;
    if (done % 25 === 0 || done === externalParents.length) {
      console.log(`  ${done}/${externalParents.length}`);
    }
    return r;
  });

  const dcIdToKey = new Map();
  const dcErrors = [];
  for (const r of dcResults) {
    if (r.key) dcIdToKey.set(r.dcId, r.key);
    else dcErrors.push(r);
  }
  console.log(`  Resolved keys: ${dcIdToKey.size}  Failed: ${dcErrors.length}`);

  // ── Step 2: Cloud key -> Cloud numeric id ────────────────────────────────
  const keysToResolve = [...dcIdToKey.values()];
  console.log(`\nStep 3: Resolving ${keysToResolve.length} Cloud keys -> Cloud numeric ids...`);
  done = 0;
  const cloudResults = await runWithConcurrency(keysToResolve, opts.concurrency, async (key) => {
    const r = await resolveCloudKeyToId(cloudClient, key);
    done++;
    if (done % 25 === 0 || done === keysToResolve.length) {
      console.log(`  ${done}/${keysToResolve.length}`);
    }
    return r;
  });

  const keyToCloudId = new Map();
  const cloudErrors = [];
  for (const r of cloudResults) {
    if (r.cloudId) keyToCloudId.set(r.key, r.cloudId);
    else cloudErrors.push(r);
  }
  console.log(`  Resolved cloud ids: ${keyToCloudId.size}  Failed: ${cloudErrors.length}`);

  // ── Step 3: Build final DC id -> Cloud id map and rewrite CSV ───────────
  const dcIdToCloudId = new Map();
  const unresolved = []; // { dcId, dcKey, reason }
  for (const dcId of externalParents) {
    const key = dcIdToKey.get(dcId);
    if (!key) {
      const e = dcErrors.find((x) => x.dcId === dcId);
      unresolved.push({ dcId, dcKey: "", reason: `DC lookup failed: ${e?.error || "unknown"}` });
      continue;
    }
    const cloudId = keyToCloudId.get(key);
    if (!cloudId) {
      const e = cloudErrors.find((x) => x.key === key);
      unresolved.push({ dcId, dcKey: key, reason: `Cloud lookup failed: ${e?.error || "unknown"}` });
      continue;
    }
    dcIdToCloudId.set(dcId, cloudId);
  }
  console.log(
    `\nFinal mapping: ${dcIdToCloudId.size} resolved, ${unresolved.length} unresolved (will be blanked in output)`,
  );

  // Rewrite rows
  let overwritten = 0;
  let blanked = 0;
  const childrenOfUnresolvedParents = new Map(); // parent dcId -> [child keys]
  for (let r = 1; r < rows.length; r++) {
    const cur = rows[r][idxParentId];
    if (!cur || !cur.trim()) continue;
    const dcId = cur.trim();
    if (!externalParents.includes(dcId)) continue; // in-file parent, leave alone
    const cloudId = dcIdToCloudId.get(dcId);
    if (cloudId) {
      rows[r][idxParentId] = String(cloudId);
      overwritten++;
    } else {
      rows[r][idxParentId] = "";
      blanked++;
      const childKey = idxIssueKey !== -1 ? rows[r][idxIssueKey] : "(row " + r + ")";
      const list = childrenOfUnresolvedParents.get(dcId) || [];
      list.push(childKey);
      childrenOfUnresolvedParents.set(dcId, list);
    }
  }
  console.log(`Rows overwritten with Cloud id: ${overwritten}`);
  console.log(`Rows blanked (unresolved parent): ${blanked}`);

  if (opts.dryRun) {
    console.log("\n*** DRY RUN — not writing output files ***");
  } else {
    fs.writeFileSync(opts.output, serializeCsv(rows), "utf8");
    console.log(`\nWrote sanitized CSV: ${opts.output}`);

    if (unresolved.length > 0) {
      const parsed = path.parse(opts.output);
      const unresolvedPath = path.join(parsed.dir, `${parsed.name}.unresolved.csv`);
      const unresolvedRows = [
        ["DC Parent Id", "DC Issue Key", "Affected Child Keys", "Reason"],
        ...unresolved.map((u) => [
          u.dcId,
          u.dcKey,
          (childrenOfUnresolvedParents.get(u.dcId) || []).join(" "),
          u.reason,
        ]),
      ];
      fs.writeFileSync(unresolvedPath, serializeCsv(unresolvedRows), "utf8");
      console.log(`Wrote unresolved report: ${unresolvedPath}`);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  console.error(e.stack);
  process.exit(1);
});
