#!/usr/bin/env node
/**
 * mend_comments — mend JCMA-migrated Cloud Jira comments.
 *
 * Phases:
 *   plan         — JQL-scan Cloud, pair Cloud↔DC comments, compute proposed
 *                  ADF edits, write plan_<runId>.json. No Cloud writes.
 *   audit        — Render the plan as CSV + Markdown for human review.
 *   apply        — Re-GET each comment, verify hash unchanged, PUT corrected
 *                  ADF with ?notifyUsers=false. Requires --apply explicitly.
 *   notify-test  — One-shot end-to-end check that PUT comment with
 *                  notifyUsers=false truly suppresses email notifications.
 *
 * See README.md for full flag reference.
 */

const fs = require("fs");
const path = require("path");

// Load .env from this directory; fall back to the sibling recover script's .env
// so credentials can be shared by symlink or by environment variable.
require("dotenv").config({
  path: fs.existsSync(path.join(__dirname, "..", ".env"))
    ? path.join(__dirname, "..", ".env")
    : path.join(__dirname, "..", "..", "recover_truncated_content", ".env"),
});

const CloudJiraClient = require("../src/cloudJiraClient");
const DatacenterClient = require("../src/datacenterClient");
const PlanManager = require("../src/planManager");
const UserMapper = require("../src/userMapper");
const { pairComments } = require("../src/commentPairer");
const { mendCommentAdf, hashAdf } = require("../src/adfMender");
const NotificationMuter = require("../src/notificationMuter");
const { flattenText } = require("../src/adfWalker");
const { flattenPlan, writeAuditCsv, writeAuditMd } = require("../src/auditWriter");

const SCRIPT_DIR = path.join(__dirname, "..");
const LOGS_DIR = path.join(SCRIPT_DIR, "logs");
const REPORTS_DIR = path.join(SCRIPT_DIR, "reports");

const DEFAULT_CREATORS = [
  "712020:00000000-0000-0000-0000-000000000000",
  "712020:00000000-0000-0000-0000-000000000000",
];

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function timestampRunId() {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
}

function makeLogger(runId, phase) {
  ensureDir(LOGS_DIR);
  const file = path.join(LOGS_DIR, `${phase}_${runId}.log`);
  const fd = fs.openSync(file, "a");
  return {
    log: (msg) => {
      const line = `[${new Date().toISOString()}] ${msg}`;
      console.log(line);
      fs.writeSync(fd, line + "\n");
    },
    file,
    close: () => { try { fs.closeSync(fd); } catch { /* ignore */ } },
  };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const phase = args[0];
  const opts = {
    phase,
    projects: null,
    creators: null,
    issue: null,
    keys: null,
    limit: 0,
    concurrency: null,
    maxUserSearchConcurrency: 2,
    userMapCache: path.join(LOGS_DIR, "user_map_cache.json"),
    probe: false,
    planFile: null,
    emit: "both",
    dryRun: false,
    apply: false,
    resume: false,
    retryFailed: false,
    notifyTestIssue: null,
    notifyTestMention: null,
    muteNotifications: false, // OPT-IN — adds per-project scheme swap on top of notifyUsers=false
    restoreOnlyNotifications: false, // crash-recovery: restore any pending snapshots and exit
    newest: false, // flip JQL ORDER BY to created DESC (process most-recent first)
  };

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    switch (a) {
      case "--projects":
        opts.projects = (next || "").split(",").filter(Boolean);
        i++; break;
      case "--creators":
        opts.creators = (next || "").split(",").filter(Boolean);
        i++; break;
      case "--issue":
        opts.issue = next; i++; break;
      case "--keys":
        opts.keys = (next || "").split(",").map((s) => s.trim()).filter(Boolean);
        i++; break;
      case "--limit":
        opts.limit = parseInt(next, 10) || 0; i++; break;
      case "--concurrency":
        opts.concurrency = parseInt(next, 10) || 0; i++; break;
      case "--max-user-search-concurrency":
        opts.maxUserSearchConcurrency = parseInt(next, 10) || 1; i++; break;
      case "--user-map-cache":
        opts.userMapCache = next; i++; break;
      case "--probe":
        opts.probe = true; break;
      case "--plan-file":
        opts.planFile = next; i++; break;
      case "--emit":
        opts.emit = next; i++; break;
      case "--dry-run":
        opts.dryRun = true; break;
      case "--apply":
        opts.apply = true; break;
      case "--resume":
        opts.resume = true; break;
      case "--retry-failed":
        opts.retryFailed = true; break;
      case "--mention":
        opts.notifyTestMention = next; i++; break;
      case "--mute-notifications":
        // Belt-and-suspenders on top of notifyUsers=false: also clone each
        // project's notification scheme, blank out "Issue Commented" /
        // "Issue Comment Edited" / "Issue Updated", apply, restore. Opt-in
        // because for most sites notifyUsers=false alone is sufficient.
        opts.muteNotifications = true; break;
      case "--restore-only-notifications":
        // Crash recovery: read logs/notification_snapshots.jsonl and put
        // every project's original scheme back. Doesn't apply any comments.
        opts.restoreOnlyNotifications = true; break;
      case "--newest":
        // ORDER BY created DESC instead of ASC. Use with --limit to grab the
        // most-recently-created issues first.
        opts.newest = true; break;
      case "--help":
      case "-h":
        printHelp(); process.exit(0);
      default:
        if (phase === "notify-test" && a === "--issue") {
          // already handled above; defensive
        } else if (!a.startsWith("--")) {
          // positional ignored
        } else {
          console.error(`Unknown flag: ${a}`);
          printHelp();
          process.exit(2);
        }
    }
  }

  // Phase-specific carry-over
  if (phase === "notify-test") opts.notifyTestIssue = opts.issue;
  return opts;
}

