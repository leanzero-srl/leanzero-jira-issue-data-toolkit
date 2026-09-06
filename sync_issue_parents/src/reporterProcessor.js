const fs = require("fs");
const path = require("path");

/**
 * ReporterProcessor — DC → Cloud reporter sync.
 *
 * Mirrors ParentProcessor's two-phase architecture (plan → pre-flight →
 * batched PUT) but for the `reporter` field. After a JCMA import every
 * issue's reporter is the import API user; this restores the historical DC
 * reporter, mapping DC username → Cloud accountId via UserMapper.
 *
 * Overwrite policy: ALWAYS overwrite when the Cloud reporter differs from
 * the resolved DC reporter. Skips when Cloud already matches (no-op).
 *
 * Cloud endpoint used for writes:
 *   PUT /rest/api/3/issue/{key}?notifyUsers=false
 *   body: { fields: { reporter: { accountId: "<id>" } } }
 * (`accountId` is required for writes per the Cloud User schema; `name`/`key`
 * are deprecated under the privacy migration.)
 */
class ReporterProcessor {
  constructor(dcClient, cloudClient, planManager, userMapper, options = {}) {
    this.dcClient = dcClient;
    this.cloudClient = cloudClient;
    this.planManager = planManager;
    this.userMapper = userMapper;

    this.dryRun = options.dryRun || false;
    this.limit = options.limit || 0;
    this.concurrency = options.concurrency || 5;
    this.retryFailed = options.retryFailed || false;
    this.jql = options.jql || null;
    this.log = options.log || console.log;
    this.logDir = options.logDir;
    this.muter = options.muter || null;
    this.muteNotifications = options.muteNotifications !== false;

    this.stats = {
      cloudIssuesScanned: 0,
      dcLookupErrors: 0,
      dcWithoutReporter: 0,
      userResolveNoMatch: 0,
      userResolveAmbiguous: 0,
      userResolveErrors: 0,
      cloudAlreadyCorrect: 0,
      issuesNeedingUpdate: 0,
      issuesUpdated: 0,
      issuesFailed: 0,
      preflightStaleSame: 0,
      preflightMissingInCloud: 0,
    };

    this.missingReporters = [];
    this.runId = null;
  }

  getStats() {
    return { ...this.stats };
  }

  // ─────────────────────────────────────────────────
  //  PHASE 1: BUILD PLAN
  // ─────────────────────────────────────────────────

