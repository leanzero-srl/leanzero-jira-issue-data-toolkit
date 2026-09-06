/**
 * Match Cloud comments to their DC counterparts.
 *
 * Primary key: |created_cloud - created_dc| <= TIME_TOLERANCE_MS AND
 *              DC author email resolves to the same Cloud accountId as the
 *              Cloud comment's author (when both sides have a resolvable user).
 *
 * Tiebreaker (same author, same second): Levenshtein-ratio on the first 200
 * chars of flattened text — pick the pair with the lower distance.
 *
 * Fallback: when the author can't be resolved (e.g. DC user deleted), accept
 * the timestamp-only match if exactly one DC candidate is within the window.
 */

const { flattenText } = require("./adfWalker");
const { flattenDcWiki } = require("./mentionExtractor");

// Cloud truncates comment timestamps to minute precision during JCMA
// migration (DC "10:46:11.489" → Cloud "10:46:00.000"), so we need up to
// 60s + a small buffer to catch the correct DC counterpart. Author-match
// (high-confidence) runs first; this tolerance only governs candidate pool
// width, and a fuzzy-preview tiebreaker disambiguates when multiple DC
// comments fall in the window.
const TIME_TOLERANCE_MS = 65000;

function parseTime(t) {
  if (!t) return 0;
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : 0;
}

function previewText(s, len = 200) {
  if (typeof s !== "string") return "";
  return s.replace(/\s+/g, " ").trim().slice(0, len);
}

/** Cheap edit-distance ratio (0=identical, 1=fully different). */
function distanceRatio(a, b) {
  if (!a && !b) return 0;
  if (!a || !b) return 1;
  const A = a.length;
  const B = b.length;
  if (A === 0 || B === 0) return 1;
  // Levenshtein up to a length cap. We only need a ranking signal.
  const max = Math.max(A, B);
  // Bounded DP — fine because previews are <= 200 chars.
  let prev = new Array(B + 1);
  for (let j = 0; j <= B; j++) prev[j] = j;
  let curr = new Array(B + 1);
  for (let i = 1; i <= A; i++) {
    curr[0] = i;
    for (let j = 1; j <= B; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[B] / max;
}

/**
 * @param {Array<{id, author, body, created, ...}>} cloudComments - already sorted by created ASC
 * @param {Array<{id, author, created, storage, rendered}>} dcComments
 * @param {{
 *   resolveDcEmail: (dcUsername: string) => Promise<string|null>,  // DC username → Cloud accountId or null
 *   log?: Function,
 * }} ctx
 *
 * @returns {Promise<{
 *   pairs: Array<{ cloud, dc, matchSource: "author+time"|"time-only"|"fuzzy"|null, confidence: "high"|"medium"|"low" }>,
 *   unmatchedCloud: Array<object>,
 *   unmatchedDc: Array<object>,
 * }>}
 */
async function pairComments(cloudComments, dcComments, ctx) {
  const dcByUsedFlag = dcComments.map((c) => ({ c, used: false }));
  const pairs = [];
  const unmatchedCloud = [];

  for (const cloud of cloudComments) {
    const cloudTime = parseTime(cloud.created);
    const cloudAccountId =
      (cloud.author && (cloud.author.accountId || cloud.author.id)) || null;

    // Candidate pool: DC comments within the time tolerance and not yet paired.
    const candidates = [];
    for (const slot of dcByUsedFlag) {
      if (slot.used) continue;
      const dcTime = parseTime(slot.c.created);
      if (Math.abs(dcTime - cloudTime) <= TIME_TOLERANCE_MS) {
        candidates.push(slot);
      }
    }

    if (candidates.length === 0) {
      unmatchedCloud.push(cloud);
      continue;
    }

    // Try author-resolution match.
    let pickedSlot = null;
    let pickedSource = null;
    let pickedConfidence = "high";

    if (cloudAccountId) {
      for (const slot of candidates) {
        const dcUsername = slot.c.author && slot.c.author.name;
        if (!dcUsername) continue;
        const resolvedAccountId = await ctx.resolveDcEmail(dcUsername);
        if (resolvedAccountId && resolvedAccountId === cloudAccountId) {
          pickedSlot = slot;
          pickedSource = "author+time";
          pickedConfidence = "high";
          break;
        }
      }
    }

    if (!pickedSlot && candidates.length === 1) {
      pickedSlot = candidates[0];
      pickedSource = "time-only";
      pickedConfidence = "medium";
    }

    if (!pickedSlot && candidates.length > 1) {
      // Fuzzy: pick the candidate with the lowest preview distance.
      const cloudPreview = previewText(flattenText(cloud.body));
      let best = null;
      let bestDist = Infinity;
      for (const slot of candidates) {
        const dcPreview = previewText(flattenDcWiki(slot.c.storage || ""));
        const d = distanceRatio(cloudPreview, dcPreview);
        if (d < bestDist) {
          bestDist = d;
          best = slot;
        }
      }
      if (best) {
        pickedSlot = best;
        pickedSource = "fuzzy";
        pickedConfidence = bestDist < 0.25 ? "medium" : "low";
      }
    }

    if (pickedSlot) {
      pickedSlot.used = true;
      pairs.push({
        cloud,
        dc: pickedSlot.c,
        matchSource: pickedSource,
        confidence: pickedConfidence,
      });
    } else {
      unmatchedCloud.push(cloud);
    }
  }

  const unmatchedDc = dcByUsedFlag.filter((s) => !s.used).map((s) => s.c);
  return { pairs, unmatchedCloud, unmatchedDc };
}

module.exports = {
  pairComments,
  TIME_TOLERANCE_MS,
};