function printHelp() {
  console.log(`
Usage:
  mend_comments.js plan         [--projects K1,K2] [--limit N] [--creators ID1,ID2]
                                [--issue KEY] [--concurrency 5] [--newest]
                                [--max-user-search-concurrency 2]
                                [--user-map-cache PATH] [--probe]
  mend_comments.js audit        [--plan-file PATH] [--emit csv|md|both]
  mend_comments.js apply        [--plan-file PATH] [--dry-run] [--apply]
                                [--concurrency 3] [--resume] [--retry-failed]
  mend_comments.js notify-test  --issue ISSUE-KEY [--mention ACCOUNT_ID]
`);
}

function buildClients() {
  const cloudBase = process.env.CLOUD_BASE_URL;
  const cloudToken = process.env.CLOUD_API_TOKEN;
  if (!cloudBase || !cloudToken) {
    throw new Error("CLOUD_BASE_URL and CLOUD_API_TOKEN are required (.env)");
  }
  const dcBase = process.env.DC_BASE_URL;
  if (!dcBase) throw new Error("DC_BASE_URL is required (.env)");
  const dcAuth = process.env.DC_PAT
    ? { token: process.env.DC_PAT }
    : { username: process.env.DC_USERNAME, password: process.env.DC_PASSWORD };

  const cloudClient = new CloudJiraClient(cloudBase, cloudToken);
  const dcClient = new DatacenterClient(dcBase, dcAuth);
  return { cloudClient, dcClient };
}

/* ─────────────────────────────────────────────────────────────────────
 *  WORKER POOL  — generic async-queue-driven concurrency.
 * ────────────────────────────────────────────────────────────────── */

async function runWorkerPool(items, workerFn, concurrency) {
  const n = Math.max(1, concurrency | 0);
  let cursor = 0;
  const workers = [];
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        try {
          await workerFn(items[idx], idx);
        } catch (e) {
          console.error(`  [worker ${w}] unhandled error on item ${idx}: ${e.message}`);
        }
      }
    })());
  }
  await Promise.all(workers);
}

/* ─────────────────────────────────────────────────────────────────────
 *  PHASE: plan
 * ────────────────────────────────────────────────────────────────── */

