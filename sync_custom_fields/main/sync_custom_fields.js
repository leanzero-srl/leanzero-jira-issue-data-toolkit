#!/usr/bin/env node
/**
 * sync_custom_fields — copy Jira custom-field values DC -> Cloud.
 *
 * DC is the source of truth: for each issue selected by a Cloud JQL, fetch the
 * same-keyed DC issue, resolve each writable Cloud custom field to its DC source
 * by name, translate the DC value to the Cloud write shape, and overwrite the
 * Cloud value when it is missing or differs.
 *
 * Phases:
 *   field-report  read-only — dump resolved DC<->Cloud map + ambiguities
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
const DatacenterClient = require("../src/datacenterClient");
const fieldIndex = require("../src/fieldIndex");
const fieldDiffer = require("../src/fieldDiffer");
const statusRestore = require("../src/statusRestore");
const registry = require("../src/typeRegistry");
const auditWriter = require("../src/auditWriter");
const { htmlToAdf, plaintextAdf } = require("../../sync_issue_comments/src/htmlToAdf");
const UserMapper = require("../../mend_comments/src/userMapper");
const PlanManager = require("../../mend_comments/src/planManager");
const NotificationMuter = require("../../sync_issue_links/src/notificationMuter");

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
    preferMigratedTarget: !!cfg.preferMigratedTarget,
    allowClearWhenDcEmpty: !!cfg.allowClearWhenDcEmpty,
    richTextOverwrite: cfg.richTextOverwrite || "missing_only",
    recheckBeforeApply: cfg.recheckBeforeApply !== false,
    enableTypes: cfg.enableTypes || [],
    muteNotifications: cfg.muteNotifications !== false,
    statusPaths: cfg.statusPaths || {},
    statusRestore: cfg.statusRestore || { setResolutionFromDc: true },
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
    userMapCache: path.join(LOGS_DIR, "user_map_cache.json"),
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
      case "--user-map-cache": opts.userMapCache = argv[++i]; break;
      case "--help": case "-h": opts.help = true; break;
      default: console.error(`  WARN: unknown arg ${a}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`sync_custom_fields — copy custom-field values DC -> Cloud (DC = source of truth)

USAGE
  node main/sync_custom_fields.js <phase> [options]

PHASES
  field-report   read-only: resolved DC<->Cloud field map + ambiguities for sample issues
  plan           read-only: compute per-field diffs -> logs/plan_<runId>.json + reports
  audit          render latest (or --plan-file) plan -> reports/audit_<runId>.{csv,md}
  apply          PUT updates: requires --dry-run or --apply
  status-restore move issues back to DC (original) status via transitions
                 (config statusPaths); requires --dry-run or --apply

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
  --recheck/--no-recheck   re-read Cloud before writing (default: config)
  --no-mute-notifications  do NOT mute "Issue Updated" (watchers WILL be emailed)
  --restore-only-notifications   restore muted schemes from a crashed run, then exit

  --plan-file PATH     operate on a specific plan
  --config PATH        alternate config.json
`);
}

function buildClients() {
  const cloudBase = process.env.CLOUD_BASE_URL;
  const cloudToken = process.env.CLOUD_API_TOKEN;
  if (!cloudBase || !cloudToken) throw new Error("CLOUD_BASE_URL and CLOUD_API_TOKEN are required (.env)");
  const dcBase = process.env.DC_BASE_URL;
  if (!dcBase) throw new Error("DC_BASE_URL is required (.env)");
  const dcAuth = process.env.DC_PAT
    ? { token: process.env.DC_PAT }
    : { username: process.env.DC_USERNAME, password: process.env.DC_PASSWORD };
  return {
    cloudClient: new CloudJiraClient(cloudBase, cloudToken),
    dcClient: new DatacenterClient(dcBase, dcAuth),
  };
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

// Build the shared field indexes (cloud + dc /field catalogs), cached to disk.
async function buildFieldIndexes(cloudClient, dcClient, log) {
  const cachePath = path.join(LOGS_DIR, "field_index_cache.json");
  const [cloudFields, dcFields] = await Promise.all([cloudClient.getFields(), dcClient.getFields()]);
  log(`  Field catalogs: cloud=${cloudFields.length}, dc=${dcFields.length}`);
  try {
    fs.writeFileSync(cachePath, JSON.stringify({ at: new Date().toISOString(), cloud: cloudFields.length, dc: dcFields.length }, null, 2));
  } catch { /* ignore */ }
  return fieldIndex.buildIndexes(cloudFields, dcFields);
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

