const fs = require("fs");
const path = require("path");

const { isOverCap, adfJsonLength, TRUNCATION_LIMIT } = require("./truncationDetector");
const { loadCheckpoint, appendCheckpoint } = require("./projectIterator");
const {
  buildDescriptionDocx,
  buildCommentsDocx,
  DOCX_MIME,
} = require("./docxBuilder");

class RecoveryProcessor {
  constructor(cloudClient, dcClient, planManager, options = {}) {
    this.cloudClient = cloudClient;
    this.dcClient = dcClient;
    this.planManager = planManager;

    this.dryRun = options.dryRun || false;
    this.apply = options.apply || false;
    this.limit = options.limit || 0;
    this.concurrency = options.concurrency || 3;
    this.retryFailed = options.retryFailed || false;
    this.projectsFilter = options.projects || null; // string[] or null
    this.keyMap = options.keyMap || {}; // { cloudKey: dcKey }
    this.maxDocxBytes = options.maxDocxBytes || 10 * 1024 * 1024;
    this.log = options.log || console.log;
    this.logDir = options.logDir;
    this.docxOutDir = options.docxOutDir;
    this.muter = options.muter || null; // NotificationMuter instance
    this.muteNotifications = options.muteNotifications !== false; // default true

    this.stats = {
      projectsScanned: 0,
      projectsSkippedCheckpoint: 0,
      issuesScanned: 0,
      issuesOverCap: 0,
      descriptionsOverCap: 0,
      commentsOverCap: 0,
      dcFetchFailures: 0,
      docxFilesWritten: 0,
      docxBytesTotal: 0,
      uploadsAttempted: 0,
      uploadsSucceeded: 0,
      uploadsFailed: 0,
      uploadsSkippedNoPermission: 0,
      issuesCompleted: 0,
      issuesPartial: 0,
      issuesFailed: 0,
      issuesSkipped: 0,
    };

    this.runId = null;
    this.maxAttachmentSize = null;
    this.effectiveMaxBytes = this.maxDocxBytes;
  }

  getStats() {
    return { ...this.stats };
  }

  // ─────────────────────────────────────────────────
  //  PHASE 1: BUILD PLAN
  // ─────────────────────────────────────────────────

  async buildPlan(runId) {
    this.runId = runId;

    // Resolve Cloud attachment cap and clamp our docx split threshold to it
    try {
      const cfg = await this.cloudClient.getConfiguration();
      this.maxAttachmentSize =
        typeof cfg.maxAttachmentSize === "number" ? cfg.maxAttachmentSize : null;
      if (this.maxAttachmentSize != null) {
        this.log(`  Cloud max attachment size: ${this.maxAttachmentSize} bytes`);
        if (this.maxAttachmentSize < this.maxDocxBytes) {
          this.effectiveMaxBytes = this.maxAttachmentSize;
          this.log(
            `  Clamping docx split threshold from ${this.maxDocxBytes} to ${this.effectiveMaxBytes} (Cloud cap)`,
          );
        }
      }
      if (cfg.attachmentsEnabled === false) {
        this.log("  WARN: Cloud reports attachmentsEnabled=false — apply will fail");
      }
    } catch (e) {
      this.log(`  WARN: could not fetch Cloud configuration: ${e.message}`);
    }

    // Resolve project list — drive from DC because that's where the
    // pre-truncation content lives. Cloud counterparts are looked up later
    // (key map default = identity).
    let projects;
    if (this.projectsFilter && this.projectsFilter.length > 0) {
      projects = this.projectsFilter.map((k) => ({ key: k }));
      this.log(`  Project list: ${projects.length} (from --projects)`);
    } else {
      this.log("  Discovering all DC projects...");
      projects = await this.dcClient.listProjects();
      this.log(`  Discovered ${projects.length} DC projects`);
    }
    if (projects.length === 0) {
      throw new Error(
        "DC returned 0 projects — check DC_BASE_URL / DC auth or pass --projects",
      );
    }

    // Resume via checkpoint
    const { doneKeys } = loadCheckpoint(this.logDir);
    if (doneKeys.size > 0) {
      this.log(`  Resuming from checkpoint: ${doneKeys.size} project(s) already processed`);
    }

    // Memory-bounded scan output: each hit is appended to a JSONL file and
    // immediately released — we never hold the full plan map in memory. At
    // the end of scan we stream the JSONL into the regular plan_*.json for
    // the apply phase to consume.
    this.planManager.createMasterIndex(runId, {
      mode: "plan",
      projectsTotal: projects.length,
      projectsAlreadyDone: doneKeys.size,
      detectionRule: `DC body length > ${TRUNCATION_LIMIT} (any field)`,
    });
    const hitsJsonl = this.planManager.openHitsJsonl(runId);
    this.log(`  Hits stream: ${hitsJsonl}`);

    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];
      const projectKey = project.key;

