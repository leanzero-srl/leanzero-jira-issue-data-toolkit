const fs = require("fs");
const path = require("path");

/**
 * Project-by-project notification muting for bulk Cloud writes.
 *
 * Background: each attachment upload (or issue update / parent set) triggers
 * the "Issue Updated" notification event. With thousands of operations across
 * a project, that's thousands of emails to watchers. Atlassian provides no
 * per-call `notifyUsers=false` for these endpoints, so the only supported
 * workaround is to clone the project's current notification scheme, mute the
 * "Issue Updated" event in the clone, assign the clone to the project for the
 * duration of the bulk operation, then restore the original scheme and delete
 * the clone.
 *
 * This class manages the clone/mute/assign/restore lifecycle. Snapshots are
 * persisted to disk so a crashed run can be recovered with --restore-only:
 *
 *   const muter = new NotificationMuter(cloudClient, snapshotDir, log);
 *   await muter.initialize();
 *   try {
 *     await muter.muteProject('PROJ');
 *     // ... bulk work ...
 *   } finally {
 *     await muter.restoreProject('PROJ');
 *   }
 *
 * Or to recover from a prior crash:
 *   await muter.restoreAllFromSnapshot();
 */

const MUTED_EVENT_NAMES = ["Issue Updated"]; // default
const SNAPSHOT_FILENAME = "notification_snapshots.jsonl";

class NotificationMuter {
  constructor(cloudClient, snapshotDir, log) {
    this.cloud = cloudClient;
    this.snapshotDir = snapshotDir;
    this.log = log || console.log;
    this.snapshotPath = path.join(snapshotDir, SNAPSHOT_FILENAME);
    this.snapshots = new Map(); // projectKey -> { originalSchemeId, tempSchemeId, mutedEventIds, createdAt }
    this.dryRun = false;
    this.eventNameToId = null; // populated by initialize()
    this.targetEventNames = new Set(MUTED_EVENT_NAMES);
  }

  setDryRun(v) {
    this.dryRun = !!v;
  }

  setTargetEvents(names) {
    if (Array.isArray(names) && names.length > 0) {
      this.targetEventNames = new Set(names);
    }
  }

  /**
   * Load any prior snapshots from disk and learn the global event-name -> id
   * mapping. Safe to call before the muter is needed (no Cloud writes).
   */
  async initialize() {
    fs.mkdirSync(this.snapshotDir, { recursive: true });
    this._loadSnapshots();
    if (this.snapshots.size > 0) {
      this.log(
        `  [muter] Loaded ${this.snapshots.size} prior snapshot(s) from ${this.snapshotPath}`,
      );
    }
  }

  /**
   * Discover the numeric event ID for each target event NAME by inspecting a
   * scheme. Event IDs are instance-specific so we must read them from the
   * site itself rather than hard-code "2" for Issue Updated.
   * Given a scheme that has the events configured, find the IDs.
   */
  async _discoverEventIdsFromScheme(schemeId) {
    if (this.eventNameToId) return this.eventNameToId;
    const scheme = await this.cloud.getNotificationScheme(schemeId);
    const events = scheme.notificationSchemeEvents || [];
    const map = new Map();
    for (const ne of events) {
      const ev = ne.event || {};
      if (ev.name && ev.id != null) map.set(ev.name, String(ev.id));
    }
    this.eventNameToId = map;
    this.log(
      `  [muter] Discovered ${map.size} event IDs from scheme ${schemeId}`,
    );
    for (const n of this.targetEventNames) {
      if (!map.has(n)) {
        this.log(
          `  [muter] WARN: event "${n}" not found in scheme ${schemeId} — will skip muting it`,
        );
      }
    }
    return map;
  }

