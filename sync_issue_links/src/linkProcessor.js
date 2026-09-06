const fs = require("fs");
const path = require("path");

/**
 * LinkProcessor — replicate issue-to-issue links from DC to Cloud.
 *
 * The unit of work is a canonical DIRECTED triple (typeName, outwardKey,
 * inwardKey), NOT an issue. A single physical link appears on BOTH endpoint
 * issues (once as an inwardIssue entry, once as an outwardIssue entry), so we
 * normalize every raw entry to the same triple and dedup globally — planning
 * each link exactly once regardless of how many scanned issues surface it.
 *
 * Cloud create semantics (verified against the REST docs):
 *   POST /rest/api/3/issueLink {type:{name}, outwardIssue:{key:O}, inwardIssue:{key:I}}
 *   renders as "O {type.outward} I". So a triple's outwardKey/inwardKey map
 *   directly onto the POST body and preserve the original direction.
 */

const PROJECT_RE = /^([^-]+)-\d+/;

function projectOf(issueKey) {
  const m = PROJECT_RE.exec(issueKey || "");
  return m ? m[1].toUpperCase() : (issueKey || "").toUpperCase();
}

function tripleId(typeName, outwardKey, inwardKey) {
  return `${typeName}|${outwardKey}|${inwardKey}`;
}

/**
 * Convert a normalized link entry (relative to currentKey) into a canonical
 * directed triple.
 *   direction 'outward': current {type.outward} other  -> outward=current, inward=other
 *   direction 'inward' : current {type.inward}  other  == other {type.outward} current
 *                                                       -> outward=other,   inward=current
 */
function canonicalTriple(currentKey, link) {
  let outwardKey;
  let inwardKey;
  if (link.direction === "outward") {
    outwardKey = currentKey;
    inwardKey = link.otherKey;
  } else {
    outwardKey = link.otherKey;
    inwardKey = currentKey;
  }
  return { typeName: link.typeName, outwardKey, inwardKey };
}

