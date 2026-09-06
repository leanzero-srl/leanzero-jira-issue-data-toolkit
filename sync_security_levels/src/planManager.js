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
    this.autoSaveThreshold = 500;
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
      version: "1.0",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stats: {
        totalIssues: 0,
        pending: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
        levelsCreated: 0,
        levelsMapped: 0,
        projectsWithNoCloudScheme: 0,
      },
      planFile: null,
    };

    this.saveMasterIndex();
    return this.masterIndex;
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
      this.log(`  ${this.masterIndex.stats.totalIssues} total issues`);
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

  // ─────────────────────────────────────────────────
  //  PLAN FILE
  // ─────────────────────────────────────────────────

  createPlan(runId, issuesMap) {
    if (!fs.existsSync(this.planDir)) {
      fs.mkdirSync(this.planDir, { recursive: true });
    }

    const planFile = path.join(this.planDir, `plan_${runId}.json`);

    this.plan = {
      version: "1.0",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stats: { total: 0, pending: 0, completed: 0, failed: 0, skipped: 0 },
      issues: issuesMap,
    };

    this.recalculateStats();
    this.planFilePath = planFile;
    this._streamWritePlan(planFile, this.plan);

    if (this.masterIndex) {
      this.masterIndex.planFile = planFile;
      this.masterIndex.stats.totalIssues = this.plan.stats.total;
      this.masterIndex.stats.pending = this.plan.stats.pending;
      this.masterIndex.stats.skipped = this.plan.stats.skipped;
      this.masterIndex.updatedAt = new Date().toISOString();
      this.saveMasterIndex();
    }

    return { planFile, plan: this.plan };
  }

  _streamWritePlan(filePath, plan) {
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
      this.log(`  ERROR saving plan: ${error.message}`);
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  async loadPlan(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
      this.log(`  Plan not found: ${filePath}`);
      return null;
    }

    try {
      this.log(`  Loading plan from ${filePath} (streaming)...`);
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
      this.log(`  Loaded plan: ${this.formatStats()}`);
      return this.plan;
    } catch (error) {
      this.log(`  ERROR loading plan: ${error.message}`);
      return null;
    }
  }

  savePlan() {
    if (!this.plan || !this.planFilePath) return;

    this.plan.updatedAt = new Date().toISOString();
    this.recalculateStats();
    this._streamWritePlan(this.planFilePath, this.plan);
    this.updatesSinceSave = 0;
  }

  // ─────────────────────────────────────────────────
  //  STATUS TRACKING
  // ─────────────────────────────────────────────────

  getIssuesToProcess(retryFailed = false) {
    if (!this.plan) return [];
    return Object.entries(this.plan.issues).filter(
      ([, data]) => data.status === "pending" || (retryFailed && data.status === "failed"),
    );
  }

  updateIssueStatus(issueKey, status, error = null) {
    if (!this.plan || !this.plan.issues[issueKey]) return;

    this.plan.issues[issueKey].status = status;
    this.plan.issues[issueKey].error = error;
    this.plan.issues[issueKey].updatedAt = new Date().toISOString();

    this.updatesSinceSave++;
    if (this.updatesSinceSave >= this.autoSaveThreshold) {
      this.savePlan();
    }
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
        planFile: this.masterIndex.planFile || null,
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