      if (doneKeys.has(projectKey)) {
        this.stats.projectsSkippedCheckpoint++;
        this.log(`  [${i + 1}/${projects.length}] ${projectKey} ... SKIP (checkpoint)`);
        continue;
      }

      this.log(`  [${i + 1}/${projects.length}] ${projectKey} ...`);
      let scanned = 0;
      let hits = 0;
      let projectStatus = "OK";
      let projectNote = "";

      // Worker pool for the per-hit work (DC renderedFields fetch + docx
      // render + write). Detection scan stays sequential (paginated DC
      // search). Concurrency is bounded by `this.concurrency` (default 3).
      const inflight = new Set();
      const awaitSlot = async () => {
        while (inflight.size >= this.concurrency) {
          await Promise.race(inflight);
        }
      };
      const spawn = (work) => {
        const p = (async () => {
          try { await work(); } catch (e) {
            this.log(`    UNEXPECTED hit-worker error: ${e.message}`);
          } finally { inflight.delete(p); }
        })();
        inflight.add(p);
        return p;
      };

      try {
        // Stream DC issues. Per-page payload includes description (wiki markup
        // string) and the inline comment array — so we can compute body lengths
        // for every issue with NO extra round-trips. Only oversized issues get
        // a follow-up GET for renderedFields (HTML for the docx).
        for await (const issue of this.dcClient.iterateProjectIssues(projectKey, {
          fields: "description,comment",
          limit: this.limit,
        })) {
          scanned++;
          this.stats.issuesScanned++;

          if (scanned % 100 === 0) {
            this.log(
              `    [${projectKey}] progress: ${scanned} scanned, ${hits} hit(s) so far, ${inflight.size} in-flight`,
            );
          }

          const dcKey = issue.key;
          const dcDescription = issue.fields?.description;
          const dcComments = issue.fields?.comment?.comments || [];
          const descOver = isOverCap(dcDescription);
          const oversizedComments = dcComments.filter((c) => isOverCap(c.body));

          if (!descOver && oversizedComments.length === 0) continue;

          hits++;
          this.stats.issuesOverCap++;
          if (descOver) this.stats.descriptionsOverCap++;
          this.stats.commentsOverCap += oversizedComments.length;

          // Resolve Cloud key (JCMA default is identity)
          const cloudKey = this.keyMap[dcKey] || dcKey;

          // RESUME: if the expected docx files already exist on disk, record
          // them in the plan and skip the DC fetch + docx render. This makes
          // a crashed/aborted scan idempotent on restart. Sync, no worker
          // needed — it's just a stat + file existence check.
          const existing = this._findExistingDocxFiles(cloudKey, descOver, oversizedComments.length > 0);
          if (existing.complete) {
            const files = existing.files.map((f) => this._toPlanFile(f));
            this.planManager.appendHit(cloudKey, {
              status: "pending",
              dcKey,
              descriptionTruncated: descOver,
              descriptionDcLength: adfJsonLength(dcDescription),
              commentTruncationCount: oversizedComments.length,
              totalCommentCount: dcComments.length,
              files,
              error: null,
              resumedFromDisk: true,
            });
            for (const f of files) {
              this.stats.docxFilesWritten++;
              this.stats.docxBytesTotal += f.size || 0;
            }
            continue;
          }

          // Capture hit context for the worker — release inline-page references
          // (large `dcComments` and `dcDescription`) immediately by snapshotting
          // only what we need.
          const hitCtx = {
            dcKey,
            cloudKey,
            descOver,
            dcDescription,
            inlineComments: dcComments,
            totalCmts: issue.fields?.comment?.total,
            oversizedCommentCount: oversizedComments.length,
          };

          // Dispatch to the worker pool. The loop continues paging while the
          // worker fetches DC renderedFields + renders the docx + appends to
          // JSONL.
          await awaitSlot();
          spawn(() => this._processHit(hitCtx));
        }

        // Drain in-flight hits before moving to the next project
        if (inflight.size > 0) {
          this.log(`    [${projectKey}] draining ${inflight.size} in-flight hit(s)...`);
          await Promise.all(inflight);
        }
      } catch (e) {
        projectStatus = "FAILED";
        projectNote = (e.message || "").substring(0, 200);
        this.log(`    ${projectKey}: project scan FAILED — ${e.message}`);
      }

