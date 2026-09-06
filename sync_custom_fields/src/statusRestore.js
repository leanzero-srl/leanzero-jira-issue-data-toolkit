// =============================================================================
// statusRestore.js — move Cloud issues back to their DC (original) status.
//
// Status is a SYSTEM field: it can only change via workflow TRANSITIONS, and the
// target status may not be directly reachable (e.g. Reopened -> Resolved ->
// Closed). The desired hop sequence is declared in config `statusPaths` keyed by
// "<cloudStatus>-><dcStatus>" as an ordered list of TARGET status names. We match
// on the transition's destination status (`to.name`), not its label, so renamed
// transitions still resolve.
//
// Idempotent: before each hop we read the live status and skip hops already
// satisfied, so a re-run / resume converges.
// =============================================================================

const lc = (s) => String(s == null ? "" : s).trim().toLowerCase();

/**
 * Build the work list from status maps + configured paths.
 * @returns { worklist:[{key,from,to,path,dcResolution}], unmatched:[{key,from,to}] }
 */
function buildStatusWorklist(cloudStatusMap, dcStatusMap, statusPaths) {
  const worklist = [];
  const unmatched = [];
  const pathIndex = new Map();
  for (const [k, v] of Object.entries(statusPaths || {})) {
    pathIndex.set(lc(k.split("->")[0]) + "->" + lc(k.split("->")[1]), v);
  }
  for (const [key, c] of cloudStatusMap.entries()) {
    const d = dcStatusMap.get(key);
    if (!d || !d.status || !c.status) continue;
    if (lc(c.status) === lc(d.status)) continue; // already correct
    const path = pathIndex.get(lc(c.status) + "->" + lc(d.status));
    if (!path) {
      unmatched.push({ key, from: c.status, to: d.status });
      continue;
    }
    worklist.push({ key, from: c.status, to: d.status, path, dcResolution: d.resolution || null });
  }
  return { worklist, unmatched };
}

/**
 * Execute the hop sequence for one issue.
 * @param cloud   CloudJiraClient
 * @param item    { key, to, path:[targetStatusNames], dcResolution }
 * @param opts    { dryRun, setResolution, log }
 * @returns { ok, steps, finalStatus, finalResolution, error, skipped }
 */
async function executeStatusPath(cloud, item, opts = {}) {
  const { key, path } = item;
  const log = opts.log || (() => {});
  const steps = [];

  // Idempotency: if already at the final target, nothing to do.
  const start = await cloud.getStatus(key);
  if (!start) return { ok: false, error: "issue_not_found", steps };
  if (lc(start.status) === lc(item.to)) {
    return { ok: true, steps, finalStatus: start.status, finalResolution: start.resolution, skipped: "already_target" };
  }

  // Dry-run: validate only the FIRST hop live (we can't look ahead without
  // actually moving the issue); predict the remaining hops from config.
  if (opts.dryRun) {
    const transitions = await cloud.getTransitions(key);
    const firstTarget = path.find((p) => lc(p) !== lc(start.status)) || path[0];
    const t = transitions.find((x) => lc(x.to && x.to.name) === lc(firstTarget));
    if (!t) return { ok: false, error: `no_transition_to:${firstTarget}:from:${start.status}`, steps };
    for (const nextStatus of path) {
      const validated = lc(nextStatus) === lc(firstTarget);
      steps.push({ to: nextStatus, transitionId: validated ? t.id : null, name: validated ? t.name : "(predicted)", validated });
    }
    return { ok: true, steps, finalStatus: `(would be) ${item.to}`, finalResolution: null };
  }

  for (let hop = 0; hop < path.length; hop++) {
    const nextStatus = path[hop];
    const cur = await cloud.getStatus(key);
    if (!cur) return { ok: false, error: "issue_not_found_midpath", steps };
    if (lc(cur.status) === lc(nextStatus)) continue; // hop already satisfied

    const transitions = await cloud.getTransitions(key);
    const t = transitions.find((x) => lc(x.to && x.to.name) === lc(nextStatus));
    if (!t) {
      return { ok: false, error: `no_transition_to:${nextStatus}:from:${cur.status}`, steps };
    }

    // If this transition's screen exposes resolution and we have a DC resolution
    // to restore, set it on the transition. (SD's screens don't, so resolution
    // is left to workflow post-functions — verified by read-back.)
    const fields = {};
    if (opts.setResolution && item.dcResolution && t.fields && t.fields.resolution) {
      fields.resolution = { name: item.dcResolution };
    }

    const res = await cloud.transitionIssue(key, t.id, fields);
    if (!res.success) {
      return { ok: false, error: `transition_failed:${nextStatus}:${res.error}`, steps };
    }
    steps.push({ to: nextStatus, transitionId: t.id, setResolution: !!fields.resolution });
    log(`    ${key}: -> ${nextStatus} (transition ${t.id} "${t.name}")`);
  }

  const final = await cloud.getStatus(key);
  return { ok: true, steps, finalStatus: final ? final.status : null, finalResolution: final ? final.resolution : null };
}

module.exports = { buildStatusWorklist, executeStatusPath };
