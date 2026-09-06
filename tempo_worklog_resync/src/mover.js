/**
 * Phase 2: Move worklogs from a source issue to a destination (archive) issue.
 *
 * For each worklog on the source:
 *   1. POST /worklog on destination with original timeSpent, started, comment
 *   2. On success: DELETE /worklog/{id} from source
 *
 * Caveats (documented so future-you doesn't re-discover):
 * - New worklogs are attributed to the API caller, NOT the original author
 * - Original timestamps (started) ARE preserved in the request body
 * - Worklog IDs change; any automation referencing them will break
 * - Tempo time-accounting entries linked to these worklogs may lose sync
 */

const fs = require("fs");
const path = require("path");
const { toADF, adfToPlainText } = require("./jiraClient");

class Mover {
  constructor(client, options = {}) {
    this.client = client;
    this.dryRun = options.dryRun || false;
    this.keepSource = options.keepSource || false;
    this.moveCount = options.moveCount || 0; // how many oldest to move (0 = all)
    this.delayMs = options.delayMs || 500; // throttle between individual worklog ops

    this.logDir = path.join(__dirname, "..", "logs");
    if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    this.planFile = path.join(this.logDir, `move_${ts}.jsonl`);

    // counters
    this.created = 0;
    this.deleted = 0;
    this.failed = 0;
  }

  /** Sleep utility */
  _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /** Append one JSONL line to the plan log */
  _writeLine(obj) {
    fs.appendFileSync(this.planFile, JSON.stringify(obj) + "\n");
  }

  /**
   * Move worklogs from source to destination.
   * @param {string} srcKey - source issue key
   * @param {string} dstKey - destination (archive) issue key
   */
  async move(srcKey, dstKey) {
    // Verify source exists. Skip destination verification in dry-run because the
    // archive may be a placeholder ("PROJ-NEW-ARCHIVE") that hasn't been created.
    await this.client.getIssue(srcKey);
    if (!this.dryRun) {
      try {
        await this.client.getIssue(dstKey);
      } catch (err) {
        if (err.statusCode === 404) throw new Error(`Destination issue ${dstKey} not found. Create it first.`);
        throw err;
      }
    }

    console.log(`\nFetching worklogs from ${srcKey}...`);
    const allWorklogs = await this.client.getWorklogs(srcKey);
    console.log(`${srcKey} has ${allWorklogs.length} worklog(s)`);

    if (this.moveCount > 0 && this.moveCount < allWorklogs.length) {
      // Sort by started ascending (oldest first), take only the requested number
      const sorted = [...allWorklogs].sort((a, b) => (a.started || "").localeCompare(b.started || ""));
      return this._process(sorted.slice(0, this.moveCount), srcKey, dstKey);
    }

    // Default: move all, oldest first
    const sorted = [...allWorklogs].sort((a, b) => (a.started || "").localeCompare(b.started || ""));
    return this._process(sorted, srcKey, dstKey);
  }

