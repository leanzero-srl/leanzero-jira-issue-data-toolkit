class SecurityLevelProcessor {
  constructor(dcClient, cloudClient, planManager, options = {}) {
    this.dcClient = dcClient;
    this.cloudClient = cloudClient;
    this.planManager = planManager;

    this.dryRun = options.dryRun || false;
    this.limit = options.limit || 0;
    this.concurrency = options.concurrency || 5;
    this.retryFailed = options.retryFailed || false;
    this.log = options.log || console.log;

    // DC data
    this.dcSchemes = new Map(); // schemeName -> { id, levels: Map<levelName, { id, description }> }
    this.dcProjectSchemes = new Map(); // projectKey -> { schemeId, schemeName }

    // Cloud data
    this.cloudSchemes = new Map(); // schemeName -> { id, levels: Map<levelName, levelId> }
    this.cloudSchemeById = new Map(); // schemeId -> { name, levels: Map<levelName, levelId> }
    this.cloudProjectSchemes = new Map(); // projectId -> schemeId
    this.cloudProjectKeyToId = new Map(); // projectKey -> projectId

    // Mapping: (projectKey, dcLevelName) -> cloudLevelId
    this.levelMapping = new Map(); // "projectKey::levelName" -> cloudLevelId

    // Tracking
    this.missingLevels = new Map(); // "projectKey::levelName" -> { schemeId, name, description }
    this.unmappedProjects = new Set(); // projects with no Cloud scheme

    this.stats = {
      dcIssuesScanned: 0,
      cloudIssuesChecked: 0,
      issuesAlreadyInSync: 0,
      issuesNeedingUpdate: 0,
      issuesUpdated: 0,
      issuesFailed: 0,
      issuesSkipped: 0,
      levelsCreated: 0,
      levelsMapped: 0,
      levelsUnmapped: 0,
      projectsWithNoCloudScheme: 0,
    };
  }

  getStats() {
    return { ...this.stats };
  }

  // ─────────────────────────────────────────────────
  //  PHASE 1a: BUILD MAPPINGS
  // ─────────────────────────────────────────────────

  async buildMappings(projectKeys) {
    this.log("\nStep 2: Building security level mappings...");

    // 1. Fetch DC security schemes and their levels
    this.log("  Fetching DC security schemes...");
    const dcSchemeList = await this.dcClient.fetchAllSecuritySchemes();
    this.log(`  Found ${dcSchemeList.length} DC security scheme(s)`);

    for (const scheme of dcSchemeList) {
      const full = await this.dcClient.fetchSecurityScheme(scheme.id);
      const levels = new Map();
      for (const level of full.levels || []) {
        levels.set(level.name, { id: String(level.id), description: level.description || "" });
      }
      this.dcSchemes.set(scheme.name, { id: String(scheme.id), levels });
      this.log(`    DC Scheme "${scheme.name}" (id: ${scheme.id}): ${levels.size} level(s)`);
    }

    // 2. Fetch Cloud security schemes and their levels
    this.log("  Fetching Cloud security schemes...");
    const cloudSchemeList = await this.cloudClient.fetchAllSecuritySchemes();
    this.log(`  Found ${cloudSchemeList.length} Cloud security scheme(s)`);

    if (cloudSchemeList.length > 0) {
      const schemeIds = cloudSchemeList.map((s) => s.id);
      const cloudLevels = await this.cloudClient.fetchSecurityLevels(schemeIds);

      for (const scheme of cloudSchemeList) {
        const entry = { id: String(scheme.id), name: scheme.name, levels: new Map() };
        this.cloudSchemes.set(scheme.name, entry);
        this.cloudSchemeById.set(String(scheme.id), entry);
      }

      for (const level of cloudLevels) {
        const schemeId = String(level.issueSecuritySchemeId);
        const scheme = this.cloudSchemeById.get(schemeId);
        if (scheme) {
          scheme.levels.set(level.name, String(level.id));
        }
      }

      for (const scheme of cloudSchemeList) {
        const entry = this.cloudSchemes.get(scheme.name);
        this.log(`    Cloud Scheme "${scheme.name}" (id: ${scheme.id}): ${entry.levels.size} level(s)`);
      }
    }

    // 3. Fetch Cloud project-to-scheme associations
    this.log("  Fetching Cloud project-to-scheme associations...");
    const cloudAssociations = await this.cloudClient.fetchProjectSchemeAssociations();
    for (const assoc of cloudAssociations) {
      this.cloudProjectSchemes.set(String(assoc.projectId), String(assoc.issueSecuritySchemeId));
    }
    this.log(`  Found ${cloudAssociations.length} Cloud project-scheme association(s)`);

    // 4. Build level mapping per project (DC scheme associations already populated by buildPlan)
    this.log("  Building level mappings...");
    for (const projectKey of projectKeys) {
      await this._buildProjectMapping(projectKey);
    }

    this.log(`  Mapping complete: ${this.stats.levelsMapped} mapped, ${this.stats.levelsUnmapped} unmapped, ${this.stats.projectsWithNoCloudScheme} projects without Cloud scheme`);
  }

  async _buildProjectMapping(projectKey) {
    // Find the DC scheme for this project
    const dcAssoc = this.dcProjectSchemes.get(projectKey);
    if (!dcAssoc) return;

    // Find the Cloud project ID
    let cloudProject = this.cloudProjectKeyToId.get(projectKey);
    if (cloudProject === undefined) {
      const proj = await this.cloudClient.getProjectByKey(projectKey);
      if (proj) {
        cloudProject = proj.id;
        this.cloudProjectKeyToId.set(projectKey, cloudProject);
      } else {
        this.cloudProjectKeyToId.set(projectKey, null);
      }
    }

    if (!cloudProject) {
      this.unmappedProjects.add(projectKey);
      return;
    }

    // Find the Cloud scheme for this project
    const cloudSchemeId = this.cloudProjectSchemes.get(String(cloudProject));
    if (!cloudSchemeId) {
      this.unmappedProjects.add(projectKey);
      this.stats.projectsWithNoCloudScheme++;
      return;
    }

    const cloudScheme = this.cloudSchemeById.get(cloudSchemeId);
    if (!cloudScheme) return;

    // Get DC scheme levels
    const dcSchemeInfo = this.dcSchemes.get(dcAssoc.schemeName);
    if (!dcSchemeInfo) return;

    // Match levels by name
    for (const [levelName, dcLevel] of dcSchemeInfo.levels) {
      const mapKey = `${projectKey}::${levelName}`;

      const cloudLevelId = cloudScheme.levels.get(levelName);
      if (cloudLevelId) {
        this.levelMapping.set(mapKey, cloudLevelId);
        this.stats.levelsMapped++;
      } else {
        this.missingLevels.set(mapKey, {
          cloudSchemeId,
          name: levelName,
          description: dcLevel.description,
          projectKey,
        });
        this.stats.levelsUnmapped++;
      }
    }
  }

  // ─────────────────────────────────────────────────
  //  PHASE 1b: REPORT MISSING LEVELS
  // ─────────────────────────────────────────────────

  /**
   * Reports missing security levels and writes a CSV/text report.
   * Returns true if there are missing levels (blocking), false if none.
   */
  async _reportMissingLevels() {
    // Deduplicate by (cloudSchemeId, levelName)
    const toCreate = new Map();
    for (const [, info] of this.missingLevels) {
      const dedupeKey = `${info.cloudSchemeId}::${info.name}`;
      if (!toCreate.has(dedupeKey)) {
        toCreate.set(dedupeKey, info);
      }
    }

    // Count affected issues per missing level
    const affectedCounts = new Map();
    for (const [, info] of this.missingLevels) {
      const dedupeKey = `${info.cloudSchemeId}::${info.name}`;
      affectedCounts.set(dedupeKey, (affectedCounts.get(dedupeKey) || 0) + 1);
    }

    this.log(`\n${"!".repeat(70)}`);
    this.log(`  MISSING SECURITY LEVELS — Manual action required`);
    this.log(`${"!".repeat(70)}`);
    this.log(`\n  Found ${toCreate.size} security level(s) that exist in DC but NOT in Cloud.`);
    this.log(`  These must be created manually in Cloud with the correct members/actors`);
    this.log(`  before the sync can proceed.\n`);

    // Build report data
    const reportLines = ["Cloud Scheme ID,Cloud Scheme Name,Missing Level Name,DC Description,Affected Projects"];

    for (const [dedupeKey, info] of toCreate) {
      const cloudScheme = this.cloudSchemeById.get(info.cloudSchemeId);
      const schemeName = cloudScheme ? cloudScheme.name : "unknown";

      // Collect affected projects for this level
      const affectedProjects = [];
      for (const [, mInfo] of this.missingLevels) {
        if (`${mInfo.cloudSchemeId}::${mInfo.name}` === dedupeKey && !affectedProjects.includes(mInfo.projectKey)) {
          affectedProjects.push(mInfo.projectKey);
        }
      }

      this.log(`  Scheme: "${schemeName}" (id: ${info.cloudSchemeId})`);
      this.log(`    Level: "${info.name}"`);
      this.log(`    DC Description: "${info.description}"`);
      this.log(`    Affected projects: ${affectedProjects.join(", ")}`);
      this.log("");

      const escapedDesc = `"${(info.description || "").replace(/"/g, '""')}"`;
      reportLines.push(`${info.cloudSchemeId},${schemeName},${info.name},${escapedDesc},${affectedProjects.join("; ")}`);
    }

    // Write report file
    const fs = require("fs");
    const path = require("path");
    const reportFile = path.join(this.planManager.planDir, `missing_levels_${Date.now()}.csv`);
    fs.writeFileSync(reportFile, reportLines.join("\n") + "\n");

    this.log(`  Report saved: ${reportFile}`);
    this.log(`\n  ACTION REQUIRED:`);
    this.log(`  1. Open the Cloud admin UI for each scheme listed above`);
    this.log(`  2. Create the missing level(s) with the correct members/actors`);
    this.log(`     (refer to the DC admin UI for the correct members)`);
    this.log(`  3. Re-run this script after all levels are created`);
    this.log(`\n${"!".repeat(70)}\n`);

    return true;
  }

  // ─────────────────────────────────────────────────
  //  PHASE 1c: BUILD PLAN (smart: count-compare then Cloud-first gap finding)
  // ─────────────────────────────────────────────────

  async buildPlan(runId) {
    // ── Step 1: Discover DC projects with security schemes ──
    this.log("\nStep 1: Discovering DC projects with security schemes...");
    const allProjects = await this.dcClient.fetchAllProjects();
    this.log(`  ${allProjects.length} total DC projects`);

    const dcProjectCounts = new Map(); // projectKey -> count
    for (const p of allProjects) {
      const scheme = await this.dcClient.fetchProjectSecurityScheme(p.key);
      if (scheme && scheme.id) {
        this.dcProjectSchemes.set(p.key, {
          schemeId: String(scheme.id),
          schemeName: scheme.name,
        });
      }
    }
    this.log(`  ${this.dcProjectSchemes.size} project(s) with security schemes`);

    this.log("\n  Getting issue counts per project...");
    for (const [projectKey] of this.dcProjectSchemes) {
      const count = await this.dcClient.searchCount(`level is not EMPTY AND project = "${projectKey}"`);
      if (count > 0) {
        dcProjectCounts.set(projectKey, count);
      }
      if (this.limit > 0 && dcProjectCounts.size >= this.limit) break;
    }
    this.log(`  ${dcProjectCounts.size} project(s) with actual security-level issues`);

    for (const [key, count] of dcProjectCounts) {
      const scheme = this.dcProjectSchemes.get(key);
      this.log(`    ${key}: ${count} issues (scheme: "${scheme.schemeName}")`);
      this.stats.dcIssuesScanned += count;
    }

    if (dcProjectCounts.size === 0) {
      this.log("  No projects with security-level issues found in DC.");
      this.planManager.createMasterIndex(runId);
      this.planManager.createPlan(runId, {});
      return;
    }

    // ── Step 2: Build mappings (schemes, levels, project associations) ──
    await this.buildMappings(dcProjectCounts.keys());

    // ── Step 3: Check for missing levels — report and stop if found ──
    if (this.missingLevels.size > 0) {
      const blocked = await this._reportMissingLevels();
      if (blocked) return;
    }

    // ── Step 4: Per-project count comparison and Cloud-first gap finding ──
    this.log("\nStep 4: Comparing per-project counts and finding gaps...\n");
    const issuesMap = {};

    for (const [projectKey, dcTotal] of dcProjectCounts) {
      this.log(`── Project: ${projectKey} (${dcTotal} DC issues with security) ──`);

      if (this.unmappedProjects.has(projectKey)) {
        this.log(`  SKIP: project not in Cloud or no Cloud scheme`);
        continue;
      }

      const cloudProjectId = this.cloudProjectKeyToId.get(projectKey);
      if (!cloudProjectId) {
        this.log(`  SKIP: project not found in Cloud`);
        continue;
      }

      const cloudSchemeId = this.cloudProjectSchemes.get(String(cloudProjectId));
      if (!cloudSchemeId) {
        this.log(`  SKIP: no Cloud scheme`);
        continue;
      }

      // Count comparison
      const cloudTotal = await this.cloudClient.searchCount(`project = "${projectKey}" AND level is not EMPTY`);
      this.log(`  Counts: DC=${dcTotal}, Cloud=${cloudTotal}`);

      if (cloudTotal >= dcTotal) {
        this.log(`  Cloud count >= DC count — likely in sync, skipping`);
        this.stats.issuesAlreadyInSync += dcTotal;
        continue;
      }

      const gap = dcTotal - cloudTotal;
      this.log(`  GAP: ${gap} issue(s) may be missing security levels in Cloud`);

      // Fetch Cloud issues WITHOUT security level in this project
      this.log(`  Fetching Cloud issues without security level...`);
      const cloudMissing = await this.cloudClient.searchIssues(
        `project = "${projectKey}" AND level is EMPTY ORDER BY key ASC`,
        "summary",
        100,
      );
      this.log(`  Found ${cloudMissing.length} Cloud issues without security level`);

      if (cloudMissing.length === 0) {
        this.log(`  No issues without security level — gap may be due to deleted issues`);
        continue;
      }

      // Cross-check against DC: for each Cloud issue without a level, check if DC has one
      this.log(`  Cross-checking ${cloudMissing.length} issues against DC...`);
      let foundInProject = 0;
      let checked = 0;

      for (const cloudIssue of cloudMissing) {
        checked++;
        if (checked % 500 === 0) {
          this.log(`    Progress: ${checked}/${cloudMissing.length} checked, ${foundInProject} need update`);
        }
        let dcIssue;
        try {
          dcIssue = await this.dcClient.makeRequest(
            "GET",
            `/rest/api/2/issue/${encodeURIComponent(cloudIssue.key)}?fields=security`,
          );
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 403) continue;
          throw err;
        }

        const dcSecurity = dcIssue.fields?.security;
        if (!dcSecurity) continue;

        const mapKey = `${projectKey}::${dcSecurity.name}`;
        const cloudLevelId = this.levelMapping.get(mapKey);

        if (!cloudLevelId) {
          // Level not mapped — skip or log
          this.log(`    ${cloudIssue.key}: DC has "${dcSecurity.name}" but no Cloud mapping`);
          issuesMap[cloudIssue.key] = {
            status: "skipped",
            projectKey,
            dcLevelName: dcSecurity.name,
            dcLevelId: String(dcSecurity.id),
            cloudLevelId: null,
            cloudLevelName: null,
            cloudSchemeId,
            error: `No Cloud level mapping for "${dcSecurity.name}"`,
            updatedAt: null,
          };
          continue;
        }

        issuesMap[cloudIssue.key] = {
          status: "pending",
          projectKey,
          dcLevelName: dcSecurity.name,
          dcLevelId: String(dcSecurity.id),
          cloudLevelId,
          cloudLevelName: dcSecurity.name,
          cloudSchemeId,
          error: null,
          updatedAt: null,
        };
        foundInProject++;
      }

      this.log(`  ${foundInProject} issue(s) need security level in project ${projectKey}`);
    }

    // ── Step 5: Save plan ──
    this.stats.issuesSkipped = Object.values(issuesMap).filter((i) => i.status === "skipped").length;
    this.stats.issuesNeedingUpdate = Object.values(issuesMap).filter((i) => i.status === "pending").length;
    this.stats.cloudIssuesChecked = Object.keys(issuesMap).length;

    this.log(`\n  Plan summary: ${this.stats.issuesNeedingUpdate} to update, ${this.stats.issuesSkipped} skipped`);

    this.planManager.createMasterIndex(runId);
    const { planFile } = this.planManager.createPlan(runId, issuesMap);

    if (this.planManager.masterIndex) {
      this.planManager.masterIndex.stats.levelsCreated = this.stats.levelsCreated;
      this.planManager.masterIndex.stats.levelsMapped = this.stats.levelsMapped;
      this.planManager.masterIndex.stats.projectsWithNoCloudScheme = this.stats.projectsWithNoCloudScheme;
      this.planManager.saveMasterIndex();
    }

    this.log(`  Plan saved: ${planFile}`);
  }

  // ─────────────────────────────────────────────────
  //  PHASE 2: EXECUTE PLAN
  // ─────────────────────────────────────────────────

  async executePlan() {
    const toProcess = this.planManager.getIssuesToProcess(this.retryFailed);

    if (toProcess.length === 0) {
      this.log("  No issues to process.");
      return;
    }

    this.log(`\n  Executing plan: ${toProcess.length} issue(s) to update (concurrency: ${this.concurrency})...`);

    if (this.dryRun) {
      this.log("  *** DRY RUN - No changes will be made ***");
      for (const [issueKey, data] of toProcess) {
        this.log(`    [DRY RUN] Would set ${issueKey} security level to "${data.cloudLevelName}" (${data.cloudLevelId})`);
        this.planManager.updateIssueStatus(issueKey, "completed");
        this.stats.issuesUpdated++;
      }
      return;
    }

    // Process in batches
    const batchSize = this.concurrency * 5;
    const totalBatches = Math.ceil(toProcess.length / batchSize);
    let processed = 0;

    for (let b = 0; b < totalBatches; b++) {
      const batchStart = b * batchSize;
      const batch = toProcess.slice(batchStart, batchStart + batchSize);

      const updates = batch.map(([issueKey, data]) => ({
        issueKey,
        payload: {
          fields: {
            security: { id: data.cloudLevelId },
          },
        },
      }));

      const results = await this.cloudClient.updateIssuesBatch(updates, this.concurrency);

      let batchRateLimits = 0;
      for (const [issueKey, result] of results) {
        processed++;
        if (result.success) {
          this.planManager.updateIssueStatus(issueKey, "completed");
          this.stats.issuesUpdated++;
        } else {
          this.planManager.updateIssueStatus(issueKey, "failed", result.error);
          this.stats.issuesFailed++;
          if (result.isRateLimit) batchRateLimits++;
          // Log first few failures per batch and then periodically
          if (this.stats.issuesFailed <= 10 || this.stats.issuesFailed % 50 === 0) {
            this.log(`    FAILED ${issueKey}: ${result.error}`);
          }
        }

        if (processed % 25 === 0) {
          this.log(`    Progress: ${processed}/${toProcess.length} (${this.stats.issuesUpdated} updated, ${this.stats.issuesFailed} failed)`);
        }
      }

      // If rate limits detected in this batch, pause before next batch
      if (batchRateLimits > 0) {
        const pauseSeconds = Math.min(10 + batchRateLimits * 5, 60);
        this.log(`    ⚠ ${batchRateLimits} rate limit(s) in batch — pausing ${pauseSeconds}s before next batch`);
        await new Promise((r) => setTimeout(r, pauseSeconds * 1000));
      }

      // Periodic save
      if ((b + 1) % 5 === 0) {
        this.planManager.savePlan();
      }
    }

    this.planManager.savePlan();
    this.log(`\n  Execution complete: ${this.stats.issuesUpdated} updated, ${this.stats.issuesFailed} failed`);
  }
}

module.exports = SecurityLevelProcessor;