      this.stats.projectsScanned++;
      appendCheckpoint(this.logDir, {
        projectKey,
        scanned,
        hits,
        status: projectStatus,
        note: projectNote,
        completedAt: new Date().toISOString(),
      });
      this.log(`    ${projectKey}: scanned=${scanned} hits=${hits} [${projectStatus}]`);
    }

    // Finalize: stream JSONL into the regular plan_<runId>.json that apply
    // consumes. CSV summary is built from the JSONL too — no in-memory map.
    const finalized = await this.planManager.finalizePlanFromJsonl(runId);
    await this._writeTruncationSummaryFromJsonl(runId, this.planManager.hitsJsonlPath);
    this.log(`  Plan entries: ${finalized.total} (pending=${finalized.pending}, failed=${finalized.failed})`);

    // Update master with final scan stats
    if (this.planManager.masterIndex) {
      Object.assign(this.planManager.masterIndex.stats, {
        totalIssuesScanned: this.stats.issuesScanned,
        issuesOverCap: this.stats.issuesOverCap,
        descriptionsOverCap: this.stats.descriptionsOverCap,
        commentsOverCap: this.stats.commentsOverCap,
        docxFilesWritten: this.stats.docxFilesWritten,
        totalDocxBytes: this.stats.docxBytesTotal,
        uploadsAttempted: 0,
        uploadsSucceeded: 0,
        uploadsFailed: 0,
      });
      this.planManager.saveMasterIndex();
    }

    this.log("");
    this.log("  Plan summary:");
    this.log(`    Projects scanned:                ${this.stats.projectsScanned}`);
    this.log(`    Projects skipped (checkpoint):   ${this.stats.projectsSkippedCheckpoint}`);
    this.log(`    Cloud issues scanned:            ${this.stats.issuesScanned}`);
    this.log(`    Issues with truncation:          ${this.stats.issuesOverCap}`);
    this.log(`    Descriptions truncated:          ${this.stats.descriptionsOverCap}`);
    this.log(`    Comments truncated:              ${this.stats.commentsOverCap}`);
    this.log(`    DC fetch failures:               ${this.stats.dcFetchFailures}`);
    this.log(`    Docx files written:              ${this.stats.docxFilesWritten}`);
    this.log(
      `    Docx bytes total:                ${this.stats.docxBytesTotal} (${(this.stats.docxBytesTotal / 1024 / 1024).toFixed(2)} MB)`,
    );
  }

  /**
   * Per-hit worker — runs concurrently via the inflight pool in buildPlan().
   * Fetches DC renderedFields, renders docx(s), appends one JSONL entry, then
   * releases all per-hit references.
   *
   * `ctx` is a small snapshot captured before dispatch:
   *   { dcKey, cloudKey, descOver, dcDescription, inlineComments, totalCmts,
   *     oversizedCommentCount }
   *
   * Must NOT throw — all errors are caught and recorded as failed plan entries.
   */
  async _processHit(ctx) {
    const { dcKey, cloudKey, descOver, dcDescription, inlineComments, totalCmts, oversizedCommentCount } = ctx;

    // If DC reports more comments than the inline array delivered, fetch
    // the full list — we still want to include them all in the comments
    // docx for context, even if they themselves weren't oversize.
    let fullComments = inlineComments;
    if (typeof totalCmts === "number" && totalCmts > inlineComments.length) {
      try {
        fullComments = await this.dcClient.getCommentsPaginated(dcKey);
      } catch (e) {
        this.log(
          `    [${dcKey}] paginated comments FAILED: ${e.message} — using inline page only`,
        );
      }
    }

    // Fetch rendered HTML for the docx (one extra DC call per hit)
    let dcRendered;
    try {
      dcRendered = await this.dcClient.getIssueWithRenderedBodies(dcKey);
    } catch (e) {
      this.stats.dcFetchFailures++;
      this.log(`    [${dcKey}] DC renderedFields FAILED: ${e.message}`);
      this.planManager.appendHit(cloudKey, {
        status: "failed",
        dcKey,
        descriptionTruncated: descOver,
        descriptionDcLength: adfJsonLength(dcDescription),
        commentTruncationCount: oversizedCommentCount,
        totalCommentCount: fullComments.length,
        files: [],
        error: `DC renderedFields: ${e.message}`,
      });
      return;
    }

    // Merge rendered bodies onto the comment list so docxBuilder can pick
    // either `.rendered` (HTML) or `.storage` (wiki) when writing.
    const renderedByCommentId = new Map();
    for (const c of dcRendered.comments || []) {
      if (c && c.id != null) renderedByCommentId.set(String(c.id), c.rendered);
    }
    let docxComments = fullComments.map((c) => ({
      id: c.id,
      author: c.author
        ? { name: c.author.name || null, displayName: c.author.displayName || null }
        : null,
      created: c.created || null,
      updated: c.updated || null,
      storage: typeof c.body === "string" ? c.body : null,
      rendered: renderedByCommentId.get(String(c.id)) || null,
    }));

    // Build docx files
    const files = [];
    try {
      if (descOver) {
        const descHtml =
          dcRendered.description.rendered ||
          dcRendered.description.storage ||
          (typeof dcDescription === "string" ? dcDescription : "") ||
          "";
        const descFiles = await buildDescriptionDocx({
          issueKey: cloudKey,
          html: descHtml,
          outDir: this.docxOutDir,
        });
        for (const f of descFiles) files.push(this._toPlanFile(f));
      }
      if (oversizedCommentCount > 0) {
        const cmtFiles = await buildCommentsDocx({
          issueKey: cloudKey,
          comments: docxComments,
          outDir: this.docxOutDir,
          maxBytes: this.effectiveMaxBytes,
          log: this.log,
        });
        for (const f of cmtFiles) files.push(this._toPlanFile(f));
      }
    } catch (e) {
      this.log(`    [${cloudKey}] docx build FAILED: ${e.message}`);
      this.planManager.appendHit(cloudKey, {
        status: "failed",
        dcKey,
        descriptionTruncated: descOver,
        descriptionDcLength: adfJsonLength(dcDescription),
        commentTruncationCount: oversizedCommentCount,
        totalCommentCount: fullComments.length,
        files,
        error: `docx: ${e.message}`,
      });
      dcRendered = null; docxComments = null; fullComments = null;
      return;
    }

    for (const f of files) {
      this.stats.docxFilesWritten++;
      this.stats.docxBytesTotal += f.size || 0;
    }

    this.planManager.appendHit(cloudKey, {
      status: "pending",
      dcKey,
      descriptionTruncated: descOver,
      descriptionDcLength: adfJsonLength(dcDescription),
      commentTruncationCount: oversizedCommentCount,
      totalCommentCount: fullComments.length,
      files,
      error: null,
    });

    this.log(
      `    [${dcKey} -> ${cloudKey}] HIT: desc=${descOver ? adfJsonLength(dcDescription) + " chars" : "ok"}, ${oversizedCommentCount}/${fullComments.length} comment(s) over cap, ${files.length} docx file(s)`,
    );

    // Release per-hit memory aggressively so V8 GC can reclaim
    dcRendered = null;
    docxComments = null;
    fullComments = null;
  }

  _toPlanFile(f) {
    return {
      type: f.type,
      path: f.path,
      size: f.size || 0,
      oversize: !!f.oversize,
      uploadStatus: "pending",
      cloudAttachmentId: null,
      error: null,
      attempts: 0,
    };
  }

  /**
   * Resume support: check if the expected docx files for this issue already
   * exist on disk from a prior (interrupted) run. Returns { complete, files }.
   * `complete` is true only if every needed type has at least one matching file.
   *
   * Naming convention from docxBuilder:
   *   {KEY}_description.docx
   *   {KEY}_comment.docx       (single-file case)
   *   {KEY}_comment_{N}.docx   (split case, N=1,2,...)
   */
  _findExistingDocxFiles(issueKey, needsDescription, needsComments) {
    if (!fs.existsSync(this.docxOutDir)) return { complete: false, files: [] };
    const all = fs.readdirSync(this.docxOutDir);
    const descPath = path.join(this.docxOutDir, `${issueKey}_description.docx`);
    const cmtSingle = `${issueKey}_comment.docx`;
    const cmtSplitPrefix = `${issueKey}_comment_`;

    const files = [];
    let hasDescription = false;
    let hasComments = false;

    if (needsDescription && fs.existsSync(descPath)) {
      const st = fs.statSync(descPath);
      files.push({ type: "description", path: descPath, size: st.size });
      hasDescription = true;
    }

    if (needsComments) {
      const cmtFiles = [];
      for (const f of all) {
        if (f === cmtSingle || (f.startsWith(cmtSplitPrefix) && f.endsWith(".docx"))) {
          cmtFiles.push(f);
        }
      }
      if (cmtFiles.length > 0) {
        cmtFiles.sort();
        for (const f of cmtFiles) {
          const p = path.join(this.docxOutDir, f);
          const st = fs.statSync(p);
          files.push({ type: "comment", path: p, size: st.size });
        }
        hasComments = true;
      }
    }

    const complete = (!needsDescription || hasDescription) && (!needsComments || hasComments);
    return { complete, files };
  }

  /**
   * Streamed read of hits.jsonl + streamed write of CSV. No in-memory map.
   */
  async _writeTruncationSummaryFromJsonl(runId, jsonlPath) {
    const csvPath = path.join(this.logDir, `truncation_summary_${runId}.csv`);
    let fd = null;
    let rowCount = 0;
    try {
      fd = fs.openSync(csvPath, "w");
      fs.writeSync(
        fd,
        "issueKey,dcKey,descriptionTruncated,commentTruncationCount,totalCommentCount,fileCount,totalBytes,status,error\n",
      );
      if (jsonlPath && fs.existsSync(jsonlPath)) {
        const readline = require("readline");
        const rl = readline.createInterface({
          input: fs.createReadStream(jsonlPath, { encoding: "utf-8" }),
          crlfDelay: Infinity,
        });
        for await (const line of rl) {
          if (!line.trim()) continue;
          let data;
          try { data = JSON.parse(line); } catch { continue; }
          const key = data.key || "";
          const totalBytes = (data.files || []).reduce((s, f) => s + (f.size || 0), 0);
          const err = (data.error || "").replace(/[",\n]/g, " ");
          fs.writeSync(
            fd,
            `${key},${data.dcKey || ""},${data.descriptionTruncated ? 1 : 0},${data.commentTruncationCount || 0},${data.totalCommentCount || 0},${(data.files || []).length},${totalBytes},${data.status},${err}\n`,
          );
          rowCount++;
        }
      }
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
    if (this.planManager.masterIndex) {
      this.planManager.masterIndex.truncationSummaryCsv = csvPath;
      this.planManager.saveMasterIndex();
    }
    this.log(`  Truncation summary CSV: ${csvPath} (${rowCount} rows)`);
  }

  // ─────────────────────────────────────────────────
  //  PHASE 2: APPLY PLAN (upload docx as Cloud attachments)
  // ─────────────────────────────────────────────────

  async applyPlan() {
    const todo = this.planManager.getIssuesToProcess(this.retryFailed);
    if (todo.length === 0) {
      this.log("  No pending issues to apply.");
      return;
    }

    if (!this.runId) {
      const mf = this.planManager.masterIndexPath || "";
      const m = mf.match(/master_(\d+)\.json/);
      this.runId = m ? m[1] : String(Date.now());
    }

    // Group todo by project key so we can mute/restore notifications
    // per-project. The plan only contains Cloud keys; project key is the prefix.
    const byProject = new Map();
    const fileCountByProject = new Map();
    for (const entry of todo) {
      const [issueKey, data] = entry;
      const proj = (issueKey.split("-")[0] || "").toUpperCase();
      if (!byProject.has(proj)) byProject.set(proj, []);
      byProject.get(proj).push(entry);
      const n = Array.isArray(data && data.files) ? data.files.length : 0;
      fileCountByProject.set(proj, (fileCountByProject.get(proj) || 0) + n);
    }
    // Largest projects first — they account for most of the throughput and
    // surface failures earliest. Ties broken alphabetically for stability.
    const projectKeys = [...byProject.keys()].sort((a, b) => {
      const fa = fileCountByProject.get(a) || 0;
      const fb = fileCountByProject.get(b) || 0;
      if (fa !== fb) return fb - fa;
      return a.localeCompare(b);
    });
    this.log(
      `  Applying across ${projectKeys.length} project(s), ${todo.length} issue(s) total, concurrency=${this.concurrency}`,
    );
    this.log(`  Project order (by attachment count, desc):`);
    for (const pk of projectKeys.slice(0, 10)) {
      this.log(
        `    ${pk.padEnd(14)} issues=${String(byProject.get(pk).length).padStart(5)}  files=${String(fileCountByProject.get(pk) || 0).padStart(6)}`,
      );
    }
    if (projectKeys.length > 10) {
      this.log(`    ... and ${projectKeys.length - 10} more`);
    }
    if (this.dryRun) this.log("  *** DRY RUN: no uploads will be performed ***");
    if (this.muter && !this.muteNotifications) {
      this.log("  *** Notifications NOT being suppressed (--no-mute-notifications) ***");
    }

    let totalCompleted = 0;
    for (const projectKey of projectKeys) {
      const projTodo = byProject.get(projectKey);
      this.log(
        `\n  [project ${projectKey}] starting (${projTodo.length} issue(s))`,
      );

      // Mute notifications for this project (skip in dry-run; respect opt-out)
      let muted = false;
      if (this.muter && this.muteNotifications && !this.dryRun) {
        muted = await this.muter.muteProject(projectKey);
        if (!muted) {
          this.log(
            `  [project ${projectKey}] WARN: could not mute notifications — proceeding anyway (users may receive emails)`,
          );
        }
      }

      // Process all this project's issues via worker pool
      let idx = 0;
      let completed = 0;
      const worker = async () => {
        while (idx < projTodo.length) {
          const current = idx++;
          const [issueKey, data] = projTodo[current];
          try {
            await this._applyIssue(issueKey, data);
          } catch (err) {
            this.log(`    UNEXPECTED ERROR on ${issueKey}: ${err.message}`);
            this.planManager.updateIssueStatus(issueKey, "failed", err.message);
            this.stats.issuesFailed++;
          }
          completed++;
          totalCompleted++;
          if (completed % 25 === 0 || completed === projTodo.length) {
            this.log(
              `    [${projectKey}] progress: ${completed}/${projTodo.length} (uploaded: ${this.stats.uploadsSucceeded}, failed: ${this.stats.uploadsFailed})`,
            );
            if (!this.dryRun) this.planManager.savePlan();
          }
        }
      };

      try {
        const workers = [];
        for (let i = 0; i < Math.min(this.concurrency, projTodo.length); i++) {
          workers.push(worker());
        }
        await Promise.all(workers);
      } finally {
        // Always restore notifications, even on error mid-project
        if (muted) {
          const ok = await this.muter.restoreProject(projectKey);
          if (!ok) {
            this.log(
              `  [project ${projectKey}] WARN: notification restore FAILED — run with --restore-only to retry`,
            );
          }
        }
      }

      this.log(
        `  [project ${projectKey}] done — totalCompleted=${totalCompleted}/${todo.length}`,
      );
    }

    if (!this.dryRun) this.planManager.savePlan();

    if (this.planManager.masterIndex) {
      Object.assign(this.planManager.masterIndex.stats, {
        uploadsAttempted: this.stats.uploadsAttempted,
        uploadsSucceeded: this.stats.uploadsSucceeded,
        uploadsFailed: this.stats.uploadsFailed,
      });
      this.planManager.saveMasterIndex();
    }
  }

  async _applyIssue(issueKey, data) {
    // Preflight: confirm issue still exists in Cloud
    let exists;
    try {
      exists = await this.cloudClient.verifyIssueExists(issueKey);
    } catch (e) {
      this.log(`    [${issueKey}] preflight error: ${e.message}`);
      if (!this.dryRun) {
        this.planManager.updateIssueStatus(issueKey, "failed", `preflight: ${e.message}`);
      }
      this.stats.issuesFailed++;
      return;
    }
    if (!exists) {
      this.log(`    [${issueKey}] not found in Cloud — skipping`);
      if (!this.dryRun) {
        this.planManager.updateIssueStatus(issueKey, "skipped", "cloud-issue-not-found");
      }
      this.stats.issuesSkipped++;
      return;
    }

    // Permission check (cached per project)
    const projectKey = issueKey.split("-")[0];
    const perms = await this.cloudClient.verifyEditPermission(projectKey);
    if (!perms.CREATE_ATTACHMENTS) {
      this.log(`    [${issueKey}] no CREATE_ATTACHMENTS on ${projectKey} — skipping`);
      this.stats.uploadsSkippedNoPermission += (data.files || []).filter(
        (f) => f.uploadStatus === "pending",
      ).length;
      if (!this.dryRun) {
        this.planManager.updateIssueStatus(
          issueKey,
          "skipped",
          `no CREATE_ATTACHMENTS on ${projectKey}`,
        );
      }
      this.stats.issuesSkipped++;
      return;
    }

    const files = Array.isArray(data.files) ? data.files : [];
    let uploaded = 0;
    let failed = 0;

    for (const file of files) {
      if (file.uploadStatus !== "pending") continue;

      if (!fs.existsSync(file.path)) {
        file.uploadStatus = "failed";
        file.error = "docx file missing on disk";
        failed++;
        this.stats.uploadsFailed++;
        this.log(`    [${issueKey}] missing file: ${file.path}`);
        continue;
      }

      if (this.dryRun) {
        this.log(
          `    [dry-run] [${issueKey}] would upload ${path.basename(file.path)} (${file.size}B)`,
        );
        continue;
      }

      file.attempts = (file.attempts || 0) + 1;
      this.stats.uploadsAttempted++;

      const filename = path.basename(file.path);
      try {
        const result = await this.cloudClient.uploadAttachment(
          issueKey,
          file.path,
          filename,
          DOCX_MIME,
        );
        if (result.success) {
          const newId =
            Array.isArray(result.response) && result.response[0]
              ? result.response[0].id
              : null;
          file.uploadStatus = "uploaded";
          file.cloudAttachmentId = newId;
          file.error = null;
          uploaded++;
          this.stats.uploadsSucceeded++;
        } else {
          if (result.statusCode === 413) {
            file.uploadStatus = "skipped-too-large";
            file.error = `upload 413: ${result.error}`;
            this.log(`    [${issueKey}] FAIL 413 ${filename}: ${result.error}`);
          } else {
            file.uploadStatus = "failed";
            file.error = `upload: ${result.error}`;
            failed++;
            this.stats.uploadsFailed++;
            this.log(`    [${issueKey}] FAIL ${filename}: ${result.error}`);
          }
        }
      } catch (e) {
        file.uploadStatus = "failed";
        file.error = `upload: ${e.message}`;
        failed++;
        this.stats.uploadsFailed++;
        this.log(`    [${issueKey}] FAIL ${filename}: ${e.message}`);
      }
    }

    // Roll up issue status
    if (this.dryRun) return;
    const anyPendingLeft = files.some((f) => f.uploadStatus === "pending");
    let newStatus;
    if (failed > 0 && uploaded === 0) {
      newStatus = "failed";
      this.stats.issuesFailed++;
    } else if (failed > 0 && uploaded > 0) {
      newStatus = "partial";
      this.stats.issuesPartial++;
    } else if (anyPendingLeft) {
      newStatus = "pending";
    } else {
      newStatus = "completed";
      this.stats.issuesCompleted++;
    }

    this.planManager.plan.issues[issueKey].files = files;
    this.planManager.updateIssueStatus(
      issueKey,
      newStatus,
      failed > 0 ? `${failed} file(s) failed` : null,
    );
  }
}

module.exports = RecoveryProcessor;
