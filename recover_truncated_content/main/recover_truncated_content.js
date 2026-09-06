#!/usr/bin/env node

/**
 * Recover Truncated Descriptions & Comments
 *
 * Scans every Cloud issue across every project, detects descriptions and
 * comment bodies whose serialized ADF JSON length is exactly 32,767 (the
 * JCMA cap that produces silent truncation during DC -> Cloud migration),
 * fetches the full text from the matching Data Center issue (using
 * renderedFields HTML for rich-text fidelity), and writes:
 *   - reports/docx/{KEY}_description.docx       (when description was truncated)
 *   - reports/docx/{KEY}_comment.docx           (when any comment was truncated;
 *                                                ALL comments included in
 *                                                chronological order)
 * Files over 10 MB split into _1, _2, _3, ...
 *
 * Two-phase architecture:
 *   PLAN (default):   scan + detect + generate docx + write plan JSON.
 *                     No Cloud writes. Resumable via logs/checkpoint.jsonl.
 *   APPLY (--apply):  read plan + upload each docx as a Cloud attachment.
 *                     Cloud description/comment bodies are NOT modified.
 */

// Self-bump heap + expose --gc so the long-running scan doesn't OOM on big
// projects (default Node heap is ~2GB; we've seen SD reach 5,975 hits + heavy
// docx render state and crash). Re-spawns once with the flags set.
if (
  !process.env._RTC_HEAP_BUMPED &&
  !process.execArgv.some((a) => a.startsWith("--max-old-space-size"))
) {
  const { spawnSync } = require("child_process");
  const args = [
    "--max-old-space-size=8192",
    "--expose-gc",
    ...process.argv.slice(1),
  ];
  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: { ...process.env, _RTC_HEAP_BUMPED: "1" },
  });
  process.exit(result.status == null ? 1 : result.status);
}

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DatacenterClient = require("../src/datacenterClient");
const CloudJiraClient = require("../src/cloudJiraClient");
const PlanManager = require("../src/planManager");
const RecoveryProcessor = require("../src/recoveryProcessor");
const NotificationMuter = require("../src/notificationMuter");

const DEFAULT_MAX_DOCX_BYTES = 10 * 1024 * 1024;

class TruncationRecovery {
  constructor(options = {}) {
    this.options = {
      projects: options.projects || null, // string[] of Cloud project keys
      limit: options.limit || 0,
      apply: options.apply || false,
      dryRun: options.dryRun || false,
      planFile: options.planFile || null,
      resume: options.resume || false,
      retryFailed: options.retryFailed || false,
      concurrency: options.concurrency || 3,
      keyMapFile: options.keyMapFile || null,
      maxDocxBytes: options.maxDocxBytes || DEFAULT_MAX_DOCX_BYTES,
      muteNotifications: options.muteNotifications !== false, // default true
      restoreOnly: options.restoreOnly || false,
    };

    this.validateConfig();

    this.logDir = path.join(__dirname, "../logs");
    if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
    this.docxOutDir = path.join(__dirname, "../reports/docx");
    if (!fs.existsSync(this.docxOutDir)) fs.mkdirSync(this.docxOutDir, { recursive: true });

    this.logFile = path.join(this.logDir, `recover_${Date.now()}.log`);
    fs.writeFileSync(
      this.logFile,
      `Recover Truncated Content Log\nStarted: ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`,
    );

    this.log = this.log.bind(this);

    // DC: PAT preferred over basic
    if (process.env.DC_PAT) {
      this.dcClient = new DatacenterClient(process.env.DC_BASE_URL, {
        token: process.env.DC_PAT,
      });
    } else {
      this.dcClient = new DatacenterClient(process.env.DC_BASE_URL, {
        username: process.env.DC_USERNAME,
        password: process.env.DC_PASSWORD,
      });
    }

    this.cloudClient = new CloudJiraClient(
      process.env.CLOUD_BASE_URL,
      process.env.CLOUD_API_TOKEN,
    );

    this.planManager = new PlanManager(this.logDir, this.log);
    if (this.options.planFile) this.planManager.setPlanFile(this.options.planFile);

    this.keyMap = this._loadKeyMap();
    this.startTime = Date.now();
  }