async function runPlan(opts) {
  ensureDir(LOGS_DIR);
  const runId = timestampRunId();
  const logger = makeLogger(runId, "plan");
  const { log } = logger;

  log(`mend_comments plan — runId=${runId}`);

  const { cloudClient, dcClient } = buildClients();
  const userMapper = new UserMapper(cloudClient, {
    cacheFilePath: opts.userMapCache,
    log,
  });

  // DC user → Cloud accountId helper used by commentPairer. Memoized through
  // dcClient.getUser + userMapper.resolveByEmail; nothing extra to add here.
  const resolveDcEmail = async (dcUsername) => {
    if (!dcUsername) return null;
    let dcUser;
    try {
      dcUser = await dcClient.getUser(dcUsername);
    } catch (e) {
      log(`  [resolve] DC user lookup failed for "${dcUsername}": ${e.message}`);
      return null;
    }
    if (!dcUser || !dcUser.emailAddress) return null;
    const r = await userMapper.resolveByEmail(dcUser.emailAddress);
    return r.accountId || null;
  };

  const planManager = new PlanManager(LOGS_DIR, log);
  planManager.createMasterIndex(runId, { mode: "mend_comments" });
  planManager.openHitsJsonl(runId);

  const creators = opts.creators && opts.creators.length
    ? opts.creators
    : (process.env.MEND_CREATOR_ACCOUNT_IDS
        ? process.env.MEND_CREATOR_ACCOUNT_IDS.split(",").map((s) => s.trim()).filter(Boolean)
        : DEFAULT_CREATORS);

  log(`Creators: ${creators.join(", ")}`);

  const concurrency = opts.concurrency || 5;
  log(`Concurrency: ${concurrency}`);

  // Build JQL
  let jql;
  if (opts.issue) {
    jql = `key = ${opts.issue}`;
  } else if (opts.keys && opts.keys.length) {
    jql = `key in (${opts.keys.join(", ")})`;
  } else {
    const creatorList = creators.map((c) => `"${c}"`).join(", ");
    jql = `creator in (${creatorList})`;
    if (opts.projects && opts.projects.length) {
      jql += ` AND project in (${opts.projects.map((p) => `"${p}"`).join(", ")})`;
    }
    jql += opts.newest ? ` ORDER BY created DESC` : ` ORDER BY created ASC`;
  }
  log(`JQL: ${jql}`);

  // Connection test
  if (!(await cloudClient.testConnection())) throw new Error("Cloud connection failed");
  if (!(await dcClient.testConnection())) throw new Error("DC connection failed");

  // Probe pass: dump mention shapes from a few comments for spot-checking.
  if (opts.probe) {
    await runProbe(cloudClient, dcClient, jql, log);
  }

  // Collect issue keys (we don't process during page callback because we want
  // the worker pool to drive per-issue work).
  const issueKeys = [];
  await cloudClient.searchIssues(jql, "key,project,created", 100, async (batch) => {
    for (const issue of batch) {
      issueKeys.push(issue.key);
      if (opts.limit && issueKeys.length >= opts.limit) return false;
    }
    return true;
  });
  log(`Matched ${issueKeys.length} Cloud issues`);

  let processed = 0;
  let mendedIssueCount = 0;
  let usersResolveTicks = 0;

  await runWorkerPool(issueKeys, async (issueKey) => {
    try {
      const cloudComments = await cloudClient.getComments(issueKey);
      if (!cloudComments || cloudComments.length === 0) {
        processed++;
        return;
      }

      const dcIssue = await dcClient.getIssueWithRenderedBodies(issueKey);
      let dcComments = dcIssue ? dcIssue.comments : [];
      if (
        dcIssue &&
        typeof dcIssue.commentTotal === "number" &&
        dcIssue.commentTotal > dcComments.length
      ) {
        dcComments = await dcClient.getCommentsPaginated(issueKey);
      }

      const { pairs, unmatchedCloud } = await pairComments(cloudComments, dcComments, {
        resolveDcEmail,
        log,
      });

      const commentEntries = [];
      for (const pair of pairs) {
        const result = await mendCommentAdf({
          cloudComment: pair.cloud,
          dcComment: pair.dc,
          dcClient,
          userMapper,
          log,
        });

        const beforeFlat = flattenText(pair.cloud.body).replace(/\s+/g, " ").trim().slice(0, 240);
        const afterFlat = result.bodyAfter
          ? flattenText(result.bodyAfter).replace(/\s+/g, " ").trim().slice(0, 240)
          : "";

        commentEntries.push({
          commentId: pair.cloud.id,
          cloudAuthor: (pair.cloud.author && (pair.cloud.author.displayName || pair.cloud.author.accountId)) || null,
          dcAuthor: (pair.dc.author && (pair.dc.author.displayName || pair.dc.author.name)) || null,
          matchSource: pair.matchSource,
          confidence: pair.confidence,
          hashBefore: result.hashBefore,
          hashAfter: result.hashAfter,
          bodyAfter: result.bodyAfter, // included in plan so apply phase doesn't recompute
          changes: result.changes,
          skipped: result.skipped,
          skipReason: result.skipReason,
          beforeSnippet: beforeFlat,
          afterSnippet: afterFlat,
        });
      }
      for (const u of unmatchedCloud) {
        commentEntries.push({
          commentId: u.id,
          cloudAuthor: (u.author && (u.author.displayName || u.author.accountId)) || null,
          dcAuthor: null,
          matchSource: null,
          confidence: null,
          hashBefore: hashAdf(u.body),
          hashAfter: null,
          bodyAfter: null,
          changes: { mentionsReplaced: [], semicolonsCollapsed: [], semicolonsAmbiguous: [] },
          skipped: true,
          skipReason: "no_dc_counterpart",
          beforeSnippet: flattenText(u.body).replace(/\s+/g, " ").trim().slice(0, 240),
          afterSnippet: "",
        });
      }

      const actionable = commentEntries.filter((c) => !c.skipped);
      if (actionable.length > 0) {
        planManager.appendHit(issueKey, {
          status: "pending",
          comments: commentEntries,
        });
        mendedIssueCount++;
      }

      processed++;
      if (processed % 25 === 0) {
        log(`  ...processed ${processed}/${issueKeys.length} (mendable so far: ${mendedIssueCount})`);
      }

      // Persist user-map cache periodically.
      usersResolveTicks++;
      if (usersResolveTicks % 50 === 0) {
        userMapper.flushCache();
      }
    } catch (e) {
      log(`  ERROR on ${issueKey}: ${e.message}`);
      planManager.appendHit(issueKey, {
        status: "failed",
        error: e.message,
        comments: [],
      });
    }
  }, concurrency);

  userMapper.flushCache();
  const finalized = await planManager.finalizePlanFromJsonl(runId);
  log(`Finalized plan: ${finalized.planFile}`);
  log(`  total: ${finalized.total}, pending: ${finalized.pending}, failed: ${finalized.failed}`);
  log(`UserMapper stats: ${JSON.stringify(userMapper.getStats())}`);
  log(`Cloud stats: ${JSON.stringify(cloudClient.getStats())}`);
  log(`DC stats: ${JSON.stringify(dcClient.getStats())}`);
  logger.close();
}

