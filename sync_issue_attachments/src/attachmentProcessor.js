const fs = require("fs");
const path = require("path");

const SAFE_FILENAME_RE = /[\/\\\x00-\x1f"<>:|?*]/g;

function sanitizeForDisk(name) {
  return String(name || "file").replace(SAFE_FILENAME_RE, "_").slice(0, 200);
}

function fingerprint(filename, size) {
  return `${filename}::${size == null ? "?" : size}`;
}

class AttachmentProcessor {
  constructor(dcClient, cloudClient, planManager, options = {}) {
    this.dcClient = dcClient;
    this.cloudClient = cloudClient;
    this.planManager = planManager;

    this.dryRun = options.dryRun || false;
    this.limit = options.limit || 0;
    this.concurrency = options.concurrency || 3;
    this.retryFailed = options.retryFailed || false;
    this.jql = options.jql || null;
    this.maxBytesOverride = options.maxBytes || 0;
    this.keepTemp = options.keepTemp || false;
    this.log = options.log || console.log;
    this.logDir = options.logDir;
    this.muter = options.muter || null;
    this.muteNotifications = options.muteNotifications !== false;

    this.stats = {
      cloudIssuesScanned: 0,
      issuesWithUploads: 0,
      issuesSkippedAllPresent: 0,
      issuesSkippedNoDcAttachments: 0,
      issuesSkippedDcLookupFailed: 0,
      issuesCompleted: 0,
      issuesPartial: 0,
      issuesFailed: 0,
      attachmentsToUpload: 0,
      attachmentsUploaded: 0,
      attachmentsAlreadyPresent: 0,
      attachmentsTooLarge: 0,
      attachmentsFailed: 0,
      bytesDownloaded: 0,
      bytesUploaded: 0,
    };

    this.runId = null;
    this.tmpDir = null;
    this.maxAttachmentSize = null;
  }

  getStats() {
    return { ...this.stats };
  }

  // ─────────────────────────────────────────────────
  //  PHASE 1: BUILD PLAN
  // ─────────────────────────────────────────────────

  async buildPlan(runId) {
    this.runId = runId;
    if (!this.jql) throw new Error("buildPlan requires options.jql");

    // Resolve Cloud max attachment size (cached on client)
    try {
      const cfg = await this.cloudClient.getConfiguration();
      this.maxAttachmentSize =
        this.maxBytesOverride > 0
          ? this.maxBytesOverride
          : cfg.attachmentsEnabled === false
          ? 0
          : typeof cfg.maxAttachmentSize === "number"
          ? cfg.maxAttachmentSize
          : null;
      if (this.maxAttachmentSize != null) {
        this.log(
          `  Cloud max attachment size: ${this.maxAttachmentSize} bytes${this.maxBytesOverride > 0 ? " (overridden by --max-bytes)" : ""}`,
        );
      }
      if (cfg.attachmentsEnabled === false) {
        this.log("  WARN: Cloud configuration reports attachmentsEnabled=false");
      }
    } catch (e) {
      this.log(`  WARN: could not fetch Cloud configuration: ${e.message}`);
    }

    this.log(`\n  Running Cloud JQL: ${this.jql}`);
    this.log(`  Requesting fields: attachment`);

    const cloudIssues = await this.cloudClient.searchIssues(
      this.jql,
      "attachment",
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
    const oversizeRows = [];
    let processed = 0;

    for (const issue of candidates) {
      processed++;
      if (processed % 50 === 0) {
        this.log(`  ...processed ${processed}/${candidates.length}`);
      }

      const issueKey = issue.key;
      // Cloud-side attachments come pre-loaded in the JQL response.
      const cloudAttachments = (issue.fields?.attachment || []).map((a) => ({
        filename: a.filename,
        size: typeof a.size === "number" ? a.size : null,
      }));
      // Prime cache
      this.cloudClient._attachmentCache.set(
        issueKey,
        cloudAttachments.map((a) => ({ ...a, id: null, mimeType: null })),
      );

      const cloudFps = new Set(
        cloudAttachments.map((a) => fingerprint(a.filename, a.size)),
      );

      // DC lookup
      const dcRes = await this.dcClient.getIssueAttachments(issueKey);
      if (dcRes.error) {
        issuesMap[issueKey] = {
          status: "skipped",
          skipReason: "dc-lookup-failed",
          error: dcRes.error,
          attachments: [],
        };
        this.stats.issuesSkippedDcLookupFailed++;
        continue;
      }

      const dcAttachments = dcRes.attachments || [];
      if (dcAttachments.length === 0) {
        issuesMap[issueKey] = {
          status: "skipped",
          skipReason: "no-dc-attachments",
          error: null,
          attachments: [],
        };
        this.stats.issuesSkippedNoDcAttachments++;
        continue;
      }

      // Decide per-attachment status
      const planAttachments = [];
      let anyPending = 0;
      let anyAlreadyPresent = 0;

      for (const a of dcAttachments) {
        const fp = fingerprint(a.filename, a.size);
        if (cloudFps.has(fp)) {
          planAttachments.push({
            dcId: a.id,
            filename: a.filename,
            size: a.size,
            mimeType: a.mimeType,
            contentUrl: a.content,
            status: "skipped-already-present",
            cloudAttachmentId: null,
            error: null,
            attempts: 0,
          });
          anyAlreadyPresent++;
          this.stats.attachmentsAlreadyPresent++;
          continue;
        }
        if (
          this.maxAttachmentSize != null &&
          a.size != null &&
          a.size > this.maxAttachmentSize
        ) {
          planAttachments.push({
            dcId: a.id,
            filename: a.filename,
            size: a.size,
            mimeType: a.mimeType,
            contentUrl: a.content,
            status: "skipped-too-large",
            cloudAttachmentId: null,
            error: `size ${a.size} > max ${this.maxAttachmentSize}`,
            attempts: 0,
          });
          this.stats.attachmentsTooLarge++;
          oversizeRows.push({
            issueKey,
            filename: a.filename,
            size: a.size,
            maxAllowed: this.maxAttachmentSize,
            detectedAt: new Date().toISOString(),
          });
          continue;
        }
        planAttachments.push({
          dcId: a.id,
          filename: a.filename,
          size: a.size,
          mimeType: a.mimeType,
          contentUrl: a.content,
          status: "pending",
          cloudAttachmentId: null,
          error: null,
          attempts: 0,
        });
        anyPending++;
        this.stats.attachmentsToUpload++;
      }

      const issueStatus = anyPending > 0 ? "pending" : "skipped";
      const skipReason =
        anyPending > 0
          ? null
          : anyAlreadyPresent === dcAttachments.length
          ? "all-already-present"
          : "no-uploadable-attachments";

      issuesMap[issueKey] = {
        status: issueStatus,
        skipReason,
        error: null,
        attachments: planAttachments,
      };

      if (issueStatus === "pending") {
        this.stats.issuesWithUploads++;
      } else if (skipReason === "all-already-present") {
        this.stats.issuesSkippedAllPresent++;
      }
    }

    this.planManager.createMasterIndex(runId, { jql: this.jql });
    this.planManager.createPlan(runId, issuesMap);

    this._writeMissingAttachmentsReport(runId, issuesMap);
    if (oversizeRows.length > 0) {
      this._writeOversizeReport(runId, oversizeRows);
    }

    this.log("");
    this.log(`  Plan summary:`);
    this.log(`    Cloud issues scanned:            ${this.stats.cloudIssuesScanned}`);
    this.log(`    Issues with uploads pending:     ${this.stats.issuesWithUploads}`);
    this.log(`    Issues all-present (skipped):    ${this.stats.issuesSkippedAllPresent}`);
    this.log(`    Issues no-DC-attachments (skip): ${this.stats.issuesSkippedNoDcAttachments}`);
    this.log(`    Issues DC lookup failed (skip):  ${this.stats.issuesSkippedDcLookupFailed}`);
    this.log(`    Attachments to upload:           ${this.stats.attachmentsToUpload}`);
    this.log(`    Attachments already-present:     ${this.stats.attachmentsAlreadyPresent}`);
    this.log(`    Attachments too-large (skipped): ${this.stats.attachmentsTooLarge}`);
  }

  _writeMissingAttachmentsReport(runId, issuesMap) {
    const csvPath = path.join(this.logDir, `missing_attachments_${runId}.csv`);
    const header = "issueKey,dcAttachmentCount,pendingCount,pendingTotalBytes\n";
    const rows = [];
    for (const [key, data] of Object.entries(issuesMap)) {
      if (data.status !== "pending") continue;
      const pending = data.attachments.filter((a) => a.status === "pending");
      const totalBytes = pending.reduce((s, a) => s + (a.size || 0), 0);
      rows.push(`${key},${data.attachments.length},${pending.length},${totalBytes}`);
    }
    fs.writeFileSync(csvPath, header + rows.join("\n") + (rows.length ? "\n" : ""));
    if (this.planManager.masterIndex) {
      this.planManager.masterIndex.missingAttachmentsCsv = csvPath;
      this.planManager.saveMasterIndex();
    }
    this.log(`  Missing-attachments report: ${rows.length} rows`);
    this.log(`    CSV: ${csvPath}`);
  }

  _writeOversizeReport(runId, rows) {
    const csvPath = path.join(this.logDir, `oversize_attachments_${runId}.csv`);
    const header = "issueKey,filename,size,maxAllowed,detectedAt\n";
    const lines = rows.map((r) => {
      const fn = /[",\n]/.test(r.filename)
        ? `"${r.filename.replace(/"/g, '""')}"`
        : r.filename;
      return `${r.issueKey},${fn},${r.size},${r.maxAllowed},${r.detectedAt}`;
    });
    fs.writeFileSync(csvPath, header + lines.join("\n") + (lines.length ? "\n" : ""));
    if (this.planManager.masterIndex) {
      this.planManager.masterIndex.oversizeAttachmentsCsv = csvPath;
      this.planManager.saveMasterIndex();
    }
    this.log(`  Oversize-attachments report: ${rows.length} rows`);
    this.log(`    CSV: ${csvPath}`);
  }

  // ─────────────────────────────────────────────────
  //  PHASE 2: EXECUTE PLAN
  // ─────────────────────────────────────────────────

  async executePlan() {
    const todo = this.planManager.getIssuesToProcess(this.retryFailed);
    if (todo.length === 0) {
      this.log("  No pending issues to execute.");
      return;
    }

    // Pull runId from the plan file path or master index
    if (!this.runId) {
      const mf = this.planManager.masterIndexPath || "";
      const m = mf.match(/master_(\d+)\.json/);
      this.runId = m ? m[1] : String(Date.now());
    }

    // Resolve cloud config (re-fetch if execute-only path skipped buildPlan)
    if (this.maxAttachmentSize == null) {
      try {
        const cfg = await this.cloudClient.getConfiguration();
        this.maxAttachmentSize =
          this.maxBytesOverride > 0
            ? this.maxBytesOverride
            : typeof cfg.maxAttachmentSize === "number"
            ? cfg.maxAttachmentSize
            : null;
      } catch {
        /* non-fatal */
      }
    }

    this.tmpDir = path.join(this.logDir, "tmp", this.runId);
    fs.mkdirSync(this.tmpDir, { recursive: true });
    this.log(`  Temp dir: ${this.tmpDir}`);

    // Group by project so we can mute/restore notifications around each
    // project's bulk uploads (avoids spamming watchers with "Issue Updated"
    // emails for thousands of attachments).
    const byProject = new Map();
    for (const entry of todo) {
      const [issueKey] = entry;
      const proj = (issueKey.split("-")[0] || "").toUpperCase();
      if (!byProject.has(proj)) byProject.set(proj, []);
      byProject.get(proj).push(entry);
    }
    const projectKeys = [...byProject.keys()].sort();
    this.log(
      `  Executing across ${projectKeys.length} project(s), ${todo.length} issue(s) total, concurrency=${this.concurrency}`,
    );
    if (this.dryRun) this.log("  *** DRY RUN: no downloads or uploads will be performed ***");
    if (this.muter && !this.muteNotifications) {
      this.log("  *** Notifications NOT being suppressed (--no-mute-notifications) ***");
    }

    let totalCompleted = 0;
    for (const projectKey of projectKeys) {
      const projTodo = byProject.get(projectKey);
      this.log(`\n  [project ${projectKey}] starting (${projTodo.length} issue(s))`);

      let muted = false;
      if (this.muter && this.muteNotifications && !this.dryRun) {
        muted = await this.muter.muteProject(projectKey);
        if (!muted) {
          this.log(
            `  [project ${projectKey}] WARN: could not mute notifications — proceeding anyway`,
          );
        }
      }

      let idx = 0;
      let completed = 0;
      const worker = async () => {
        while (idx < projTodo.length) {
          const current = idx++;
          const [issueKey, data] = projTodo[current];
          try {
            await this._processIssue(issueKey, data);
          } catch (err) {
            this.log(`    UNEXPECTED ERROR on ${issueKey}: ${err.message}`);
            this.planManager.updateIssueStatus(issueKey, "failed", err.message);
            this.stats.issuesFailed++;
          }
          completed++;
          totalCompleted++;
          if (completed % 25 === 0 || completed === projTodo.length) {
            this.log(
              `    [${projectKey}] progress: ${completed}/${projTodo.length} (uploaded: ${this.stats.attachmentsUploaded}, failed: ${this.stats.attachmentsFailed})`,
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
        if (muted) {
          const ok = await this.muter.restoreProject(projectKey);
          if (!ok) {
            this.log(
              `  [project ${projectKey}] WARN: restore FAILED — run with --restore-only to retry`,
            );
          }
        }
      }
      this.log(
        `  [project ${projectKey}] done — totalCompleted=${totalCompleted}/${todo.length}`,
      );
    }

    if (!this.dryRun) this.planManager.savePlan();

    // Cleanup tmpDir unless --keep-temp
    if (!this.keepTemp) {
      try {
        fs.rmSync(this.tmpDir, { recursive: true, force: true });
      } catch (e) {
        this.log(`  WARN: tmp cleanup failed: ${e.message}`);
      }
    } else {
      this.log(`  --keep-temp: leaving downloads in ${this.tmpDir}`);
    }
  }

  async _processIssue(issueKey, data) {
    // Preflight: refresh Cloud attachments (covers concurrent uploads between plan and exec)
    let freshCloud;
    try {
      this.cloudClient.invalidateAttachmentCache(issueKey);
      freshCloud = await this.cloudClient.listAttachments(issueKey);
    } catch (e) {
      if (e.statusCode === 404) {
        this.log(`    [preflight] ${issueKey}: not found in Cloud — skipping`);
        if (!this.dryRun) {
          this.planManager.updateIssueStatus(
            issueKey,
            "skipped",
            "cloud-issue-not-found-at-preflight",
          );
        }
        return;
      }
      throw e;
    }
    const freshFps = new Set(
      freshCloud.map((a) => fingerprint(a.filename, a.size)),
    );

    const attachments = Array.isArray(data.attachments) ? data.attachments : [];
    let uploaded = 0;
    let failed = 0;
    let skippedPresent = 0;

    for (const att of attachments) {
      if (att.status !== "pending") continue; // already-present, too-large, uploaded, etc. — leave as-is
      const fp = fingerprint(att.filename, att.size);
      if (freshFps.has(fp)) {
        att.status = "skipped-already-present";
        skippedPresent++;
        this.stats.attachmentsAlreadyPresent++;
        continue;
      }

      // Oversize re-check
      if (
        this.maxAttachmentSize != null &&
        att.size != null &&
        att.size > this.maxAttachmentSize
      ) {
        att.status = "skipped-too-large";
        att.error = `size ${att.size} > max ${this.maxAttachmentSize}`;
        this.stats.attachmentsTooLarge++;
        continue;
      }

      if (this.dryRun) {
        this.log(
          `    [dry-run] ${issueKey}: would download "${att.filename}" (${att.size ?? "?"} B) and upload to Cloud`,
        );
        // do NOT mark uploaded in dry-run — leaves the plan untouched
        continue;
      }

      const safeName = sanitizeForDisk(att.filename);
      const tempPath = path.join(
        this.tmpDir,
        `${issueKey}__${att.dcId}__${safeName}`,
      );

      att.attempts = (att.attempts || 0) + 1;

      // Download
      let dl;
      try {
        dl = await this.dcClient.downloadAttachmentToFile(
          att.contentUrl,
          tempPath,
        );
        this.stats.bytesDownloaded += dl.bytesWritten;
      } catch (e) {
        att.status = "failed";
        att.error = `download: ${e.message}`;
        failed++;
        this.stats.attachmentsFailed++;
        try {
          fs.unlinkSync(tempPath);
        } catch {
          /* file may not exist */
        }
        this.log(`    FAIL dl ${issueKey} "${att.filename}": ${e.message}`);
        continue;
      }

      // Upload
      try {
        const result = await this.cloudClient.uploadAttachment(
          issueKey,
          tempPath,
          att.filename,
          att.mimeType || dl.mimeType || "application/octet-stream",
        );
        if (result.success) {
          const newId = Array.isArray(result.response) && result.response[0]
            ? result.response[0].id
            : null;
          att.status = "uploaded";
          att.cloudAttachmentId = newId;
          att.error = null;
          uploaded++;
          this.stats.attachmentsUploaded++;
          this.stats.bytesUploaded += att.size || 0;
        } else {
          if (result.statusCode === 413) {
            att.status = "skipped-too-large";
            att.error = `upload 413: ${result.error}`;
            this.stats.attachmentsTooLarge++;
          } else {
            att.status = "failed";
            att.error = `upload: ${result.error}`;
            failed++;
            this.stats.attachmentsFailed++;
            this.log(
              `    FAIL up ${issueKey} "${att.filename}": ${result.error}`,
            );
          }
        }
      } catch (e) {
        att.status = "failed";
        att.error = `upload: ${e.message}`;
        failed++;
        this.stats.attachmentsFailed++;
        this.log(`    FAIL up ${issueKey} "${att.filename}": ${e.message}`);
      } finally {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          /* ignore */
        }
      }
    }

    // Roll up issue status
    const anyPendingLeft = attachments.some((a) => a.status === "pending");
    let newStatus;
    if (this.dryRun) {
      // Don't write any real status in dry-run — leave row as pending
      return;
    }
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

    this.planManager.plan.issues[issueKey].attachments = attachments;
    this.planManager.updateIssueStatus(
      issueKey,
      newStatus,
      failed > 0 ? `${failed} attachment(s) failed` : null,
    );
  }
}

module.exports = AttachmentProcessor;