  /**
   * Mute notifications for the configured target events on the given project.
   * Idempotent — if the project is already muted (snapshot exists), this is
   * a no-op and a one-line log.
   *
   * Returns true if muting was applied (or already in place), false on error.
   */
  async muteProject(projectKey) {
    if (this.snapshots.has(projectKey)) {
      this.log(`  [muter] ${projectKey} already muted (snapshot present), skipping`);
      return true;
    }

    if (this.dryRun) {
      this.log(`  [muter] [dry-run] would mute ${projectKey} (no API calls)`);
      return true;
    }

    let originalScheme;
    try {
      originalScheme = await this.cloud.getProjectNotificationScheme(projectKey);
    } catch (e) {
      this.log(`  [muter] ${projectKey}: GET scheme FAILED: ${e.message}`);
      return false;
    }
    if (!originalScheme || originalScheme.id == null) {
      this.log(`  [muter] ${projectKey}: project has no notification scheme; nothing to mute`);
      return false;
    }
    const originalSchemeId = String(originalScheme.id);

    let fullScheme;
    try {
      fullScheme = await this.cloud.getNotificationScheme(originalSchemeId);
    } catch (e) {
      this.log(`  [muter] ${projectKey}: GET full scheme ${originalSchemeId} FAILED: ${e.message}`);
      return false;
    }

    // Cache event-name -> id lookup from this scheme if not already known
    if (!this.eventNameToId) {
      await this._discoverEventIdsFromScheme(originalSchemeId);
    }
    const targetEventIds = new Set();
    for (const n of this.targetEventNames) {
      const id = this.eventNameToId?.get(n);
      if (id) targetEventIds.add(id);
    }
    if (targetEventIds.size === 0) {
      this.log(
        `  [muter] ${projectKey}: no target events resolved (looked for: ${[...this.targetEventNames].join(", ")}); skipping`,
      );
      return false;
    }

    // Build the new scheme payload: copy all events EXCEPT muted targets.
    // Cloud's POST /notificationscheme rejects events with empty notifications
    // arrays ("The notifications array has to be provided."), so we OMIT muted
    // events from the new scheme entirely. An omitted event triggers no
    // notifications — same effect as an empty recipients list.
    // We also drop any non-muted event whose notifications list happens to be
    // empty on the source scheme (same API constraint).
    const baseEvents = fullScheme.notificationSchemeEvents || [];
    const newEvents = [];
    for (const ne of baseEvents) {
      const evId = String(ne.event?.id ?? "");
      if (!evId) continue;
      if (targetEventIds.has(evId)) continue; // muted — omit
      const copied = (ne.notifications || []).map((n) => {
        const out = { notificationType: n.notificationType || n.type };
        if (n.parameter != null) out.parameter = n.parameter;
        if (n.user?.accountId) out.parameter = n.user.accountId;
        if (n.group?.groupId) out.parameter = n.group.groupId;
        if (n.projectRole?.id) out.parameter = String(n.projectRole.id);
        if (n.field?.id) out.parameter = n.field.id;
        return out;
      }).filter((n) => n.notificationType);
      if (copied.length === 0) continue; // can't post empty notifications array
      newEvents.push({ event: { id: evId }, notifications: copied });
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
    const cloneName = `(muted-${ts}) ${(originalScheme.name || "scheme").substring(0, 60)}`;
    const cloneDescription = `Auto-created by recover_truncated_content / sync_* on ${ts} to suppress "${[...this.targetEventNames].join(", ")}" notifications for ${projectKey}. Original scheme: ${originalSchemeId}. Safe to delete if abandoned.`;

    let tempSchemeId;
    try {
      const created = await this.cloud.createNotificationScheme({
        name: cloneName,
        description: cloneDescription,
        notificationSchemeEvents: newEvents,
      });
      tempSchemeId = String(created.id);
    } catch (e) {
      this.log(`  [muter] ${projectKey}: CREATE clone scheme FAILED: ${e.message}`);
      return false;
    }

    try {
      await this.cloud.setProjectNotificationScheme(projectKey, tempSchemeId);
    } catch (e) {
      this.log(`  [muter] ${projectKey}: ASSIGN clone scheme ${tempSchemeId} FAILED: ${e.message}`);
      // Try to clean up the orphan clone
      try {
        await this.cloud.deleteNotificationScheme(tempSchemeId);
      } catch { /* ignore */ }
      return false;
    }

    const snapshot = {
      projectKey,
      originalSchemeId,
      originalSchemeName: originalScheme.name || null,
      tempSchemeId,
      tempSchemeName: cloneName,
      mutedEventIds: [...targetEventIds],
      mutedEventNames: [...this.targetEventNames],
      createdAt: new Date().toISOString(),
    };
    this.snapshots.set(projectKey, snapshot);
    this._appendSnapshot(snapshot);
    this.log(
      `  [muter] ${projectKey}: muted (original=${originalSchemeId} "${originalScheme.name}", clone=${tempSchemeId})`,
    );
    return true;
  }

  /**
   * Restore the project's original scheme and delete the temporary clone.
   * Idempotent — safe to call even if the project was never muted.
   */
  async restoreProject(projectKey) {
    const snap = this.snapshots.get(projectKey);
    if (!snap) {
      this.log(`  [muter] ${projectKey}: no snapshot to restore, skipping`);
      return true;
    }

    if (this.dryRun) {
      this.log(`  [muter] [dry-run] would restore ${projectKey} (no API calls)`);
      return true;
    }

    let restored = false;
    try {
      await this.cloud.setProjectNotificationScheme(projectKey, snap.originalSchemeId);
      restored = true;
      this.log(
        `  [muter] ${projectKey}: restored original scheme ${snap.originalSchemeId} "${snap.originalSchemeName}"`,
      );
    } catch (e) {
      this.log(
        `  [muter] ${projectKey}: RESTORE FAILED — original=${snap.originalSchemeId}: ${e.message}`,
      );
      // Don't delete the clone if restore failed — we still need it active
      return false;
    }

    try {
      await this.cloud.deleteNotificationScheme(snap.tempSchemeId);
      this.log(`  [muter] ${projectKey}: deleted clone ${snap.tempSchemeId}`);
    } catch (e) {
      this.log(
        `  [muter] ${projectKey}: WARN clone ${snap.tempSchemeId} not deleted: ${e.message} — clean up manually`,
      );
    }

    this.snapshots.delete(projectKey);
    this._rewriteSnapshots();
    return restored;
  }

  /**
   * Restore every snapshot currently on disk. Used by --restore-only after a
   * crash to bring projects back to their original schemes without doing any
   * of the original work.
   */
  async restoreAllFromSnapshot() {
    if (this.snapshots.size === 0) {
      this.log("  [muter] no snapshots to restore");
      return { restored: 0, failed: 0 };
    }
    this.log(`  [muter] restoring ${this.snapshots.size} snapshot(s)...`);
    let restored = 0;
    let failed = 0;
    for (const projectKey of [...this.snapshots.keys()]) {
      const ok = await this.restoreProject(projectKey);
      if (ok) restored++;
      else failed++;
    }
    return { restored, failed };
  }

  // ─────────────────────────────────────────────────
  //  SNAPSHOT PERSISTENCE
  // ─────────────────────────────────────────────────

  _loadSnapshots() {
    if (!fs.existsSync(this.snapshotPath)) return;
    const data = fs.readFileSync(this.snapshotPath, "utf8");
    for (const line of data.split("\n")) {
      if (!line.trim()) continue;
      try {
        const snap = JSON.parse(line);
        if (snap.projectKey) this.snapshots.set(snap.projectKey, snap);
      } catch { /* skip malformed */ }
    }
  }

  _appendSnapshot(snap) {
    fs.appendFileSync(this.snapshotPath, JSON.stringify(snap) + "\n");
  }

  _rewriteSnapshots() {
    // Snapshot file is append-only by default; on restore we rewrite to drop
    // the restored entry. Simple rewrite is fine — file is small.
    const lines = [];
    for (const snap of this.snapshots.values()) {
      lines.push(JSON.stringify(snap));
    }
    fs.writeFileSync(this.snapshotPath, lines.length > 0 ? lines.join("\n") + "\n" : "");
  }

  hasSnapshotFor(projectKey) {
    return this.snapshots.has(projectKey);
  }

  pendingSnapshotCount() {
    return this.snapshots.size;
  }
}

module.exports = NotificationMuter;
