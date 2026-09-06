const fs = require("fs");
const path = require("path");

class ParentProcessor {
  constructor(dcClient, cloudClient, planManager, options = {}) {
    this.dcClient = dcClient;
    this.cloudClient = cloudClient;
    this.planManager = planManager;

    this.dryRun = options.dryRun || false;
    this.limit = options.limit || 0;
    this.concurrency = options.concurrency || 5;
    this.retryFailed = options.retryFailed || false;
    this.jql = options.jql || null;
    this.epicLinkFieldId = options.epicLinkFieldId || null;
    this.parentLinkFieldId = options.parentLinkFieldId || null;
    this.log = options.log || console.log;
    this.logDir = options.logDir;
    this.muter = options.muter || null;
    this.muteNotifications = options.muteNotifications !== false;

    this.stats = {
      cloudIssuesScanned: 0,
      alreadyHasParent: 0,
      dcLookupErrors: 0,
      dcWithoutParent: 0,
      parentResolvedFromSubtask: 0,
      parentResolvedFromEpicLink: 0,
      parentResolvedFromParentLink: 0,
      parentResolvedFromGenericParent: 0,
      parentMissingInCloud: 0,
      issuesNeedingUpdate: 0,
      issuesUpdated: 0,
      issuesFailed: 0,
      // Phase 1b — reverse-discovery children of imported issues
      childrenSearchTotal: 0,
      childrenAlreadyInImported: 0,
      childrenNotInCloud: 0,
      childrenAlreadyHaveParent: 0,
      childrenAddedPending: 0,
      // Pre-flight (execute time)
      preflightStaleSame: 0,
      preflightStaleDifferent: 0,
      preflightMissingInCloud: 0,
    };

    this.missingParents = [];
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
    this.log(`  Requesting fields: parent,issuetype`);

    const cloudIssues = await this.cloudClient.searchIssues(
      this.jql,
      "parent,issuetype",
      100,
    );

    let candidates = cloudIssues;
    if (this.limit > 0 && candidates.length > this.limit) {
      this.log(`  Truncating to --limit ${this.limit} (had ${candidates.length})`);
      candidates = candidates.slice(0, this.limit);
    }

    this.stats.cloudIssuesScanned = candidates.length;
    this.log(`  Cloud JQL returned ${candidates.length} issues to inspect`);

    // Track the imported keys + types for Phase 1b (reverse children search)
    const importedKeys = [];
    const importedTypesByKey = new Map();
    for (const c of candidates) {
      importedKeys.push(c.key);
      importedTypesByKey.set(c.key, c.fields?.issuetype?.name || null);
    }

    const issuesMap = {};
    let processed = 0;

    this.log("\n  Phase 1a: Resolving parents of imported issues...");
    for (const issue of candidates) {
      processed++;
      if (processed % 50 === 0) {
        this.log(`  ...processed ${processed}/${candidates.length}`);
      }

      const childKey = issue.key;
      const fields = issue.fields || {};
      const childIssueType = fields.issuetype?.name || null;

      // 1. Skip if Cloud already has a parent
      // Note: the JQL response may omit `parent` for some project types;
      //       if undefined we fall back to an explicit fetch to be safe.
      let cloudParent = fields.parent;
      if (cloudParent === undefined) {
        const fetched = await this.cloudClient.getIssueParent(childKey);
        cloudParent = fetched?.parent || null;
      }

      if (cloudParent && cloudParent.key) {
        issuesMap[childKey] = {
          status: "skipped",
          skipReason: "cloud-already-has-parent",
          dcIssueType: null,
          cloudIssueType: childIssueType,
          parentSource: null,
          targetParentKey: null,
          existingCloudParent: cloudParent.key,
          error: null,
          updatedAt: null,
        };
        this.stats.alreadyHasParent++;
        continue;
      }

      // 2. Fetch DC parent
      const dcInfo = await this.dcClient.getIssueParentInfo(childKey, {
        epicLinkFieldId: this.epicLinkFieldId,
        parentLinkFieldId: this.parentLinkFieldId,
      });

      if (dcInfo.error) {
        issuesMap[childKey] = {
          status: "skipped",
          skipReason: "dc-lookup-failed",
          dcIssueType: null,
          cloudIssueType: childIssueType,
          parentSource: null,
          targetParentKey: null,
          existingCloudParent: null,
          error: dcInfo.error,
          updatedAt: null,
        };
        this.stats.dcLookupErrors++;
        continue;
      }

      if (!dcInfo.parentKey) {
        issuesMap[childKey] = {
          status: "skipped",
          skipReason: "no-dc-parent",
          dcIssueType: dcInfo.issueType,
          cloudIssueType: childIssueType,
          parentSource: null,
          targetParentKey: null,
          existingCloudParent: null,
          error: null,
          updatedAt: null,
        };
        this.stats.dcWithoutParent++;
        continue;
      }

      // 3. Verify the parent exists in Cloud
      let parentExists;
      try {
        parentExists = await this.cloudClient.verifyIssueExists(dcInfo.parentKey);
      } catch (error) {
        issuesMap[childKey] = {
          status: "skipped",
          skipReason: "cloud-verify-failed",
          dcIssueType: dcInfo.issueType,
          cloudIssueType: childIssueType,
          parentSource: dcInfo.parentSource,
          targetParentKey: dcInfo.parentKey,
          existingCloudParent: null,
          error: `verify failed: ${error.message}`,
          updatedAt: null,
        };
        this.stats.dcLookupErrors++;
        continue;
      }

      if (!parentExists) {
        issuesMap[childKey] = {
          status: "skipped",
          skipReason: "parent-missing-in-cloud",
          dcIssueType: dcInfo.issueType,
          cloudIssueType: childIssueType,
          parentSource: dcInfo.parentSource,
          targetParentKey: dcInfo.parentKey,
          existingCloudParent: null,
          error: null,
          updatedAt: null,
        };
        this.missingParents.push({
          childKey,
          dcIssueType: dcInfo.issueType,
          dcParentKey: dcInfo.parentKey,
          parentSource: dcInfo.parentSource,
          detectedAt: new Date().toISOString(),
        });
        this.stats.parentMissingInCloud++;
        continue;
      }

      // 4. Plan-eligible
      issuesMap[childKey] = {
        status: "pending",
        skipReason: null,
        dcIssueType: dcInfo.issueType,
        cloudIssueType: childIssueType,
        parentSource: dcInfo.parentSource,
        targetParentKey: dcInfo.parentKey,
        existingCloudParent: null,
        error: null,
        updatedAt: null,
      };

      this.stats.issuesNeedingUpdate++;
      if (dcInfo.parentSource === this.epicLinkFieldId) {
        this.stats.parentResolvedFromEpicLink++;
      } else if (dcInfo.parentSource === this.parentLinkFieldId) {
        this.stats.parentResolvedFromParentLink++;
      } else if (dcInfo.parentSource === "fields.parent" && dcInfo.isSubtask) {
        this.stats.parentResolvedFromSubtask++;
      } else if (dcInfo.parentSource === "fields.parent") {
        this.stats.parentResolvedFromGenericParent++;
      }
    }

    // Tag every Phase-1a entry with how it was discovered
    for (const v of Object.values(issuesMap)) {
      if (!v.discovery) v.discovery = "imported-jql";
    }

    // ───────────────────────────────────────────────
    //  Phase 1b: reverse — find DC children of any imported issue
    // ───────────────────────────────────────────────
    this.log("\n  Phase 1b: Searching DC for children of imported issues...");
    await this._enrichWithChildren(importedKeys, importedTypesByKey, issuesMap);

    // Persist master index + plan
    this.planManager.createMasterIndex(runId, { jql: this.jql });
    this.planManager.createPlan(runId, issuesMap);

    // Mirror skip-counters into the master index for at-a-glance reporting
    if (this.planManager.masterIndex) {
      const m = this.planManager.masterIndex.stats;
      m.alreadyHasParent = this.stats.alreadyHasParent;
      m.noDcParent = this.stats.dcWithoutParent;
      m.parentMissingInCloud = this.stats.parentMissingInCloud;
      m.dcLookupErrors = this.stats.dcLookupErrors;
      this.planManager.saveMasterIndex();
    }

    // Always write the missing-parents report (even if empty)
    this._writeMissingParentsReport(runId);

    this.log("");
    this.log(`  Plan summary:`);
    this.log(`    Cloud issues scanned:                  ${this.stats.cloudIssuesScanned}`);
    this.log(`    Already has Cloud parent (skipped):    ${this.stats.alreadyHasParent}`);
    this.log(`    No DC parent (skipped):                ${this.stats.dcWithoutParent}`);
    this.log(`    DC lookup errors:                      ${this.stats.dcLookupErrors}`);
    this.log(`    Parent missing in Cloud (skipped):     ${this.stats.parentMissingInCloud}`);
    this.log(`    Pending updates:                       ${this.stats.issuesNeedingUpdate}`);
    this.log(`      ├ from sub-task parent:              ${this.stats.parentResolvedFromSubtask}`);
    this.log(`      ├ from Epic Link (${this.epicLinkFieldId || "n/a"}): ${this.stats.parentResolvedFromEpicLink}`);
    this.log(`      ├ from Parent Link (${this.parentLinkFieldId || "n/a"}): ${this.stats.parentResolvedFromParentLink}`);
    this.log(`      └ from generic parent:               ${this.stats.parentResolvedFromGenericParent}`);
    this.log(`    Phase 1b — reverse children search:`);
    this.log(`      DC children found:                   ${this.stats.childrenSearchTotal}`);
    this.log(`      ├ already in imported set:           ${this.stats.childrenAlreadyInImported}`);
    this.log(`      ├ not in Cloud (skipped):            ${this.stats.childrenNotInCloud}`);
    this.log(`      ├ Cloud already has parent (skip):   ${this.stats.childrenAlreadyHaveParent}`);
    this.log(`      └ added as pending:                  ${this.stats.childrenAddedPending}`);
  }

