#!/usr/bin/env node

/**
 * Sync Issue Parents: Datacenter -> Cloud
 *
 * Recover parent-child issue relationships from a Jira DC instance and
 * restore them on the corresponding Cloud issues (same key).
 *
 * Behavior:
 *   - Cloud JQL is the entry point. Every issue it returns is a candidate.
 *   - Recovers all parent relations: sub-task `parent`, Story-under-Epic
 *     (Epic Link customfield), and generic next-gen `parent`.
 *   - Skips Cloud issues that already have a parent (never overwrites).
 *   - Skips + logs to a missing-parents report if the DC parent is not in Cloud.
 *
 * Two-phase architecture:
 *   Phase 1 (Plan):   Walk Cloud JQL results, read DC parents, verify parent
 *                     keys in Cloud, write plan JSON + missing-parents report.
 *   Phase 2 (Execute): Apply plan with concurrent PUTs, resumable, dry-run-able.
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DatacenterClient = require("../src/datacenterClient");
const CloudJiraClient = require("../src/cloudJiraClient");
const PlanManager = require("../src/planManager");
const ParentProcessor = require("../src/parentProcessor");
const ReporterProcessor = require("../src/reporterProcessor");
const AssigneeProcessor = require("../src/assigneeProcessor");
const UserMapper = require("../src/userMapper");
const NotificationMuter = require("../src/notificationMuter");

const VALID_FIELDS = new Set(["parent", "reporter", "assignee"]);

// Fields whose value is a Cloud user (resolved DC username -> accountId via
// UserMapper). Both share the same plan/resume scaffolding.
const USER_FIELDS = new Set(["reporter", "assignee"]);

class IssueParentSync {
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
      epicLinkFieldId: options.epicLinkFieldId || null,
      parentLinkFieldId: options.parentLinkFieldId || null,
      field: options.field || "parent",
      muteNotifications: options.muteNotifications !== false,
      restoreOnly: options.restoreOnly || false,
    };

    if (!VALID_FIELDS.has(this.options.field)) {
      throw new Error(
        `Invalid --field "${this.options.field}". Expected one of: ${[...VALID_FIELDS].join(", ")}`,
      );
    }

    this.validateConfig();

    if (!this.options.executeOnly && !this.options.jql) {
      throw new Error(
        "Missing --jql. Either pass --jql '<cloud JQL>' to build a new plan, or use --execute-only/--resume to run an existing plan.",
      );
    }

    this.logDir = path.join(__dirname, "../logs");
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.logFile = path.join(this.logDir, `sync_${Date.now()}.log`);
    fs.writeFileSync(
      this.logFile,
      `Sync Issue Parents Log\nStarted: ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`,
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
      // Ignore log write failures
    }
  }

  async run() {
    this.log("==========================================");
    this.log("Sync Issue Parents: DC -> Cloud");
    this.log("==========================================");
    this.log(`  DC:    ${process.env.DC_BASE_URL}`);
    this.log(`  Cloud: ${process.env.CLOUD_BASE_URL}`);
    this.log("");

    if (this.options.dryRun) {
      this.log("*** DRY RUN MODE - No changes will be made ***");
      this.log("");
    }

    if (this.options.jql) {
      this.log(`  JQL: ${this.options.jql}`);
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
    this.log(`  Field:       ${this.options.field}`);
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

    // The runId for a new plan; ignored when --execute-only.
    const newRunId = String(Date.now());

    // ── Resolve master index path early when --execute-only ──
    // We need it both to set up the UserMapper cache path (reporter mode) and
    // to load the plan a few steps below.
    let resumeMasterPath = null;
    let resumeMaster = null;
    if (this.options.executeOnly) {
      const masterPrefix = USER_FIELDS.has(this.options.field) ? this.options.field : "";
      resumeMasterPath = this.options.planFile
        || this.planManager.findLatestMasterIndex(masterPrefix);
      if (!resumeMasterPath) {
        throw new Error(
          `No ${this.options.field} master index found in ${this.logDir}. Run without --execute-only first to build a plan, or pass --plan-file.`,
        );
      }
      resumeMaster = this.planManager.loadMasterIndex(resumeMasterPath);
      if (!resumeMaster) {
        throw new Error(
          `Could not load master index: ${resumeMasterPath}`,
        );
      }
    }

    // Notification muter — suppresses per-project "Issue Updated" emails
    // during bulk parent (and reporter) PUTs. Snapshots persist to logs/ so
    // a crashed run can be recovered with --restore-only.
    this.muter = new NotificationMuter(this.cloudClient, this.logDir, this.log);
    await this.muter.initialize();
    if (this.options.restoreOnly) {
      this.log("\n*** RESTORE-ONLY MODE — restoring any pending notification snapshots ***");
      const result = await this.muter.restoreAllFromSnapshot();
      this.log(`  Restored ${result.restored}, failed ${result.failed}`);
      return;
    }

    let processor;

    if (USER_FIELDS.has(this.options.field)) {
      // ── User-field sync path (reporter | assignee) ──
      // Both resolve a DC username -> Cloud accountId via UserMapper and share
      // the same plan/pre-flight/batched-PUT scaffolding; only the field and
      // the per-field processor differ.
      const ProcessorClass =
        this.options.field === "assignee" ? AssigneeProcessor : ReporterProcessor;

      const userMapCachePath = resumeMaster?.userMapCacheFile
        || path.join(this.logDir, `user_map_${this.options.field}_${newRunId}.json`);
      const userMapper = new UserMapper(this.cloudClient, {
        cacheFilePath: userMapCachePath,
        log: this.log,
      });
      // Stash on `this` so the SIGINT shutdown handler can flush partial
      // resolutions; without this, a Ctrl-C during buildPlan loses every
      // lookup made since the run started.
      this.userMapper = userMapper;
      this.log(`  User-map cache: ${userMapCachePath}`);

      processor = new ProcessorClass(
        this.dcClient,
        this.cloudClient,
        this.planManager,
        userMapper,
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
    } else {
      // ── Parent sync path (default) ──
      // Step 1b: Resolve DC custom field ids for Epic Link / Parent Link
      if (!this.options.epicLinkFieldId || !this.options.parentLinkFieldId) {
        this.log("\nStep 1b: Discovering parent-related custom fields in DC...");
        const discovered = await this.dcClient.discoverParentFieldIds();
        if (!this.options.epicLinkFieldId) {
          this.options.epicLinkFieldId = discovered.epicLinkFieldId;
        }
        if (!this.options.parentLinkFieldId) {
          this.options.parentLinkFieldId = discovered.parentLinkFieldId;
        }
      }
      this.log(`  Epic Link field id:   ${this.options.epicLinkFieldId || "(not present)"}`);
      this.log(`  Parent Link field id: ${this.options.parentLinkFieldId || "(not present)"}`);

      processor = new ParentProcessor(
        this.dcClient,
        this.cloudClient,
        this.planManager,
        {
          jql: this.options.jql,
          dryRun: this.options.dryRun,
          limit: this.options.limit,
          concurrency: this.options.concurrency,
          retryFailed: this.options.retryFailed,
          epicLinkFieldId: this.options.epicLinkFieldId,
          parentLinkFieldId: this.options.parentLinkFieldId,
          log: this.log,
          logDir: this.logDir,
          muter: this.muter,
          muteNotifications: this.options.muteNotifications,
        },
      );
    }

    // ── Phase 1: Build or Load Plan ──
    if (this.options.executeOnly) {
      this.log(`\nStep 2: Loaded existing plan from ${resumeMasterPath}`);
    } else {
      this.log("\nStep 2: Building execution plan...");
      await processor.buildPlan(newRunId);

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

    this.log(`\nStep 3: Executing plan (${this.planManager.plan.stats.pending} pending issues)...`);
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

    if (this.options.field === "reporter") {
      this.log("Reporter Sync Breakdown:");
      this.log(`  Cloud issues scanned:                  ${processorStats.cloudIssuesScanned}`);
      this.log(`  DC lookup errors:                      ${processorStats.dcLookupErrors}`);
      this.log(`  No DC reporter (skipped):              ${processorStats.dcWithoutReporter}`);
      this.log(`  Cloud already correct (skipped):       ${processorStats.cloudAlreadyCorrect}`);
      this.log(`  Unresolved DC user — no match:         ${processorStats.userResolveNoMatch}`);
      this.log(`  Unresolved DC user — ambiguous:        ${processorStats.userResolveAmbiguous}`);
      this.log(`  Unresolved DC user — lookup errors:    ${processorStats.userResolveErrors}`);
      this.log(`  Pending updates planned:               ${processorStats.issuesNeedingUpdate}`);
      if (
        processorStats.preflightStaleSame ||
        processorStats.preflightMissingInCloud
      ) {
        this.log("\nExecute pre-flight (re-checked Cloud state immediately before PUTs):");
        this.log(`  Already correct (no-op):               ${processorStats.preflightStaleSame}`);
        this.log(`  Cloud issue not found:                 ${processorStats.preflightMissingInCloud}`);
      }
      this.log(`  Issues updated:                        ${processorStats.issuesUpdated}`);
      this.log(`  Issues failed:                         ${processorStats.issuesFailed}`);
    } else if (this.options.field === "assignee") {
      this.log("Assignee Sync Breakdown:");
      this.log(`  Cloud issues scanned:                  ${processorStats.cloudIssuesScanned}`);
      this.log(`  DC lookup errors:                      ${processorStats.dcLookupErrors}`);
      this.log(`  No DC assignee (skipped):              ${processorStats.dcWithoutAssignee}`);
      this.log(`  Cloud already correct (skipped):       ${processorStats.cloudAlreadyCorrect}`);
      this.log(`  Unresolved DC user — no match:         ${processorStats.userResolveNoMatch}`);
      this.log(`  Unresolved DC user — ambiguous:        ${processorStats.userResolveAmbiguous}`);
      this.log(`  Unresolved DC user — lookup errors:    ${processorStats.userResolveErrors}`);
      this.log(`  Pending updates planned:               ${processorStats.issuesNeedingUpdate}`);
      if (
        processorStats.preflightStaleSame ||
        processorStats.preflightMissingInCloud
      ) {
        this.log("\nExecute pre-flight (re-checked Cloud state immediately before PUTs):");
        this.log(`  Already correct (no-op):               ${processorStats.preflightStaleSame}`);
        this.log(`  Cloud issue not found:                 ${processorStats.preflightMissingInCloud}`);
      }
      this.log(`  Issues updated:                        ${processorStats.issuesUpdated}`);
      this.log(`  Issues failed:                         ${processorStats.issuesFailed}`);
    } else {
      this.log("Parent Recovery Breakdown:");
      this.log(`  Cloud issues scanned:                  ${processorStats.cloudIssuesScanned}`);
      this.log(`  Already had Cloud parent (skipped):    ${processorStats.alreadyHasParent}`);
      this.log(`  No DC parent (skipped):                ${processorStats.dcWithoutParent}`);
      this.log(`  DC lookup errors:                      ${processorStats.dcLookupErrors}`);
      this.log(`  Parent missing in Cloud (skipped):     ${processorStats.parentMissingInCloud}`);
      this.log(`  Pending updates planned:               ${processorStats.issuesNeedingUpdate}`);
      this.log(`    from sub-task parent:                ${processorStats.parentResolvedFromSubtask}`);
      this.log(`    from Epic Link:                      ${processorStats.parentResolvedFromEpicLink}`);
      this.log(`    from Parent Link:                    ${processorStats.parentResolvedFromParentLink}`);
      this.log(`    from generic parent:                 ${processorStats.parentResolvedFromGenericParent}`);
      this.log("\nPhase 1b — Reverse children search:");
      this.log(`  DC children discovered:                ${processorStats.childrenSearchTotal}`);
      this.log(`  Already in imported set:               ${processorStats.childrenAlreadyInImported}`);
      this.log(`  Not in Cloud (out of scope):           ${processorStats.childrenNotInCloud}`);
      this.log(`  Cloud already has parent (skipped):    ${processorStats.childrenAlreadyHaveParent}`);
      this.log(`  Added as pending:                      ${processorStats.childrenAddedPending}`);
      if (
        processorStats.preflightStaleSame ||
        processorStats.preflightStaleDifferent ||
        processorStats.preflightMissingInCloud
      ) {
        this.log("\nExecute pre-flight (re-checked Cloud state immediately before PUTs):");
        this.log(`  Already correct (no-op):               ${processorStats.preflightStaleSame}`);
        this.log(`  Cloud parent changed (overwrite avoided): ${processorStats.preflightStaleDifferent}`);
        this.log(`  Cloud issue not found:                 ${processorStats.preflightMissingInCloud}`);
      }
      this.log(`  Issues updated:                        ${processorStats.issuesUpdated}`);
      this.log(`  Issues failed:                         ${processorStats.issuesFailed}`);
    }

    const totalProcessed = processorStats.issuesUpdated + processorStats.issuesFailed;
    const successRate =
      totalProcessed > 0
        ? ((processorStats.issuesUpdated / totalProcessed) * 100).toFixed(1)
        : "N/A";
    this.log(`  Success rate:                          ${successRate}%`);

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
      if (m.missingParentsCsv) this.log(`  Missing-parents CSV:    ${m.missingParentsCsv}`);
      if (m.missingParentsJson) this.log(`  Missing-parents JSON:   ${m.missingParentsJson}`);
      if (m.missingReportersCsv) this.log(`  Missing-reporters CSV:  ${m.missingReportersCsv}`);
      if (m.missingReportersJson) this.log(`  Missing-reporters JSON: ${m.missingReportersJson}`);
      if (m.missingAssigneesCsv) this.log(`  Missing-assignees CSV:  ${m.missingAssigneesCsv}`);
      if (m.missingAssigneesJson) this.log(`  Missing-assignees JSON: ${m.missingAssigneesJson}`);
      if (m.userMapCacheFile) this.log(`  User-map cache file:    ${m.userMapCacheFile}`);
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
Sync Issue Field: Datacenter -> Cloud

Recover an issue field's DC value and write it back to Cloud. Supported fields:
  - parent   (default; sub-task parent, Epic Link, Parent Link)
  - reporter (resolves DC username/email -> Cloud accountId via /user/search)
  - assignee (resolves DC username/email -> Cloud accountId; restores DC assignee,
              never un-assigns a Cloud issue)

Usage:
  node sync_issue_parents.js [--field parent|reporter|assignee] --jql '<cloud JQL>' [options]
  node sync_issue_parents.js [--field parent|reporter|assignee] --resume [--plan-file <path>] [options]

Options:
  --field <name>           Field to sync: "parent" (default), "reporter", or "assignee"
  --jql <string>           Cloud JQL selecting issues to fix (required unless --resume)
  --dry-run                Preview PUTs without sending them
  --limit <n>              Truncate Cloud search results to N issues
  --plan-only              Build the plan + report, then exit
  --execute-only           Skip plan build, load existing plan and execute
  --resume                 Alias for --execute-only
  --plan-file <path>       Master index JSON file to resume from
  --concurrency <n>        Max parallel Cloud PUTs (default: 5)
  --retry-failed           Also re-run plan entries with status "failed"
  --epic-link-field <id>   (parent only) DC Epic Link custom field id (auto-discovered if omitted)
  --parent-link-field <id> (parent only) DC Parent Link custom field id (auto-discovered if omitted)
  --help                   Show this help

Environment Variables (in .env):
  DC_BASE_URL         Jira Datacenter base URL
  DC_USERNAME         DC username (Basic Auth)
  DC_PASSWORD         DC password (Basic Auth)
  CLOUD_BASE_URL      Jira Cloud base URL (e.g. https://site.atlassian.net)
  CLOUD_API_TOKEN     Cloud API token (base64-encoded email:token)

Examples:
  # Build a plan against a small slice (no writes)
  node main/sync_issue_parents.js \\
      --jql 'creator = 712020:00000000-0000-0000-0000-000000000000' \\
      --plan-only --limit 50

  # Dry execute against an existing plan
  node main/sync_issue_parents.js --resume \\
      --plan-file ./logs/master_1736291234567.json --dry-run

  # Full sync end-to-end
  node main/sync_issue_parents.js \\
      --jql 'creator = 712020:00000000-0000-0000-0000-000000000000'

  # Resume after Ctrl-C, re-run failed entries
  node main/sync_issue_parents.js --resume --retry-failed

  # Build a reporter-sync plan (no writes)
  node main/sync_issue_parents.js --field reporter \\
      --jql 'project = PRD AND reporter = 712020:00000000-0000-0000-0000-000000000000' \\
      --plan-only --limit 25

  # Dry execute the reporter plan
  node main/sync_issue_parents.js --field reporter --resume --dry-run

  # Full reporter sync end-to-end
  node main/sync_issue_parents.js --field reporter \\
      --jql 'project = PRD AND reporter = 712020:00000000-0000-0000-0000-000000000000'
    `);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
        IssueParentSync.showHelp();
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
      case "--epic-link-field":
        options.epicLinkFieldId = args[++i];
        break;
      case "--parent-link-field":
        options.parentLinkFieldId = args[++i];
        break;
      case "--field":
        options.field = (args[++i] || "").toLowerCase();
        break;
      case "--no-mute-notifications":
        options.muteNotifications = false;
        break;
      case "--restore-only":
        options.restoreOnly = true;
        options.executeOnly = true;
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
    if (sync && sync.userMapper) {
      sync.userMapper.flushCache();
      console.log(`User-map cache flushed: ${sync.userMapper.cacheFilePath}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    const options = parseArgs();
    sync = new IssueParentSync(options);
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

module.exports = IssueParentSync;
