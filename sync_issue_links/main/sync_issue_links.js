#!/usr/bin/env node

/**
 * Sync Issue Links: Datacenter -> Cloud
 *
 * For each Cloud issue matching the JQL, read the DC counterpart's issue-to-issue
 * links (the `issuelinks` field) and re-create any that are missing on Cloud,
 * preserving link type and direction.
 *
 * A single physical link appears on BOTH endpoint issues, so every raw entry is
 * normalized to a canonical directed triple (typeName, outwardKey, inwardKey)
 * and deduplicated globally — each link is planned and created exactly once.
 *
 * Two-phase architecture (same as sync_issue_parents / sync_issue_attachments):
 *   Phase 1 (Plan):    Walk Cloud JQL results, read DC + Cloud links, dedup to
 *                      canonical triples, validate (type exists, both endpoints
 *                      exist, not already linked), write plan + skip reports.
 *   Phase 2 (Execute): POST /rest/api/3/issueLink for each pending triple, with
 *                      a live pre-flight re-check. Resumable, dry-run-able.
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DatacenterClient = require("../src/datacenterClient");
const CloudJiraClient = require("../src/cloudJiraClient");
const PlanManager = require("../src/planManager");
const LinkProcessor = require("../src/linkProcessor");
const NotificationMuter = require("../src/notificationMuter");

// Default population: every issue created by the migration service account.
// Override with --jql for spot runs.
const DEFAULT_JQL = "creator = 712020:00000000-0000-0000-0000-000000000000";

class IssueLinkSync {
  constructor(options = {}) {
    this.options = {
      jql: options.jql || null,
      dryRun: options.dryRun || false,
      limit: options.limit || 0,
      planOnly: options.planOnly || false,
      executeOnly: options.executeOnly || false,
      planFile: options.planFile || null,
      concurrency: options.concurrency || 5,
      retryFailed: options.retryFailed || false,
      muteNotifications: options.muteNotifications !== false,
      restoreOnly: options.restoreOnly || false,
    };

    this.validateConfig();

    if (!this.options.executeOnly && !this.options.jql) {
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
      `Sync Issue Links Log\nStarted: ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`,
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
    this.log("Sync Issue Links: DC -> Cloud");
    this.log("==========================================");
    this.log(`  DC:    ${process.env.DC_BASE_URL}`);
    this.log(`  Cloud: ${process.env.CLOUD_BASE_URL}`);
    this.log("");

    if (this.options.dryRun) {
      this.log("*** DRY RUN MODE - No links will be created ***");
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
    // bulk link creation. Snapshots persist to logs/ for crash recovery via
    // --restore-only.
    this.muter = new NotificationMuter(this.cloudClient, this.logDir, this.log);
    await this.muter.initialize();

    if (this.options.restoreOnly) {
      this.log("\n*** RESTORE-ONLY MODE — restoring any pending notification snapshots ***");
      const result = await this.muter.restoreAllFromSnapshot();
      this.log(`  Restored ${result.restored}, failed ${result.failed}`);
      return;
    }

    const processor = new LinkProcessor(
      this.dcClient,
      this.cloudClient,
      this.planManager,
      {
        jql: this.options.jql,
        dryRun: this.options.dryRun,
        limit: this.options.limit,
        concurrency: this.options.concurrency,
        retryFailed: this.options.retryFailed,
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
      `\nStep 3: Executing plan (${this.planManager.plan.stats.pending} pending links)...`,
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

    // The master index's per-status counts are frozen at plan-build time; the
    // loaded plan holds the live counts after execution. Reconcile so the
    // "Plan Status" block reflects what actually happened.
    if (this.planManager.masterIndex && this.planManager.plan) {
      const ps = this.planManager.plan.stats;
      Object.assign(this.planManager.masterIndex.stats, {
        totalIssues: ps.total,
        pending: ps.pending,
        completed: ps.completed,
        failed: ps.failed,
        skipped: ps.skipped,
      });
    }

    const planSummary = this.planManager.getPlanSummary();

    this.log("\n" + "=".repeat(60));
    this.log("FINAL REPORT");
    this.log("=".repeat(60));

    if (this.options.dryRun) {
      this.log("*** DRY RUN - No actual changes were made ***\n");
    }

    this.log("Issue Link Sync Breakdown:");
    this.log(`  Cloud issues scanned:               ${processorStats.cloudIssuesScanned}`);
    this.log(`  DC lookup failures:                 ${processorStats.dcLookupErrors}`);
    this.log(`  Distinct links discovered:          ${processorStats.triplesDiscovered}`);
    this.log(`  Links to create (planned pending):  ${processorStats.linksToCreate}`);
    this.log(``);
    this.log(`  Skipped — already linked:           ${processorStats.linksAlreadyLinked}`);
    this.log(`  Skipped — already linked (preflt):  ${processorStats.preflightAlreadyLinked}`);
    this.log(`  Skipped — link type missing:        ${processorStats.linksTypeMissing}`);
    this.log(`  Skipped — endpoint missing:         ${processorStats.linksEndpointMissing}`);
    this.log(`  Skipped — self-link:                ${processorStats.linksSelfSkipped}`);
    this.log(``);
    this.log(`  Links created:                      ${processorStats.linksCreated}`);
    this.log(`  Links failed:                       ${processorStats.linksFailed}`);

    if (planSummary) {
      this.log("\nPlan Status:");
      this.log(`  Total links:            ${planSummary.totalIssues || planSummary.total || 0}`);
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
      if (m.linkTypeMissingCsv) this.log(`  Link-type-missing CSV:  ${m.linkTypeMissingCsv}`);
      if (m.endpointMissingCsv) this.log(`  Endpoint-missing CSV:   ${m.endpointMissingCsv}`);
      if (m.skippedLinksJson) this.log(`  Skipped-links summary:  ${m.skippedLinksJson}`);
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
Sync Issue Links: Datacenter -> Cloud

Replicate issue-to-issue links from DC onto migrated Cloud issues, preserving
link type and direction. Idempotent: links already present on Cloud (e.g. from
JCMA or a prior run) are skipped.

Usage:
  node sync_issue_links.js [--jql '<cloud JQL>'] [options]
  node sync_issue_links.js --resume [--plan-file <path>] [options]

Options:
  --jql <string>           Cloud JQL selecting issues to inspect.
                           Default: ${DEFAULT_JQL}
                           (Cloud accountId of the migration service account —
                            captures every issue created by the migration.)
  --dry-run                Preview link creation without performing it
  --limit <n>              Truncate Cloud search results to N issues
  --plan-only              Build the plan + reports, then exit
  --execute-only           Skip plan build, load existing plan and execute
  --resume                 Alias for --execute-only
  --plan-file <path>       Master index JSON file to resume from
  --concurrency <n>        Max parallel link POSTs (default: 5)
  --retry-failed           Also re-run plan entries with status "failed"
  --no-mute-notifications  Don't clone/mute project notification schemes
  --restore-only           Restore any pending notification-scheme snapshots
  --help                   Show this help

Environment Variables (in .env, cloned from the sibling sync scripts):
  DC_BASE_URL         Jira Datacenter base URL
  DC_USERNAME         DC username (Basic Auth)
  DC_PASSWORD         DC password (Basic Auth)
  CLOUD_BASE_URL      Jira Cloud base URL (e.g. https://site.atlassian.net)
  CLOUD_API_TOKEN     Cloud API token (base64-encoded email:token)

Examples:
  # Smoke test one known issue (read-only)
  node main/sync_issue_links.js --jql 'key = PROJ-123' --dry-run

  # Plan-only full population (default JQL, capped at 50)
  node main/sync_issue_links.js --plan-only --limit 50

  # Full sync (default JQL)
  node main/sync_issue_links.js

  # Resume an in-progress plan and retry previously-failed links
  node main/sync_issue_links.js --resume --retry-failed
    `);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
        IssueLinkSync.showHelp();
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
        options.concurrency = parseInt(args[++i], 10) || 5;
        break;
      case "--retry-failed":
        options.retryFailed = true;
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
    sync = new IssueLinkSync(options);
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

module.exports = IssueLinkSync;
