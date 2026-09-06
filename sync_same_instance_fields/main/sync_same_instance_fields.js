#!/usr/bin/env node
/**
 * sync_same_instance_fields — copy custom-field values from (migrated) source
 * fields to their non-(migrated) target fields on the SAME Jira Cloud instance.
 *
 * Phases:
 *   field-report  read-only — dump resolved source<->target map + ambiguities for sample issues
 *   plan          read-only — compute per-field diffs, write plan + reports
 *   audit         render plan as CSV + Markdown
 *   apply         PUT updates (--dry-run | --apply), idempotent, resumable
 *
 * See README.md for usage.
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config();

const CloudJiraClient = require("../src/cloudJiraClient");
const fieldResolver = require("../src/fieldResolver");
const fieldDiffer = require("../src/fieldDiffer");
const registry = require("../src/typeRegistry");
const auditWriter = require("../src/auditWriter");
const PlanManager = require("../src/planManager");
const NotificationMuter = require("../src/notificationMuter");
const fieldEnabler = require("../src/fieldEnabler");

const SCRIPT_DIR = path.join(__dirname, "..");
const LOGS_DIR = path.join(SCRIPT_DIR, "logs");
const REPORTS_DIR = path.join(SCRIPT_DIR, "reports");
const CONFIG_DIR = path.join(SCRIPT_DIR, "config");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function timestampRunId() {
  return new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
}

function makeLogger(runId, phase) {
  ensureDir(LOGS_DIR);
  const file = path.join(LOGS_DIR, `${phase}_${runId}.log`);
  const fd = fs.openSync(file, "a");
  return {
    log: (msg) => {
      const line = `[${new Date().toISOString()}] ${msg}`;
      console.log(line);
      try { fs.writeSync(fd, line + "\n"); } catch { /* ignore */ }
    },
    file,
    close: () => { try { fs.closeSync(fd); } catch { /* ignore */ } },
  };
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error(`  WARN: failed to parse ${filePath}: ${e.message}`);
    return fallback;
  }
}

function loadConfig(opts) {
  const cfgPath = opts.config || path.join(CONFIG_DIR, "config.json");
  const cfg = loadJson(cfgPath, {});
  return {
    jql: opts.jql || cfg.jql || "",
    concurrency: cfg.concurrency || { plan: 5, apply: 3 },
    fieldDenylist: cfg.fieldDenylist || [],
    fieldPairs: cfg.fieldPairs || [],
    richTextOverwrite: cfg.richTextOverwrite || "missing_only",
    recheckBeforeApply: cfg.recheckBeforeApply !== false,
    muteNotifications: cfg.muteNotifications !== false,
  };
}