async function runProbe(cloudClient, dcClient, jql, log) {
  log("=== PROBE (sampling mention shapes) ===");
  const sample = [];
  await cloudClient.searchIssues(jql, "key", 100, async (batch) => {
    for (const issue of batch) {
      sample.push(issue.key);
      if (sample.length >= 5) return false;
    }
    return true;
  });
  for (const k of sample) {
    log(`  probe issue: ${k}`);
    const cloudComments = await cloudClient.getComments(k);
    const dcIssue = await dcClient.getIssueWithRenderedBodies(k);
    log(`    cloud comments: ${cloudComments.length}, dc comments: ${(dcIssue && dcIssue.comments.length) || 0}`);
    for (const c of cloudComments.slice(0, 3)) {
      const flat = JSON.stringify(c.body).slice(0, 500);
      log(`    [${c.id}] ${flat}`);
      try {
        const props = await cloudClient.getCommentProperties(c.id);
        log(`    properties: ${JSON.stringify(props).slice(0, 300)}`);
      } catch (e) {
        log(`    properties err: ${e.message}`);
      }
    }
  }
  log("=== /PROBE ===");
}

/* ─────────────────────────────────────────────────────────────────────
 *  PHASE: audit
 * ────────────────────────────────────────────────────────────────── */

async function runAudit(opts) {
  ensureDir(REPORTS_DIR);
  const runId = timestampRunId();
  const logger = makeLogger(runId, "audit");
  const { log } = logger;

  const planManager = new PlanManager(LOGS_DIR, log);
  const planFile = opts.planFile || findLatestPlanFile(LOGS_DIR);
  if (!planFile) throw new Error("No plan file found. Pass --plan-file or run `plan` first.");
  log(`Loading plan: ${planFile}`);
  const plan = await planManager.loadPlan(planFile);
  if (!plan) throw new Error(`Failed to load plan: ${planFile}`);

  const rows = flattenPlan(plan);
  log(`Audit rows: ${rows.length}`);

  const csvPath = path.join(REPORTS_DIR, `audit_${runId}.csv`);
  const mdPath = path.join(REPORTS_DIR, `audit_${runId}.md`);

  if (opts.emit === "csv" || opts.emit === "both") {
    writeAuditCsv(rows, csvPath);
    log(`Wrote CSV: ${csvPath}`);
  }
  if (opts.emit === "md" || opts.emit === "both") {
    writeAuditMd(rows, mdPath, {
      "plan file": planFile,
      "rows": rows.length,
      "actionable": rows.filter((r) => !r.skipReason).length,
    });
    log(`Wrote MD: ${mdPath}`);
  }
  logger.close();
}