  async buildPlan(runId) {
    this.runId = runId;

    if (!this.jql) {
      throw new Error("buildPlan requires options.jql");
    }

    this.log(`\n  Running Cloud JQL: ${this.jql}`);
    this.log(`  Requesting fields: reporter,issuetype`);

    const cloudIssues = await this.cloudClient.searchIssues(
      this.jql,
      "reporter,issuetype",
      100,
    );

    let candidates = cloudIssues;
    if (this.limit > 0 && candidates.length > this.limit) {
      this.log(`  Truncating to --limit ${this.limit} (had ${candidates.length})`);
      candidates = candidates.slice(0, this.limit);
    }

    this.stats.cloudIssuesScanned = candidates.length;
    this.log(`  Cloud JQL returned ${candidates.length} issues to inspect`);

    const issuesMap = {};
    let processed = 0;

    this.log("\n  Phase 1: Resolving DC reporters and mapping to Cloud users...");
    for (const issue of candidates) {
      processed++;
      if (processed % 50 === 0) {
        this.log(`  ...processed ${processed}/${candidates.length}`);
      }

      const childKey = issue.key;
      const cloudReporter = issue.fields?.reporter || null;
      const cloudReporterAccountId = cloudReporter?.accountId || null;
      const cloudIssueType = issue.fields?.issuetype?.name || null;

      const dcRes = await this.dcClient.getIssueReporter(childKey);
      if (dcRes.error) {
        this.stats.dcLookupErrors++;
        issuesMap[childKey] = this._makeRow({
          status: "skipped",
          skipReason: `dc-lookup-failed: ${dcRes.error}`,
          existingCloudReporterAccountId: cloudReporterAccountId,
          cloudIssueType,
        });
        continue;
      }

      const dcReporter = dcRes.reporter;
      if (!dcReporter || !(dcReporter.name || dcReporter.emailAddress)) {
        this.stats.dcWithoutReporter++;
        issuesMap[childKey] = this._makeRow({
          status: "skipped",
          skipReason: "no-dc-reporter",
          existingCloudReporterAccountId: cloudReporterAccountId,
          cloudIssueType,
        });
        continue;
      }

      const resolved = await this.userMapper.resolve(dcReporter);

      if (!resolved.accountId) {
        // unresolved — track for CSV and skip
        if (resolved.note === "no_match") this.stats.userResolveNoMatch++;
        else if (resolved.note && resolved.note.startsWith("ambiguous_"))
          this.stats.userResolveAmbiguous++;
        else this.stats.userResolveErrors++;

        this.missingReporters.push({
          issueKey: childKey,
          dcUsername: dcReporter.name || "",
          dcEmail: dcReporter.emailAddress || "",
          dcDisplayName: dcReporter.displayName || "",
          note: resolved.note || "lookup_error",
          candidateCount: resolved.candidateCount || 0,
          detectedAt: new Date().toISOString(),
        });

        issuesMap[childKey] = this._makeRow({
          status: "skipped",
          skipReason: resolved.note || "lookup_error",
          dcReporterUsername: dcReporter.name,
          dcReporterEmail: dcReporter.emailAddress,
          dcReporterDisplayName: dcReporter.displayName,
          existingCloudReporterAccountId: cloudReporterAccountId,
          cloudIssueType,
        });
        continue;
      }

      // Already correct on Cloud — no PUT needed.
      if (
        cloudReporterAccountId &&
        cloudReporterAccountId === resolved.accountId
      ) {
        this.stats.cloudAlreadyCorrect++;
        issuesMap[childKey] = this._makeRow({
          status: "skipped",
          skipReason: "cloud-already-correct",
          dcReporterUsername: dcReporter.name,
          dcReporterEmail: dcReporter.emailAddress,
          dcReporterDisplayName: dcReporter.displayName,
          targetReporterAccountId: resolved.accountId,
          existingCloudReporterAccountId: cloudReporterAccountId,
          userMapperSource: resolved.source,
          cloudIssueType,
        });
        continue;
      }

      this.stats.issuesNeedingUpdate++;
      issuesMap[childKey] = this._makeRow({
        status: "pending",
        dcReporterUsername: dcReporter.name,
        dcReporterEmail: dcReporter.emailAddress,
        dcReporterDisplayName: dcReporter.displayName,
        targetReporterAccountId: resolved.accountId,
        existingCloudReporterAccountId: cloudReporterAccountId,
        userMapperSource: resolved.source,
        cloudIssueType,
      });
    }

    // Persist the user-map cache once Phase 1 is done.
    this.userMapper.flushCache();

    // Persist master index + plan (with reporter file prefix)
    this.planManager.createMasterIndex(
      runId,
      {
        field: "reporter",
        jql: this.jql,
        userMapCacheFile: this.userMapper.cacheFilePath || null,
      },
      "reporter",
    );
    this.planManager.createPlan(runId, issuesMap, "reporter");

    // Mirror skip counters into master index for at-a-glance reporting
    if (this.planManager.masterIndex) {
      const m = this.planManager.masterIndex.stats;
      m.dcLookupErrors = this.stats.dcLookupErrors;
      m.noDcReporter = this.stats.dcWithoutReporter;
      m.cloudAlreadyCorrect = this.stats.cloudAlreadyCorrect;
      m.userResolveNoMatch = this.stats.userResolveNoMatch;
      m.userResolveAmbiguous = this.stats.userResolveAmbiguous;
      m.userResolveErrors = this.stats.userResolveErrors;
      this.planManager.saveMasterIndex();
    }

    this._writeMissingReportersReport(runId);

    const um = this.userMapper.getStats();
    this.log("");
    this.log(`  Plan summary:`);
    this.log(`    Cloud issues scanned:                  ${this.stats.cloudIssuesScanned}`);
    this.log(`    DC lookup errors:                      ${this.stats.dcLookupErrors}`);
    this.log(`    No DC reporter (skipped):              ${this.stats.dcWithoutReporter}`);
    this.log(`    Cloud already correct (skipped):       ${this.stats.cloudAlreadyCorrect}`);
    this.log(`    Unresolved DC user (skipped):          ${
      this.stats.userResolveNoMatch + this.stats.userResolveAmbiguous + this.stats.userResolveErrors
    }`);
    this.log(`      ├ no Cloud match:                    ${this.stats.userResolveNoMatch}`);
    this.log(`      ├ ambiguous:                         ${this.stats.userResolveAmbiguous}`);
    this.log(`      └ lookup errors:                     ${this.stats.userResolveErrors}`);
    this.log(`    Pending updates:                       ${this.stats.issuesNeedingUpdate}`);
    this.log(`  UserMapper:`);
    this.log(`    cache hits / lookups / cache size:     ${um.cacheHits} / ${um.lookupCalls} / ${um.cacheSize}`);
  }