async function resolveIssueKeys(cloudClient, opts, config, log) {
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
  const issues = await cloudClient.searchIssues(jql, "key", 100);
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
  log(`sync_custom_fields plan — runId=${runId}`);

  const { cloudClient, dcClient } = buildClients();
  if (!(await cloudClient.testConnection())) throw new Error("Cloud connection failed");
  if (!(await dcClient.testConnection())) throw new Error("DC connection failed");

  const indexes = await buildFieldIndexes(cloudClient, dcClient, log);
  const overrides = fieldIndex.loadOverrides(loadJson(path.join(CONFIG_DIR, "field_overrides.json"), { overrides: [] }));
  const optionMaps = buildOptionMaps();
  const denylist = denylistSet(config);
  const userMapper = new UserMapper(cloudClient, { cacheFilePath: opts.userMapCache, log });

  const keys = await resolveIssueKeys(cloudClient, opts, config, log);
  log(`  ${keys.length} issue(s) to scan`);

  const planManager = new PlanManager(LOGS_DIR, log);
  planManager.createMasterIndex(runId, { jql: config.jql || null, mode: "custom_fields" });
  planManager.openHitsJsonl(runId);

  const ctx = { userMapper, htmlToAdf, plaintextAdf, optionMaps, richTextOverwrite: config.richTextOverwrite };
  const globalAmbiguities = [];
  const skipHistogram = {};
  let scanned = 0;
  let withChanges = 0;

  const concurrency = opts.concurrency || config.concurrency.plan || 5;
  await runWorkerPool(keys, async (issueKey) => {
    let cloudIssue, editmeta, dcIssue;
    try {
      [cloudIssue, editmeta, dcIssue] = await Promise.all([
        cloudClient.getIssueFields(issueKey),
        cloudClient.getEditMeta(issueKey),
        dcClient.getIssueFields(issueKey),
      ]);
    } catch (e) {
      planManager.appendHit(issueKey, { status: "failed", error: e.message, fieldPlans: [], skips: [], ambiguities: [] });
      return;
    }
    if (!cloudIssue) { planManager.appendHit(issueKey, { status: "skipped", skipReason: "cloud_missing", fieldPlans: [], skips: [], ambiguities: [] }); return; }
    if (!editmeta) { planManager.appendHit(issueKey, { status: "skipped", skipReason: "editmeta_unavailable", fieldPlans: [], skips: [], ambiguities: [] }); return; }
    if (!dcIssue) { planManager.appendHit(issueKey, { status: "skipped", skipReason: "dc_missing", fieldPlans: [], skips: [], ambiguities: [] }); return; }

    const resolution = fieldIndex.resolveForIssue(editmeta, dcIssue.fields, indexes, overrides, { denylist });
    const { fieldPlans, skips } = await fieldDiffer.diffIssue(
      resolution, dcIssue.fields, dcIssue.renderedFields, cloudIssue.fields, editmeta, ctx,
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

    if (scanned % 50 === 0) { userMapper.flushCache(); log(`  ...scanned ${scanned}/${keys.length}, ${withChanges} with changes`); }
  }, concurrency);

  userMapper.flushCache();
  const fin = await planManager.finalizePlanFromJsonl(runId);

  // Resolution report
  writeResolutionReport(runId, { globalAmbiguities, skipHistogram, scanned, withChanges, userStats: userMapper.getStats() });

  log(`DONE plan — scanned=${scanned}, withChanges=${withChanges}, planFile=${fin.planFile}`);
  log(`  ambiguities=${globalAmbiguities.length}, skip histogram=${JSON.stringify(skipHistogram)}`);
  log(`  user-map: ${JSON.stringify(userMapper.getStats())}`);
  log(`  cloud=${JSON.stringify(cloudClient.getStats())} dc=${JSON.stringify(dcClient.getStats())}`);
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
  L.push(`- user-map: ${JSON.stringify(data.userStats)}`);
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
    // Deduplicate by cloudFieldId+reason for readability.
    const seen = new Map();
    for (const am of data.globalAmbiguities) {
      const key = `${am.cloudFieldId}|${am.reason}`;
      if (!seen.has(key)) seen.set(key, { ...am, count: 0, example: am.issueKey });
      seen.get(key).count++;
    }
    L.push(`| field | cloudFieldId | reason | candidates | count | example |`);
    L.push(`|---|---|---|---|---|---|`);
    for (const am of seen.values()) {
      L.push(`| ${am.name} | ${am.cloudFieldId} | ${am.reason} | ${(am.candidates || []).join(", ")} | ${am.count} | ${am.example} |`);
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
  log(`sync_custom_fields field-report — runId=${runId}`);

  const { cloudClient, dcClient } = buildClients();
  if (!(await cloudClient.testConnection())) throw new Error("Cloud connection failed");
  if (!(await dcClient.testConnection())) throw new Error("DC connection failed");

  const indexes = await buildFieldIndexes(cloudClient, dcClient, log);
  const overrides = fieldIndex.loadOverrides(loadJson(path.join(CONFIG_DIR, "field_overrides.json"), { overrides: [] }));
  const denylist = denylistSet(config);

  // Sample a handful of issues (default 10) to exercise per-issuetype editmeta.
  const sampleLimit = opts.limit > 0 ? opts.limit : 10;
  const keys = await resolveIssueKeys(cloudClient, opts, config, log);
  const sample = keys.slice(0, sampleLimit);
  log(`  Sampling ${sample.length} issue(s) for resolution`);

  const pairSeen = new Map();   // cloudFieldId -> {name, dcFieldId, reason}
  const ambSeen = new Map();
  for (const issueKey of sample) {
    const [editmeta, dcIssue] = await Promise.all([
      cloudClient.getEditMeta(issueKey),
      dcClient.getIssueFields(issueKey),
    ]);
    if (!editmeta || !dcIssue) continue;
    const res = fieldIndex.resolveForIssue(editmeta, dcIssue.fields, indexes, overrides, { denylist });
    for (const p of res.pairs) {
      if (!pairSeen.has(p.cloudFieldId)) pairSeen.set(p.cloudFieldId, { name: p.name, dcFieldId: p.dcFieldId, dcName: p.dcName, reason: p.reason, category: p.handler.category });
    }
    for (const am of res.ambiguities) {
      const key = `${am.cloudFieldId}|${am.reason}`;
      if (!ambSeen.has(key)) ambSeen.set(key, { ...am, example: issueKey });
    }
  }

  ensureDir(REPORTS_DIR);
  const out = path.join(REPORTS_DIR, `field_resolution_${runId}.md`);
  const L = [];
  L.push(`# Field resolution (field-report) — ${runId}`);
  L.push(`Sampled ${sample.length} issue(s).`);
  L.push("");
  L.push(`## Resolved pairs (DC -> Cloud)`);
  L.push(`| field | category | dcFieldId | cloudFieldId | via |`);
  L.push(`|---|---|---|---|---|`);
  for (const [cfId, p] of [...pairSeen.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    L.push(`| ${p.name} | ${p.category} | ${p.dcFieldId} | ${cfId} | ${p.reason} |`);
  }
  L.push("");
  L.push(`## Ambiguities — pin in config/field_overrides.json`);
  if (!ambSeen.size) L.push(`_none_`);
  else {
    L.push(`| field | cloudFieldId | reason | candidates | example |`);
    L.push(`|---|---|---|---|---|`);
    for (const am of ambSeen.values()) {
      L.push(`| ${am.name} | ${am.cloudFieldId} | ${am.reason} | ${(am.candidates || []).join(", ")} | ${am.example} |`);
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
  log(`sync_custom_fields apply — runId=${runId} ${opts.dryRun ? "[DRY-RUN]" : "[LIVE]"} recheck=${recheck}`);

  const { cloudClient } = buildClients();
  if (!(await cloudClient.testConnection())) throw new Error("Cloud connection failed");

  const muter = new NotificationMuter(cloudClient, LOGS_DIR, log);
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
          const current = await cloudClient.getIssueFieldValue(issueKey, fp.cloudFieldId);
          const cur = registry.normalizeByCategory(fp.category, current);
          const want = registry.normalizeByCategory(fp.category, fp.writeValue);
          if (!registry.equalNorm(cur, want)) kept.push(fp);
        } catch { kept.push(fp); }
      }
      fieldPlans = kept;
      if (!fieldPlans.length) { planManager.updateIssueStatus(issueKey, "completed"); return; }
    }

    const fields = {};
    for (const fp of fieldPlans) fields[fp.cloudFieldId] = fp.writeValue;

    if (opts.dryRun) {
      const size = JSON.stringify({ fields }).length;
      log(`  [dry] ${issueKey} — would PUT ${fieldPlans.length} field(s) (${size}B): ${fieldPlans.map((f) => `${f.name}[${f.action}]`).join(", ")}`);
      stats.dryRun++;
      planManager.updateIssueStatus(issueKey, "pending");
      updates++;
      return;
    }

    const res = await cloudClient.updateIssue(issueKey, { fields });
    if (res.success) {
      stats.applied++;
      stats.fieldsWritten += fieldPlans.length;
      planManager.updateIssueStatus(issueKey, "completed");
    } else {
      // Isolate the offending field with per-field PUTs.
      log(`  [warn] ${issueKey} bulk PUT failed (${res.error}); isolating per-field`);
      let anyFail = false;
      for (const fp of fieldPlans) {
        const r = await cloudClient.updateIssue(issueKey, { fields: { [fp.cloudFieldId]: fp.writeValue } });
        if (r.success) { stats.fieldsWritten++; }
        else { anyFail = true; log(`    [field-fail] ${issueKey}.${fp.cloudFieldId} (${fp.name}): ${r.error}`); }
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
  log(`  cloud=${JSON.stringify(cloudClient.getStats())}`);
  logger.close();
}

/* ─────────────────────────── PHASE: status-restore ───────────────────────────
 *
 *  Move Cloud issues back to their DC (original) status via workflow transitions.
 *  Status != custom field: it can only change by POSTing transitions, possibly
 *  multi-hop (config `statusPaths`). Idempotent + resumable; notification-muted.
 * ──────────────────────────────────────────────────────────────────────────── */

async function runStatusRestore(opts) {
  if (!opts.dryRun && !opts.apply && !opts.restoreOnly) {
    console.error("ERROR: status-restore requires --dry-run or --apply (or --restore-only-notifications)");
    process.exit(2);
  }
  const runId = timestampRunId();
  const logger = makeLogger(runId, "status-restore");
  const { log } = logger;
  const config = loadConfig(opts);
  log(`sync_custom_fields status-restore — runId=${runId} ${opts.dryRun ? "[DRY-RUN]" : "[LIVE]"}`);

  const { cloudClient, dcClient } = buildClients();
  if (!(await cloudClient.testConnection())) throw new Error("Cloud connection failed");

  const muter = new NotificationMuter(cloudClient, LOGS_DIR, log);
  muter.setTargetEvents(["Issue Updated", "Issue Resolved", "Issue Reopened", "Issue Closed", "Generic Event"]);
  muter.setDryRun(opts.dryRun);
  await muter.initialize();
  if (opts.restoreOnly) {
    log("*** RESTORE-ONLY MODE ***");
    const r = await muter.restoreAllFromSnapshot();
    log(`  restored=${r.restored}, failed=${r.failed}`);
    logger.close();
    return;
  }
  if (!(await dcClient.testConnection())) throw new Error("DC connection failed");

  // Resume from an existing status plan, or build a fresh one.
  let plan;
  if (opts.planFile && fs.existsSync(opts.planFile)) {
    plan = loadJson(opts.planFile, null);
    log(`  Resumed status plan ${opts.planFile} (${plan.worklist.length} items)`);
  } else {
    const keys = await resolveIssueKeys(cloudClient, opts, config, log);
    let useKeys = keys;
    if (opts.limit > 0) useKeys = keys.slice(0, opts.limit);
    log(`  ${useKeys.length} issue(s); fetching statuses...`);
    const [cloudStatus, dcStatus] = await Promise.all([
      cloudClient.getIssueStatuses(useKeys),
      dcClient.getIssueStatuses(useKeys),
    ]);
    const { worklist, unmatched } = statusRestore.buildStatusWorklist(cloudStatus, dcStatus, config.statusPaths);
    for (const w of worklist) w.status = "pending";
    plan = { runId, createdAt: new Date().toISOString(), worklist, unmatched };
    const planPath = path.join(LOGS_DIR, `status_plan_${runId}.json`);
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    plan._path = planPath;
    log(`  status plan: ${planPath}`);
    // Report
    ensureDir(REPORTS_DIR);
    const rep = path.join(REPORTS_DIR, `status_restore_${runId}.md`);
    const byPair = {};
    for (const w of worklist) { const k = `${w.from} -> ${w.to}`; byPair[k] = (byPair[k] || 0) + 1; }
    const RL = [`# Status restore plan — ${runId}`, "", `- to restore: **${worklist.length}**`, `- no configured path (skipped): **${unmatched.length}**`, "", `## Transitions by status pair`];
    for (const [k, c] of Object.entries(byPair).sort((a, b) => b[1] - a[1])) RL.push(`- ${c}×  ${k}  (path: ${(config.statusPaths[k.replace(" -> ", "->")] || []).join(" → ")})`);
    if (unmatched.length) {
      RL.push("", `## Unmatched (add a statusPaths entry to handle)`);
      const um = {}; for (const u of unmatched) { const k = `${u.from} -> ${u.to}`; um[k] = (um[k] || 0) + 1; }
      for (const [k, c] of Object.entries(um).sort((a, b) => b[1] - a[1])) RL.push(`- ${c}×  ${k}`);
    }
    fs.writeFileSync(rep, RL.join("\n"));
    log(`  report: ${rep}`);
  }

  const todo = plan.worklist.filter((w) => w.status === "pending" || (opts.retryFailed && w.status === "failed"));
  log(`  ${todo.length} to process${opts.resume ? " (resume)" : ""}`);
  const setResolution = config.statusRestore.setResolutionFromDc !== false;
  const stats = { done: 0, dry: 0, failed: 0, resolutionMissing: 0 };

  const processOne = async (w) => {
    const r = await statusRestore.executeStatusPath(cloudClient, w, { dryRun: opts.dryRun, setResolution, log });
    w.result = r;
    if (opts.dryRun) {
      w.status = "pending";
      stats.dry++;
      log(`  [dry] ${w.key}: ${w.from} -> ${w.to} via [${(r.steps || []).map((s) => s.to).join(" → ")}]${r.ok ? "" : "  !! " + r.error}`);
      return;
    }
    if (r.ok) {
      w.status = "done";
      stats.done++;
      if (setResolution && w.dcResolution && !r.finalResolution) stats.resolutionMissing++;
      log(`  [ok] ${w.key}: now ${r.finalStatus}, resolution=${r.finalResolution || "(none)"}${r.skipped ? " [" + r.skipped + "]" : ""}`);
    } else {
      w.status = "failed";
      stats.failed++;
      log(`  [FAIL] ${w.key}: ${r.error}`);
    }
  };

  const savePlan = () => { if (plan._path) { try { const { _path, ...rest } = plan; fs.writeFileSync(_path, JSON.stringify(rest, null, 2)); } catch { /* ignore */ } } };

  const concurrency = opts.concurrency || 3;
  if (config.muteNotifications && opts.muteNotifications && !opts.dryRun) {
    const byProject = new Map();
    for (const w of todo) { const p = (w.key.split("-")[0] || "").toUpperCase(); if (!byProject.has(p)) byProject.set(p, []); byProject.get(p).push(w); }
    for (const projectKey of [...byProject.keys()].sort()) {
      const projTodo = byProject.get(projectKey);
      log(`\n  [project ${projectKey}] ${projTodo.length} issue(s)`);
      const muted = await muter.muteProject(projectKey);
      if (!muted) log(`  [project ${projectKey}] WARN: could not mute — proceeding`);
      try { await runWorkerPool(projTodo, processOne, concurrency); }
      finally { savePlan(); if (muted) { const ok = await muter.restoreProject(projectKey); if (!ok) log(`  [project ${projectKey}] WARN: restore FAILED — re-run --restore-only-notifications`); } }
    }
  } else {
    if (!opts.muteNotifications && !opts.dryRun) log(`*** NOTIFICATION MUTE DISABLED — watchers WILL be emailed ***`);
    await runWorkerPool(todo, processOne, concurrency);
    savePlan();
  }

  savePlan();
  log(`DONE status-restore — done=${stats.done}, dry=${stats.dry}, failed=${stats.failed}, resolutionMissingAfter=${stats.resolutionMissing}`);
  log(`  cloud=${JSON.stringify(cloudClient.getStats())}`);
  logger.close();
}

/* ─────────────────────────── main ─────────────────────────── */

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || !opts.mode) { printHelp(); return; }
  switch (opts.mode) {
    case "field-report": await runFieldReport(opts); break;
    case "plan": await runPlan(opts); break;
    case "audit": await runAudit(opts); break;
    case "apply": await runApply(opts); break;
    case "status-restore": await runStatusRestore(opts); break;
    default: console.error(`Unknown phase: ${opts.mode}`); printHelp(); process.exit(2);
  }
}

main().catch((e) => { console.error(`FATAL: ${e.stack || e.message}`); process.exit(1); });
