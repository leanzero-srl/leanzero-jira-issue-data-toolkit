/**
 * Decide which DC comments need to be injected into Cloud for one issue.
 *
 *   diffComments({
 *     cloudComments,         // Cloud comments WITH `properties` inlined
 *     dcComments,            // DC comments from the extended DC client
 *     resolveDcEmail,        // dcUsername → cloudAccountId|null
 *     log,
 *   })
 *
 * Returns: { toCreate: DcComment[], skipped: Array<{dc, reason}>, partial: Map }
 *
 * Selection rules (in order):
 *   1. **Already injected** — if Cloud carries ALL parts of this DC comment
 *        (tagged via migration.dc_comment_id, + migration.part_index/_total when
 *        the comment was split), skip.
 *   2. **Partially injected** — if SOME but not all parts of a split comment are
 *        present (e.g. B1 posted, B2/B3 failed on a prior run), re-plan the
 *        comment so apply can top up the MISSING parts. Such a comment is added
 *        to `toCreate` AND recorded in `partial` (dcId → {presentParts, total}),
 *        and is EXCLUDED from the heuristic pairer below (its existing parts
 *        would otherwise falsely pair the whole comment by timestamp).
 *   3. **JCMA counterpart present** — run mend_comments' commentPairer to
 *        check whether a Cloud comment can be paired with this DC comment by
 *        (created ~±65s + author email match). If yes, skip — JCMA already
 *        migrated this comment.
 *   4. **Inject** — otherwise add to `toCreate`, preserving original DC order
 *        (sorted by created ASC by the DC client).
 */

const {
  MIGRATION_TAG_KEY,
  PART_INDEX_PROP_KEY,
  PART_TOTAL_PROP_KEY,
} = require("./cloudJiraClient");
const { pairComments } = require("../../mend_comments/src/commentPairer");

async function diffComments({ cloudComments, dcComments, resolveDcEmail, log = () => {} }) {
  const tagMap = collectMigrationTags(cloudComments);

  // Partition DC comments into: fully covered (skip), partially covered
  // (top-up), and untouched (run through the heuristic pairer).
  const dcCandidates = [];
  const skipped = [];
  const partial = new Map(); // dcId → { presentParts: Set<number>, total: number }
  const forcedCreate = []; // partially-covered comments bypass the pairer

  for (const dc of dcComments) {
    const cov = tagMap.get(String(dc.id));
    if (cov) {
      const total = cov.total || 1;
      const fullyCovered =
        cov.parts.size >= total && everyPartPresent(cov.parts, total);
      if (fullyCovered) {
        skipped.push({ dc, reason: "already_injected_tagged" });
        continue;
      }
      // Partially covered → top up the missing parts; never re-pair.
      partial.set(String(dc.id), { presentParts: new Set(cov.parts), total });
      forcedCreate.push(dc);
      continue;
    }
    dcCandidates.push(dc);
  }

  if (dcCandidates.length === 0) {
    return { toCreate: forcedCreate, skipped, partial };
  }

  // Run the heuristic pair against the FULL Cloud comment set. `unmatchedDc`
  // is the set of DC comments with no Cloud counterpart — the inverse of how
  // mend_comments uses this function. We re-use it as-is.
  const { unmatchedDc } = await pairComments(cloudComments, dcCandidates, {
    resolveDcEmail,
    log,
  });

  // Any DC candidate that DID match a Cloud comment is a JCMA-migrated
  // counterpart — skip it.
  const unmatchedIds = new Set(unmatchedDc.map((d) => String(d.id)));
  for (const dc of dcCandidates) {
    if (!unmatchedIds.has(String(dc.id))) {
      skipped.push({ dc, reason: "jcma_counterpart_present" });
    }
  }

  // Partially-covered comments are always injected (to top up), placed FIRST so
  // they keep DC order relative to the rest (both lists are already created-ASC).
  return { toCreate: [...forcedCreate, ...unmatchedDc], skipped, partial };
}

function everyPartPresent(partsSet, total) {
  for (let i = 1; i <= total; i++) {
    if (!partsSet.has(i)) return false;
  }
  return true;
}

/**
 * Map every DC comment id present in Cloud to the part indices that exist there.
 * Returns Map<dcId, { parts: Set<number>, total: number }>. An un-split comment
 * (tagged by the original code path, no part props) is recorded as part 1 of 1,
 * so it reads as fully covered.
 */
function collectMigrationTags(cloudComments) {
  const out = new Map();
  if (!Array.isArray(cloudComments)) return out;
  for (const c of cloudComments) {
    const props = Array.isArray(c.properties) ? c.properties : [];
    let dcId = null;
    let partIndex = null;
    let partTotal = null;
    for (const p of props) {
      if (!p || p.value == null) continue;
      if (p.key === MIGRATION_TAG_KEY) dcId = String(p.value);
      else if (p.key === PART_INDEX_PROP_KEY) partIndex = Number(p.value);
      else if (p.key === PART_TOTAL_PROP_KEY) partTotal = Number(p.value);
    }
    if (!dcId) continue;
    if (!out.has(dcId)) out.set(dcId, { parts: new Set(), total: null });
    const e = out.get(dcId);
    e.parts.add(Number.isFinite(partIndex) ? partIndex : 1);
    if (Number.isFinite(partTotal)) e.total = partTotal;
    else if (e.total == null) e.total = 1;
  }
  return out;
}

module.exports = {
  diffComments,
  collectMigrationTags,
};