function findLatestPlanFile(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /^plan_.*\.json$/.test(f));
  if (files.length === 0) return null;
  files.sort();
  return path.join(dir, files[files.length - 1]);
}

/* ─────────────────────────────────────────────────────────────────────
 *  PHASE: apply
 * ────────────────────────────────────────────────────────────────── */

async function runApply(opts) {
  if (!opts.apply && !opts.dryRun && !opts.restoreOnlyNotifications) {
    console.error("ERROR: pass --dry-run to preview, --apply to write, or --restore-only-notifications to recover snapshots. Aborting.");
    process.exit(2);
  }

  const runId = timestampRunId();
  const logger = makeLogger(runId, opts.dryRun ? "apply-dry" : "apply");
  const { log } = logger;
  log(`mend_comments apply — runId=${runId}, dryRun=${opts.dryRun}, apply=${opts.apply}`);

  const { cloudClient } = buildClients();
  if (!(await cloudClient.testConnection())) throw new Error("Cloud connection failed");

  // Notification muter (opt-in via --mute-notifications). notifyUsers=false
  // on PUT comment is the primary suppressor; this is the belt-and-suspenders
  // fallback for sites/plugins that silently ignore the flag.
  const muter = new NotificationMuter(cloudClient, LOGS_DIR, log);
  await muter.initialize();
  // Mute the events that can fire on PUT /comment/{id}. Atlassian docs are
  // unclear on which one(s) actually fire; mute all three to be safe.
  muter.setTargetEvents(["Issue Commented", "Issue Comment Edited", "Issue Updated"]);

  if (opts.restoreOnlyNotifications) {
    log("*** RESTORE-ONLY MODE — restoring any pending notification snapshots ***");
    const result = await muter.restoreAllFromSnapshot();
    log(`Restored ${result.restored}, failed ${result.failed}`);
    logger.close();
    return;
  }

  const planManager = new PlanManager(LOGS_DIR, log);
  const planFile = opts.planFile || findLatestPlanFile(LOGS_DIR);
  if (!planFile) throw new Error("No plan file. Pass --plan-file or run `plan` first.");
  log(`Loading plan: ${planFile}`);
  const plan = await planManager.loadPlan(planFile);
  if (!plan) throw new Error(`Failed to load plan: ${planFile}`);

  const todo = planManager.getIssuesToProcess(opts.retryFailed);
  log(`Issues to process: ${todo.length}`);

  const concurrency = opts.concurrency || 3;
  log(`Concurrency: ${concurrency}`);
  if (opts.muteNotifications) {
    log(`Notification mute: ENABLED (per-project clone+swap as fallback to notifyUsers=false)`);
  } else {
    log(`Notification mute: disabled (relying on notifyUsers=false only) — pass --mute-notifications to add scheme swap`);
  }

  const stats = { applied: 0, skipped: 0, drift: 0, failed: 0, dryRun: 0 };
  let savesQueued = Promise.resolve();
  let updates = 0;

  // Per-issue worker that does the actual PUTs
  const processOneIssue = async ([issueKey, data]) => {
    if (opts.resume && data.status === "applied") return;

    const comments = Array.isArray(data.comments) ? data.comments : [];
    const actionable = comments.filter((c) => !c.skipped && c.bodyAfter);
    if (actionable.length === 0) {
      planManager.updateIssueStatus(issueKey, "skipped");
      stats.skipped++;
      return;
    }

    let issueFailed = false;
    let issueApplied = 0;

    for (const c of actionable) {
      try {
        const fresh = await cloudClient.getComment(issueKey, c.commentId);
        const currentHash = hashAdf(fresh && fresh.body);
        if (currentHash !== c.hashBefore) {
          log(`  [drift] ${issueKey}/${c.commentId} — hash changed; skipping`);
          c.applyStatus = "skipped_drift";
          stats.drift++;
          continue;
        }
        if (opts.dryRun) {
          const payloadSize = JSON.stringify({ body: c.bodyAfter }).length;
          log(`  [dry] ${issueKey}/${c.commentId} — would PUT (${payloadSize}B)`);
          c.applyStatus = "would_apply";
          stats.dryRun++;
        } else {
          await cloudClient.updateComment(issueKey, c.commentId, c.bodyAfter);
          c.applyStatus = "applied";
          c.appliedAt = new Date().toISOString();
          stats.applied++;
          issueApplied++;
        }
      } catch (e) {
        log(`  [fail] ${issueKey}/${c.commentId} — ${e.message}`);
        c.applyStatus = "failed";
        c.applyError = e.message;
        stats.failed++;
        issueFailed = true;
      }
    }

    if (opts.dryRun) {
      planManager.updateIssueStatus(issueKey, "pending");
    } else if (issueFailed && issueApplied === 0) {
      planManager.updateIssueStatus(issueKey, "failed");
    } else if (issueFailed) {
      planManager.updateIssueStatus(issueKey, "completed", "partial");
    } else {
      planManager.updateIssueStatus(issueKey, "completed");
    }

    updates++;
    if (updates % 25 === 0) {
      savesQueued = savesQueued.then(() => { planManager.savePlan(); });
      log(`  ...applied ${stats.applied}, dry ${stats.dryRun}, drift ${stats.drift}, failed ${stats.failed}`);
    }
  };

  // Group by project so we can mute/restore notifications around each
  // project's bulk PUTs. Only applied when --mute-notifications is set.
  // When the flag is OFF, behavior is identical to the previous single-pool
  // approach (just notifyUsers=false on each PUT).
  if (opts.muteNotifications && !opts.dryRun) {
    const byProject = new Map();
    for (const entry of todo) {
      const proj = (entry[0].split("-")[0] || "").toUpperCase();
      if (!byProject.has(proj)) byProject.set(proj, []);
      byProject.get(proj).push(entry);
    }
    const projectKeys = [...byProject.keys()].sort();
    log(`Executing across ${projectKeys.length} project(s) with notification muting`);

    for (const projectKey of projectKeys) {
      const projTodo = byProject.get(projectKey);
      log(`\n  [project ${projectKey}] starting (${projTodo.length} issue(s))`);

      const muted = await muter.muteProject(projectKey);
      if (!muted) {
        log(`  [project ${projectKey}] WARN: could not mute notifications — proceeding (relying on notifyUsers=false)`);
      }

      try {
        await runWorkerPool(projTodo, processOneIssue, concurrency);
      } finally {
        if (muted) {
          const ok = await muter.restoreProject(projectKey);
          if (!ok) {
            log(`  [project ${projectKey}] WARN: restore FAILED — re-run with --restore-only-notifications`);
          }
        }
      }
      log(`  [project ${projectKey}] done`);
    }
  } else {
    await runWorkerPool(todo, processOneIssue, concurrency);
  }

  await savesQueued;
  planManager.savePlan();
  log(`DONE — applied=${stats.applied}, dry=${stats.dryRun}, drift=${stats.drift}, skipped=${stats.skipped}, failed=${stats.failed}`);
  log(`Cloud stats: ${JSON.stringify(cloudClient.getStats())}`);
  logger.close();
}

