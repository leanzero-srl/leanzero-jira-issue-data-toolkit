/**
 * Token-anchored normalization of `;` runs in a Cloud ADF body, using DC
 * plaintext as the source of truth.
 *
 * Why not absolute offsets: ADF text nodes are split around marks, mentions,
 * emojis and panels — the cumulative offset into a flattened Cloud text does
 * NOT match the same byte offset in the DC body. So we anchor on local context
 * (a few chars on each side of the ; run) and look for that anchor uniquely in
 * the DC plaintext.
 *
 * Algorithm per Cloud text node:
 *   for each run of `;` of length >= 2 in node.text:
 *     ctx = up to 20 visible chars before + 20 chars after the run within node.text
 *     find unique occurrence of (ctxLeft + <some-;-run> + ctxRight) in DC plaintext
 *     if unique → shrink the Cloud run to the matched DC run length
 *     else → leave it; log ambiguous_semicolon_run
 *
 * Mutates `cloudAdf` in place. Returns a list of edit descriptors for the
 * audit report.
 */

const { walk } = require("./adfWalker");

const MIN_RUN = 2; // ;; or longer
const CTX_RADIUS = 20;

/** Escape a literal string for use inside a RegExp. */
function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find every (start, length) run of `;` of length >= minRun in `s`. */
function findSemicolonRuns(s, minRun = MIN_RUN) {
  const runs = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === ";") {
      let j = i;
      while (j < s.length && s[j] === ";") j++;
      const len = j - i;
      if (len >= minRun) runs.push({ start: i, length: len });
      i = j;
    } else {
      i++;
    }
  }
  return runs;
}

/**
 * Within `text`, return the [start, end) window around (start, length)
 * extending up to CTX_RADIUS on each side, but never crossing whitespace
 * boundaries past CTX_RADIUS — we want stable local context, not whole
 * paragraphs.
 */
function pickAnchorWindow(text, runStart, runLen) {
  const left = Math.max(0, runStart - CTX_RADIUS);
  const right = Math.min(text.length, runStart + runLen + CTX_RADIUS);
  return {
    leftCtx: text.slice(left, runStart),
    rightCtx: text.slice(runStart + runLen, right),
  };
}

// Strip "@<token>(<space><token>)?" mention-shaped sequences from an anchor
// string. Used by Pass 3 to handle Cloud comments where an @unknown mention
// has already been rewritten as a plain-text node ("@Alex Carter") and
// the matching DC body just had `[~acarter]` which flattens to "". The two
// sides cannot align until the @-token is removed from both.
const MENTION_TOKEN_RE = /@[^\s,;]+(\s+[A-Z][^\s,;]*)?/g;
function stripMentionTokens(s) {
  if (typeof s !== "string" || !s) return s;
  return s.replace(MENTION_TOKEN_RE, "").replace(/\s{2,}/g, " ");
}

/**
 * Search `dcPlain` for the unique occurrence of (leftCtx + ;+ + rightCtx),
 * returning the matched DC `;` run length.
 *
 * Three passes:
 *   1. Literal: anchor with one-or-more `;` between.
 *   2. Zero-semi: anchor with NO `;` between — DC ran the position without
 *      semicolons, so the Cloud run is a pure JCMA artifact (collapse to 0).
 *   3. Mention-stripped: drop "@<word>(<space><word>)?" sequences from the
 *      Cloud-side anchor and retry pass 1. Salvages runs that sit next to a
 *      mention which was already plain-text-rewritten on a prior run (the
 *      visible "@Alex Carter" exists on Cloud but never on DC).
 *
 * Returns:
 *   number >= 0  — DC has that many `;` at the unique anchor position
 *   null         — 0 matches OR 2+ matches (ambiguous), don't touch Cloud
 */
function findDcRunLength(dcPlain, leftCtx, rightCtx) {
  if (!leftCtx && !rightCtx) return null;

  // Pass 1
  let result = _searchWithSemis(dcPlain, leftCtx, rightCtx);
  if (result !== undefined) return result;

  // Pass 2
  result = _searchWithoutSemis(dcPlain, leftCtx, rightCtx);
  if (result !== undefined) return result;

  // Pass 3 — strip @-mention tokens from Cloud anchors and retry. Skip if it
  // reduces the anchors to too little to disambiguate.
  //
  // The 4-char minimum is intentionally low: when a `;` run sits at the very
  // end of a comment the right anchor is empty, so we have to lean on a short
  // left context. Uniqueness in DC plaintext is what protects us — if "FYI "
  // alone matches more than once in the DC body, _searchWithSemis returns
  // `undefined` and we leave the run alone.
  const leftStripped = stripMentionTokens(leftCtx);
  const rightStripped = stripMentionTokens(rightCtx);
  if (leftStripped === leftCtx && rightStripped === rightCtx) return null;
  if (leftStripped.length + rightStripped.length < 4) return null;

  result = _searchWithSemis(dcPlain, leftStripped, rightStripped);
  if (result !== undefined) return result;
  result = _searchWithoutSemis(dcPlain, leftStripped, rightStripped);
  return result === undefined ? null : result;
}

