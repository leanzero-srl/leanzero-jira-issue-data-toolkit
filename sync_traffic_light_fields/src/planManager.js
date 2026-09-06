const fs = require("fs");
const path = require("path");

class PlanManager {
  constructor(planDir, log) {
    this.planDir = planDir;
    this.log = log || console.log;
    this.plan = null;
    this.planFilePath = null;
    this.masterIndex = null;
    this.masterIndexPath = null;
    this.updatesSinceSave = 0;
    this.autoSaveThreshold = 10;
  }

  setPlanFile(filePath) {
    this.masterIndexPath = filePath;
  }

  // ─────────────────────────────────────────────────
  //  MASTER INDEX
  // ─────────────────────────────────────────────────

  createMasterIndex(runId) {
    if (!fs.existsSync(this.planDir)) {
      fs.mkdirSync(this.planDir, { recursive: true });
    }

    this.masterIndexPath = path.join(this.planDir, `master_${runId}.json`);
    this.masterIndex = {
      version: "2.0",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stats: { totalFields: 0, totalIssues: 0, pending: 0, completed: 0, failed: 0, skipped: 0 },
      fields: [],
    };

    this.saveMasterIndex();
    return this.masterIndex;
  }

  addFieldToMasterIndex(fieldName, dcFieldId, cloudFieldId, planFile, issueCount, stats) {
    if (!this.masterIndex) return;

    this.masterIndex.fields.push({
      fieldName,
      dcFieldId,
      cloudFieldId,
      planFile,
      issueCount,
      stats,
      status: issueCount > 0 ? "pending" : "skipped",
    });

    this.masterIndex.stats.totalFields = this.masterIndex.fields.length;
    this.masterIndex.stats.totalIssues += issueCount;
    this.masterIndex.stats.pending += stats.pending || 0;
    this.masterIndex.stats.skipped += stats.skipped || 0;
    this.masterIndex.updatedAt = new Date().toISOString();

    this.saveMasterIndex();
  }

  saveMasterIndex() {
    if (!this.masterIndex || !this.masterIndexPath) return;
    try {
      fs.writeFileSync(this.masterIndexPath, JSON.stringify(this.masterIndex, null, 2));
    } catch (error) {
      this.log(`  ERROR saving master index: ${error.message}`);
    }
  }

  loadMasterIndex(filePath) {
    const target = filePath || this.masterIndexPath;
    if (!target) {
      this.log("  No master index specified, searching for latest...");
      const latest = this.findLatestMasterIndex();
      if (!latest) {
        this.log("  No existing master index found.");
        return null;
      }
      this.masterIndexPath = latest;
    } else {
      this.masterIndexPath = target;
    }

    if (!fs.existsSync(this.masterIndexPath)) {
      this.log(`  Master index not found: ${this.masterIndexPath}`);
      return null;
    }

    try {
      const data = fs.readFileSync(this.masterIndexPath, "utf8");
      this.masterIndex = JSON.parse(data);
      this.log(`  Loaded master index from ${this.masterIndexPath}`);
      this.log(`  ${this.masterIndex.fields.length} field plans, ${this.masterIndex.stats.totalIssues} total issues`);
      return this.masterIndex;
    } catch (error) {
      this.log(`  ERROR loading master index: ${error.message}`);
      return null;
    }
  }

  findLatestMasterIndex() {
    if (!fs.existsSync(this.planDir)) return null;

    const files = fs.readdirSync(this.planDir)
      .filter((f) => f.startsWith("master_") && f.endsWith(".json"))
      .sort()
      .reverse();

    return files.length > 0 ? path.join(this.planDir, files[0]) : null;
  }

  getFieldPlansToExecute() {
    if (!this.masterIndex) return [];
    return this.masterIndex.fields.filter(
      (f) => f.status === "pending" || f.status === "failed",
    );
  }

  // ─────────────────────────────────────────────────
  //  PER-FIELD PLAN
  // ─────────────────────────────────────────────────