function csvField(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

class LinkProcessor {
  constructor(dcClient, cloudClient, planManager, options = {}) {
    this.dcClient = dcClient;
    this.cloudClient = cloudClient;
    this.planManager = planManager;

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
      triplesDiscovered: 0,
      linksToCreate: 0,
      linksSelfSkipped: 0,
      linksTypeMissing: 0,
      linksEndpointMissing: 0,
      linksAlreadyLinked: 0,
      preflightAlreadyLinked: 0,
      linksCreated: 0,
      linksFailed: 0,
    };

    this.runId = null;
  }

  getStats() {
    return { ...this.stats };
  }

  /** Set of canonical tripleIds for an issue's normalized links. */
  _tripleSet(issueKey, links) {
    return new Set(
      (links || []).map((l) => {
        const t = canonicalTriple(issueKey, l);
        return tripleId(t.typeName, t.outwardKey, t.inwardKey);
      }),
    );
  }

  // ─────────────────────────────────────────────────
  //  PHASE 1: BUILD PLAN
  // ─────────────────────────────────────────────────

  async buildPlan(runId) {
    this.runId = runId;
    if (!this.jql) throw new Error("buildPlan requires options.jql");

    // Preload Cloud link types (name -> exists). Links whose type is absent on
    // Cloud are skipped + reported (we never auto-create link types).
    let cloudLinkTypeNames = new Set();
    try {
      const lt = await this.cloudClient.getIssueLinkTypes();
      cloudLinkTypeNames = lt.names;
      this.log(`  Cloud link types available: ${cloudLinkTypeNames.size}`);
      if (cloudLinkTypeNames.size === 0) {
        this.log("  WARN: Cloud reports zero issue link types — all links will be skipped");
      }
    } catch (e) {
      this.log(`  WARN: could not fetch Cloud link types: ${e.message}`);
    }

    this.log(`\n  Running Cloud JQL: ${this.jql}`);
    this.log(`  Requesting fields: issuelinks`);

    const cloudIssues = await this.cloudClient.searchIssues(
      this.jql,
      "issuelinks",
      100,
    );

    let candidates = cloudIssues;
    if (this.limit > 0 && candidates.length > this.limit) {
      this.log(`  Truncating to --limit ${this.limit} (had ${candidates.length})`);
      candidates = candidates.slice(0, this.limit);
    }

    this.stats.cloudIssuesScanned = candidates.length;
    this.log(`  Cloud JQL returned ${candidates.length} issues to inspect`);

    // discovered: tripleId -> plan entry (status decided by gates below).
    // pendingVerify: tripleId -> otherEndpointKey (the endpoint that must be
    // verified to exist in Cloud; the discoveredVia endpoint is known-present).
    const discovered = new Map();
    const pendingVerify = new Map();
    const linkTypeMissingRows = [];

    let processed = 0;
    for (const issue of candidates) {
      processed++;
      if (processed % 50 === 0) {
        this.log(`  ...processed ${processed}/${candidates.length}`);
      }

      const issueKey = issue.key;
      // Prime the Cloud link cache from the JQL response and compute the set of
      // triples already present on Cloud for this issue (for the already-linked
      // gate). A link is bidirectional, so checking either endpoint is enough.
      const cloudLinks = this.cloudClient.primeIssueLinks(
        issueKey,
        issue.fields?.issuelinks,
      );
      const cloudTriples = this._tripleSet(issueKey, cloudLinks);

      const dcRes = await this.dcClient.getIssueLinks(issueKey);
      if (dcRes.error) {
        this.stats.dcLookupErrors++;
        continue;
      }

      for (const dcLink of dcRes.links) {
        const t = canonicalTriple(issueKey, dcLink);
        const id = tripleId(t.typeName, t.outwardKey, t.inwardKey);
        if (discovered.has(id)) continue; // GLOBAL DEDUP

        const entry = {
          typeName: t.typeName,
          outwardKey: t.outwardKey,
          inwardKey: t.inwardKey,
          sourceDcLinkId: dcLink.id,
          discoveredVia: issueKey,
          status: "pending",
          skipReason: null,
          error: null,
          createdCloudLinkId: null,
          attempts: 0,
          updatedAt: null,
        };
        this.stats.triplesDiscovered++;

        // GATE 1: self-link
        if (t.outwardKey === t.inwardKey) {
          entry.status = "skipped";
          entry.skipReason = "self-link";
          this.stats.linksSelfSkipped++;
        }
        // GATE 2: link type must exist on Cloud
        else if (!cloudLinkTypeNames.has(t.typeName)) {
          entry.status = "skipped";
          entry.skipReason = "link-type-missing-in-cloud";
          this.stats.linksTypeMissing++;
          linkTypeMissingRows.push({
            typeName: t.typeName,
            outwardKey: t.outwardKey,
            inwardKey: t.inwardKey,
            discoveredVia: issueKey,
            sourceDcLinkId: dcLink.id,
          });
        }
        // GATE 3: already present on Cloud (JCMA or a prior run)
        else if (cloudTriples.has(id)) {
          entry.status = "skipped";
          entry.skipReason = "already-linked";
          this.stats.linksAlreadyLinked++;
        }
        // GATE 4 (endpoint existence) deferred to a batched verify pass.
        else {
          pendingVerify.set(id, dcLink.otherKey);
        }

        discovered.set(id, entry);
      }
    }

    // Batched endpoint-existence verification. The discoveredVia endpoint came
    // from the Cloud JQL (known-present); we only need to verify the OTHER end.
    const endpointMissingRows = [];
    if (pendingVerify.size > 0) {
      const distinctOther = [...new Set(pendingVerify.values())];
      this.log(
        `  Verifying ${distinctOther.length} distinct endpoint issue(s) exist in Cloud...`,
      );
      const existMap = await this.cloudClient.batchGetIssueParents(distinctOther, 50);

      for (const [id, otherKey] of pendingVerify) {
        const info = existMap.get(otherKey);
        const exists = info ? info.exists : false;
        const entry = discovered.get(id);
        if (exists) {
          this.stats.linksToCreate++;
        } else {
          entry.status = "skipped";
          entry.skipReason = "endpoint-missing-in-cloud";
          entry.error = `missing endpoint ${otherKey}`;
          this.stats.linksEndpointMissing++;
          endpointMissingRows.push({
            tripleId: id,
            typeName: entry.typeName,
            outwardKey: entry.outwardKey,
            inwardKey: entry.inwardKey,
            missingKey: otherKey,
            discoveredVia: entry.discoveredVia,
          });
        }
      }
    }

    const issuesMap = {};
    for (const [id, entry] of discovered) {
      issuesMap[id] = entry;
    }

    this.planManager.createMasterIndex(runId, { jql: this.jql });
    this.planManager.createPlan(runId, issuesMap);

    this._writeLinkTypeMissingReport(runId, linkTypeMissingRows);
    this._writeEndpointMissingReport(runId, endpointMissingRows);
    this._writeSkippedSummary(runId);

    this.log("");
    this.log(`  Plan summary:`);
    this.log(`    Cloud issues scanned:            ${this.stats.cloudIssuesScanned}`);
    this.log(`    DC lookup failures:              ${this.stats.dcLookupErrors}`);
    this.log(`    Distinct links discovered:       ${this.stats.triplesDiscovered}`);
    this.log(`    Links to create (pending):       ${this.stats.linksToCreate}`);
    this.log(`    Skipped — already linked:        ${this.stats.linksAlreadyLinked}`);
    this.log(`    Skipped — link type missing:     ${this.stats.linksTypeMissing}`);
    this.log(`    Skipped — endpoint missing:      ${this.stats.linksEndpointMissing}`);
    this.log(`    Skipped — self-link:             ${this.stats.linksSelfSkipped}`);
  }

  _writeLinkTypeMissingReport(runId, rows) {
    const csvPath = path.join(this.logDir, `link_type_missing_${runId}.csv`);
    const header = "typeName,outwardKey,inwardKey,discoveredVia,sourceDcLinkId\n";
    const lines = rows.map(
      (r) =>
        `${csvField(r.typeName)},${csvField(r.outwardKey)},${csvField(r.inwardKey)},${csvField(r.discoveredVia)},${csvField(r.sourceDcLinkId)}`,
    );
    fs.writeFileSync(csvPath, header + lines.join("\n") + (lines.length ? "\n" : ""));
    if (this.planManager.masterIndex) {
      this.planManager.masterIndex.linkTypeMissingCsv = csvPath;
      this.planManager.saveMasterIndex();
    }
    this.log(`  Link-type-missing report: ${rows.length} rows`);
    if (rows.length) this.log(`    CSV: ${csvPath}`);
  }

  _writeEndpointMissingReport(runId, rows) {
    const csvPath = path.join(this.logDir, `endpoint_missing_${runId}.csv`);
    const header = "tripleId,typeName,outwardKey,inwardKey,missingKey,discoveredVia\n";
    const lines = rows.map(
      (r) =>
        `${csvField(r.tripleId)},${csvField(r.typeName)},${csvField(r.outwardKey)},${csvField(r.inwardKey)},${csvField(r.missingKey)},${csvField(r.discoveredVia)}`,
    );
    fs.writeFileSync(csvPath, header + lines.join("\n") + (lines.length ? "\n" : ""));
    if (this.planManager.masterIndex) {
      this.planManager.masterIndex.endpointMissingCsv = csvPath;
      this.planManager.saveMasterIndex();
    }
    this.log(`  Endpoint-missing report: ${rows.length} rows`);
    if (rows.length) this.log(`    CSV: ${csvPath}`);
  }

  _writeSkippedSummary(runId) {
    const jsonPath = path.join(this.logDir, `skipped_links_${runId}.json`);
    const summary = {
      runId,
      generatedAt: new Date().toISOString(),
      bySkipReason: {
        "self-link": this.stats.linksSelfSkipped,
        "link-type-missing-in-cloud": this.stats.linksTypeMissing,
        "already-linked": this.stats.linksAlreadyLinked,
        "endpoint-missing-in-cloud": this.stats.linksEndpointMissing,
      },
      pending: this.stats.linksToCreate,
      discovered: this.stats.triplesDiscovered,
    };
    fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
    if (this.planManager.masterIndex) {
      this.planManager.masterIndex.skippedLinksJson = jsonPath;
      this.planManager.saveMasterIndex();
    }
  }

  // ─────────────────────────────────────────────────
  //  PHASE 2: EXECUTE PLAN
  // ─────────────────────────────────────────────────

  async executePlan() {
    const todo = this.planManager.getIssuesToProcess(this.retryFailed);
    if (todo.length === 0) {
      this.log("  No pending links to execute.");
      return;
    }

    if (!this.runId) {
      const mf = this.planManager.masterIndexPath || "";
      const m = mf.match(/master_(\d+)\.json/);
      this.runId = m ? m[1] : String(Date.now());
    }

    // ── Pre-flight: re-fetch live Cloud links for the distinct discoveredVia
    // issues and drop any triple that now exists (handles concurrent creation
    // and re-runs against a partially-linked target). Read-only; runs in dry-run
    // too but does not mutate the plan in dry-run.
    const discoveryKeys = [...new Set(todo.map(([, d]) => d.discoveredVia))];
    this.log(
      `  Pre-flight: re-fetching live links for ${discoveryKeys.length} issue(s)...`,
    );
    const liveTriples = new Map(); // issueKey -> Set<tripleId>
    const CHUNK = 50;
    for (let i = 0; i < discoveryKeys.length; i += CHUNK) {
      const chunk = discoveryKeys.slice(i, i + CHUNK);
      let issues = null;
      try {
        issues = await this.cloudClient.searchIssues(
          `key in (${chunk.join(",")})`,
          "issuelinks",
          100,
        );
      } catch (e) {
        // A deleted/invalid key 400s the whole chunk — fall back per-key.
        for (const key of chunk) {
          try {
            this.cloudClient.invalidateIssueLinksCache(key);
            const links = await this.cloudClient.getIssueLinks(key);
            liveTriples.set(key, this._tripleSet(key, links));
          } catch {
            liveTriples.set(key, new Set());
          }
        }
        continue;
      }
      const seen = new Set();
      for (const issue of issues) {
        seen.add(issue.key);
        const links = this.cloudClient.primeIssueLinks(
          issue.key,
          issue.fields?.issuelinks,
        );
        liveTriples.set(issue.key, this._tripleSet(issue.key, links));
      }
      // Keys not returned (e.g. deleted since plan) — treat as no live links;
      // the create attempt will surface the real error if the issue is gone.
      for (const key of chunk) {
        if (!seen.has(key)) liveTriples.set(key, new Set());
      }
    }

    const stillPending = [];
    let preflightSkipped = 0;
    for (const entry of todo) {
      const [id, data] = entry;
      const present = liveTriples.get(data.discoveredVia);
      if (present && present.has(id)) {
        if (!this.dryRun) {
          this.planManager.updateIssueStatus(id, "skipped", "already-linked-at-preflight");
        }
        this.stats.preflightAlreadyLinked++;
        preflightSkipped++;
        continue;
      }
      stillPending.push(entry);
    }
    if (!this.dryRun) this.planManager.savePlan();
    this.log(
      `  Pre-flight: ${stillPending.length} to create, ${preflightSkipped} already linked (skipped)`,
    );
    if (stillPending.length === 0) return;

    // ── Notification muting: a link can touch TWO projects (outward + inward).
    // The "issue link created" event can fire on both endpoints, so mute the
    // UNION of all involved projects up-front and restore them all at the end.
    const projectUnion = new Set();
    for (const [, d] of stillPending) {
      projectUnion.add(projectOf(d.outwardKey));
      projectUnion.add(projectOf(d.inwardKey));
    }
    const projects = [...projectUnion].sort();
    this.log(
      `  Creating ${stillPending.length} link(s) across ${projects.length} project(s), concurrency=${this.concurrency}`,
    );
    if (this.dryRun) this.log("  *** DRY RUN: no links will be created ***");
    if (this.muter && !this.muteNotifications) {
      this.log("  *** Notifications NOT being suppressed (--no-mute-notifications) ***");
    }

    const mutedProjects = [];
    if (this.muter && this.muteNotifications && !this.dryRun) {
      for (const proj of projects) {
        const ok = await this.muter.muteProject(proj);
        if (ok) mutedProjects.push(proj);
        else this.log(`  [project ${proj}] WARN: could not mute notifications — proceeding anyway`);
      }
    }

    try {
      const batchSize = Math.max(this.concurrency * 5, 25);
      let totalDone = 0;
      let firstFailuresLogged = 0;

      for (let i = 0; i < stillPending.length; i += batchSize) {
        const batch = stillPending.slice(i, i + batchSize);

        if (this.dryRun) {
          for (const [, d] of batch) {
            const label = d.typeName && this._typeOutward(d.typeName);
            this.log(
              `    [dry-run] would create: ${d.outwardKey} ${label ? `[${label}]` : `(${d.typeName} outward)`} ${d.inwardKey}`,
            );
            this.stats.linksCreated++; // display only — plan untouched
          }
        } else {
          const items = batch.map(([id, d]) => ({
            tripleId: id,
            typeName: d.typeName,
            outwardKey: d.outwardKey,
            inwardKey: d.inwardKey,
          }));
          const results = await this.cloudClient.createIssueLinksBatch(
            items,
            this.concurrency,
          );

          let hadRateLimit = false;
          for (const [id, result] of results) {
            const d = this.planManager.plan.issues[id];
            if (d) d.attempts = (d.attempts || 0) + 1;
            if (result.success) {
              this.planManager.updateIssueStatus(id, "completed", null);
              this.stats.linksCreated++;
            } else {
              this.planManager.updateIssueStatus(id, "failed", result.error);
              this.stats.linksFailed++;
              if (firstFailuresLogged < 10) {
                this.log(`    FAIL ${id}: ${result.error}`);
                firstFailuresLogged++;
              }
            }
            if (result.isRateLimit) hadRateLimit = true;
            // Invalidate both endpoints so any later read sees the new link.
            if (d) {
              this.cloudClient.invalidateIssueLinksCache(d.outwardKey);
              this.cloudClient.invalidateIssueLinksCache(d.inwardKey);
            }
          }

          if (hadRateLimit) {
            this.log("    [Cloud] cooldown 5s after rate-limit signals");
            await new Promise((r) => setTimeout(r, 5000));
          }
        }

        totalDone += batch.length;
        if (totalDone % 25 < batchSize) {
          this.log(
            `    progress: ${totalDone}/${stillPending.length} (${this.stats.linksCreated} created, ${this.stats.linksFailed} failed)`,
          );
        }
        if (!this.dryRun) this.planManager.savePlan();
      }
    } finally {
      for (const proj of mutedProjects) {
        const ok = await this.muter.restoreProject(proj);
        if (!ok) {
          this.log(
            `  [project ${proj}] WARN: restore FAILED — run with --restore-only to retry`,
          );
        }
      }
    }

    if (!this.dryRun) this.planManager.savePlan();
  }

  _typeOutward(typeName) {
    const cache = this.cloudClient._linkTypeCache;
    if (cache && cache.byName.has(typeName)) {
      return cache.byName.get(typeName).outward;
    }
    return null;
  }
}

module.exports = LinkProcessor;