// Returns: number on unique match, undefined on 0/2+ matches (so the caller
// knows to try the next pass). Returning `null` is reserved for "give up".
function _searchWithSemis(dcPlain, leftCtx, rightCtx) {
  const re = new RegExp(escRe(leftCtx) + "(;+)" + escRe(rightCtx), "g");
  let m, firstLen = null, count = 0;
  while ((m = re.exec(dcPlain)) !== null) {
    count++;
    if (count === 1) firstLen = m[1].length;
    if (count > 1) return undefined;
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return count === 1 ? firstLen : undefined;
}

function _searchWithoutSemis(dcPlain, leftCtx, rightCtx) {
  const re = new RegExp(escRe(leftCtx) + escRe(rightCtx), "g");
  let m, count = 0;
  while ((m = re.exec(dcPlain)) !== null) {
    count++;
    if (count > 1) return undefined;
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return count === 1 ? 0 : undefined;
}

/**
 * Normalize ; runs across the WHOLE Cloud comment.
 *
 * Why flatten: ADF text is split across nodes around marks (bold/italic/link
 * /code/etc). A `;;;` may sit in its own tiny text node with only 1–2 chars
 * of surrounding text inside that node — far too short to disambiguate
 * against DC plain text. The fix: build a flat representation of the entire
 * comment, walk runs on the flat string (so anchors get the full 20-char
 * context across node boundaries), then surgically shorten the underlying
 * text nodes that contain each run.
 *
 * @returns {{
 *   changes: Array<{ before: string, after: string, anchorLeft: string, anchorRight: string }>,
 *   ambiguous: Array<{ run: string, anchorLeft: string, anchorRight: string }>,
 * }}
 */
function normalizeSemicolons(cloudAdf, dcPlain) {
  const changes = [];
  const ambiguous = [];
  if (!cloudAdf || !dcPlain) return { changes, ambiguous };

  // Build flat text + node offset map
  const flatNodes = []; // [{ node, start, length }]
  let flatText = "";
  for (const frame of walk(cloudAdf)) {
    const n = frame.node;
    if (n && n.type === "text" && typeof n.text === "string" && n.text.length > 0) {
      flatNodes.push({ node: n, start: flatText.length, length: n.text.length });
      flatText += n.text;
    }
  }
  if (flatNodes.length === 0) return { changes, ambiguous };

  const runs = findSemicolonRuns(flatText, MIN_RUN);
  if (runs.length === 0) return { changes, ambiguous };

  // Process runs back-to-front so earlier flat offsets stay valid as we
  // delete characters from text nodes.
  for (let k = runs.length - 1; k >= 0; k--) {
    const r = runs[k];
    const { leftCtx, rightCtx } = pickAnchorWindow(flatText, r.start, r.length);
    const dcLen = findDcRunLength(dcPlain, leftCtx, rightCtx);
    if (dcLen === null) {
      ambiguous.push({
        run: ";".repeat(r.length),
        anchorLeft: leftCtx,
        anchorRight: rightCtx,
      });
      continue;
    }
    if (dcLen >= r.length) continue; // DC has same-or-more ; — leave Cloud alone
    const toRemove = r.length - dcLen;
    _removeCharsFromFlat(flatNodes, r.start + dcLen, toRemove);
    changes.push({
      before: ";".repeat(r.length),
      after: ";".repeat(dcLen),
      anchorLeft: leftCtx,
      anchorRight: rightCtx,
    });
  }

  return { changes, ambiguous };
}

/**
 * Remove `count` characters from the flat representation starting at
 * `flatStart`, mutating the underlying text nodes. Handles spans that cross
 * text-node boundaries.
 *
 * Note: after we delete chars from one node, subsequent node `start` offsets
 * shift left by the removed amount. `flatStart` STAYS the same — in the
 * shifted coordinates, the next chars to delete are still at `flatStart`
 * (which is now within the next node).
 */
function _removeCharsFromFlat(flatNodes, flatStart, count) {
  let remaining = count;
  let i = 0;
  while (remaining > 0 && i < flatNodes.length) {
    const fn = flatNodes[i];
    const nodeEnd = fn.start + fn.length;
    if (flatStart >= nodeEnd) { i++; continue; }
    const localStart = Math.max(0, flatStart - fn.start);
    const localEnd = Math.min(fn.length, localStart + remaining);
    const removed = localEnd - localStart;
    if (removed > 0) {
      fn.node.text =
        fn.node.text.slice(0, localStart) + fn.node.text.slice(localEnd);
      fn.length -= removed;
      remaining -= removed;
      for (let j = i + 1; j < flatNodes.length; j++) flatNodes[j].start -= removed;
    }
    if (remaining > 0) i++;
  }
}

module.exports = {
  normalizeSemicolons,
  findSemicolonRuns,
  // exported for tests
  pickAnchorWindow,
  findDcRunLength,
};