  _makeRow(overrides) {
    return {
      status: "pending",
      skipReason: null,
      dcReporterUsername: null,
      dcReporterEmail: null,
      dcReporterDisplayName: null,
      targetReporterAccountId: null,
      existingCloudReporterAccountId: null,
      userMapperSource: null,
      cloudIssueType: null,
      error: null,
      updatedAt: null,
      ...overrides,
    };
  }

  _writeMissingReportersReport(runId) {
    const csvPath = path.join(this.logDir, `missing_reporters_${runId}.csv`);
    const jsonPath = path.join(this.logDir, `missing_reporters_${runId}.json`);

    const header = "issueKey,dcUsername,dcEmail,dcDisplayName,note,candidateCount,detectedAt\n";
    const esc = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = this.missingReporters
      .map((r) =>
        [r.issueKey, r.dcUsername, r.dcEmail, r.dcDisplayName, r.note, r.candidateCount, r.detectedAt]
          .map(esc)
          .join(","),
      )
      .join("\n");

    fs.writeFileSync(csvPath, header + rows + (rows ? "\n" : ""));

    const summaryByNote = {};
    for (const r of this.missingReporters) {
      const k = (r.note || "unknown").split(":")[0];
      summaryByNote[k] = (summaryByNote[k] || 0) + 1;
    }
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        { runId, count: this.missingReporters.length, summaryByNote, rows: this.missingReporters },
        null,
        2,
      ),
    );

    if (this.planManager.masterIndex) {
      this.planManager.masterIndex.missingReportersCsv = csvPath;
      this.planManager.masterIndex.missingReportersJson = jsonPath;
      this.planManager.saveMasterIndex();
    }

    this.log(`  Missing-reporters report: ${this.missingReporters.length} rows`);
    this.log(`    CSV:  ${csvPath}`);
    this.log(`    JSON: ${jsonPath}`);
  }

  // ─────────────────────────────────────────────────
  //  PHASE 2: EXECUTE PLAN
  // ─────────────────────────────────────────────────

  async executePlan() {
    let todo = this.planManager.getIssuesToProcess(this.retryFailed);

    if (todo.length === 0) {
      this.log("  No pending issues to execute.");
      return;
    }

    this.log(
      `  Pre-flight: batched re-fetch Cloud reporter state for ${todo.length} pending rows...`,
    );
    const preflightKeys = todo.map(([k]) => k);
    const cloudState = await this.cloudClient.batchGetIssueReporters(preflightKeys, 50);

    let staleSame = 0;
    let missing = 0;
    let willOverwriteNonNull = 0;
    const stillPending = [];
    for (const entry of todo) {
      const [key, data] = entry;
      const cs = cloudState.get(key);
      if (!cs || !cs.exists) {
        if (!this.dryRun) {
          this.planManager.updateIssueStatus(
            key,
            "skipped",
            "cloud-issue-not-found-at-preflight",
          );
        }
        missing++;
        continue;
      }
      const currentAccountId = cs.reporter?.accountId || null;
      if (currentAccountId && currentAccountId === data.targetReporterAccountId) {
        if (!this.dryRun) {
          this.planManager.updateIssueStatus(key, "completed", null);
        }
        staleSame++;
        continue;
      }
      // Always overwrite when Cloud differs (per the agreed overwrite policy).
      // Log the first few so the operator can spot-check that they really do
      // want this reporter replaced (the parent sync warns + skips here; the
      // reporter sync warns + proceeds because importer-as-reporter is the
      // common reason for running this at all).
      if (
        currentAccountId
        && currentAccountId !== data.existingCloudReporterAccountId
        && willOverwriteNonNull < 5
      ) {
        this.log(
          `    [pre-flight] ${key}: cloud reporter changed since plan (was ${data.existingCloudReporterAccountId || "null"}, now ${currentAccountId}) — will overwrite with ${data.targetReporterAccountId}`,
        );
      }
      if (currentAccountId) willOverwriteNonNull++;
      stillPending.push(entry);
    }
    if (!this.dryRun) this.planManager.savePlan();
    this.log(
      `  Pre-flight result: ${stillPending.length} still pending (of which ${willOverwriteNonNull} will overwrite a non-null Cloud reporter), ${staleSame} already correct (no-op), ${missing} not in Cloud`,
    );
    this.stats.preflightStaleSame = staleSame;
    this.stats.preflightMissingInCloud = missing;
    todo = stillPending;
    if (todo.length === 0) {
      this.log("  No rows left to apply after pre-flight.");
      return;
    }

    // Group by project for per-project notification muting (reporter PUTs
    // trigger Issue Updated emails the same as parent PUTs).
    const byProject = new Map();
    for (const entry of todo) {
      const [issueKey] = entry;
      const proj = (issueKey.split("-")[0] || "").toUpperCase();
      if (!byProject.has(proj)) byProject.set(proj, []);
      byProject.get(proj).push(entry);
    }
    const projectKeys = [...byProject.keys()].sort();
    this.log(
      `  Executing across ${projectKeys.length} project(s), ${todo.length} update(s) total, concurrency=${this.concurrency}`,
    );
    if (this.dryRun) this.log("  *** DRY RUN: no PUT requests will be issued ***");
    if (this.muter && !this.muteNotifications) {
      this.log("  *** Notifications NOT being suppressed (--no-mute-notifications) ***");
    }

    const batchSize = Math.max(this.concurrency * 5, 25);
    let firstFailuresLogged = 0;
    let totalDone = 0;

    for (const projectKey of projectKeys) {
      const projTodo = byProject.get(projectKey);
      this.log(`\n  [project ${projectKey}] starting (${projTodo.length} update(s))`);

      let muted = false;
      if (this.muter && this.muteNotifications && !this.dryRun) {
        muted = await this.muter.muteProject(projectKey);
        if (!muted) {
          this.log(`  [project ${projectKey}] WARN: could not mute notifications — proceeding anyway`);
        }
      }

      try {
        for (let i = 0; i < projTodo.length; i += batchSize) {
          const batch = projTodo.slice(i, i + batchSize);

          if (this.dryRun) {
            for (const [issueKey, data] of batch) {
              this.log(
                `    [dry-run] Would set ${issueKey}.reporter = ${data.targetReporterAccountId} (${data.dcReporterUsername || data.dcReporterEmail})`,
              );
              this.stats.issuesUpdated++;
            }
          } else {
            const updates = batch.map(([issueKey, data]) => ({
              issueKey,
              payload: {
                fields: { reporter: { accountId: data.targetReporterAccountId } },
              },
            }));

            const results = await this.cloudClient.updateIssuesBatch(
              updates,
              this.concurrency,
            );

            let hadRateLimit = false;
            for (const [issueKey, result] of results) {
              if (result.success) {
                this.planManager.updateIssueStatus(issueKey, "completed", null);
                this.stats.issuesUpdated++;
              } else {
                this.planManager.updateIssueStatus(issueKey, "failed", result.error);
                this.stats.issuesFailed++;
                if (firstFailuresLogged < 10) {
                  this.log(`    FAIL ${issueKey}: ${result.error}`);
                  firstFailuresLogged++;
                } else if (this.stats.issuesFailed % 50 === 0) {
                  this.log(`    FAIL ${issueKey}: ${result.error}`);
                }
              }
              if (result.isRateLimit) hadRateLimit = true;
            }

            if (hadRateLimit) {
              this.log("    [Cloud] cooldown 5s after rate-limit signals");
              await new Promise((r) => setTimeout(r, 5000));
            }
          }

          totalDone += batch.length;
          if (totalDone % 25 < batchSize) {
            this.log(
              `    [${projectKey}] progress: ${totalDone}/${todo.length} (${this.stats.issuesUpdated} updated, ${this.stats.issuesFailed} failed)`,
            );
          }

          if (!this.dryRun) this.planManager.savePlan();
        }
      } finally {
        if (muted) {
          const ok = await this.muter.restoreProject(projectKey);
          if (!ok) {
            this.log(
              `  [project ${projectKey}] WARN: restore FAILED — run with --restore-only to retry`,
            );
          }
        }
      }
      this.log(`  [project ${projectKey}] done`);
    }

    if (!this.dryRun) this.planManager.savePlan();
  }
}

module.exports = ReporterProcessor;