  /**
   * Create and save a per-field plan for traffic light data.
   *
   * @param {string} runId
   * @param {object} fieldConfig - { name, dcFieldId, cloudFieldId }
   * @param {object} issuesMap - { issueKey: { status, dcRaw, cloudValue, error } }
   * @returns {{ planFile: string, plan: object }}
   */
  createFieldPlan(runId, fieldConfig, issuesMap) {
    if (!fs.existsSync(this.planDir)) {
      fs.mkdirSync(this.planDir, { recursive: true });
    }

    const safeName = fieldConfig.name
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .substring(0, 50);
    const planFile = path.join(this.planDir, `plan_${runId}_${safeName}.json`);

    const plan = {
      version: "1.0",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      fieldName: fieldConfig.name,
      dcFieldId: fieldConfig.dcFieldId,
      cloudFieldId: fieldConfig.cloudFieldId,
      stats: { total: 0, pending: 0, completed: 0, failed: 0, skipped: 0 },
      issues: issuesMap,
    };

    // Calculate stats
    for (const issue of Object.values(plan.issues)) {
      plan.stats.total++;
      if (plan.stats[issue.status] !== undefined) {
        plan.stats[issue.status]++;
      }
    }

    this._streamWriteFieldPlan(planFile, plan);
    return { planFile, plan };
  }