function parseArgs(argv) {
  const opts = {
    mode: argv[2],
    projects: null,
    issue: null,
    keys: null,
    limit: 0,
    concurrency: null,
    planFile: null,
    config: null,
    jql: null,
    dryRun: false,
    apply: false,
    resume: false,
    retryFailed: false,
    recheck: null,
    muteNotifications: true,
    restoreOnly: false,
    restore: false,
    manifest: null,
    extendContexts: false,
  };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--projects": opts.projects = argv[++i].split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--issue": opts.issue = argv[++i]; break;
      case "--keys": opts.keys = argv[++i].split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--limit": opts.limit = parseInt(argv[++i], 10) || 0; break;
      case "--concurrency": opts.concurrency = parseInt(argv[++i], 10) || null; break;
      case "--plan-file": opts.planFile = argv[++i]; break;
      case "--config": opts.config = argv[++i]; break;
      case "--jql": opts.jql = argv[++i]; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--apply": opts.apply = true; break;
      case "--resume": opts.resume = true; break;
      case "--retry-failed": opts.retryFailed = true; break;
      case "--recheck": opts.recheck = true; break;
      case "--no-recheck": opts.recheck = false; break;
      case "--no-mute-notifications": opts.muteNotifications = false; break;
      case "--restore-only-notifications": opts.restoreOnly = true; break;
      case "--restore": opts.restore = true; break;
      case "--manifest": opts.manifest = argv[++i]; break;
      case "--extend-contexts": opts.extendContexts = true; break;
      case "--help": case "-h": opts.help = true; break;
      default: console.error(`  WARN: unknown arg ${a}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`sync_same_instance_fields — copy custom-field values from (migrated) sources to targets on the same Cloud instance

USAGE
  node main/sync_same_instance_fields.js <phase> [options]

PHASES
  field-report   read-only: resolved source<->target field map + ambiguities for sample issues
  prepare        make targets writable: add missing select options, un-hide in field
                 config, add to edit screens. Dry-run by default; --apply to execute,
                 --restore to undo. Run this BEFORE plan on a fresh instance.
  plan           read-only: compute per-field diffs -> logs/plan_<runId>.json + reports
  audit          render latest (or --plan-file) plan -> reports/audit_<runId>.{csv,md}
  apply          PUT updates: requires --dry-run or --apply
                 (migrated) sources → non-(migrated) targets on the same Cloud instance

PREPARE
  --apply              execute the screen/field-config/option changes (default: dry-run)
  --extend-contexts    also auto-extend an existing field context to cover a project/
                       issuetype it doesn't yet (opt-in, reversible via --restore).
                       Without this flag such gaps are only WARNED about, never changed.
  --restore            undo a previous prepare (latest manifest, or --manifest PATH)
  --manifest PATH      explicit prepare manifest for --restore

SELECTION
  --jql "<JQL>"        Cloud JQL (overrides config.jql)
  --projects A,B       restrict to these project keys
  --issue KEY          single issue
  --keys K1,K2         explicit issue list
  --limit N            cap issues scanned

APPLY
  --dry-run            log intended PUTs, write nothing
  --apply              perform the writes
  --resume             skip issues already completed
  --retry-failed       also re-run failed issues
  --recheck/--no-recheck   re-read target before writing (default: config)
  --no-mute-notifications  do NOT mute "Issue Updated" (watchers WILL be emailed)

  --plan-file PATH     operate on a specific plan
  --config PATH        alternate config.json
`);
}

function buildClient() {
  const cloudBase = process.env.CLOUD_BASE_URL;
  const cloudToken = process.env.CLOUD_API_TOKEN;
  if (!cloudBase || !cloudToken) throw new Error("CLOUD_BASE_URL and CLOUD_API_TOKEN are required (.env)");
  return new CloudJiraClient(cloudBase, cloudToken);
}

async function runWorkerPool(items, workerFn, concurrency) {
  const n = Math.max(1, concurrency | 0);
  let cursor = 0;
  const workers = [];
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        try { await workerFn(items[idx], idx); }
        catch (e) { console.error(`  [worker ${w}] item ${idx}: ${e.message}`); }
      }
    })());
  }
  await Promise.all(workers);
}

// Build the shared field indexes (global field catalog), cached to disk.
async function buildFieldIndexes(client, log) {
  const cachePath = path.join(LOGS_DIR, "field_index_cache.json");
  const cloudFields = await client.getFields();
  log(`  Field catalog: ${cloudFields.length} fields`);
  try {
    fs.writeFileSync(cachePath, JSON.stringify({ at: new Date().toISOString(), fields: cloudFields.length }, null, 2));
  } catch { /* ignore */ }
  return {
    nameIndex: fieldResolver.buildNameIndex(cloudFields),
    idIndex: fieldResolver.buildIdIndex(cloudFields),
  };
}

// Build a lc-name keyed Map of per-field option remaps.
function buildOptionMaps() {
  const raw = loadJson(path.join(CONFIG_DIR, "option_value_map.json"), { maps: {} });
  const m = new Map();
  for (const [name, map] of Object.entries(raw.maps || {})) {
    m.set(String(name).trim().toLowerCase(), map);
  }
  return m;
}

function denylistSet(config) {
  return new Set((config.fieldDenylist || []).map((s) => String(s).trim().toLowerCase()));
}

async function resolveIssueKeys(client, opts, config, log) {
  if (opts.issue) return [opts.issue];
  if (opts.keys && opts.keys.length) return opts.keys;
  let jql;
  if (opts.projects && opts.projects.length) {
    jql = `project in (${opts.projects.join(",")}) ORDER BY updated DESC`;
  } else {
    jql = config.jql;
  }
  if (!jql) throw new Error("No issue selection — provide --issue/--keys/--projects or config.jql");
  log(`  Cloud JQL: ${jql}`);
  const issues = await client.searchIssues(jql, "key", 100);
  let keys = issues.map((i) => i.key);
  if (opts.limit > 0) keys = keys.slice(0, opts.limit);
  return keys;
}

/* ─────────────────────────── PHASE: plan ─────────────────────────── */

async function runPlan(opts) {
  ensureDir(LOGS_DIR);
  const runId = timestampRunId();
  const logger = makeLogger(runId, "plan");
  const { log } = logger;
  const config = loadConfig(opts);
  log(`sync_same_instance_fields plan — runId=${runId}`);

  const client = buildClient();
  if (!(await client.testConnection())) throw new Error("Cloud connection failed");

  const indexes = await buildFieldIndexes(client, log);
  const overrides = fieldResolver.loadOverrides(loadJson(path.join(CONFIG_DIR, "field_overrides.json"), { overrides: [] }));
  const optionMaps = buildOptionMaps();
  const denylist = denylistSet(config);
  const explicitPairs = config.fieldPairs.map((p) => ({
    sourceName: p.sourceName,
    targetName: p.targetName,
  }));

  const keys = await resolveIssueKeys(client, opts, config, log);
  log(`  ${keys.length} issue(s) to scan`);

  const planManager = new PlanManager(LOGS_DIR, log);
  planManager.createMasterIndex(runId, { jql: config.jql || null, mode: "same_instance_fields" });
  planManager.openHitsJsonl(runId);

  const ctx = { optionMaps, richTextOverwrite: config.richTextOverwrite };
  const globalAmbiguities = [];
  const skipHistogram = {};
  let scanned = 0;
  let withChanges = 0;

  const concurrency = opts.concurrency || config.concurrency.plan || 5;
  await runWorkerPool(keys, async (issueKey) => {
    let cloudIssue, editmeta;
    try {
      [cloudIssue, editmeta] = await Promise.all([
        client.getIssueFields(issueKey),
        client.getEditMeta(issueKey),
      ]);
    } catch (e) {
      planManager.appendHit(issueKey, { status: "failed", error: e.message, fieldPlans: [], skips: [], ambiguities: [] });
      return;
    }
    if (!cloudIssue) { planManager.appendHit(issueKey, { status: "skipped", skipReason: "cloud_missing", fieldPlans: [], skips: [], ambiguities: [] }); return; }
    if (!editmeta) { planManager.appendHit(issueKey, { status: "skipped", skipReason: "editmeta_unavailable", fieldPlans: [], skips: [], ambiguities: [] }); return; }

    const resolution = fieldResolver.resolveForIssue(
      editmeta.fields || editmeta,
      cloudIssue.fields,
      indexes.nameIndex,
      indexes.idIndex,
      overrides,
      explicitPairs,
      { denylist },
    );
    const { fieldPlans, skips } = await fieldDiffer.diffIssue(
      resolution.pairs,
      cloudIssue.fields,
      editmeta.fields || editmeta,
      ctx,
    );

    const allSkips = skips.concat(resolution.skips);
    for (const sk of allSkips) {
      const k = String(sk.reason || "skip").split(":")[0];
      skipHistogram[k] = (skipHistogram[k] || 0) + 1;
    }
    for (const am of resolution.ambiguities) globalAmbiguities.push({ issueKey, ...am });

    scanned++;
    if (fieldPlans.length) withChanges++;
    planManager.appendHit(issueKey, {
      status: fieldPlans.length ? "pending" : "skipped",
      project: (issueKey.split("-")[0] || "").toUpperCase(),
      fieldPlans,
      skips: allSkips,
      ambiguities: resolution.ambiguities,
    });

    if (scanned % 50 === 0) { log(`  ...scanned ${scanned}/${keys.length}, ${withChanges} with changes`); }
  }, concurrency);

  const fin = await planManager.finalizePlanFromJsonl(runId);

  // Resolution report
  writeResolutionReport(runId, { globalAmbiguities, skipHistogram, scanned, withChanges });

  log(`DONE plan — scanned=${scanned}, withChanges=${withChanges}, planFile=${fin.planFile}`);
  log(`  ambiguities=${globalAmbiguities.length}, skip histogram=${JSON.stringify(skipHistogram)}`);
  log(`  cloud=${JSON.stringify(client.getStats())}`);
  logger.close();
}

function writeResolutionReport(runId, data) {
  ensureDir(REPORTS_DIR);
  const out = path.join(REPORTS_DIR, `field_resolution_${runId}.md`);
  const L = [];
  L.push(`# Field resolution report — ${runId}`);
  L.push("");
  L.push(`- issues scanned: ${data.scanned}`);
  L.push(`- issues with changes: ${data.withChanges}`);
  L.push("");
  L.push(`## Skip reasons (histogram)`);
  const sk = Object.keys(data.skipHistogram).sort();
  if (!sk.length) L.push(`_none_`);
  for (const k of sk) L.push(`- ${k}: ${data.skipHistogram[k]}`);
  L.push("");
  L.push(`## Ambiguities — pin these in config/field_overrides.json`);
  if (!data.globalAmbiguities.length) {
    L.push(`_none_`);
  } else {
    // Deduplicate by targetFieldId+reason for readability.
    const seen = new Map();
    for (const am of data.globalAmbiguities) {
      const key = `${am.targetFieldId || am.cloudFieldId}|${am.reason}`;
      if (!seen.has(key)) seen.set(key, { ...am, count: 0, example: am.issueKey });
      seen.get(key).count++;
    }
    L.push(`| source | target | reason | candidates | count | example |`);
    L.push(`|---|---|---|---|---|---|`);
    for (const am of seen.values()) {
      const src = am.sourceName || am.name;
      const tgt = am.targetName || am.name;
      const cands = (am.targetCandidates || am.candidates || []).join(", ");
      L.push(`| ${src} | ${tgt} | ${am.reason} | ${cands} | ${am.count} | ${am.example} |`);
    }
  }
  L.push("");
  fs.writeFileSync(out, L.join("\n"));
  console.log(`  Resolution report: ${out}`);
}

/* ─────────────────────────── PHASE: field-report ─────────────────────────── */

async function runFieldReport(opts) {
  const runId = timestampRunId();
  const logger = makeLogger(runId, "field-report");
  const { log } = logger;
  const config = loadConfig(opts);
  log(`sync_same_instance_fields field-report — runId=${runId}`);

  const client = buildClient();
  if (!(await client.testConnection())) throw new Error("Cloud connection failed");

  const indexes = await buildFieldIndexes(client, log);
  const overrides = fieldResolver.loadOverrides(loadJson(path.join(CONFIG_DIR, "field_overrides.json"), { overrides: [] }));
  const denylist = denylistSet(config);
  const explicitPairs = config.fieldPairs.map((p) => ({
    sourceName: p.sourceName,
    targetName: p.targetName,
  }));

  // Sample a handful of issues (default 10) to exercise per-issuetype editmeta.
  const sampleLimit = opts.limit > 0 ? opts.limit : 10;
  const keys = await resolveIssueKeys(client, opts, config, log);
  const sample = keys.slice(0, sampleLimit);
  log(`  Sampling ${sample.length} issue(s) for resolution`);

  const pairSeen = new Map();   // targetFieldId -> {sourceName, targetName, sourceFieldId, reason, category}
  const ambSeen = new Map();
  for (const issueKey of sample) {
    let cloudIssue, editmeta;
    try {
      [cloudIssue, editmeta] = await Promise.all([
        client.getIssueFields(issueKey),
        client.getEditMeta(issueKey),
      ]);
    } catch { continue; }
    if (!cloudIssue || !editmeta) continue;

    const res = fieldResolver.resolveForIssue(
      editmeta.fields || editmeta,
      cloudIssue.fields,
      indexes.nameIndex,
      indexes.idIndex,
      overrides,
      explicitPairs,
      { denylist },
    );
    for (const p of res.pairs) {
      if (!pairSeen.has(p.targetFieldId)) {
        pairSeen.set(p.targetFieldId, {
          sourceName: p.sourceFieldName,
          targetName: p.targetFieldName,
          sourceFieldId: p.sourceFieldId,
          reason: p.reason,
          category: p.handler.category,
        });
      }
    }
    for (const am of res.ambiguities) {
      const key = `${am.targetFieldId || am.cloudFieldId}|${am.reason}`;
      if (!ambSeen.has(key)) ambSeen.set(key, { ...am, example: issueKey });
    }
  }

  ensureDir(REPORTS_DIR);
  const out = path.join(REPORTS_DIR, `field_resolution_${runId}.md`);
  const L = [];
  L.push(`# Field resolution (field-report) — ${runId}`);
  L.push(`Sampled ${sample.length} issue(s).`);
  L.push("");
  L.push(`## Resolved pairs (source -> target)`);
  L.push(`| source | target | category | sourceFieldId | via |`);
  L.push(`|---|---|---|---|---|`);
  for (const [tfId, p] of [...pairSeen.entries()].sort((a, b) => a[1].targetName.localeCompare(b[1].targetName))) {
    L.push(`| ${p.sourceName} | ${p.targetName} | ${p.category} | ${p.sourceFieldId} | ${p.reason} |`);
  }
  L.push("");
  L.push(`## Ambiguities — pin in config/field_overrides.json`);
  if (!ambSeen.size) L.push(`_none_`);
  else {
    L.push(`| source | target | reason | candidates | example |`);
    L.push(`|---|---|---|---|---|`);
    for (const am of ambSeen.values()) {
      const src = am.sourceName || am.name;
      const tgt = am.targetName || am.name;
      const cands = (am.targetCandidates || am.candidates || []).join(", ");
      L.push(`| ${src} | ${tgt} | ${am.reason} | ${cands} | ${am.example} |`);
    }
  }
  fs.writeFileSync(out, L.join("\n"));
  log(`  Wrote ${out} — ${pairSeen.size} resolved pairs, ${ambSeen.size} ambiguities`);
  logger.close();
}

/* ─────────────────────────── PHASE: audit ─────────────────────────── */

function findLatestPlanFile(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("plan_") && f.endsWith(".json")).sort().reverse();
  return files.length ? path.join(dir, files[0]) : null;
}

