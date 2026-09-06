#!/usr/bin/env node

/**
 * Sync Security Levels: Datacenter -> Cloud
 *
 * Two-phase architecture:
 *   Phase 1 (Plan):   Scan DC issues with security levels, map to Cloud levels, build execution plan
 *   Phase 2 (Execute): Apply plan to Cloud issues with concurrent PUTs and resume support
 *
 * Security levels are matched by name within each project's security scheme context.
 * Missing levels can be optionally created in Cloud with --create-missing-levels.
 *
 * Usage:
 *   node sync_security_levels.js [options]
 *
 * Options:
 *   --dry-run                Preview what would be updated without making changes
 *   --limit <n>              Limit total DC issues scanned
 *   --plan-only              Build the plan and save it, but don't execute
 *   --execute-only           Load existing plan and execute without rebuilding
 *   --resume                 Alias for --execute-only
 *   --plan-file <path>       Path to master index JSON file
 *   --concurrency <n>        Max parallel Cloud PUT requests (default: 5)
 *   --retry-failed           Also reprocess issues with status "failed"
 *   NOTE: If security levels are missing in Cloud, the script will generate a
  report (CSV) listing what needs to be created manually before proceeding.
 *   --help                   Show this help message
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DatacenterClient = require("../src/datacenterClient");
const CloudJiraClient = require("../src/cloudJiraClient");
const PlanManager = require("../src/planManager");
const SecurityLevelProcessor = require("../src/securityLevelProcessor");

class SecurityLevelSync {
  constructor(options = {}) {
    this.options = {
      dryRun: options.dryRun || false,
      limit: options.limit || 0,
      planOnly: options.planOnly || false,
      executeOnly: options.executeOnly || false,
      planFile: options.planFile || null,
      concurrency: options.concurrency || 5,
      retryFailed: options.retryFailed || false,
    };

    this.validateConfig();

    // Initialize logging
    this.logDir = path.join(__dirname, "../logs");
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.logFile = path.join(this.logDir, `sync_${Date.now()}.log`);
    fs.writeFileSync(
      this.logFile,
      `Sync Security Levels Log\nStarted: ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`,
    );

    this.log = this.log.bind(this);

    // Initialize clients
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
        `Missing required environment variables: ${missing.join(", ")}\nCopy .env.example to .env and fill in the values.`,
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
    this.log("Sync Security Levels: DC -> Cloud");
    this.log("==========================================");
    this.log(`  DC:    ${process.env.DC_BASE_URL}`);
    this.log(`  Cloud: ${process.env.CLOUD_BASE_URL}`);
    this.log("");

    if (this.options.dryRun) {
      this.log("*** DRY RUN MODE - No changes will be made ***");
      this.log("");
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
    if (!dcOk) {
      throw new Error("Cannot connect to Jira Datacenter");
    }
    this.log("  Datacenter: OK");

    const cloudOk = await this.cloudClient.testConnection();
    if (!cloudOk) {
      throw new Error("Cannot connect to Jira Cloud");
    }
    this.log("  Cloud Jira: OK");

    // Create processor
    const processor = new SecurityLevelProcessor(
      this.dcClient,
      this.cloudClient,
      this.planManager,
      {
        dryRun: this.options.dryRun,
        limit: this.options.limit,
        concurrency: this.options.concurrency,
        retryFailed: this.options.retryFailed,
        log: this.log,
      },
    );

    // ── Phase 1: Build or Load Plan ──
    if (this.options.executeOnly) {
      this.log("\nStep 2: Loading existing plan...");
      const master = this.planManager.loadMasterIndex(this.options.planFile);
      if (!master) {
        throw new Error(
          "No master index found. Run without --execute-only first to build a plan.",
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

    this.log(`\nStep ${this.options.executeOnly ? "3" : "3"}: Executing plan (${this.planManager.plan.stats.pending} pending issues)...`);
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

    this.log("DC Scanning:");
    this.log(`  Issues scanned:         ${processorStats.dcIssuesScanned}`);

    this.log("\nLevel Mapping:");
    this.log(`  Levels mapped:          ${processorStats.levelsMapped}`);
    this.log(`  Levels unmapped:        ${processorStats.levelsUnmapped}`);
    this.log(`  Levels created:         ${processorStats.levelsCreated}`);
    this.log(`  Projects without scheme:${processorStats.projectsWithNoCloudScheme}`);

    this.log("\nIssue Processing:");
    this.log(`  Cloud issues checked:   ${processorStats.cloudIssuesChecked}`);
    this.log(`  Already in sync:        ${processorStats.issuesAlreadyInSync}`);
    this.log(`  Issues updated:         ${processorStats.issuesUpdated}`);
    this.log(`  Issues failed:          ${processorStats.issuesFailed}`);
    this.log(`  Issues skipped:         ${processorStats.issuesSkipped}`);

    const totalProcessed = processorStats.issuesUpdated + processorStats.issuesFailed;
    const successRate =
      totalProcessed > 0
        ? ((processorStats.issuesUpdated / totalProcessed) * 100).toFixed(1)
        : "N/A";
    this.log(`  Success rate:           ${successRate}%`);

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

    this.log("\nAPI Statistics:");
    this.log(`  DC requests:            ${dcStats.requestCount} (${dcStats.errorCount} errors)`);
    this.log(`  Cloud requests:         ${cloudStats.requestCount} (${cloudStats.errorCount} errors, ${cloudStats.rateLimitCount} rate limits)`);

    this.log(`\nTotal elapsed time:       ${elapsed}s`);
    this.log(`Log file:                 ${this.logFile}`);
    this.log("=".repeat(60));
  }

  static showHelp() {
    console.log(`
Sync Security Levels: Datacenter -> Cloud

Two-phase architecture:
  Phase 1 (Plan):   Scan DC issues with security levels, map to Cloud, build plan
  Phase 2 (Execute): Apply plan — one PUT per issue to set security level (concurrent)

Security levels are matched by name within each project's security scheme.
If levels are missing in Cloud, a CSV report is generated for manual creation.

Usage:
  node sync_security_levels.js [options]

Options:
  --dry-run                Preview what would be updated without making changes
  --limit <n>              Limit total DC issues scanned
  --plan-only              Build the plan and save it, but don't execute
  --execute-only           Load existing plan and execute without rebuilding
  --resume                 Alias for --execute-only (resume from last plan)
  --plan-file <path>       Path to master index JSON file
  --concurrency <n>        Max parallel Cloud PUT requests (default: 5)
  --retry-failed           Also reprocess issues with status "failed" (default: pending only)
  --help                   Show this help message

Environment Variables (in .env):
  DC_BASE_URL         Jira Datacenter base URL
  DC_USERNAME         Datacenter username (Basic Auth)
  DC_PASSWORD         Datacenter password (Basic Auth)
  CLOUD_BASE_URL      Jira Cloud base URL (e.g. https://site.atlassian.net)
  CLOUD_API_TOKEN     Cloud API token (base64 encoded email:token)

Examples:
  # Build plan only (preview)
  node sync_security_levels.js --plan-only

  # Build plan with issue limit
  node sync_security_levels.js --plan-only --limit 100

  # Full sync in dry-run mode
  node sync_security_levels.js --dry-run

  # Execute existing plan with higher concurrency
  node sync_security_levels.js --execute-only --concurrency 10

  # Resume from a specific master index
  node sync_security_levels.js --resume --plan-file ./logs/master_123456.json

  # Full sync
  node sync_security_levels.js
    `);
  }
}

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
        SecurityLevelSync.showHelp();
        process.exit(0);
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
      default:
        if (args[i].startsWith("--")) {
          console.warn(`Unknown option: ${args[i]}`);
        }
        break;
    }
  }

  return options;
}

// Main execution
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
    sync = new SecurityLevelSync(options);
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

module.exports = SecurityLevelSync;