  _streamWriteFieldPlan(filePath, plan) {
    let fd = null;
    try {
      fd = fs.openSync(filePath, "w");
      fs.writeSync(fd, "{\n");
      fs.writeSync(fd, `"version":${JSON.stringify(plan.version)},\n`);
      fs.writeSync(fd, `"createdAt":${JSON.stringify(plan.createdAt)},\n`);
      fs.writeSync(fd, `"updatedAt":${JSON.stringify(plan.updatedAt)},\n`);
      fs.writeSync(fd, `"fieldName":${JSON.stringify(plan.fieldName)},\n`);
      fs.writeSync(fd, `"dcFieldId":${JSON.stringify(plan.dcFieldId)},\n`);
      fs.writeSync(fd, `"cloudFieldId":${JSON.stringify(plan.cloudFieldId)},\n`);
      fs.writeSync(fd, `"stats":${JSON.stringify(plan.stats)},\n`);
      fs.writeSync(fd, `"issues":{\n`);

      const issueKeys = Object.keys(plan.issues);
      for (let i = 0; i < issueKeys.length; i++) {
        const key = issueKeys[i];
        const comma = i < issueKeys.length - 1 ? ",\n" : "\n";
        fs.writeSync(fd, `${JSON.stringify(key)}:${JSON.stringify(plan.issues[key])}${comma}`);
      }

      fs.writeSync(fd, "}\n}");
    } catch (error) {
      this.log(`  ERROR saving field plan: ${error.message}`);
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  loadFieldPlan(filePath) {
    if (!fs.existsSync(filePath)) {
      this.log(`  Field plan not found: ${filePath}`);
      return null;
    }

    try {
      const data = fs.readFileSync(filePath, "utf8");
      this.plan = JSON.parse(data);
      this.planFilePath = filePath;
      this.recalculateStats();
      this.log(`  Loaded field plan: "${this.plan.fieldName}" from ${filePath}`);
      this.log(`  Plan stats: ${this.formatStats()}`);
      return this.plan;
    } catch (error) {
      this.log(`  ERROR loading field plan: ${error.message}`);
      return null;
    }
  }

  savePlan() {
    if (!this.plan || !this.planFilePath) return;

    this.plan.updatedAt = new Date().toISOString();
    this.recalculateStats();

    if (this.isMergedPlan()) {
      this._streamWriteMergedPlan(this.planFilePath, this.plan);
    } else {
      this._streamWriteFieldPlan(this.planFilePath, this.plan);
    }
    this.updatesSinceSave = 0;
  }

  // ─────────────────────────────────────────────────
  //  MERGED EXECUTION PLAN
  // ─────────────────────────────────────────────────

  /**
   * Build a merged execution plan from all pending per-field plans.
   * Groups by issue key so one PUT updates all fields for an issue.
   *
   * Merged issue format:
   * {
   *   status: "pending",
   *   fields: {
   *     cloudFieldId: { fieldName, dcRaw, cloudValue, status, error }
   *   }
   * }
   */
  buildMergedPlan(runId) {
    const fieldPlans = this.getFieldPlansToExecute();
    if (fieldPlans.length === 0) {
      this.log("  No field plans to merge.");
      return null;
    }

    this.log(`\nMerging ${fieldPlans.length} field plans by unique issue key...`);

    const mergedIssues = new Map();
    let totalFieldEntries = 0;

    for (let i = 0; i < fieldPlans.length; i++) {
      const entry = fieldPlans[i];
      this.log(`  [${i + 1}/${fieldPlans.length}] Reading "${entry.fieldName}" (${entry.issueCount} issues)...`);

      if (!entry.planFile || !fs.existsSync(entry.planFile)) {
        this.log(`    WARNING: Plan file missing, skipping`);
        continue;
      }

      let fieldPlan;
      try {
        const data = fs.readFileSync(entry.planFile, "utf8");
        fieldPlan = JSON.parse(data);
      } catch (error) {
        this.log(`    ERROR reading plan file: ${error.message}, skipping`);
        continue;
      }

      const cloudFieldId = fieldPlan.cloudFieldId;
      const fieldName = fieldPlan.fieldName;

      for (const [issueKey, issueData] of Object.entries(fieldPlan.issues)) {
        if (issueData.status === "skipped") continue;

        if (!mergedIssues.has(issueKey)) {
          mergedIssues.set(issueKey, {
            status: "pending",
            fields: {},
            updatedAt: null,
            error: null,
          });
        }

        const merged = mergedIssues.get(issueKey);
        merged.fields[cloudFieldId] = {
          fieldName,
          dcRaw: issueData.dcRaw,
          cloudValue: issueData.cloudValue,
          status: issueData.status || "pending",
          error: issueData.error || null,
        };
        totalFieldEntries++;
      }

      fieldPlan = null;
    }

    const uniqueIssues = mergedIssues.size;
    this.log(`  Merge complete: ${uniqueIssues} unique issues from ${totalFieldEntries} total field entries`);
    if (totalFieldEntries > 0) {
      this.log(`  Reduction: ${totalFieldEntries} API calls -> ${uniqueIssues} API calls (${((1 - uniqueIssues / totalFieldEntries) * 100).toFixed(1)}% fewer)`);
    }

    const plan = {
      version: "1.1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stats: { total: 0, pending: 0, completed: 0, failed: 0, skipped: 0 },
      issues: {},
    };

    for (const [issueKey, issueData] of mergedIssues) {
      plan.issues[issueKey] = issueData;
      plan.stats.total++;
      if (plan.stats[issueData.status] !== undefined) {
        plan.stats[issueData.status]++;
      }
    }

    const mergedFile = path.join(this.planDir, `merged_${runId}.json`);
    this._streamWriteMergedPlan(mergedFile, plan);

    if (this.masterIndex) {
      this.masterIndex.mergedPlanFile = mergedFile;
      this.masterIndex.stats.uniqueIssues = uniqueIssues;
      this.masterIndex.updatedAt = new Date().toISOString();
      this.saveMasterIndex();
    }

    this.log(`  Merged plan saved: ${mergedFile}`);
    return mergedFile;
  }

  _streamWriteMergedPlan(filePath, plan) {
    let fd = null;
    try {
      fd = fs.openSync(filePath, "w");
      fs.writeSync(fd, "{\n");
      fs.writeSync(fd, `"version":${JSON.stringify(plan.version)},\n`);
      fs.writeSync(fd, `"createdAt":${JSON.stringify(plan.createdAt)},\n`);
      fs.writeSync(fd, `"updatedAt":${JSON.stringify(plan.updatedAt)},\n`);
      fs.writeSync(fd, `"stats":${JSON.stringify(plan.stats)},\n`);
      fs.writeSync(fd, `"issues":{\n`);

      const issueKeys = Object.keys(plan.issues);
      for (let i = 0; i < issueKeys.length; i++) {
        const key = issueKeys[i];
        const comma = i < issueKeys.length - 1 ? ",\n" : "\n";
        fs.writeSync(fd, `${JSON.stringify(key)}:${JSON.stringify(plan.issues[key])}${comma}`);
      }

      fs.writeSync(fd, "}\n}");
    } catch (error) {
      this.log(`  ERROR saving merged plan: ${error.message}`);
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  async loadMergedPlan(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
      this.log(`  Merged plan not found: ${filePath}`);
      return null;
    }

    try {
      this.log(`  Loading merged plan from ${filePath} (streaming)...`);
      const plan = { version: null, createdAt: null, updatedAt: null, stats: null, issues: {} };

      const readline = require("readline");
      const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });

      let inIssues = false;
      let issueCount = 0;

      for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line || line === "{" || line === "}") continue;

        if (line === '"issues":{') {
          inIssues = true;
          continue;
        }

        if (!inIssues) {
          const clean = line.endsWith(",") ? line.slice(0, -1) : line;
          const colonIdx = clean.indexOf(":");
          if (colonIdx === -1) continue;
          const key = JSON.parse(clean.substring(0, colonIdx));
          const val = JSON.parse(clean.substring(colonIdx + 1));
          plan[key] = val;
        } else {
          const clean = line.endsWith(",") ? line.slice(0, -1) : line;
          const colonIdx = clean.indexOf(":");
          if (colonIdx === -1) continue;
          const key = JSON.parse(clean.substring(0, colonIdx));
          const val = JSON.parse(clean.substring(colonIdx + 1));
          plan.issues[key] = val;
          issueCount++;
          if (issueCount % 10000 === 0) {
            this.log(`  Loaded ${issueCount} issues...`);
          }
        }
      }

      this.plan = plan;
      this.planFilePath = filePath;
      this.recalculateStats();
      this.log(`  Loaded merged plan: ${this.formatStats()}`);
      return this.plan;
    } catch (error) {
      this.log(`  ERROR loading merged plan: ${error.message}`);
      return null;
    }
  }

  isMergedPlan() {
    return this.plan && this.plan.version === "1.1";
  }

  // ─────────────────────────────────────────────────
  //  STATUS TRACKING
  // ─────────────────────────────────────────────────

  getIssuesToProcess() {
    if (!this.plan) return [];
    return Object.entries(this.plan.issues).filter(
      ([, data]) => data.status === "pending" || data.status === "failed",
    );
  }

  updateIssueStatus(issueKey, status, error = null) {
    if (!this.plan || !this.plan.issues[issueKey]) return;

    this.plan.issues[issueKey].status = status;
    this.plan.issues[issueKey].error = error;
    this.plan.issues[issueKey].updatedAt = new Date().toISOString();

    if (!this.isMergedPlan()) {
      this.updatesSinceSave++;
      if (this.updatesSinceSave >= this.autoSaveThreshold) {
        this.savePlan();
      }
    }
  }

  updateFieldStatus(issueKey, fieldId, status, error = null) {
    if (!this.plan || !this.plan.issues[issueKey]) return;

    const issue = this.plan.issues[issueKey];
    if (!issue.fields || !issue.fields[fieldId]) return;

    issue.fields[fieldId].status = status;
    issue.fields[fieldId].error = error;

    this.deriveIssueStatus(issueKey);
  }

  deriveIssueStatus(issueKey) {
    if (!this.plan || !this.plan.issues[issueKey]) return;

    const issue = this.plan.issues[issueKey];
    if (!issue.fields) return;

    const statuses = Object.values(issue.fields).map((f) => f.status);

    if (statuses.every((s) => s === "completed")) {
      issue.status = "completed";
    } else if (statuses.some((s) => s === "pending" || s === "failed")) {
      issue.status = statuses.some((s) => s === "pending") ? "pending" : "failed";
    } else if (statuses.every((s) => s === "skipped")) {
      issue.status = "skipped";
    }

    issue.updatedAt = new Date().toISOString();
  }

  recalculateStats() {
    if (!this.plan) return;

    const stats = { total: 0, pending: 0, completed: 0, failed: 0, skipped: 0 };

    for (const issue of Object.values(this.plan.issues)) {
      stats.total++;
      if (stats[issue.status] !== undefined) {
        stats[issue.status]++;
      }
    }

    this.plan.stats = stats;
  }

  formatStats() {
    if (!this.plan) return "No plan loaded";
    const s = this.plan.stats;
    return `${s.total} issues (${s.pending} pending, ${s.completed} completed, ${s.failed} failed, ${s.skipped} skipped)`;
  }

  getPlanSummary() {
    if (this.masterIndex) {
      return {
        ...this.masterIndex.stats,
        masterFile: this.masterIndexPath,
        mergedPlanFile: this.masterIndex.mergedPlanFile || null,
      };
    }
    if (this.plan) {
      return {
        ...this.plan.stats,
        planFile: this.planFilePath,
      };
    }
    return null;
  }
}

module.exports = PlanManager;