async function runAudit(opts) {
  ensureDir(REPORTS_DIR);
  const runId = timestampRunId();
  const logger = makeLogger(runId, "audit");
  const { log } = logger;
  const planManager = new PlanManager(LOGS_DIR, log);
  const planFile = opts.planFile || findLatestPlanFile(LOGS_DIR);
  if (!planFile) { log("  No plan file found — run plan first"); logger.close(); return; }
  const plan = await planManager.loadPlan(planFile);
  if (!plan) { log("  Could not load plan"); logger.close(); return; }

  const { rows, summary } = auditWriter.flattenPlan(plan);
  const csvPath = path.join(REPORTS_DIR, `audit_${runId}.csv`);
  const mdPath = path.join(REPORTS_DIR, `audit_${runId}.md`);
  auditWriter.writeAuditCsv(rows, csvPath);
  auditWriter.writeAuditMd(summary, mdPath, { runId, planFile });
  log(`  CSV: ${csvPath}`);
  log(`  MD:  ${mdPath}`);
  log(`  set_missing=${summary.setMissing}, overwrite_diff=${summary.overwriteDiff}, issuesWithChanges=${summary.issuesWithChanges}/${summary.issues}`);
  logger.close();
}

/* ─────────────────────────── PHASE: apply ─────────────────────────── */

