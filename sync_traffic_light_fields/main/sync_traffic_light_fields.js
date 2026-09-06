#!/usr/bin/env node

/**
 * Sync Traffic Light Fields: Datacenter -> Cloud
 *
 * Two-phase architecture:
 *   Phase 1 (Plan):   Scan DC fields, map values to Cloud shapes, build execution plan
 *   Phase 2 (Execute): Apply plan to Cloud issues with concurrent PUTs and resume support
 *
 * Traffic light fields use a static mapping config (config/field_mappings.json) to bridge
 * DC select option values like "(,,red) Red" to Cloud {shape, label} objects.
 *
 * Usage:
 *   node sync_traffic_light_fields.js [options]
 *
 * Options:
 *   --dry-run             Preview what would be updated without making changes
 *   --limit <n>           Limit total tickets processed per field
 *   --plan-only           Build the plan and save it, but don't execute
 *   --execute-only        Load existing plan and execute without rebuilding
 *   --resume              Alias for --execute-only
 *   --plan-file <path>    Path to master index JSON file
 *   --concurrency <n>     Max parallel Cloud PUT requests (default: 10)
 *   --help                Show this help message
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DatacenterClient = require("../src/datacenterClient");
const CloudJiraClient = require("../src/cloudJiraClient");
const PlanManager = require("../src/planManager");
const TrafficLightProcessor = require("../src/trafficLightProcessor");

class TrafficLightFieldSync {
  constructor(options = {}) {
    this.options = {
      dryRun: options.dryRun || false,
      limit: options.limit || 0,
      planOnly: options.planOnly || false,
      executeOnly: options.executeOnly || false,
      planFile: options.planFile || null,
      concurrency: options.concurrency || 10,
      retryFailed: options.retryFailed || false,
      fieldName: options.fieldName || null,
      force: options.force || false,
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
      `Sync Traffic Light Fields Log\nStarted: ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`,
    );

    this.log = this.log.bind(this);

    // Initialize clients
    this.dcClient = new DatacenterClient(
      process.env.DC_BASE_URL,
      process.env.DC_USERNAME,
      process.env.DC_PASSWORD,
    );

    this.cloudJiraClient = new CloudJiraClient(
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
    this.log("Sync Traffic Light Fields: DC -> Cloud");
    this.log("==========================================");
    this.log(`  DC:    ${process.env.DC_BASE_URL}`);
    this.log(`  Cloud: ${process.env.CLOUD_BASE_URL}`);
    this.log("");

    if (this.options.dryRun) {
      this.log("*** DRY RUN MODE - No changes will be made ***");
      this.log("");
    }

    if (this.options.limit > 0) {
      this.log(`  Ticket limit per field: ${this.options.limit}`);
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
      this.log(`  Retry failed: YES (will reprocess failed issues)`);
    }
    if (this.options.fieldName) {
      this.log(`  Field filter: "${this.options.fieldName}"`);
    }
    if (this.options.force) {
      this.log(`  FORCE mode: ENABLED (will overwrite already-in-sync values)`);
    }

    // Step 1: Test connections
    this.log("\nStep 1: Testing connections...");

    const dcOk = await this.dcClient.testConnection();
    if (!dcOk) {
      throw new Error("Cannot connect to Jira Datacenter");
    }
    this.log("  Datacenter: OK");

    const cloudJiraOk = await this.cloudJiraClient.testConnection();
    if (!cloudJiraOk) {
      throw new Error("Cannot connect to Jira Cloud");
    }
    this.log("  Cloud Jira: OK");

    // Create processor
    const processor = new TrafficLightProcessor(
      this.dcClient,
      this.cloudJiraClient,
      this.planManager,
      {
        dryRun: this.options.dryRun,
        limit: this.options.limit,
        concurrency: this.options.concurrency,
        retryFailed: this.options.retryFailed,
        fieldName: this.options.fieldName,
        force: this.options.force,
        log: this.log,
      },
    );

    // ── Phase 1: Build or Load Plans ──
    if (this.options.executeOnly) {
      this.log("\nStep 2: Loading existing master index...");
      const master = this.planManager.loadMasterIndex(this.options.planFile);
      if (!master) {
        throw new Error(
          "No master index found. Run without --execute-only first to build plans.",
        );
      }
    } else {
      // Build plans from DC data
      const runId = String(Date.now());

      this.log("\nStep 2: Building per-field execution plans...");
      await processor.buildPlans(runId);

      // Merge field plans
      this.log("\nStep 3: Merging field plans by unique issue key...");
      this.planManager.buildMergedPlan(runId);

      if (this.options.planOnly) {
        this.log("\n*** PLAN ONLY MODE - Skipping execution ***");
        this.printFinalReport(processor.getStats());
        return;
      }
    }

    // ── Phase 2: Execute Merged Plan ──
    let mergedPlanFile = this.planManager.masterIndex?.mergedPlanFile;

    if (!mergedPlanFile) {
      const fieldPlans = this.planManager.getFieldPlansToExecute();
      if (fieldPlans.length === 0) {
        this.log("\nNo field plans to execute.");
        this.printFinalReport(processor.getStats());
        return;
      }
      this.log("\nBuilding merged execution plan from field plans...");
      const runId = path.basename(this.planManager.masterIndexPath).replace("master_", "").replace(".json", "");
      mergedPlanFile = this.planManager.buildMergedPlan(runId);
    }

    const plan = await this.planManager.loadMergedPlan(mergedPlanFile);
    if (!plan) {
      this.log("\nERROR: Could not load merged execution plan.");
      this.printFinalReport(processor.getStats());
      return;
    }

    this.log(`\nStep ${this.options.executeOnly ? "3" : "4"}: Executing merged plan (${this.planManager.plan.stats.total} unique issues)...`);
    await processor.executeMergedPlan();

    this.planManager.savePlan();
    this.planManager.saveMasterIndex();

    this.printFinalReport(processor.getStats());
  }

  printFinalReport(processorStats) {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const dcStats = this.dcClient.getStats();
    const cloudJiraStats = this.cloudJiraClient.getStats();
    const planSummary = this.planManager.getPlanSummary();

    this.log("\n" + "=".repeat(60));
    this.log("FINAL REPORT");
    this.log("=".repeat(60));

    if (this.options.dryRun) {
      this.log("*** DRY RUN - No actual changes were made ***\n");
    }

    this.log("Field Processing:");
    this.log(`  Fields checked:    ${processorStats.fieldsChecked}`);
    this.log(`  Fields matched:    ${processorStats.fieldsMatched}`);
    this.log(`  Fields skipped:    ${processorStats.fieldsSkipped}`);

    this.log("\nIssue Processing:");
    this.log(`  Issues processed:  ${processorStats.issuesProcessed}`);
    this.log(`  Issues updated:    ${processorStats.issuesUpdated}`);
    this.log(`  Already in sync:   ${processorStats.issuesAlreadyInSync}`);
    this.log(`  Issues failed:     ${processorStats.issuesFailed}`);
    this.log(`  Issues skipped:    ${processorStats.issuesSkipped}`);

    const successRate =
      processorStats.issuesProcessed > 0
        ? ((processorStats.issuesUpdated / processorStats.issuesProcessed) * 100).toFixed(1)
        : "N/A";
    this.log(`  Success rate:      ${successRate}%`);

    if (processorStats.unmappedValues && processorStats.unmappedValues.length > 0) {
      this.log(`\nUnmapped DC Values:  ${processorStats.unmappedValues.length}`);
      for (const { fieldName, dcValue } of processorStats.unmappedValues) {
        this.log(`  "${fieldName}": "${dcValue}"`);
      }
    }

    if (planSummary) {
      this.log("\nPlan Status:");
      this.log(`  Total fields:      ${planSummary.totalFields || "N/A"}`);
      this.log(`  Total entries:     ${planSummary.totalIssues || planSummary.total || 0}`);
      if (planSummary.uniqueIssues) {
        this.log(`  Unique issues:     ${planSummary.uniqueIssues}`);
      }
      this.log(`  Completed:         ${planSummary.completed}`);
      this.log(`  Failed:            ${planSummary.failed}`);
      this.log(`  Pending:           ${planSummary.pending}`);
      this.log(`  Skipped:           ${planSummary.skipped}`);
      this.log(`  Master index:      ${planSummary.masterFile || "N/A"}`);
      if (planSummary.mergedPlanFile) {
        this.log(`  Merged plan:       ${planSummary.mergedPlanFile}`);
      }
    }

    this.log("\nAPI Statistics:");
    this.log(`  DC requests:       ${dcStats.requestCount} (${dcStats.errorCount} errors)`);
    this.log(`  Cloud Jira reqs:   ${cloudJiraStats.requestCount} (${cloudJiraStats.errorCount} errors, ${cloudJiraStats.rateLimitCount} rate limits)`);
    if (cloudJiraStats.screenFixCount > 0) {
      this.log(`  Screen auto-fixes: ${cloudJiraStats.screenFixCount}`);
    }

    this.log(`\nTotal elapsed time:  ${elapsed}s`);
    this.log(`Log file:            ${this.logFile}`);
    this.log("=".repeat(60));
  }

  static showHelp() {
    console.log(`
Sync Traffic Light Fields: Datacenter -> Cloud

Two-phase architecture:
  Phase 1 (Plan):   Scan DC fields, map values via static config, build execution plan
  Phase 2 (Execute): Apply merged plan — one PUT per issue with all fields (concurrent)

Traffic light values are mapped using config/field_mappings.json which bridges
DC select option values to Cloud {shape, label} objects.

Usage:
  node sync_traffic_light_fields.js [options]

Options:
  --dry-run             Preview what would be updated without making changes
  --limit <n>           Limit total tickets processed per field
  --plan-only           Build the plan and save it, but don't execute
  --execute-only        Load existing plan and execute without rebuilding
  --resume              Alias for --execute-only (resume from last plan)
  --plan-file <path>    Path to master index JSON file
  --concurrency <n>     Max parallel Cloud PUT requests (default: 10)
  --retry-failed        Also reprocess issues with status "failed" (default: pending only)
  --field <name>        Only process the named field from field_mappings.json (case-insensitive)
  --force               Overwrite every matched issue (skip "already in sync" check)
  --help                Show this help message

Environment Variables (in .env):
  DC_BASE_URL         Jira Datacenter base URL
  DC_USERNAME         Datacenter username (Basic Auth)
  DC_PASSWORD         Datacenter password (Basic Auth)
  CLOUD_BASE_URL      Jira Cloud base URL (e.g. https://site.atlassian.net)
  CLOUD_API_TOKEN     Cloud API token (base64 encoded email:token)

Examples:
  # Build plan only (preview)
  node sync_traffic_light_fields.js --plan-only

  # Build plan with a limit of 10 issues per field
  node sync_traffic_light_fields.js --plan-only --limit 10

  # Full sync in dry-run mode
  node sync_traffic_light_fields.js --dry-run

  # Execute existing plan with 20 concurrent requests
  node sync_traffic_light_fields.js --execute-only --concurrency 20

  # Resume from a specific master index
  node sync_traffic_light_fields.js --resume --plan-file ./logs/master_123456.json

  # Full sync
  node sync_traffic_light_fields.js
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
        TrafficLightFieldSync.showHelp();
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
        options.concurrency = parseInt(args[++i], 10) || 10;
        break;
      case "--retry-failed":
        options.retryFailed = true;
        break;
      case "--field":
        options.fieldName = args[++i];
        break;
      case "--force":
        options.force = true;
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
    sync = new TrafficLightFieldSync(options);
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

module.exports = TrafficLightFieldSync;