  validateConfig() {
    const baseRequired = ["DC_BASE_URL", "CLOUD_BASE_URL", "CLOUD_API_TOKEN"];
    const missing = baseRequired.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}\nCheck the .env file.`,
      );
    }
    if (!process.env.DC_PAT && !(process.env.DC_USERNAME && process.env.DC_PASSWORD)) {
      throw new Error(
        "DC auth missing: set DC_PAT, OR set BOTH DC_USERNAME and DC_PASSWORD.",
      );
    }
  }

  _loadKeyMap() {
    if (!this.options.keyMapFile) return {};
    try {
      const raw = fs.readFileSync(this.options.keyMapFile, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      throw new Error("expected a JSON object { cloudKey: dcKey }");
    } catch (e) {
      throw new Error(
        `--key-map ${this.options.keyMapFile}: ${e.message}`,
      );
    }
  }

  log(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(message);
    try {
      fs.appendFileSync(this.logFile, line + "\n");
    } catch {
      /* ignore */
    }
  }

  async run() {
    this.log("==========================================");
    this.log("Recover Truncated Descriptions & Comments");
    this.log("==========================================");
    this.log(`  DC:    ${process.env.DC_BASE_URL}`);
    this.log(`  Cloud: ${process.env.CLOUD_BASE_URL}`);
    this.log(`  Auth (DC): ${process.env.DC_PAT ? "PAT (bearer)" : "Basic (username+password)"}`);
    this.log("");

    if (this.options.dryRun) {
      this.log("*** DRY RUN MODE: no uploads will be performed ***");
      this.log("");
    }

    if (this.options.projects) {
      this.log(`  Projects filter: ${this.options.projects.join(", ")}`);
    } else {
      this.log(`  Projects filter: <none> (will scan ALL Cloud projects)`);
    }
    if (this.options.limit > 0) this.log(`  Per-project issue limit: ${this.options.limit}`);
    if (this.options.keyMapFile) {
      this.log(
        `  Key map: ${this.options.keyMapFile} (${Object.keys(this.keyMap).length} entries)`,
      );
    }
    this.log(`  Max docx bytes (split threshold): ${this.options.maxDocxBytes}`);
    this.log(`  Concurrency: ${this.options.concurrency}`);
    if (this.options.retryFailed) this.log(`  Retry failed: YES`);
    this.log(
      `  Mode: ${this.options.apply ? "APPLY (upload docx to Cloud)" : "PLAN (scan + generate docx; no Cloud writes)"}`,
    );

    this.log("\nStep 1: Testing connections...");
    const dcOk = await this.dcClient.testConnection();
    if (!dcOk) throw new Error("Cannot connect to Jira Datacenter");
    this.log("  Datacenter: OK");

    const cloudOk = await this.cloudClient.testConnection();
    if (!cloudOk) throw new Error("Cannot connect to Jira Cloud");
    this.log("  Cloud Jira: OK");

    // NotificationMuter — instantiated for apply phase to suppress per-project
    // "Issue Updated" spam during bulk attachment uploads. Snapshots persist
    // to logs/ so a crash can be recovered with --restore-only.
    this.muter = new NotificationMuter(this.cloudClient, this.logDir, this.log);
    await this.muter.initialize();

    // --restore-only path: just restore any pending snapshots and exit.
    if (this.options.restoreOnly) {
      this.log("\n*** RESTORE-ONLY MODE — restoring any pending notification snapshots ***");
      const result = await this.muter.restoreAllFromSnapshot();
      this.log(`  Restored ${result.restored}, failed ${result.failed}`);
      return;
    }

    const processor = new RecoveryProcessor(
      this.cloudClient,
      this.dcClient,
      this.planManager,
      {
        apply: this.options.apply,
        dryRun: this.options.dryRun,
        limit: this.options.limit,
        concurrency: this.options.concurrency,
        retryFailed: this.options.retryFailed,
        projects: this.options.projects,
        keyMap: this.keyMap,
        maxDocxBytes: this.options.maxDocxBytes,
        log: this.log,
        logDir: this.logDir,
        docxOutDir: this.docxOutDir,
        muter: this.muter,
        muteNotifications: this.options.muteNotifications,
      },
    );

    if (!this.options.apply) {
      // PLAN PHASE — always runs a fresh scan unless resuming
      const runId = String(Date.now());
      this.log("\nStep 2: Building plan (scanning Cloud, detecting truncation, fetching DC, generating docx)...");
      await processor.buildPlan(runId);
      this.printFinalReport(processor.getStats());
      return;
    }

    // APPLY PHASE
    this.log("\nStep 2: Loading existing plan...");
    const master = this.planManager.loadMasterIndex(this.options.planFile);
    if (!master) {
      throw new Error(
        "No master index found. Run without --apply first to build a plan, or pass --plan-file.",
      );
    }
    const planFile = this.planManager.masterIndex?.planFile;
    if (!planFile) {
      throw new Error("Master index does not reference a plan file.");
    }
    const plan = await this.planManager.loadPlan(planFile);
    if (!plan) {
      throw new Error("Could not load plan file.");
    }

    this.log(
      `\nStep 3: Applying plan (${this.planManager.plan.stats.pending} pending issues)...`,
    );
    await processor.applyPlan();

    this.planManager.savePlan();
    this.planManager.saveMasterIndex();

    this.printFinalReport(processor.getStats());
  }

  printFinalReport(stats) {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const dcStats = this.dcClient.getStats();
    const cloudStats = this.cloudClient.getStats();
    const planSummary = this.planManager.getPlanSummary();

    this.log("\n" + "=".repeat(60));
    this.log("FINAL REPORT");
    this.log("=".repeat(60));

    if (this.options.dryRun) this.log("*** DRY RUN — no Cloud changes were made ***\n");

    this.log("Scan / Plan:");
    this.log(`  Projects scanned:                ${stats.projectsScanned}`);
    this.log(`  Projects skipped (checkpoint):   ${stats.projectsSkippedCheckpoint}`);
    this.log(`  DC issues scanned:               ${stats.issuesScanned}`);
    this.log(`  Issues with content over cap:    ${stats.issuesOverCap}`);
    this.log(`  Descriptions over cap:           ${stats.descriptionsOverCap}`);
    this.log(`  Comments over cap:               ${stats.commentsOverCap}`);
    this.log(`  DC renderedFields failures:      ${stats.dcFetchFailures}`);
    this.log(`  Docx files written:              ${stats.docxFilesWritten}`);
    const mb = (n) => (n / 1024 / 1024).toFixed(2);
    this.log(`  Docx bytes total:                ${stats.docxBytesTotal} (${mb(stats.docxBytesTotal)} MB)`);

    if (this.options.apply) {
      this.log("\nApply / Upload:");
      this.log(`  Uploads attempted:               ${stats.uploadsAttempted}`);
      this.log(`  Uploads succeeded:               ${stats.uploadsSucceeded}`);
      this.log(`  Uploads failed:                  ${stats.uploadsFailed}`);
      this.log(`  Uploads skipped (no perm):       ${stats.uploadsSkippedNoPermission}`);
      this.log(`  Issues completed:                ${stats.issuesCompleted}`);
      this.log(`  Issues partial:                  ${stats.issuesPartial}`);
      this.log(`  Issues failed:                   ${stats.issuesFailed}`);
      this.log(`  Issues skipped:                  ${stats.issuesSkipped}`);
    }

    if (planSummary) {
      this.log("\nPlan Status:");
      this.log(`  Total issues:           ${planSummary.totalIssues || planSummary.total || 0}`);
      this.log(`  Completed:              ${planSummary.completed || 0}`);
      this.log(`  Failed:                 ${planSummary.failed || 0}`);
      this.log(`  Pending:                ${planSummary.pending || 0}`);
      this.log(`  Skipped:                ${planSummary.skipped || 0}`);
      this.log(`  Master index:           ${planSummary.masterFile || "N/A"}`);
      if (planSummary.planFile) this.log(`  Plan file:              ${planSummary.planFile}`);
    }

    if (this.planManager.masterIndex) {
      const m = this.planManager.masterIndex;
      if (m.truncationSummaryCsv) this.log(`  Truncation summary CSV: ${m.truncationSummaryCsv}`);
    }

    this.log("\nAPI Statistics:");
    this.log(`  DC requests:            ${dcStats.requestCount} (${dcStats.errorCount} errors)`);
    this.log(
      `  Cloud requests:         ${cloudStats.requestCount} (${cloudStats.errorCount} errors, ${cloudStats.rateLimitCount} rate limits)`,
    );

    this.log(`\nDocx output dir:         ${this.docxOutDir}`);
    this.log(`Log file:                ${this.logFile}`);
    this.log(`Total elapsed time:      ${elapsed}s`);
    this.log("=".repeat(60));
  }

  static showHelp() {
    console.log(`
Recover Truncated Descriptions & Comments (DC -> Cloud post-migration)

Usage:
  node main/recover_truncated_content.js [options]              # plan-mode (default)
  node main/recover_truncated_content.js --apply [options]      # apply (upload docx)

Options:
  --projects K1,K2         Restrict scan to these Cloud project keys (default: all)
  --limit N                Cap issues scanned per project (smoke testing)
  --apply                  Upload generated docx files to Cloud as attachments
  --plan-file PATH         Master index JSON for --apply (default: latest in logs/)
  --resume                 Continue an existing plan (alias for using latest master)
  --retry-failed           Re-attempt issues marked failed
  --concurrency N          Worker count for apply phase (default: 3)
  --dry-run                With --apply: log uploads without executing
  --key-map FILE           Optional JSON { "CLOUD-KEY": "DC-KEY" } for non-identity mapping
  --max-docx-bytes N       Split threshold in bytes (default: 10485760 = 10MB)
  --help                   Show this help

Environment Variables (.env, copy from .env.example):
  DC_BASE_URL         Jira Datacenter base URL
  DC_PAT              DC Personal Access Token (preferred)
  DC_USERNAME         DC username (used only if DC_PAT not set)
  DC_PASSWORD         DC password (used only if DC_PAT not set)
  CLOUD_BASE_URL      Jira Cloud base URL (e.g. https://site.atlassian.net)
  CLOUD_API_TOKEN     base64("email:api_token")  — generate with:
                      echo -n "email:token" | base64

Examples:
  # Single-project smoke test (1 issue):
  node main/recover_truncated_content.js --projects PROJ --limit 1

  # Plan-mode full scan, resumable:
  node main/recover_truncated_content.js

  # Apply (upload docx) from latest plan, dry-run first:
  node main/recover_truncated_content.js --apply --dry-run
  node main/recover_truncated_content.js --apply

  # Apply a specific plan, retry rows previously marked failed:
  node main/recover_truncated_content.js --apply --plan-file logs/master_1719340000000.json --retry-failed
`);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
        TruncationRecovery.showHelp();
        process.exit(0);
      case "--projects":
        options.projects = String(args[++i] || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (options.projects.length === 0) options.projects = null;
        break;
      case "--limit":
        options.limit = parseInt(args[++i], 10) || 0;
        break;
      case "--apply":
        options.apply = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--plan-file":
        options.planFile = args[++i];
        break;
      case "--resume":
        options.resume = true;
        break;
      case "--retry-failed":
        options.retryFailed = true;
        break;
      case "--concurrency":
        options.concurrency = parseInt(args[++i], 10) || 3;
        break;
      case "--key-map":
        options.keyMapFile = args[++i];
        break;
      case "--max-docx-bytes":
        options.maxDocxBytes = parseInt(args[++i], 10) || DEFAULT_MAX_DOCX_BYTES;
        break;
      case "--no-mute-notifications":
        options.muteNotifications = false;
        break;
      case "--restore-only":
        options.restoreOnly = true;
        options.apply = true; // restore-only is only meaningful in apply mode
        break;
      default:
        if (args[i].startsWith("--")) {
          console.warn(`Unknown option: ${args[i]}`);
        }
        break;
    }
  }
  return options;
}

async function main() {
  let recovery = null;

  const shutdown = () => {
    if (recovery && recovery.planManager) {
      console.log("\nShutting down gracefully...");
      if (recovery.planManager.plan) {
        recovery.planManager.savePlan();
        console.log(`Plan saved: ${recovery.planManager.planFilePath}`);
      }
      if (recovery.planManager.masterIndex) {
        recovery.planManager.saveMasterIndex();
        console.log(`Master index saved: ${recovery.planManager.masterIndexPath}`);
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    const options = parseArgs();
    recovery = new TruncationRecovery(options);
    await recovery.run();
    console.log("\nRecovery completed successfully.");
    process.exit(0);
  } catch (error) {
    console.error(`\nFatal error: ${error.message}`);
    if (error.stack) console.error(error.stack);
    if (recovery && recovery.planManager) {
      if (recovery.planManager.plan) {
        recovery.planManager.savePlan();
        console.log(`Plan saved: ${recovery.planManager.planFilePath}`);
      }
      if (recovery.planManager.masterIndex) {
        recovery.planManager.saveMasterIndex();
        console.log(`Master index saved: ${recovery.planManager.masterIndexPath}`);
      }
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = TruncationRecovery;