async function runApply(opts) {
  if (!opts.dryRun && !opts.apply && !opts.restoreOnly) {
    console.error("ERROR: apply requires --dry-run or --apply (or --restore-only-notifications)");
    process.exit(2);
  }
  const runId = timestampRunId();
  const logger = makeLogger(runId, "apply");
  const { log } = logger;
  const config = loadConfig(opts);
  const recheck = opts.recheck != null ? opts.recheck : config.recheckBeforeApply;
  log(`sync_same_instance_fields apply — runId=${runId} ${opts.dryRun ? "[DRY-RUN]" : "[LIVE]"} recheck=${recheck}`);

  const client = buildClient();
  if (!(await client.testConnection())) throw new Error("Cloud connection failed");

  const muter = new NotificationMuter(client, LOGS_DIR, log);
  muter.setTargetEvents(["Issue Updated"]);
  muter.setDryRun(opts.dryRun);
  await muter.initialize();

  if (opts.restoreOnly) {
    log("*** RESTORE-ONLY MODE ***");
    const r = await muter.restoreAllFromSnapshot();
    log(`  restored=${r.restored}, failed=${r.failed}`);
    logger.close();
    return;
  }

  const planManager = new PlanManager(LOGS_DIR, log);
  const planFile = opts.planFile || findLatestPlanFile(LOGS_DIR);
  if (!planFile) { log("  No plan file found — run plan first"); logger.close(); return; }
  await planManager.loadPlan(planFile);

  const todo = planManager.getIssuesToProcess(opts.retryFailed);
  log(`  ${todo.length} issue(s) to process`);

  const stats = { applied: 0, dryRun: 0, fieldsWritten: 0, skipped: 0, failed: 0 };
  let updates = 0;
  const concurrency = opts.concurrency || config.concurrency.apply || 3;

  const processOneIssue = async ([issueKey, data]) => {
    if (opts.resume && data.status === "completed") return;
    let fieldPlans = (data.fieldPlans || []).slice();
    if (!fieldPlans.length) { planManager.updateIssueStatus(issueKey, "skipped"); return; }

    // Recheck: drop fields already correct on Cloud (drift since plan).
    if (recheck && !opts.dryRun) {
      const kept = [];
      for (const fp of fieldPlans) {
        try {
          const current = await client.getIssueFieldValue(issueKey, fp.targetFieldId || fp.cloudFieldId);
          const cur = registry.normalizeByCategory(fp.category, current);
          const want = registry.normalizeByCategory(fp.category, fp.writeValue);
          if (!registry.equalNorm(cur, want)) kept.push(fp);
        } catch { kept.push(fp); }
      }
      fieldPlans = kept;
      if (!fieldPlans.length) { planManager.updateIssueStatus(issueKey, "completed"); return; }
    }

    const fields = {};
    for (const fp of fieldPlans) {
      const fieldId = fp.targetFieldId || fp.cloudFieldId;
      fields[fieldId] = fp.writeValue;
    }

    if (opts.dryRun) {
      const size = JSON.stringify({ fields }).length;
      log(`  [dry] ${issueKey} — would PUT ${fieldPlans.length} field(s) (${size}B): ${fieldPlans.map((f) => `${f.name}[${f.action}]`).join(", ")}`);
      stats.dryRun++;
      planManager.updateIssueStatus(issueKey, "pending");
      updates++;
      return;
    }

    const res = await client.updateIssue(issueKey, { fields });
    if (res.success) {
      stats.applied++;
      stats.fieldsWritten += fieldPlans.length;
      planManager.updateIssueStatus(issueKey, "completed");
    } else {
      // Isolate the offending field with per-field PUTs.
      log(`  [warn] ${issueKey} bulk PUT failed (${res.error}); isolating per-field`);
      let anyFail = false;
      for (const fp of fieldPlans) {
        const fieldId = fp.targetFieldId || fp.cloudFieldId;
        const r = await client.updateIssue(issueKey, { fields: { [fieldId]: fp.writeValue } });
        if (r.success) { stats.fieldsWritten++; }
        else { anyFail = true; log(`    [field-fail] ${issueKey}.${fieldId} (${fp.name}): ${r.error}`); }
      }
      if (anyFail) { stats.failed++; planManager.updateIssueStatus(issueKey, "failed", res.error); }
      else { stats.applied++; planManager.updateIssueStatus(issueKey, "completed"); }
    }
    updates++;
    if (updates % 25 === 0) { planManager.savePlan(); log(`  ...applied=${stats.applied}, failed=${stats.failed}, fields=${stats.fieldsWritten}`); }
  };

  if (config.muteNotifications && opts.muteNotifications && !opts.dryRun) {
    const byProject = new Map();
    for (const entry of todo) {
      const proj = (entry[0].split("-")[0] || "").toUpperCase();
      if (!byProject.has(proj)) byProject.set(proj, []);
      byProject.get(proj).push(entry);
    }
    const projects = [...byProject.keys()].sort();
    log(`Executing across ${projects.length} project(s) with notification muting`);
    for (const projectKey of projects) {
      const projTodo = byProject.get(projectKey);
      log(`\n  [project ${projectKey}] ${projTodo.length} issue(s)`);
      const muted = await muter.muteProject(projectKey);
      if (!muted) log(`  [project ${projectKey}] WARN: could not mute — proceeding`);
      try { await runWorkerPool(projTodo, processOneIssue, concurrency); }
      finally { if (muted) { const ok = await muter.restoreProject(projectKey); if (!ok) log(`  [project ${projectKey}] WARN: restore FAILED — re-run --restore-only-notifications`); } }
    }
  } else {
    if (!opts.muteNotifications && !opts.dryRun) log(`*** NOTIFICATION MUTE DISABLED — watchers WILL be emailed ***`);
    await runWorkerPool(todo, processOneIssue, concurrency);
  }

  planManager.savePlan();
  log(`DONE apply — applied=${stats.applied}, dry=${stats.dryRun}, failed=${stats.failed}, fieldsWritten=${stats.fieldsWritten}`);
  log(`  cloud=${JSON.stringify(client.getStats())}`);
  logger.close();
}