  /**
   * Process a list of worklogs: create on dest, delete from source.
   */
  async _process(worklogs, srcKey, dstKey) {
    console.log(`\nMoving ${worklogs.length} worklog(s) from ${srcKey} → ${dstKey}${this.dryRun ? " (DRY RUN)" : ""}${this.keepSource ? " (keeping source)" : ""}\n`);

    // Per-call counters so totals reported back are this issue's, not cumulative
    let created = 0, deleted = 0, failed = 0;
    const failures = [];

    for (let i = 0; i < worklogs.length; i++) {
      const wl = worklogs[i];
      const num = `${i + 1}/${worklogs.length}`;
      const id = wl.id;
      const started = wl.started || "(no date)";
      const spent = wl.timeSpent || `( ${wl.timeSpentSeconds}s )`;
      const originalCommentText = adfToPlainText(wl.comment).slice(0, 200);

      const originalAuthor = wl.author?.displayName || "unknown";
      const newCommentText = `[migrated from ${srcKey}, orig: ${originalAuthor}]${originalCommentText ? " " + originalCommentText : ""}`.trim();

      const body = {
        started: wl.started, // preserve original date
        comment: toADF(newCommentText),
      };
      if (wl.timeSpent) body.timeSpent = wl.timeSpent;
      else if (wl.timeSpentSeconds) body.timeSpentSeconds = wl.timeSpentSeconds;
      // Carry Tempo properties (and any other worklog properties) so the new
      // worklog stays linked to its Tempo time-tracking record.
      if (Array.isArray(wl.properties) && wl.properties.length > 0) {
        body.properties = wl.properties;
      }
      if (wl.visibility) body.visibility = wl.visibility;

      // Step 1: Create on destination
      let ok = false;
      try {
        if (this.dryRun) {
          console.log(`  ${num} [DRY] Would CREATE worklog on ${dstKey}: ${started} ${spent} by ${originalAuthor}`);
          this._writeLine({ action: "would_create", src: srcKey, dst: dstKey, origId: id, started: wl.started, timeSpent: wl.timeSpent || `${wl.timeSpentSeconds || 0}s`, author: originalAuthor, comment: newCommentText });
          ok = true;
        } else {
          const createdRes = await this.client.createWorklog(dstKey, body);
          console.log(`  ${num} CREATED on ${dstKey}: ${started} ${spent} (new id=${createdRes.id})`);
          created++;
          ok = true;
          this._writeLine({ action: "create", src: srcKey, dst: dstKey, origId: id, newId: createdRes.id, started: wl.started, timeSpent: wl.timeSpent || `${wl.timeSpentSeconds || 0}s`, author: originalAuthor });
        }
      } catch (err) {
        console.log(`  ${num} FAILED to create on ${dstKey}: ${err.message.slice(0, 200)}`);
        failed++;
        failures.push({ worklogId: id, started, timeSpent: spent, error: err.message });
        this._writeLine({ action: "create_failed", src: srcKey, dst: dstKey, origId: id, error: err.message });
      }

      // Step 2: Delete from source (only if create succeeded and not keeping source)
      if (ok && !this.keepSource) {
        try {
          if (this.dryRun) {
            console.log(`       [DRY] Would DELETE worklog ${id} from ${srcKey}`);
            this._writeLine({ action: "would_delete", issue: srcKey, worklogId: id });
          } else {
            await this.client.deleteWorklog(srcKey, id);
            console.log(`       DELETED from ${srcKey} (id=${id})`);
            deleted++;
            this._writeLine({ action: "delete", issue: srcKey, worklogId: id });
          }
        } catch (err) {
          // Delete failure is non-fatal; the worklog exists on dest at least
          console.log(`       FAILED to delete from ${srcKey}: ${err.message.slice(0, 200)}`);
          failed++;
          failures.push({ worklogId: id, error: `delete: ${err.message}` });
          this._writeLine({ action: "delete_failed", issue: srcKey, worklogId: id, error: err.message });
        }
      }

      // Throttle to avoid rate limiting
      if (i + 1 < worklogs.length && !this.dryRun) {
        await this._sleep(this.delayMs);
      }
    }

    // Bump cumulative totals on the instance for aggregate logging
    this.created += created;
    this.deleted += deleted;
    this.failed += failed;

    return { created, deleted, failed, failures, planFile: this.planFile };
  }