  /**
   * Phase 1b — Reverse discovery: for each issue in the imported set, search
   * DC for issues whose parent (any source) points back to it. Add new
   * children to the plan when:
   *   - The DC child is not already in the imported set,
   *   - The same key exists in Cloud,
   *   - The Cloud child has no parent set yet.
   *
   * Batched search reduces DC API calls to ~ceil(N/50) * 3 sources.
   */
  async _enrichWithChildren(importedKeys, importedTypes, issuesMap) {
    const isSubtaskType = (t) => {
      const n = (t || "").toLowerCase();
      return n === "sub-task" || n === "subtask";
    };

    const nonSubtaskParentKeys = importedKeys.filter(
      (k) => !isSubtaskType(importedTypes.get(k)),
    );
    const epicParentKeys = importedKeys.filter(
      (k) => (importedTypes.get(k) || "").toLowerCase() === "epic",
    );

    this.log(
      `    Source set: ${importedKeys.length} imported, ${nonSubtaskParentKeys.length} non-subtask, ${epicParentKeys.length} epic`,
    );

    // Discovered children keyed by DC child key: { parentKey, parentSource, dcIssueType, isSubtask }
    const candidatesByChild = new Map();
    const recordChild = (issue, parentKey, parentSource) => {
      if (!issue.key || !parentKey) return;
      if (candidatesByChild.has(issue.key)) return; // first writer wins (parent > epic > parentLink)
      candidatesByChild.set(issue.key, {
        parentKey,
        parentSource,
        dcIssueType: issue.fields?.issuetype?.name || null,
        isSubtask: !!issue.fields?.issuetype?.subtask,
      });
    };

    // ── 1. Sub-task children (any non-subtask in the imported set can be the parent)
    if (nonSubtaskParentKeys.length > 0) {
      await this._batchedDcSearch(
        nonSubtaskParentKeys,
        (batch) => `parent in (${batch.join(",")})`,
        "parent,issuetype",
        (issue) => {
          const pk = issue.fields?.parent?.key || null;
          if (pk) recordChild(issue, pk, "fields.parent");
        },
        "subtask",
      );
    }

    // ── 2. Epic Link children (only Epic parents in imported set)
    if (this.epicLinkFieldId && epicParentKeys.length > 0) {
      const num = this.epicLinkFieldId.replace("customfield_", "");
      await this._batchedDcSearch(
        epicParentKeys,
        (batch) => `cf[${num}] in (${batch.join(",")})`,
        `${this.epicLinkFieldId},issuetype`,
        (issue) => {
          const raw = issue.fields?.[this.epicLinkFieldId];
          const ek = typeof raw === "string" ? raw : raw?.key || null;
          if (ek) recordChild(issue, ek, this.epicLinkFieldId);
        },
        "epic-link",
      );
    }

    // ── 3. Parent Link children (any non-subtask in imported set can be the parent)
    if (this.parentLinkFieldId && nonSubtaskParentKeys.length > 0) {
      const num = this.parentLinkFieldId.replace("customfield_", "");
      await this._batchedDcSearch(
        nonSubtaskParentKeys,
        (batch) => `cf[${num}] in (${batch.join(",")})`,
        `${this.parentLinkFieldId},issuetype`,
        (issue) => {
          const raw = issue.fields?.[this.parentLinkFieldId];
          let pk = null;
          if (typeof raw === "string") pk = raw;
          else if (raw?.key) pk = raw.key;
          else if (raw?.data?.key) pk = raw.data.key;
          if (pk) recordChild(issue, pk, this.parentLinkFieldId);
        },
        "parent-link",
      );
    }

    this.stats.childrenSearchTotal = candidatesByChild.size;
    this.log(`    DC children discovered: ${candidatesByChild.size}`);

    // Filter to children NOT already in imported set
    const newChildKeys = [];
    for (const childKey of candidatesByChild.keys()) {
      if (issuesMap[childKey]) {
        this.stats.childrenAlreadyInImported++;
        continue;
      }
      newChildKeys.push(childKey);
    }
    this.log(
      `    ${newChildKeys.length} new (not in imported set), ${this.stats.childrenAlreadyInImported} were already in the plan`,
    );

    if (newChildKeys.length === 0) return;

    // Batch-fetch Cloud state for new children
    this.log(`    Fetching Cloud state for ${newChildKeys.length} children...`);
    const cloudState = await this.cloudClient.batchGetIssueParents(newChildKeys);

    let processed = 0;
    for (const childKey of newChildKeys) {
      processed++;
      if (processed % 500 === 0) {
        this.log(`      ...processed ${processed}/${newChildKeys.length}`);
      }

      const dcInfo = candidatesByChild.get(childKey);
      const cs = cloudState.get(childKey) || { exists: false, parent: null, issueType: null };

      if (!cs.exists) {
        this.stats.childrenNotInCloud++;
        continue; // not in Cloud — out of scope; do NOT add to plan
      }

      if (cs.parent && cs.parent.key) {
        issuesMap[childKey] = {
          status: "skipped",
          skipReason: "cloud-already-has-parent",
          dcIssueType: dcInfo.dcIssueType,
          cloudIssueType: cs.issueType,
          parentSource: null,
          targetParentKey: null,
          existingCloudParent: cs.parent.key,
          error: null,
          updatedAt: null,
          discovery: "child-of-imported",
        };
        this.stats.childrenAlreadyHaveParent++;
        this.stats.alreadyHasParent++;
        continue;
      }

      // Parent is guaranteed to be in the imported set, so it exists in
      // Cloud only if our earlier scan said so (cached on cloudClient).
      let parentExistsInCloud;
      try {
        parentExistsInCloud = await this.cloudClient.verifyIssueExists(
          dcInfo.parentKey,
        );
      } catch (e) {
        issuesMap[childKey] = {
          status: "skipped",
          skipReason: "cloud-verify-failed",
          dcIssueType: dcInfo.dcIssueType,
          cloudIssueType: cs.issueType,
          parentSource: dcInfo.parentSource,
          targetParentKey: dcInfo.parentKey,
          existingCloudParent: null,
          error: `verify failed: ${e.message}`,
          updatedAt: null,
          discovery: "child-of-imported",
        };
        this.stats.dcLookupErrors++;
        continue;
      }

      if (!parentExistsInCloud) {
        issuesMap[childKey] = {
          status: "skipped",
          skipReason: "parent-missing-in-cloud",
          dcIssueType: dcInfo.dcIssueType,
          cloudIssueType: cs.issueType,
          parentSource: dcInfo.parentSource,
          targetParentKey: dcInfo.parentKey,
          existingCloudParent: null,
          error: null,
          updatedAt: null,
          discovery: "child-of-imported",
        };
        this.missingParents.push({
          childKey,
          dcIssueType: dcInfo.dcIssueType,
          dcParentKey: dcInfo.parentKey,
          parentSource: dcInfo.parentSource,
          detectedAt: new Date().toISOString(),
        });
        this.stats.parentMissingInCloud++;
        continue;
      }

      // Plan-eligible child
      issuesMap[childKey] = {
        status: "pending",
        skipReason: null,
        dcIssueType: dcInfo.dcIssueType,
        cloudIssueType: cs.issueType,
        parentSource: dcInfo.parentSource,
        targetParentKey: dcInfo.parentKey,
        existingCloudParent: null,
        error: null,
        updatedAt: null,
        discovery: "child-of-imported",
      };

      this.stats.childrenAddedPending++;
      this.stats.issuesNeedingUpdate++;
      if (dcInfo.parentSource === this.epicLinkFieldId) {
        this.stats.parentResolvedFromEpicLink++;
      } else if (dcInfo.parentSource === this.parentLinkFieldId) {
        this.stats.parentResolvedFromParentLink++;
      } else if (dcInfo.parentSource === "fields.parent" && dcInfo.isSubtask) {
        this.stats.parentResolvedFromSubtask++;
      } else if (dcInfo.parentSource === "fields.parent") {
        this.stats.parentResolvedFromGenericParent++;
      }
    }
  }