/* ─────────────────────────── PHASE: prepare ─────────────────────────── */

function findLatestManifest(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("prepare_manifest_") && f.endsWith(".json")).sort().reverse();
  return files.length ? path.join(dir, files[0]) : null;
}

function printPreparePlan(plan, log) {
  log(`\n=== PREPARE PLAN ===`);
  log(`Missing select options to add: ${plan.optionAdds.length} context(s)`);
  for (const o of plan.optionAdds) log(`  + ${o.fieldName} [ctx ${o.contextId}] ${o.values.length}: ${o.values.join(", ")}`);
  log(`Field-config un-hides: ${plan.fieldConfigUnhides.length}`);
  for (const f of plan.fieldConfigUnhides) log(`  + ${f.fieldName} in field config ${f.fieldConfigId}`);
  log(`Edit-screen additions: ${plan.screenAdds.length}`);
  for (const s of plan.screenAdds) log(`  + ${s.fieldName} -> screen ${s.screenId} tab ${s.tabId}`);
  log(`Context extensions: ${(plan.contextExtensions || []).length}`);
  for (const ce of plan.contextExtensions || []) {
    const its = ce.addIssueTypeNames.length ? ` +issuetypes[${ce.addIssueTypeNames.join(", ")}]` : "";
    const prj = ce.addProjectKeys.length ? ` +projects[${ce.addProjectKeys.join(", ")}]` : "";
    log(`  ~ ${ce.fieldName} [ctx ${ce.contextId}]${its}${prj}`);
  }
  const wseen = new Set();
  const warns = [];
  for (const w of plan.contextWarnings) { const k = `${w.fieldName}|${w.projectKey}/${w.issueTypeName}`; if (wseen.has(k)) continue; wseen.add(k); warns.push(`${w.fieldName}: ${w.projectKey}/${w.issueTypeName}`); }
  log(`Context warnings (field context doesn't cover project/issuetype — MANUAL fix, not auto-changed): ${warns.length}`);
  for (const w of warns) log(`  ! ${w}`);
  if (plan.extendableGaps) log(`  ${plan.extendableGaps} of these are auto-remediable — re-run with --extend-contexts to plan them.`);
}