  /**
   * Server-side bulk move via Atlassian's Bulk Move Worklog API (Aug 2024).
   * Preserves worklog IDs and all fields (author, comment, properties) — the right
   * path for Tempo-shadowed worklogs since the tempo_id link survives.
   */
  async bulkMove(srcKey, dstKey) {
    await this.client.getIssue(srcKey);
    if (!this.dryRun) {
      try {
        await this.client.getIssue(dstKey);
      } catch (err) {
        if (err.statusCode === 404) throw new Error(`Destination issue ${dstKey} not found. Create it first.`);
        throw err;
      }
    }

    console.log(`\nFetching worklogs from ${srcKey}...`);
    const allWorklogs = await this.client.getWorklogs(srcKey);
    console.log(`${srcKey} has ${allWorklogs.length} worklog(s)`);

    const sorted = [...allWorklogs].sort((a, b) => (a.started || "").localeCompare(b.started || ""));
    const toMove = this.moveCount > 0 && this.moveCount < sorted.length ? sorted.slice(0, this.moveCount) : sorted;
    const ids = toMove.map((w) => String(w.id));

    if (ids.length === 0) {
      console.log(`Nothing to move from ${srcKey}`);
      return { created: 0, deleted: 0, moved: 0, failed: 0, failures: [], planFile: this.planFile };
    }
    if (ids.length > 5000) {
      throw new Error(`${ids.length} worklogs > Atlassian Bulk Move 5000-per-call cap. Reduce --move-count.`);
    }

    console.log(`\nBulk-moving ${ids.length} worklog(s) from ${srcKey} → ${dstKey}${this.dryRun ? " (DRY RUN)" : ""}`);
    console.log(`  oldest in scope:        ${toMove[0]?.started}`);
    console.log(`  newest in scope (#${ids.length}): ${toMove[toMove.length - 1]?.started}`);

    // Plan log: one line per worklog ID so audit trail is identical to per-worklog mode
    for (const wl of toMove) {
      this._writeLine({
        action: this.dryRun ? "would_bulk_move" : "bulk_move",
        src: srcKey,
        dst: dstKey,
        origId: wl.id,
        started: wl.started,
        timeSpent: wl.timeSpent || `${wl.timeSpentSeconds || 0}s`,
        author: wl.author?.displayName || "unknown",
      });
    }

    if (this.dryRun) {
      console.log(`\n  [DRY] Would POST /rest/api/3/issue/${srcKey}/worklog/move with ${ids.length} IDs → ${dstKey}`);
      console.log(`  [DRY] No API call made. Worklog IDs would be preserved (server-side move).`);
      return { created: 0, deleted: 0, moved: 0, failed: 0, failures: [], planFile: this.planFile };
    }

    try {
      const res = await this.client.bulkMoveWorklogs(srcKey, dstKey, ids);
      const movedCount = ids.length;
      console.log(`  Bulk move accepted. Response: ${res ? JSON.stringify(res).slice(0, 300) : "(204 no content)"}`);
      console.log(`  ${movedCount} worklog(s) now on ${dstKey} (IDs preserved).`);
      this.created += movedCount;
      this.deleted += movedCount;
      // Plan log: completion line
      this._writeLine({ action: "bulk_move_done", src: srcKey, dst: dstKey, count: movedCount });
      return { created: movedCount, deleted: movedCount, moved: movedCount, failed: 0, failures: [], planFile: this.planFile };
    } catch (err) {
      console.error(`  Bulk move FAILED: ${err.message}`);
      this._writeLine({ action: "bulk_move_failed", src: srcKey, dst: dstKey, count: ids.length, error: err.message });
      return { created: 0, deleted: 0, moved: 0, failed: ids.length, failures: [{ error: err.message }], planFile: this.planFile };
    }
  }

  /**
   * Move worklogs from multiple source issues to a single destination.
   * @param {Array<{key, summary}>} sources - list of issues to move from
   * @param {string} dstKey - archive issue key
   */
  async moveMany(sources, dstKey) {
    console.log(`\nMoving worklogs from ${sources.length} issue(s) → ${dstKey}\n`);

    const summary = [];
    for (const src of sources) {
      this.created = 0;
      this.deleted = 0;
      this.failed = 0;
      try {
        const result = await this.move(src.key, dstKey);
        summary.push({ issue: src.key, ...result });
      } catch (err) {
        console.log(`\nSkipping ${src.key}: ${err.message}`);
        summary.push({ issue: src.key, error: err.message });
      }
    }

    return summary;
  }
}

module.exports = Mover;
