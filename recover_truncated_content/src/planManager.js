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

  createMasterIndex(runId, extra = {}) {
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
        alreadyHasParent: 0,
        noDcParent: 0,
        parentMissingInCloud: 0,
        dcLookupErrors: 0,
      },
      planFile: null,
      ...extra,
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

  // ─────────────────────────────────────────────────
  //  JSONL HIT STREAM (memory-bounded scan output)
  //
  //  During plan-build we append one JSON object per hit to a JSONL file
  //  (one line each). The in-memory `this.plan.issues` is not used during
  //  build — entries are dropped right after the JSONL append so the
  //  scanning process stays flat in memory regardless of hit count.
  //  finalizePlanFromJsonl() converts the JSONL to the regular plan JSON
  //  format at the end of scan (apply-phase still consumes plan.json).
  // ─────────────────────────────────────────────────

  openHitsJsonl(runId) {
    if (!fs.existsSync(this.planDir)) {
      fs.mkdirSync(this.planDir, { recursive: true });
    }
    this.hitsJsonlPath = path.join(this.planDir, `hits_${runId}.jsonl`);
    this.hitsJsonlFd = fs.openSync(this.hitsJsonlPath, "a");
    return this.hitsJsonlPath;
  }

  appendHit(key, entry) {
    if (this.hitsJsonlFd == null) {
      throw new Error("openHitsJsonl() must be called before appendHit()");
    }
    fs.writeSync(this.hitsJsonlFd, JSON.stringify({ key, ...entry }) + "\n");
  }

  closeHitsJsonl() {
    if (this.hitsJsonlFd != null) {
      try { fs.closeSync(this.hitsJsonlFd); } catch { /* ignore */ }
      this.hitsJsonlFd = null;
    }
  }

  /**
   * After scan completes, convert the append-only JSONL into the regular
   * plan_<runId>.json that the apply phase consumes. Streamed read + streamed
   * write — at no point do we hold the full map in memory.
   * Returns { planFile, total }.
   */
  async finalizePlanFromJsonl(runId) {
    this.closeHitsJsonl();
    if (!this.hitsJsonlPath || !fs.existsSync(this.hitsJsonlPath)) {
      this.log("  No hits.jsonl to finalize — no hits found");
      return { planFile: null, total: 0, pending: 0, failed: 0 };
    }

    const planFile = path.join(this.planDir, `plan_${runId}.json`);
    const readline = require("readline");
    const fdRead = fs.createReadStream(this.hitsJsonlPath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: fdRead, crlfDelay: Infinity });

    // Two-pass: first pass to compute stats, second pass to write the JSON.
    // Both passes stream the file — no in-memory accumulation.
    let total = 0;
    const statCounts = { pending: 0, completed: 0, failed: 0, skipped: 0 };
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        total++;
        if (statCounts[entry.status] !== undefined) statCounts[entry.status]++;
      } catch { /* skip malformed */ }
    }

    // Second pass: write plan.json
    let fd = null;
    try {
      fd = fs.openSync(planFile, "w");
      fs.writeSync(fd, "{\n");
      fs.writeSync(fd, `"version":"1.0",\n`);
      fs.writeSync(fd, `"createdAt":${JSON.stringify(new Date().toISOString())},\n`);
      fs.writeSync(fd, `"updatedAt":${JSON.stringify(new Date().toISOString())},\n`);
      fs.writeSync(fd, `"stats":${JSON.stringify({ total, ...statCounts })},\n`);
      fs.writeSync(fd, `"issues":{\n`);

      const fdRead2 = fs.createReadStream(this.hitsJsonlPath, { encoding: "utf-8" });
      const rl2 = readline.createInterface({ input: fdRead2, crlfDelay: Infinity });
      let written = 0;
      for await (const line of rl2) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const key = entry.key;
        delete entry.key;
        const prefix = written === 0 ? "" : ",\n";
        fs.writeSync(fd, `${prefix}${JSON.stringify(key)}:${JSON.stringify(entry)}`);
        written++;
      }
      fs.writeSync(fd, "\n}\n}");
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }

    this.planFilePath = planFile;
    if (this.masterIndex) {
      this.masterIndex.planFile = planFile;
      this.masterIndex.stats.totalIssues = total;
      this.masterIndex.stats.pending = statCounts.pending;
      this.masterIndex.stats.skipped = statCounts.skipped;
      this.masterIndex.updatedAt = new Date().toISOString();
      this.saveMasterIndex();
    }

    this.log(`  Finalized plan: ${planFile} (${total} entries)`);
    return { planFile, total, pending: statCounts.pending, failed: statCounts.failed };
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
      // Streaming parser assumes one-issue-per-line. If the file was
      // re-saved pretty-printed (multi-line per issue) it fails. Fall back
      // to whole-file JSON.parse — fine for plans up to a few hundred MB.
      this.log(`  Streaming load failed (${error.message}); retrying with full JSON.parse...`);
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const plan = JSON.parse(raw);
        if (!plan || typeof plan !== "object" || !plan.issues) {
          throw new Error("Parsed plan is missing 'issues' object");
        }
        this.plan = plan;
        this.planFilePath = filePath;
        this.recalculateStats();
        this.log(`  Loaded plan (fallback): ${this.formatStats()}`);
        return this.plan;
      } catch (fallbackErr) {
        this.log(`  ERROR loading plan: ${fallbackErr.message}`);
        return null;
      }
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
