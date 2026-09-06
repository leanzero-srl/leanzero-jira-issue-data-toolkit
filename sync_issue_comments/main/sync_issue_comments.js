#!/usr/bin/env node
/**
 * sync_issue_comments — inject DC comments into Cloud for issues matching a JQL,
 * preserving JSM public/internal visibility per-comment.
 *
 * Phases:
 *   plan         — JQL→Cloud issues. Fetch DC + Cloud comments, diff via
 *                  migration-tag + heuristic pair, propose POST payloads.
 *                  Writes logs/plan_<runId>.json. No Cloud writes.
 *   audit        — Render plan as CSV + Markdown.
 *   apply        — POST each pending DC-only comment with properties (visibility,
 *                  migration tag, fidelity). Notification muting ON by default.
 *   notify-test  — Verify notification muter on this tenant.
 *
 * See README.md for full flag reference.
 */

const fs = require("fs");
const path = require("path");

require("dotenv").config({
  path: fs.existsSync(path.join(__dirname, "..", ".env"))
    ? path.join(__dirname, "..", ".env")
    : path.join(__dirname, "..", "..", "recover_truncated_content", ".env"),
});

const CloudJiraClient = require("../src/cloudJiraClient");
const DatacenterClient = require("../src/datacenterClient");
const UserMapper = require("../../mend_comments/src/userMapper");
const PlanManager = require("../../mend_comments/src/planManager");
const NotificationMuter = require("../../mend_comments/src/notificationMuter");
const { flattenText } = require("../../mend_comments/src/adfWalker");

const { diffComments } = require("../src/commentDiffer");
const { buildAdfForInjection } = require("../src/dcToAdfBody");
const { flattenPlan, writeAuditCsv, writeAuditMd } = require("../src/auditWriter");
const { splitAdfIntoParts, DEFAULT_SPLIT_BUDGET } = require("../src/adfSplitter");

const MIGRATION_TAG_KEY = CloudJiraClient.MIGRATION_TAG_KEY;
const JSM_PUBLIC_PROP_KEY = CloudJiraClient.JSM_PUBLIC_PROP_KEY;
const FIDELITY_PROP_KEY = CloudJiraClient.FIDELITY_PROP_KEY;
const PART_INDEX_PROP_KEY = CloudJiraClient.PART_INDEX_PROP_KEY;
const PART_TOTAL_PROP_KEY = CloudJiraClient.PART_TOTAL_PROP_KEY;

const SCRIPT_DIR = path.join(__dirname, "..");
const LOGS_DIR = path.join(SCRIPT_DIR, "logs");
const REPORTS_DIR = path.join(SCRIPT_DIR, "reports");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/** True if `presentParts` is exactly {1..k} for some 1 <= k <= total — i.e. the
 *  already-posted split parts form an unbroken prefix (apply breaks on the first
 *  failed part, so this is what a clean partial run looks like). */