async function runPrepare(opts) {
  ensureDir(LOGS_DIR);
  const runId = timestampRunId();
  const logger = makeLogger(runId, "prepare");
  const { log } = logger;
  const config = loadConfig(opts);
  const client = buildClient();
  if (!(await client.testConnection())) throw new Error("Cloud connection failed");

  // RESTORE mode — undo a previous prepare from its manifest.
  if (opts.restore) {
    const manifestPath = opts.manifest || findLatestManifest(LOGS_DIR);
    if (!manifestPath) { log("  No prepare manifest found — nothing to restore"); logger.close(); return; }
    const manifest = loadJson(manifestPath, null);
    if (!manifest) { log(`  Could not load manifest ${manifestPath}`); logger.close(); return; }
    log(`sync_same_instance_fields prepare RESTORE — runId=${runId}`);
    log(`  manifest: ${manifestPath}`);
    log(`  to undo: ${(manifest.contextExtensions || []).length} context extension(s), ${(manifest.optionAdds || []).length} option(s), ${(manifest.fieldConfigUnhides || []).length} un-hide(s), ${(manifest.screenAdds || []).length} screen add(s)`);
    const stats = await fieldEnabler.restore(client, manifest, { log });
    log(`DONE restore — contextExtensionsReverted=${stats.contextExtensionsReverted}, optionsDeleted=${stats.optionsDeleted}, fieldsRehidden=${stats.fieldsRehidden}, screenFieldsRemoved=${stats.screenFieldsRemoved}, locked=${stats.locked}, denied=${stats.denied}, failed=${stats.failed}`);
    if (stats.failed) log(`  NOTE: an option delete fails if an issue already uses that option — that is expected/safe; leave those options in place.`);
    log(`  cloud=${JSON.stringify(client.getStats())}`);
    logger.close();
    return;
  }

  log(`sync_same_instance_fields prepare — runId=${runId} ${opts.apply ? "[APPLY]" : "[DRY-RUN]"}`);
  const fields = await client.getFields();
  log(`  Field catalog: ${fields.length} fields`);
  const denylist = denylistSet(config);
  if (denylist.size) log(`  Denylist (skipped): ${[...denylist].join(", ")}`);

  const plan = await fieldEnabler.buildPlan(client, {
    fields,
    denylist,
    log,
    projects: opts.projects && opts.projects.length ? opts.projects : null,
    optionMaps: buildOptionMaps(),
    extendContexts: opts.extendContexts,
  });
  printPreparePlan(plan, log);

  if (!opts.apply) {
    log(`\nDRY-RUN — no changes made. Re-run with --apply to execute.`);
    log(`  cloud=${JSON.stringify(client.getStats())}`);
    logger.close();
    return;
  }

  const { manifest, stats } = await fieldEnabler.applyPlan(client, plan, { dryRun: false, log });
  const manifestPath = path.join(LOGS_DIR, `prepare_manifest_${runId}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  log(`\nDONE prepare — contextIssueTypesAdded=${stats.contextIssueTypesAdded}, contextProjectsAdded=${stats.contextProjectsAdded}, optionsAdded=${stats.optionsAdded}, fieldsUnhidden=${stats.fieldsUnhidden}, screenFieldsAdded=${stats.screensFieldsAdded}, locked=${stats.locked}, denied=${stats.denied}, failed=${stats.failed}`);
  log(`  Revert manifest: ${manifestPath}`);
  log(`  Undo with: node main/sync_same_instance_fields.js prepare --restore`);
  log(`  cloud=${JSON.stringify(client.getStats())}`);
  logger.close();
}

/* ─────────────────────────── main ─────────────────────────── */

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || !opts.mode) { printHelp(); return; }
  if (opts.mode === '--help' || opts.mode === '-h') { printHelp(); return; }
  switch (opts.mode) {
    case "field-report": await runFieldReport(opts); break;
    case "prepare": await runPrepare(opts); break;
    case "plan": await runPlan(opts); break;
    case "audit": await runAudit(opts); break;
    case "apply": await runApply(opts); break;
    default: console.error(`Unknown phase: ${opts.mode}`); printHelp(); process.exit(2);
  }
}

main().catch((e) => { console.error(`FATAL: ${e.stack || e.message}`); process.exit(1); });