/* ─────────────────────────────────────────────────────────────────────
 *  PHASE: notify-test
 *
 *  Posts a dummy comment (POST — fires one email; expected setup cost), then
 *  PUTs an edit with ?notifyUsers=false (should NOT fire email), then PUTs
 *  again WITHOUT the param (control — should fire), then deletes the comment.
 *  Operator confirms inbox between each step.
 * ────────────────────────────────────────────────────────────────── */

async function runNotifyTest(opts) {
  if (!opts.notifyTestIssue) {
    console.error("ERROR: notify-test requires --issue ISSUE-KEY");
    process.exit(2);
  }
  const runId = timestampRunId();
  const logger = makeLogger(runId, "notify-test");
  const { log } = logger;
  log(`mend_comments notify-test — runId=${runId} issue=${opts.notifyTestIssue}`);

  const { cloudClient } = buildClients();
  if (!(await cloudClient.testConnection())) throw new Error("Cloud connection failed");

  let mentionAccountId = opts.notifyTestMention;
  if (!mentionAccountId) {
    const me = await cloudClient.getCurrentUser();
    mentionAccountId = me && me.accountId;
    log(`Mention target (token owner): ${mentionAccountId} (${me && me.displayName})`);
  }
  if (!mentionAccountId) throw new Error("Could not determine a mention target accountId.");

  const tag = `[mend_comments-notify-test-${runId}]`;
  const adfWith = (extra) => ({
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: `${tag} hello ` },
          { type: "mention", attrs: { id: mentionAccountId, text: "@you", userType: "DEFAULT" } },
          { type: "text", text: extra ? ` ${extra}` : "" },
        ],
      },
    ],
  });

  let commentId = null;
  try {
    log("STEP 1 — POST new comment (email IS expected to fire — this is just setup)");
    const created = await cloudClient.addComment(opts.notifyTestIssue, adfWith(""));
    commentId = created && created.id;
    if (!commentId) throw new Error(`POST did not return a comment id: ${JSON.stringify(created).slice(0, 300)}`);
    log(`  created commentId=${commentId}`);
    log("  Check inbox now. An email SHOULD have arrived (POST has no notifyUsers param).");
    log("  Waiting 30s before next step...");
    await sleep(30000);

    log("STEP 2 — PUT edit with ?notifyUsers=false (expectation: NO email)");
    await cloudClient.updateComment(opts.notifyTestIssue, commentId, adfWith("(edited via notifyUsers=false)"));
    log("  Edit sent. Check inbox in ~30s — NO new email should arrive for this edit.");
    log("  Waiting 30s before control step...");
    await sleep(30000);

    log("STEP 3 — Control: PUT edit WITHOUT notifyUsers=false (expectation: email DOES fire)");
    // call makeRequest directly with the unparameterized PUT path
    await cloudClient.makeRequest(
      "PUT",
      `/rest/api/3/issue/${encodeURIComponent(opts.notifyTestIssue)}/comment/${encodeURIComponent(commentId)}`,
      { body: adfWith("(control edit — expect email)") },
    );
    log("  Control edit sent. Inbox SHOULD receive an email within ~30s.");
    log("  Waiting 30s before cleanup...");
    await sleep(30000);
  } finally {
    if (commentId) {
      try {
        await cloudClient.deleteComment(opts.notifyTestIssue, commentId);
        log(`STEP 4 — Deleted test comment ${commentId} (cleanup)`);
      } catch (e) {
        log(`STEP 4 — WARN: failed to delete test comment ${commentId}: ${e.message}`);
      }
    }
  }

  log("DONE. Verify with the inbox:");
  log("  STEP 1 (setup POST): email arrived ✓ expected");
  log("  STEP 2 (PUT notifyUsers=false): NO email ✓ what we need");
  log("  STEP 3 (PUT control, no param): email arrived ✓ confirms suppression is the cause");
  logger.close();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ─────────────────────────────────────────────────────────────────────
 *  ENTRY
 * ────────────────────────────────────────────────────────────────── */

(async () => {
  const opts = parseArgs(process.argv);
  try {
    switch (opts.phase) {
      case "plan": await runPlan(opts); break;
      case "audit": await runAudit(opts); break;
      case "apply": await runApply(opts); break;
      case "notify-test": await runNotifyTest(opts); break;
      default:
        printHelp();
        process.exit(opts.phase ? 2 : 0);
    }
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }
})();
