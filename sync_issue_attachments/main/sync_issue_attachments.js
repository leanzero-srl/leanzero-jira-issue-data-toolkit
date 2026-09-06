#!/usr/bin/env node

/**
 * Sync Issue Attachments: Datacenter -> Cloud
 *
 * For each Cloud issue matching the JQL, fetch the DC counterpart's
 * attachment list and re-upload any DC attachments that don't already exist
 * on the Cloud issue (matched by filename + byte size).
 *
 * Two-phase architecture (same as sync_issue_parents):
 *   Phase 1 (Plan):   Walk Cloud JQL results, read DC + Cloud attachments,
 *                     compute the per-attachment work list, write plan +
 *                     missing-attachments report.
 *   Phase 2 (Execute): For each issue in the plan, download each pending DC
 *                     attachment to a temp file and upload to Cloud via
 *                     POST /rest/api/3/issue/{key}/attachments.
 *                     Resumable, dry-run-able.
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DatacenterClient = require("../src/datacenterClient");
const CloudJiraClient = require("../src/cloudJiraClient");
const PlanManager = require("../src/planManager");
const AttachmentProcessor = require("../src/attachmentProcessor");
const NotificationMuter = require("../src/notificationMuter");

// Default population: every issue created by the migration service account.
// Override with --jql for spot runs.
const DEFAULT_JQL = "creator = 712020:00000000-0000-0000-0000-000000000000";

class IssueAttachmentSync {
  constructor(options = {}) {
    this.options = {
      jql: options.jql || null,
      dryRun: options.dryRun || false,
      limit: options.limit || 0,
      planOnly: options.planOnly || false,
      executeOnly: options.executeOnly || false,
      planFile: options.planFile || null,
      concurrency: options.concurrency || 3,
      retryFailed: options.retryFailed || false,
      maxBytes: options.maxBytes || 0,
      keepTemp: options.keepTemp || false,
      muteNotifications: options.muteNotifications !== false,
      restoreOnly: options.restoreOnly || false,
    };

    this.validateConfig();

    if (!this.options.executeOnly && !this.options.jql) {
      // Adopt the canonical default JQL when none was provided
      this.options.jql = DEFAULT_JQL;
      this.usingDefaultJql = true;
    }

    this.logDir = path.join(__dirname, "../logs");
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.logFile = path.join(this.logDir, `sync_${Date.now()}.log`);
    fs.writeFileSync(
      this.logFile,
      `Sync Issue Attachments Log\nStarted: ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`,
    );

    this.log = this.log.bind(this);

    this.dcClient = new DatacenterClient(
      process.env.DC_BASE_URL,
      process.env.DC_USERNAME,
      process.env.DC_PASSWORD,
    );

    this.cloudClient = new CloudJiraClient(
      process.env.CLOUD_BASE_URL,
      process.env.CLOUD_API_TOKEN,
    );

    this.planManager = new PlanManager(this.logDir, this.log);

    if (this.options.planFile) {
      this.planManager.setPlanFile(this.options.planFile);
    }

    this.startTime = Date.now();
  }

  validateConfig() {
    const required = [
      "DC_BASE_URL",
      "DC_USERNAME",
      "DC_PASSWORD",
      "CLOUD_BASE_URL",
      "CLOUD_API_TOKEN",
    ];

    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}\nCheck the .env file.`,
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
    this.log("Sync Issue Attachments: DC -> Cloud");
    this.log("==========================================");
    this.log(`  DC:    ${process.env.DC_BASE_URL}`);
    this.log(`  Cloud: ${process.env.CLOUD_BASE_URL}`);
    this.log("");

    if (this.options.dryRun) {
      this.log("*** DRY RUN MODE - No downloads or uploads will be performed ***");
      this.log("");
    }

    if (this.options.jql) {
      this.log(
        `  JQL${this.usingDefaultJql ? " (default)" : ""}: ${this.options.jql}`,
      );
    }
    if (this.options.limit > 0) {
      this.log(`  Issue limit: ${this.options.limit}`);
    }
    if (this.options.maxBytes > 0) {
      this.log(`  Max attachment size override: ${this.options.maxBytes} bytes`);
    }
    if (this.options.keepTemp) {
      this.log(`  Keep temp files: YES`);
    }
    if (this.options.planOnly) {
      this.log(`  Mode: PLAN ONLY (no execution)`);
    } else if (this.options.executeOnly) {
      this.log(`  Mode: EXECUTE ONLY (loading existing plan)`);
    } else {
      this.log(`  Mode: FULL (plan + execute)`);
    }
    this.log(`  Concurrency: ${this.options.concurrency}`);
    if (this.options.retryFailed) {
      this.log(`  Retry failed: YES`);
    }

    // Step 1: Test connections
    this.log("\nStep 1: Testing connections...");
    const dcOk = await this.dcClient.testConnection();
    if (!dcOk) throw new Error("Cannot connect to Jira Datacenter");
    this.log("  Datacenter: OK");

    const cloudOk = await this.cloudClient.testConnection();
    if (!cloudOk) throw new Error("Cannot connect to Jira Cloud");
    this.log("  Cloud Jira: OK");

    // Notification muter — suppresses per-project "Issue Updated" spam during
    // bulk attachment uploads. Snapshots persist to logs/ for crash recovery
    // via --restore-only.
    this.muter = new NotificationMuter(this.cloudClient, this.logDir, this.log);
    await this.muter.initialize();

    if (this.options.restoreOnly) {
      this.log("\n*** RESTORE-ONLY MODE — restoring any pending notification snapshots ***");
      const result = await this.muter.restoreAllFromSnapshot();
      this.log(`  Restored ${result.restored}, failed ${result.failed}`);
      return;
    }

    const processor = new AttachmentProcessor(
      this.dcClient,
      this.cloudClient,
      this.planManager,
      {
        jql: this.options.jql,
        dryRun: this.options.dryRun,
        limit: this.options.limit,
        concurrency: this.options.concurrency,
        retryFailed: this.options.retryFailed,
        maxBytes: this.options.maxBytes,
        keepTemp: this.options.keepTemp,
        log: this.log,
        logDir: this.logDir,
        muter: this.muter,
        muteNotifications: this.options.muteNotifications,
      },
    );

    // ── Phase 1: Build or Load Plan ──
    if (this.options.executeOnly) {
      this.log("\nStep 2: Loading existing plan...");
      const master = this.planManager.loadMasterIndex(this.options.planFile);
      if (!master) {
        throw new Error(
          "No master index found. Run without --execute-only first to build a plan, or pass --plan-file.",
        );
      }
    } else {
      const runId = String(Date.now());
      this.log("\nStep 2: Building execution plan...");
      await processor.buildPlan(runId);

      if (this.options.planOnly) {
        this.log("\n*** PLAN ONLY MODE - Skipping execution ***");
        this.printFinalReport(processor.getStats());
        return;
      }
    }

    // ── Phase 2: Execute Plan ──
    const planFile = this.planManager.masterIndex?.planFile;
    if (!planFile) {
      this.log("\nNo plan file to execute.");
      this.printFinalReport(processor.getStats());
      return;
    }

    const plan = await this.planManager.loadPlan(planFile);
    if (!plan) {
      this.log("\nERROR: Could not load execution plan.");
      this.printFinalReport(processor.getStats());
      return;
    }

    this.log(
      `\nStep 3: Executing plan (${this.planManager.plan.stats.pending} pending issues)...`,
    );
    await processor.executePlan();

    this.planManager.savePlan();
    this.planManager.saveMasterIndex();

    this.printFinalReport(processor.getStats());
  }

  printFinalReport(processorStats) {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const dcStats = this.dcClient.getStats();
    const cloudStats = this.cloudClient.getStats();
    const planSummary = this.planManager.getPlanSummary();

    this.log("\n" + "=".repeat(60));
    this.log("FINAL REPORT");
    this.log("=".repeat(60));

    if (this.options.dryRun) {
      this.log("*** DRY RUN - No actual changes were made ***\n");
    }

    this.log("Attachment Sync Breakdown:");
    this.log(`  Cloud issues scanned:               ${processorStats.cloudIssuesScanned}`);
    this.log(`  Issues with uploads pending:        ${processorStats.issuesWithUploads}`);
    this.log(`  Issues skipped (all already there): ${processorStats.issuesSkippedAllPresent}`);
    this.log(`  Issues skipped (no DC attachments): ${processorStats.issuesSkippedNoDcAttachments}`);
    this.log(`  Issues skipped (DC lookup failed):  ${processorStats.issuesSkippedDcLookupFailed}`);
    this.log(`  Issues completed:                   ${processorStats.issuesCompleted}`);
    this.log(`  Issues partial (some failed):       ${processorStats.issuesPartial}`);
    this.log(`  Issues failed:                      ${processorStats.issuesFailed}`);
    this.log(``);
    this.log(`  Attachments to upload (planned):    ${processorStats.attachmentsToUpload}`);
    this.log(`  Attachments uploaded:               ${processorStats.attachmentsUploaded}`);
    this.log(`  Attachments already present:        ${processorStats.attachmentsAlreadyPresent}`);
    this.log(`  Attachments too large (skipped):    ${processorStats.attachmentsTooLarge}`);
    this.log(`  Attachments failed:                 ${processorStats.attachmentsFailed}`);
    this.log(``);
    const mb = (n) => (n / 1024 / 1024).toFixed(2);
    this.log(`  Bytes downloaded:                   ${processorStats.bytesDownloaded} (${mb(processorStats.bytesDownloaded)} MB)`);
    this.log(`  Bytes uploaded:                     ${processorStats.bytesUploaded} (${mb(processorStats.bytesUploaded)} MB)`);

    if (planSummary) {
      this.log("\nPlan Status:");
      this.log(`  Total issues:           ${planSummary.totalIssues || planSummary.total || 0}`);
      this.log(`  Completed:              ${planSummary.completed || 0}`);
      this.log(`  Failed:                 ${planSummary.failed || 0}`);
      this.log(`  Pending:                ${planSummary.pending || 0}`);
      this.log(`  Skipped:                ${planSummary.skipped || 0}`);
      this.log(`  Master index:           ${planSummary.masterFile || "N/A"}`);
      if (planSummary.planFile) {
        this.log(`  Plan file:              ${planSummary.planFile}`);
      }
    }

    if (this.planManager.masterIndex) {
      const m = this.planManager.masterIndex;
      if (m.missingAttachmentsCsv) this.log(`  Missing-attachments CSV: ${m.missingAttachmentsCsv}`);
      if (m.oversizeAttachmentsCsv) this.log(`  Oversize-attachments CSV: ${m.oversizeAttachmentsCsv}`);
    }

    this.log("\nAPI Statistics:");
    this.log(`  DC requests:            ${dcStats.requestCount} (${dcStats.errorCount} errors)`);
    this.log(`  Cloud requests:         ${cloudStats.requestCount} (${cloudStats.errorCount} errors, ${cloudStats.rateLimitCount} rate limits)`);

    this.log(`\nTotal elapsed time:       ${elapsed}s`);
    this.log(`Log file:                 ${this.logFile}`);
    this.log("=".repeat(60));
  }

  static showHelp() {
    console.log(`
Sync Issue Attachments: Datacenter -> Cloud

Re-attach DC attachments to migrated Cloud issues.

Usage:
  node sync_issue_attachments.js [--jql '<cloud JQL>'] [options]
  node sync_issue_attachments.js --resume [--plan-file <path>] [options]

Options:
  --jql <string>           Cloud JQL selecting issues to inspect.
                           Default: ${DEFAULT_JQL}
                           (Cloud accountId of the migration service account —
                            captures every issue created by the migration.)
  --dry-run                Preview downloads/uploads without performing them
  --limit <n>              Truncate Cloud search results to N issues
  --plan-only              Build the plan + reports, then exit
  --execute-only           Skip plan build, load existing plan and execute
  --resume                 Alias for --execute-only
  --plan-file <path>       Master index JSON file to resume from
  --concurrency <n>        Max parallel issues processed (default: 3)
  --retry-failed           Also re-run plan entries with status "failed"
  --max-bytes <n>          Override Cloud's reported max attachment size
  --keep-temp              Don't delete downloaded files after upload
  --help                   Show this help

Environment Variables (in .env, cloned from sync_issue_parents/.env):
  DC_BASE_URL         Jira Datacenter base URL
  DC_USERNAME         DC username (Basic Auth)
  DC_PASSWORD         DC password (Basic Auth)
  CLOUD_BASE_URL      Jira Cloud base URL (e.g. https://site.atlassian.net)
  CLOUD_API_TOKEN     Cloud API token (base64-encoded email:token)

Examples:
  # Smoke test one known issue
  node main/sync_issue_attachments.js --jql 'key = PROJ-123' --dry-run

  # Plan-only full population (default JQL, capped at 50)
  node main/sync_issue_attachments.js --plan-only --limit 50

  # Full sync (default JQL)
  node main/sync_issue_attachments.js

  # Resume an in-progress plan and retry previously-failed rows
  node main/sync_issue_attachments.js --resume --retry-failed
    `);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
        IssueAttachmentSync.showHelp();
        process.exit(0);
      case "--jql":
        options.jql = args[++i];
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--limit":
        options.limit = parseInt(args[++i], 10) || 0;
        break;
      case "--plan-only":
        options.planOnly = true;
        break;
      case "--execute-only":
      case "--resume":
        options.executeOnly = true;
        break;
      case "--plan-file":
        options.planFile = args[++i];
        break;
      case "--concurrency":
        options.concurrency = parseInt(args[++i], 10) || 3;
        break;
      case "--retry-failed":
        options.retryFailed = true;
        break;
      case "--max-bytes":
        options.maxBytes = parseInt(args[++i], 10) || 0;
        break;
      case "--keep-temp":
        options.keepTemp = true;
        break;
      case "--no-mute-notifications":
        options.muteNotifications = false;
        break;
      case "--restore-only":
        options.restoreOnly = true;
        options.executeOnly = true; // restore-only is meaningful in apply (execute) mode
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
  let sync = null;

  const shutdown = () => {
    if (sync && sync.planManager) {
      console.log("\nShutting down gracefully...");
      if (sync.planManager.plan) {
        sync.planManager.savePlan();
        console.log(`Plan saved: ${sync.planManager.planFilePath}`);
      }
      if (sync.planManager.masterIndex) {
        sync.planManager.saveMasterIndex();
        console.log(`Master index saved: ${sync.planManager.masterIndexPath}`);
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    const options = parseArgs();
    sync = new IssueAttachmentSync(options);
    await sync.run();
    console.log("\nSync completed successfully.");
    process.exit(0);
  } catch (error) {
    console.error(`\nFatal error: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    if (sync && sync.planManager) {
      if (sync.planManager.plan) {
        sync.planManager.savePlan();
        console.log(`Plan saved: ${sync.planManager.planFilePath}`);
      }
      if (sync.planManager.masterIndex) {
        sync.planManager.saveMasterIndex();
        console.log(`Master index saved: ${sync.planManager.masterIndexPath}`);
      }
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = IssueAttachmentSync;