  async _batchedDcSearch(parentKeys, jqlBuilder, fieldsParam, perIssue, label) {
    const batchSize = 50;
    const totalBatches = Math.ceil(parentKeys.length / batchSize);
    let batchIdx = 0;
    for (let i = 0; i < parentKeys.length; i += batchSize) {
      batchIdx++;
      const batch = parentKeys.slice(i, i + batchSize);
      const jql = jqlBuilder(batch);
      if (batchIdx === 1 || batchIdx % 10 === 0 || batchIdx === totalBatches) {
        this.log(`      [DC search ${label}] batch ${batchIdx}/${totalBatches}`);
      }
      try {
        await this.dcClient.searchByJql(jql, fieldsParam, (issues) => {
          for (const issue of issues) perIssue(issue);
        });
      } catch (e) {
        this.log(`      [DC search ${label}] batch ${batchIdx} failed: ${e.message}`);
      }
    }
  }

  _writeMissingParentsReport(runId) {
    const csvPath = path.join(this.logDir, `missing_parents_${runId}.csv`);
    const jsonPath = path.join(this.logDir, `missing_parents_${runId}.json`);

    const header = "childKey,dcIssueType,dcParentKey,parentSource,detectedAt\n";
    const rows = this.missingParents
      .map((r) =>
        [
          r.childKey,
          r.dcIssueType || "",
          r.dcParentKey || "",
          r.parentSource || "",
          r.detectedAt,
        ]
          .map((v) => {
            const s = String(v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(","),
      )
      .join("\n");

    fs.writeFileSync(csvPath, header + rows + (rows ? "\n" : ""));

    const summaryByProject = {};
    for (const r of this.missingParents) {
      const proj = (r.childKey || "").split("-")[0];
      if (!proj) continue;
      summaryByProject[proj] = (summaryByProject[proj] || 0) + 1;
    }

    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        { runId, count: this.missingParents.length, summaryByProject, rows: this.missingParents },
        null,
        2,
      ),
    );

    if (this.planManager.masterIndex) {
      this.planManager.masterIndex.missingParentsCsv = csvPath;
      this.planManager.masterIndex.missingParentsJson = jsonPath;
      this.planManager.saveMasterIndex();
    }

    this.log(`  Missing-parents report: ${this.missingParents.length} rows`);
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

    // ── Pre-flight: re-check Cloud state for every pending row before any PUT.
    // The plan may be minutes or hours old; other tooling may have set parents
    // in the meantime. Strictly enforce "never overwrite an existing parent".
    // Runs in dry-run too (read-only — does not mutate the plan in that mode).
    this.log(
      `  Pre-flight: batched re-fetch Cloud parent state for ${todo.length} pending rows...`,
    );
    const preflightKeys = todo.map(([k]) => k);
    const cloudState = await this.cloudClient.batchGetIssueParents(
      preflightKeys,
      50,
    );
    let staleSame = 0;
    let staleDifferent = 0;
    let missing = 0;
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
      if (cs.parent && cs.parent.key) {
        if (cs.parent.key === data.targetParentKey) {
          if (!this.dryRun) {
            this.planManager.updateIssueStatus(key, "completed", null);
          }
          staleSame++;
        } else {
          if (!this.dryRun) {
            this.planManager.updateIssueStatus(
              key,
              "skipped",
              `cloud-parent-changed-since-plan (now ${cs.parent.key})`,
            );
          } else {
            this.log(
              `    [pre-flight] ${key}: cloud now has parent=${cs.parent.key}, planned=${data.targetParentKey} — would skip to avoid overwrite`,
            );
          }
          staleDifferent++;
        }
        continue;
      }
      stillPending.push(entry);
    }
    if (!this.dryRun) this.planManager.savePlan();
    this.log(
      `  Pre-flight result: ${stillPending.length} still pending, ${staleSame} already correct (no-op), ${staleDifferent} have a different Cloud parent (skipped to avoid overwrite), ${missing} not in Cloud`,
    );
    this.stats.preflightStaleSame = staleSame;
    this.stats.preflightStaleDifferent = staleDifferent;
    this.stats.preflightMissingInCloud = missing;
    todo = stillPending;
    if (todo.length === 0) {
      this.log("  No rows left to apply after pre-flight.");
      return;
    }

    // Group remaining work by project so we can mute/restore notifications
    // around each project's bulk parent updates. Parent-field updates trigger
    // the "Issue Updated" notification event, which would spam watchers for
    // every issue if left enabled.
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
          this.log(
            `  [project ${projectKey}] WARN: could not mute notifications — proceeding anyway`,
          );
        }
      }

      try {
        for (let i = 0; i < projTodo.length; i += batchSize) {
          const batch = projTodo.slice(i, i + batchSize);

          if (this.dryRun) {
            for (const [issueKey, data] of batch) {
              this.log(
                `    [dry-run] Would set ${issueKey}.parent = ${data.targetParentKey} (source: ${data.parentSource})`,
              );
              this.stats.issuesUpdated++;
            }
          } else {
            const updates = batch.map(([issueKey, data]) => ({
              issueKey,
              payload: { fields: { parent: { key: data.targetParentKey } } },
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

module.exports = ParentProcessor;