function isContiguousPrefix(presentParts, total) {
  const k = presentParts.size;
  if (k === 0 || k > total) return false;
  for (let i = 1; i <= k; i++) {
    if (!presentParts.has(i)) return false;
  }
  return true;
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

/* ─────────────────────────────────────────────────────────────────────
 *  ARG PARSING
 * ────────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const args = argv.slice(2);
  const phase = args[0];
  const opts = {
    phase,
    projects: null,
    issue: null,
    keys: null,
    jql: null,
    limit: 0,
    concurrency: null,
    newest: false,
    userMapCache: path.join(LOGS_DIR, "user_map_cache.json"),
    planFile: null,
    emit: "both",
    dryRun: false,
    apply: false,
    resume: false,
    retryFailed: false,
    notifyTestIssue: null,
    notifyTestMention: null,
    muteNotifications: true, // ON by default — opposite of mend_comments
    strictVisibility: false,
    restoreOnlyNotifications: false,
  };

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    switch (a) {
      case "--projects":
        opts.projects = (next || "").split(",").filter(Boolean);
        i++; break;
      case "--issue":
        opts.issue = next; i++; break;
      case "--keys":
        opts.keys = (next || "").split(",").map((s) => s.trim()).filter(Boolean);
        i++; break;
      case "--jql":
        opts.jql = next; i++; break;
      case "--limit":
        opts.limit = parseInt(next, 10) || 0; i++; break;
      case "--concurrency":
        opts.concurrency = parseInt(next, 10) || 0; i++; break;
      case "--newest":
        opts.newest = true; break;
      case "--user-map-cache":
        opts.userMapCache = next; i++; break;
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
      case "--no-mute-notifications":
        opts.muteNotifications = false; break;
      case "--strict-visibility":
        opts.strictVisibility = true; break;
      case "--restore-only-notifications":
        opts.restoreOnlyNotifications = true; break;
      case "--mention":
        opts.notifyTestMention = next; i++; break;
      case "--help":
      case "-h":
        printHelp(); process.exit(0);
      default:
        if (!a.startsWith("--")) {
          // positional ignored
        } else {
          console.error(`Unknown flag: ${a}`);
          printHelp();
          process.exit(2);
        }
    }
  }
  if (phase === "notify-test") opts.notifyTestIssue = opts.issue;
  return opts;
}

function printHelp() {
  console.log(`
Usage:
  sync_issue_comments.js plan         [--jql 'JQL'] [--projects K1,K2] [--issue KEY] [--keys K1,K2]
                                       [--limit N] [--concurrency 5] [--newest]
                                       [--user-map-cache PATH]
       --jql takes precedence over --issue/--keys/--projects. Scoped API tokens:
       set CLOUD_BASE_URL=https://api.atlassian.com/ex/jira/<cloudId> and
       CLOUD_API_TOKEN=base64(serviceaccount-email:scoped-token).
  sync_issue_comments.js audit        [--plan-file PATH] [--emit csv|md|both]
  sync_issue_comments.js apply        [--plan-file PATH] [--dry-run] [--apply]
                                       [--concurrency 3] [--resume] [--retry-failed]
                                       [--no-mute-notifications] [--strict-visibility]
                                       [--restore-only-notifications]
  sync_issue_comments.js notify-test  --issue KEY [--mention ACCOUNT_ID]
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
 *  WORKER POOL
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
 *  VISIBILITY RESOLUTION
 *
 *  Priority chain for the JSM internal/public flag:
 *    1. DC comment property `sd.public.comment` (already extracted as sdPublic)
 *    2. JSM Service Desk API fallback (/servicedeskapi/request/{key}/comment)
 *    3. Default-to-internal (recorded as visibilityFallback="default_internal")
 *
 *  Returns: { internal: boolean, source: string, visibilityFallback: string|null }
 * ────────────────────────────────────────────────────────────────── */

function resolveJsmVisibility(dcComment, servicedeskMap) {
  if (dcComment.sdPublic && typeof dcComment.sdPublic.internal === "boolean") {
    return {
      internal: dcComment.sdPublic.internal,
      source: dcComment.sdPublic.source,
      visibilityFallback: null,
    };
  }
  if (servicedeskMap) {
    const sd = servicedeskMap.get(String(dcComment.id));
    if (sd && typeof sd.internal === "boolean") {
      return { internal: sd.internal, source: sd.source, visibilityFallback: null };
    }
  }
  return {
    internal: true,
    source: "default_internal",
    visibilityFallback: "default_internal",
  };
}

/* ─────────────────────────────────────────────────────────────────────
 *  PHASE: plan
 * ────────────────────────────────────────────────────────────────── */

async function runPlan(opts) {
  ensureDir(LOGS_DIR);
  const runId = timestampRunId();
  const logger = makeLogger(runId, "plan");
  const { log } = logger;

  log(`sync_issue_comments plan — runId=${runId}`);

  const { cloudClient, dcClient } = buildClients();
  const userMapper = new UserMapper(cloudClient, {
    cacheFilePath: opts.userMapCache,
    log,
  });

  const resolveDcEmail = async (dcUsername) => {
    if (!dcUsername) return null;
    let dcUser;
    try { dcUser = await dcClient.getUser(dcUsername); }
    catch (e) {
      log(`  [resolve] DC user lookup failed for "${dcUsername}": ${e.message}`);
      return null;
    }
    if (!dcUser || !dcUser.emailAddress) return null;
    const r = await userMapper.resolveByEmail(dcUser.emailAddress);
    return r.accountId || null;
  };

  const planManager = new PlanManager(LOGS_DIR, log);
  planManager.createMasterIndex(runId, { mode: "sync_issue_comments" });
  planManager.openHitsJsonl(runId);

  const concurrency = opts.concurrency || 5;
  log(`Concurrency: ${concurrency}`);

  // Build JQL
  let jql;
  if (opts.jql) {
    // Arbitrary operator-supplied JQL (e.g. `creator in (accountId, ...)`).
    // Takes precedence; used to scope the run to a migration population.
    jql = opts.jql;
  } else if (opts.issue) {
    jql = `key = ${opts.issue}`;
  } else if (opts.keys && opts.keys.length) {
    jql = `key in (${opts.keys.join(", ")})`;
  } else if (opts.projects && opts.projects.length) {
    jql = `project in (${opts.projects.map((p) => `"${p}"`).join(", ")})`;
    jql += opts.newest ? ` ORDER BY created DESC` : ` ORDER BY created ASC`;
  } else {
    throw new Error("Provide one of: --jql, --issue, --keys, --projects");
  }
  log(`JQL: ${jql}`);

  if (!(await cloudClient.testConnection())) throw new Error("Cloud connection failed");
  if (!(await dcClient.testConnection())) throw new Error("DC connection failed");

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
  let issuesWithInjects = 0;
  let totalInjects = 0;
  let userResolveTicks = 0;

  await runWorkerPool(issueKeys, async (issueKey) => {
    try {
      // Use getCommentsWithVisibility — DC's issue-level expand of comment
      // properties is unreliable, and we need the JSM sd.public.comment
      // property on every comment, not just some.
      const [cloudComments, dcComments] = await Promise.all([
        cloudClient.getCommentsWithProperties(issueKey),
        dcClient.getCommentsWithVisibility(issueKey),
      ]);

      if (!dcComments || dcComments.length === 0) {
        planManager.appendHit(issueKey, {
          status: "skipped",
          skipReason: "no_dc_comments",
          toCreate: [],
          skipped: [],
        });
        processed++;
        return;
      }

      // Servicedesk fallback for visibility — single call per issue.
      const servicedeskMap = await dcClient.getServiceDeskCommentPublicFlags(issueKey);

      const { toCreate, skipped: alreadyCoveredSkipped, partial } = await diffComments({
        cloudComments,
        dcComments,
        resolveDcEmail,
        log,
      });

      const toCreatePlan = [];
      for (const dc of toCreate) {
        const vis = resolveJsmVisibility(dc, servicedeskMap);
        const built = await buildAdfForInjection({
          dcComment: dc,
          dcClient,
          userMapper,
          log,
        });
        const snippet = flattenText(built.adf).replace(/\s+/g, " ").trim().slice(0, 200);
        const payloadSize = JSON.stringify(built.adf).length;

        // Split oversized comments into multiple sequential parts so each fits
        // under Cloud's 32,767-char ADF body cap. Comments at or below budget
        // stay a single part (uniform downstream code path).
        let parts;
        let fidelity = built.fidelity;
        if (payloadSize <= DEFAULT_SPLIT_BUDGET) {
          parts = [
            { adf: built.adf, partIndex: 1, partTotal: 1, adfSize: payloadSize },
          ];
        } else {
          const { parts: partDocs, partTotal, lossy } = splitAdfIntoParts(built.adf, {
            attributionNode: built.adf.content[0],
          });
          parts = partDocs.map((adf, idx) => ({
            adf,
            partIndex: idx + 1,
            partTotal,
            adfSize: JSON.stringify(adf).length,
          }));
          if (lossy && fidelity === "adf_full") fidelity = "adf_partial_split";
          log(
            `  [split] ${issueKey}/${dc.id} — ${payloadSize}B body → ${partTotal} part(s)` +
              (lossy ? " (lossy)" : ""),
          );
        }

        // Partial-resume top-up: a prior run already created some parts of this
        // (deterministically split) comment. Mark already-present part indices
        // so apply skips them and only posts the missing tail. Guard against a
        // changed split (total mismatch) or a non-prefix hole — surface those
        // for manual review instead of risking duplicates / out-of-order parts.
        const prior = partial && partial.get(String(dc.id));
        if (prior) {
          if (prior.total !== parts.length) {
            for (const p of parts) p.skipReason = "split_total_mismatch";
            log(
              `  [topup-skip] ${issueKey}/${dc.id} — prior split total ${prior.total} != recomputed ${parts.length}; needs manual review`,
            );
          } else if (!isContiguousPrefix(prior.presentParts, prior.total)) {
            for (const p of parts) p.skipReason = "split_noncontiguous";
            log(
              `  [topup-skip] ${issueKey}/${dc.id} — present parts not a contiguous prefix; needs manual review`,
            );
          } else {
            for (const p of parts) {
              if (prior.presentParts.has(p.partIndex)) p.skipReason = "already_present";
            }
            log(
              `  [topup] ${issueKey}/${dc.id} — ${prior.presentParts.size}/${prior.total} parts already present; will post the rest`,
            );
          }
        }

        toCreatePlan.push({
          dcCommentId: String(dc.id),
          dcAuthor:
            (dc.author && (dc.author.displayName || dc.author.name)) || null,
          created: dc.created,
          internal: vis.internal,
          visibilitySource: vis.source,
          visibilityFallback: vis.visibilityFallback,
          visibility: dc.visibility || null, // classic role/group passthrough
          fidelity,
          unknownTags: built.unknownTags,
          adfSize: parts.reduce((m, p) => Math.max(m, p.adfSize), 0),
          partTotal: parts.length,
          parts,
          snippet,
        });
        totalInjects++;
      }

      const skipEntries = (alreadyCoveredSkipped || []).map((s) => ({
        dcCommentId: String(s.dc.id),
        dcAuthor: (s.dc.author && (s.dc.author.displayName || s.dc.author.name)) || null,
        created: s.dc.created,
        reason: s.reason,
      }));

      if (toCreatePlan.length > 0) issuesWithInjects++;

      planManager.appendHit(issueKey, {
        status: toCreatePlan.length > 0 ? "pending" : "skipped",
        skipReason: toCreatePlan.length === 0 ? "all_covered" : null,
        toCreate: toCreatePlan,
        skipped: skipEntries,
      });

      processed++;
      if (processed % 25 === 0) {
        log(`  ...processed ${processed}/${issueKeys.length} (issues with injects: ${issuesWithInjects}, total injects: ${totalInjects})`);
      }
      userResolveTicks++;
      if (userResolveTicks % 50 === 0) userMapper.flushCache();
    } catch (e) {
      log(`  ERROR on ${issueKey}: ${e.message}`);
      planManager.appendHit(issueKey, {
        status: "failed",
        error: e.message,
        toCreate: [],
        skipped: [],
      });
    }
  }, concurrency);

  userMapper.flushCache();
  const finalized = await planManager.finalizePlanFromJsonl(runId);
  log(`Finalized plan: ${finalized.planFile}`);
  log(`  total issues: ${finalized.total}, pending (have injects): ${finalized.pending}, failed: ${finalized.failed}`);
  log(`  total comments to inject: ${totalInjects}`);
  log(`UserMapper stats: ${JSON.stringify(userMapper.getStats())}`);
  log(`Cloud stats: ${JSON.stringify(cloudClient.getStats())}`);
  log(`DC stats: ${JSON.stringify(dcClient.getStats())}`);
  logger.close();
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

  const totalCreates = rows.filter((r) => r.kind === "create").length;
  const fallbacks = rows.filter((r) => r.visibilityFallback === "default_internal").length;
  const lowFidelity = rows.filter((r) => r.fidelity && r.fidelity !== "adf_full" && r.kind === "create").length;

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
      "comments to inject": totalCreates,
      "default_internal fallbacks": fallbacks,
      "low-fidelity bodies": lowFidelity,
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
  log(`sync_issue_comments apply — runId=${runId}, dryRun=${opts.dryRun}, apply=${opts.apply}, mute=${opts.muteNotifications}, strict=${opts.strictVisibility}`);

  const { cloudClient } = buildClients();
  if (!(await cloudClient.testConnection())) throw new Error("Cloud connection failed");

  const muter = new NotificationMuter(cloudClient, LOGS_DIR, log);
  await muter.initialize();
  muter.setTargetEvents(["Issue Commented", "Issue Comment Edited", "Issue Updated"]);

  if (opts.restoreOnlyNotifications) {
    log("*** RESTORE-ONLY MODE ***");
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

  const stats = { created: 0, dryRun: 0, skipped: 0, failed: 0, strictSkipped: 0 };
  let updates = 0;

  // Pre-check ADD_COMMENTS per project (POST /comment requires ADD_COMMENTS,
  // not EDIT_ISSUES). Project key is derived from issue key prefix.
  const projectKeys = new Set(todo.map(([k]) => (k.split("-")[0] || "").toUpperCase()));
  for (const p of projectKeys) {
    const ok = await cloudClient.verifyAddCommentsPermission(p);
    if (!ok) {
      log(`  WARN: token lacks ADD_COMMENTS on ${p} — POSTs to that project will fail`);
    }
  }

  const processOneIssue = async ([issueKey, data]) => {
    if (opts.resume && data.status === "completed") return;
    const toCreate = Array.isArray(data.toCreate) ? data.toCreate : [];
    if (toCreate.length === 0) {
      planManager.updateIssueStatus(issueKey, "skipped");
      stats.skipped++;
      return;
    }

    let issueFailed = false;

    for (const c of toCreate) {
      if (opts.strictVisibility && c.visibilityFallback === "default_internal") {
        // Skip the WHOLE comment (every part) — never post a partial split with
        // the wrong visibility.
        log(`  [strict] ${issueKey}/${c.dcCommentId} — visibility unknown; skipping`);
        c.applyStatus = "strict_skipped";
        stats.strictSkipped++;
        continue;
      }

      // Oversized comments are split into ordered parts B1, B2, B3; non-split
      // comments are a single part. Post them sequentially so Cloud's
      // created-timestamp ordering keeps the chain intact.
      const parts = Array.isArray(c.parts)
        ? c.parts
        : [{ adf: c.adf, partIndex: 1, partTotal: 1 }];
      const isSplit = parts.length > 1;

      const inlineProperties = [
        { key: JSM_PUBLIC_PROP_KEY, value: { internal: c.internal === true } },
      ];

      let anyPartFailed = false;
      let anyPartCreated = false;

      for (const part of parts) {
        // Partial-resume: this part already exists in Cloud (planned top-up).
        if (part.skipReason) {
          part.applyStatus = `skipped_${part.skipReason}`;
          continue;
        }

        // Hybrid path — empirically verified on SD-137182 2026-06-02:
        //   1. sd.public.comment MUST be set INLINE on POST. PUT-after-POST
        //      stores the property but JSM UI ignores it (JSDCLOUD-6050).
        //   2. The inline `properties` array only accepts OBJECT values.
        //      A primitive string value (e.g. migration.dc_comment_id="12735754")
        //      causes the whole array to be rejected with a misleading
        //      "EntityPropertyBean is not a valid JSON" 400. So we keep
        //      ONLY sd.public.comment inline and PUT the tags separately.
        //   3. The migration/part tags are read-only metadata for idempotency;
        //      the UI doesn't render them, so PUT-after-POST is fine.
        const followupProperties = [
          { key: MIGRATION_TAG_KEY, value: String(c.dcCommentId) },
        ];
        if (isSplit) {
          followupProperties.push({ key: PART_INDEX_PROP_KEY, value: part.partIndex });
          followupProperties.push({ key: PART_TOTAL_PROP_KEY, value: part.partTotal });
        }
        if (c.fidelity && c.fidelity !== "adf_full") {
          followupProperties.push({ key: FIDELITY_PROP_KEY, value: c.fidelity });
        }

        const label = isSplit
          ? `${issueKey}/${c.dcCommentId} part ${part.partIndex}/${part.partTotal}`
          : `${issueKey}/${c.dcCommentId}`;

        try {
          if (opts.dryRun) {
            const size = JSON.stringify({
              body: part.adf,
              properties: inlineProperties,
              visibility: c.visibility || undefined,
            }).length;
            log(`  [dry] ${label} — would POST (${size}B, inline sd.public.comment internal=${c.internal}) + ${followupProperties.length} property PUT(s), fidelity=${c.fidelity}`);
            part.applyStatus = "would_create";
            stats.dryRun++;
          } else {
            const res = await cloudClient.addCommentV3WithProps(issueKey, part.adf, {
              properties: inlineProperties,
              visibility: c.visibility || null,
            });
            const newId = res && res.id ? String(res.id) : null;
            if (!newId) throw new Error("POST returned no comment id");
            part.createdCloudCommentId = newId;

            const propFailures = [];
            for (const p of followupProperties) {
              try {
                await cloudClient.setCommentProperty(newId, p.key, p.value);
              } catch (pe) {
                propFailures.push({ key: p.key, error: pe.message });
              }
            }
            if (propFailures.length > 0) {
              // Part exists with correct visibility but a tag PUT failed. For a
              // split comment a failed part_index/part_total PUT degrades
              // partial-resume detection — log it loudly so it's auditable.
              part.applyStatus = "created_partial_props";
              part.propFailures = propFailures;
              const tag = isSplit ? "[part-tag-fail]" : "[partial-tag]";
              log(`  ${tag} ${label} → cloudId=${newId} created with correct visibility, but tag PUT failed: ${JSON.stringify(propFailures)}`);
              stats.created++;
            } else {
              part.applyStatus = "created";
              part.appliedAt = new Date().toISOString();
              stats.created++;
            }
            anyPartCreated = true;
          }
        } catch (e) {
          log(`  [fail] ${label} — ${e.message}`);
          part.applyStatus = "failed";
          part.applyError = e.message;
          stats.failed++;
          anyPartFailed = true;
          // STOP posting later parts of this comment: keep the posted parts a
          // contiguous prefix so a future resume appends the rest IN ORDER
          // (Cloud created-timestamps are monotonic). Posting B3 after B2 failed
          // would both break the chain and block a clean top-up.
          break;
        }
      }

      // Roll part statuses up to the comment.
      if (opts.dryRun) {
        c.applyStatus = "would_create";
      } else if (anyPartFailed) {
        c.applyStatus = anyPartCreated ? "created_partial_parts" : "failed";
        issueFailed = true;
        // STOP processing later comments in this issue. Cloud must always hold
        // an ORDERED PREFIX of the intended A,B1,B2,B3,C chain so a re-plan/apply
        // appends the missing suffix in order (created-timestamps are monotonic).
        // If we continued to C now, the failed comment's resumed parts would get
        // newer timestamps and land AFTER C. Trade-off: a permanently-failing
        // ("poison") comment blocks the rest of its issue until it's resolved or
        // --strict-visibility-skipped — surfaced via the issue's failed status.
        log(`  [halt-issue] ${issueKey} — comment ${c.dcCommentId} failed; deferring remaining comments to preserve order`);
        break;
      } else if (!anyPartCreated) {
        // Nothing posted and nothing failed → every part was skipped (a
        // top-up where all parts already exist, or a split_total_mismatch /
        // split_noncontiguous guard flagged for manual review).
        c.applyStatus = parts.find((p) => p.skipReason)
          ? `skipped_${parts.find((p) => p.skipReason).skipReason}`
          : "skipped";
      } else {
        c.applyStatus = "created";
      }
    }

    if (opts.dryRun) {
      planManager.updateIssueStatus(issueKey, "pending");
    } else if (issueFailed) {
      // Any failed part leaves the issue resumable. (Previously gated on
      // issueCreated===0, which would wrongly mark a partially-applied issue
      // "completed" and skip it on --resume — fatal once one comment is split
      // across multiple parts.)
      planManager.updateIssueStatus(issueKey, "failed");
    } else {
      planManager.updateIssueStatus(issueKey, "completed");
    }
    updates++;
    if (updates % 25 === 0) {
      planManager.savePlan();
      log(`  ...created=${stats.created}, dry=${stats.dryRun}, strictSkip=${stats.strictSkipped}, failed=${stats.failed}`);
    }
  };

  // Group by project so we can mute notification scheme around each project's writes.
  if (opts.muteNotifications && !opts.dryRun) {
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
      log(`\n  [project ${projectKey}] starting (${projTodo.length} issue(s))`);
      const muted = await muter.muteProject(projectKey);
      if (!muted) {
        log(`  [project ${projectKey}] WARN: could not mute notifications — proceeding`);
      }
      try {
        await runWorkerPool(projTodo, processOneIssue, concurrency);
      } finally {
        if (muted) {
          const ok = await muter.restoreProject(projectKey);
          if (!ok) log(`  [project ${projectKey}] WARN: restore FAILED — re-run --restore-only-notifications`);
        }
      }
      log(`  [project ${projectKey}] done`);
    }
  } else {
    if (!opts.muteNotifications && !opts.dryRun) {
      log(`*** NOTIFICATION MUTE DISABLED via --no-mute-notifications — watchers/customers WILL be emailed ***`);
    }
    await runWorkerPool(todo, processOneIssue, concurrency);
  }

  planManager.savePlan();
  log(`DONE — created=${stats.created}, dry=${stats.dryRun}, strictSkip=${stats.strictSkipped}, skipped=${stats.skipped}, failed=${stats.failed}`);
  log(`Cloud stats: ${JSON.stringify(cloudClient.getStats())}`);
  logger.close();
}

/* ─────────────────────────────────────────────────────────────────────
 *  PHASE: notify-test
 *
 *  POST a tagged comment, edit it with notifyUsers=false, then control edit,
 *  then delete. Operator confirms inbox at each step.
 * ────────────────────────────────────────────────────────────────── */

async function runNotifyTest(opts) {
  if (!opts.notifyTestIssue) {
    console.error("ERROR: notify-test requires --issue ISSUE-KEY");
    process.exit(2);
  }
  const runId = timestampRunId();
  const logger = makeLogger(runId, "notify-test");
  const { log } = logger;
  log(`sync_issue_comments notify-test — runId=${runId} issue=${opts.notifyTestIssue}`);

  const { cloudClient } = buildClients();
  if (!(await cloudClient.testConnection())) throw new Error("Cloud connection failed");

  let mentionAccountId = opts.notifyTestMention;
  if (!mentionAccountId) {
    const me = await cloudClient.getCurrentUser();
    mentionAccountId = me && me.accountId;
    log(`Mention target (token owner): ${mentionAccountId} (${me && me.displayName})`);
  }
  if (!mentionAccountId) throw new Error("Could not determine a mention target accountId.");

  const tag = `[sync_issue_comments-notify-test-${runId}]`;
  const adfWith = (extra) => ({
    type: "doc",
    version: 1,
    content: [{
      type: "paragraph",
      content: [
        { type: "text", text: `${tag} hello ` },
        { type: "mention", attrs: { id: mentionAccountId, text: "@you", userType: "DEFAULT" } },
        { type: "text", text: extra ? ` ${extra}` : "" },
      ],
    }],
  });

  let commentId = null;
  try {
    log("STEP 1 — POST (no notifyUsers param on POST — email is expected to fire)");
    const created = await cloudClient.addCommentV3WithProps(opts.notifyTestIssue, adfWith(""), {});
    commentId = created && created.id;
    if (!commentId) throw new Error("POST did not return a comment id");
    log(`  created commentId=${commentId}`);
    log("  Check inbox now — email SHOULD have arrived.");
    await sleep(30000);

    log("STEP 2 — PUT edit with ?notifyUsers=false (expectation: NO email)");
    await cloudClient.updateComment(opts.notifyTestIssue, commentId, adfWith("(edited via notifyUsers=false)"));
    log("  Edit sent. Check inbox in ~30s — NO new email should arrive.");
    await sleep(30000);

    log("STEP 3 — Control: PUT WITHOUT notifyUsers=false (expectation: email DOES fire)");
    await cloudClient.makeRequest(
      "PUT",
      `/rest/api/3/issue/${encodeURIComponent(opts.notifyTestIssue)}/comment/${encodeURIComponent(commentId)}`,
      { body: adfWith("(control edit — expect email)") },
    );
    log("  Control edit sent. Inbox SHOULD receive an email within ~30s.");
    await sleep(30000);
  } finally {
    if (commentId) {
      try {
        await cloudClient.deleteComment(opts.notifyTestIssue, commentId);
        log(`STEP 4 — Deleted test comment ${commentId}`);
      } catch (e) {
        log(`STEP 4 — WARN: failed to delete test comment ${commentId}: ${e.message}`);
      }
    }
  }

  log("DONE.");
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
