/**
 * Split an oversized comment ADF body into multiple sequential parts so each
 * one fits under Cloud's 32,767-character serialized-ADF body cap.
 *
 *   splitAdfIntoParts(fullAdf, { budget, attributionNode, makeMarker })
 *     → { parts: adfDoc[], partTotal, lossy }
 *
 * The migration flow elsewhere posts each returned part as its own Cloud
 * comment, in order, so a comment B that doesn't fit becomes B1, B2, B3 and the
 * overall chain reads A, B1, B2, B3, C (Cloud orders by created timestamp and we
 * post the parts consecutively).
 *
 * Design invariants:
 *   - The cap is on `JSON.stringify(body).length` of the comment BODY only
 *     (matches recover_truncated_content/src/truncationDetector). `docLen()`
 *     below is the single size oracle and always measures the WHOLE candidate
 *     doc (wrapper + attribution/marker + blocks).
 *   - DETERMINISTIC: no time/randomness, pure left-to-right traversal. The same
 *     input yields byte-identical part boundaries every run — partial-resume
 *     idempotency (re-deriving "which part_index already exists") depends on it.
 *   - Part 1 keeps the attribution blockquote; parts 2..N get a light italic
 *     continuation marker "(continued — part N of M)".
 *   - Always returns at least one part and never an empty body content array.
 *
 * `lossy` is true when the split could not be done on clean structural
 * boundaries (a heading was demoted to paragraphs, an ordered list's numbering
 * restarted, or a block fell back to plaintext chunking). The caller records a
 * lower fidelity in that case.
 */

const { cloneAdf, flattenText } = require("../../mend_comments/src/adfWalker");
const { TRUNCATION_LIMIT } = require("../../recover_truncated_content/src/truncationDetector");

// Hard cap is TRUNCATION_LIMIT (32767); work ~2.7k below it to absorb the
// attribution blockquote, the continuation marker, and any Cloud-side ADF
// normalization that grows the serialized JSON.
const DEFAULT_SPLIT_BUDGET = Math.min(30000, TRUNCATION_LIMIT - 2000);
// Fixed reservation for the continuation marker on parts 2..N. The real marker
// node serializes to ~110 chars regardless of the part numbers; 160 leaves
// headroom so the finalized part is always <= budget.
const MARKER_RESERVE = 160;
// Generous wrapper overheads for the recursive list/blockquote splitters.
const LIST_WRAP_OVERHEAD = 120;
const BQ_WRAP_OVERHEAD = 60;

/** Serialized length of an ADF doc whose content array is `contentArr`. */
function docLen(contentArr) {
  return JSON.stringify({ type: "doc", version: 1, content: contentArr }).length;
}

/** The italic "(continued — part N of M)" marker prepended to parts 2..N. */
function makeContinuationMarker(partIndex, partTotal) {
  return {
    type: "paragraph",
    content: [
      {
        type: "text",
        text: `(continued — part ${partIndex} of ${partTotal})`,
        marks: [{ type: "em" }],
      },
    ],
  };
}

/* ─────────────────────────────────────────────────────────────────────
 *  Public entry
 * ────────────────────────────────────────────────────────────────── */

function splitAdfIntoParts(
  fullAdf,
  { budget = DEFAULT_SPLIT_BUDGET, attributionNode = null, makeMarker = makeContinuationMarker } = {},
) {
  const ctx = { lossy: false };
  const content = fullAdf && Array.isArray(fullAdf.content) ? fullAdf.content : [];

  // buildAdfForInjection() always prepends the attribution blockquote as
  // content[0]; the caller passes it explicitly so we can re-emit it on part 1.
  const attribution = attributionNode || content[0] || null;
  const bodyBlocks = content.slice(1);

  // 1. Pre-explode any single body block that alone (with marker reserve) can't
  //    fit, so the greedy packer only ever deals with atoms that fit.
  const atoms = [];
  for (const block of bodyBlocks) {
    if (docLen([block]) + MARKER_RESERVE <= budget) {
      atoms.push(block);
    } else {
      atoms.push(...splitOversizedBlock(block, budget - MARKER_RESERVE, ctx));
    }
  }

  // 2. Greedy pack atoms into parts. Part 0 reserves the (larger) attribution;
  //    later parts reserve the marker. `cur.length === 0` guarantees forward
  //    progress even for an atom that's still slightly over budget.
  const partContents = [];
  let cur = [];
  for (const atom of atoms) {
    const framingReserve =
      partContents.length === 0 ? docLen(attribution ? [attribution] : []) : MARKER_RESERVE;
    const trial = cur.concat([atom]);
    if (docLen(trial) + framingReserve <= budget || cur.length === 0) {
      cur = trial;
    } else {
      partContents.push(cur);
      cur = [atom];
    }
  }
  if (cur.length > 0 || partContents.length === 0) partContents.push(cur);

  // 3. Finalize framing: attribution on part 1, marker on the rest.
  const partTotal = partContents.length;
  const parts = partContents.map((blocks, i) => {
    const framed =
      i === 0
        ? attribution
          ? [attribution, ...blocks]
          : blocks.slice()
        : [makeMarker(i + 1, partTotal), ...blocks];
    return { type: "doc", version: 1, content: framed };
  });

  return { parts, partTotal, lossy: ctx.lossy };
}

/* ─────────────────────────────────────────────────────────────────────
 *  Intra-block splitting — every helper returns block[] whose members each
 *  satisfy docLen([block]) <= budget, and flips ctx.lossy when it has to.
 * ────────────────────────────────────────────────────────────────── */

function splitOversizedBlock(block, budget, ctx) {
  const type = block && block.type;
  if (type === "paragraph" || type === "heading") return splitTextBlock(block, budget, ctx);
  if (type === "codeBlock") return splitCodeBlock(block, budget, ctx);
  if (type === "bulletList" || type === "orderedList") return splitList(block, budget, ctx);
  if (type === "blockquote") return splitBlockquote(block, budget, ctx);
  // Unknown or not-cleanly-splittable node → guaranteed-terminating fallback.
  return splitToPlaintext(block, budget, ctx);
}

function makeTextWrapper(asHeading, attrs, content) {
  if (asHeading) return { type: "heading", attrs: attrs ? cloneAdf(attrs) : { level: 1 }, content };
  return { type: "paragraph", content };
}

function makeText(text, marks) {
  const n = { type: "text", text };
  if (Array.isArray(marks) && marks.length) n.marks = cloneAdf(marks);
  return n;
}

/** Split a paragraph/heading by its inline content; the first fragment keeps
 *  heading semantics, continuations demote to paragraphs (lossy). */
function splitTextBlock(block, budget, ctx) {
  const isHeading = block.type === "heading";
  const inline = Array.isArray(block.content) ? block.content : [];
  const out = [];
  let cur = [];

  const firstIsHeading = () => isHeading && out.length === 0;
  const flush = () => {
    if (cur.length === 0) return;
    out.push(makeTextWrapper(firstIsHeading(), block.attrs, cur));
    cur = [];
  };

  for (const node of inline) {
    const trial = cur.concat([node]);
    if (docLen([makeTextWrapper(firstIsHeading(), block.attrs, trial)]) <= budget) {
      cur = trial;
      continue;
    }
    if (cur.length > 0) flush();
    // cur is empty now — does the node fit on a fresh wrapper?
    if (docLen([makeTextWrapper(firstIsHeading(), block.attrs, [node])]) <= budget) {
      cur = [node];
      continue;
    }
    // Node alone is too big. A long text node splits cleanly by its string.
    if (node.type === "text" && typeof node.text === "string") {
      for (const piece of splitTextString(node, block, firstIsHeading(), budget, ctx)) {
        out.push(piece);
      }
    } else {
      // A single non-text inline node (e.g. a pathologically large mention
      // attrs.text) can't be subdivided structurally. Flatten it to plaintext
      // and char-split so the part still respects the cap — never emit it whole.
      const synthetic = makeTextWrapper(firstIsHeading(), block.attrs, [node]);
      for (const piece of splitToPlaintext(synthetic, budget, ctx)) {
        out.push(piece);
      }
    }
  }
  flush();
  if (isHeading && out.length > 1) ctx.lossy = true; // continuations demoted
  if (out.length === 0) out.push(block);
  return out;
}

/** Split a single oversized text node's string into multiple wrapper blocks,
 *  carrying its marks and preferring whitespace boundaries. */
function splitTextString(node, block, asHeadingFirst, budget, ctx) {
  const marks = node.marks;
  const out = [];
  let rest = node.text;
  while (rest.length > 0) {
    const asHeading = asHeadingFirst && out.length === 0;
    const fits = (slice) =>
      docLen([makeTextWrapper(asHeading, block.attrs, [makeText(slice, marks)])]) <= budget;
    const maxK = largestFittingPrefix(rest, fits);
    let take = maxK;
    if (take < rest.length) {
      const ws = lastWhitespaceBoundary(rest, take);
      if (ws > 0) take = ws;
    }
    if (take <= 0) take = Math.max(1, maxK); // guarantee progress
    out.push(makeTextWrapper(asHeading, block.attrs, [makeText(rest.slice(0, take), marks)]));
    rest = rest.slice(take);
  }
  if (out.length > 1) ctx.lossy = true;
  return out;
}

function codeBlockText(block) {
  const content = Array.isArray(block.content) ? block.content : [];
  return content.map((n) => (n && typeof n.text === "string" ? n.text : "")).join("");
}

function makeCodeBlock(attrs, text) {
  const n = { type: "codeBlock" };
  if (attrs) n.attrs = cloneAdf(attrs);
  n.content = text ? [{ type: "text", text }] : [];
  return n;
}

/** Split a code block by lines (then hard-split any single over-long line).
 *  Each segment keeps its trailing newline, so concatenating the parts' text
 *  reproduces the original byte-for-byte — no newline is lost at a seam. */
function splitCodeBlock(block, budget, ctx) {
  const attrs = block.attrs;
  const segments = codeBlockText(block).split("\n"); // N segments, N-1 separators
  const wrap = (s) => makeCodeBlock(attrs, s);
  const out = [];
  let cur = ""; // accumulated text (separators included) for the current block
  let curHasContent = false;
  for (let i = 0; i < segments.length; i++) {
    const sep = i < segments.length - 1 ? "\n" : "";
    const piece = segments[i] + sep;
    if (docLen([wrap(cur + piece)]) <= budget) {
      cur += piece;
      curHasContent = true;
      continue;
    }
    if (curHasContent) {
      out.push(wrap(cur));
      cur = "";
      curHasContent = false;
    }
    if (docLen([wrap(piece)]) <= budget) {
      cur = piece;
      curHasContent = true;
      continue;
    }
    // Single segment too long (minified blob) → hard char split; the trailing
    // separator rides with the final chunk so the seam newline survives.
    const chunks = hardSplitString(segments[i], (slice) => docLen([wrap(slice)]) <= budget);
    for (let k = 0; k < chunks.length; k++) {
      out.push(wrap(chunks[k] + (k === chunks.length - 1 ? sep : "")));
    }
    ctx.lossy = true;
  }
  if (curHasContent || out.length === 0) out.push(wrap(cur));
  return out;
}

/** Split a list by listItem; recurse into a single oversized item. */
function splitList(block, budget, ctx) {
  const type = block.type;
  const items = Array.isArray(block.content) ? block.content : [];
  const wrap = (its) => ({ type, content: its });
  const out = [];
  let cur = [];
  for (const item of items) {
    const trial = cur.concat([item]);
    if (docLen([wrap(trial)]) <= budget) {
      cur = trial;
      continue;
    }
    if (cur.length > 0) {
      out.push(wrap(cur));
      cur = [];
    }
    if (docLen([wrap([item])]) <= budget) {
      cur = [item];
      continue;
    }
    // One listItem is itself too big — split its inner blocks across items.
    const inner = Array.isArray(item.content) ? item.content : [];
    for (const li of splitInnerBlocksIntoItems(inner, budget, type, ctx)) {
      out.push(wrap([li]));
    }
    if (type === "orderedList") ctx.lossy = true; // numbering restarts
  }
  if (cur.length > 0) out.push(wrap(cur));
  if (out.length === 0) out.push(block);
  if (type === "orderedList" && out.length > 1) ctx.lossy = true;
  return out;
}

function splitInnerBlocksIntoItems(innerBlocks, budget, listType, ctx) {
  const wrapItem = (blocks) => ({ type: "listItem", content: blocks });
  const wrapList = (li) => ({ type: listType, content: [li] });
  const atoms = [];
  for (const b of innerBlocks) {
    if (docLen([wrapList(wrapItem([b]))]) <= budget) atoms.push(b);
    else atoms.push(...splitOversizedBlock(b, budget - LIST_WRAP_OVERHEAD, ctx));
  }
  const out = [];
  let cur = [];
  for (const a of atoms) {
    const trial = cur.concat([a]);
    if (docLen([wrapList(wrapItem(trial))]) <= budget || cur.length === 0) cur = trial;
    else {
      out.push(wrapItem(cur));
      cur = [a];
    }
  }
  if (cur.length > 0) out.push(wrapItem(cur));
  if (out.length === 0) out.push(wrapItem(innerBlocks));
  return out;
}

/** Split a blockquote by its inner blocks, re-wrapping each chunk. */
function splitBlockquote(block, budget, ctx) {
  const inner = Array.isArray(block.content) ? block.content : [];
  const wrap = (blocks) => ({ type: "blockquote", content: blocks });
  const atoms = [];
  for (const b of inner) {
    if (docLen([wrap([b])]) <= budget) atoms.push(b);
    else atoms.push(...splitOversizedBlock(b, budget - BQ_WRAP_OVERHEAD, ctx));
  }
  const out = [];
  let cur = [];
  for (const a of atoms) {
    const trial = cur.concat([a]);
    if (docLen([wrap(trial)]) <= budget || cur.length === 0) cur = trial;
    else {
      out.push(wrap(cur));
      cur = [a];
    }
  }
  if (cur.length > 0) out.push(wrap(cur));
  if (out.length === 0) out.push(block);
  return out;
}

/** Last-resort: flatten to plain text and chunk into paragraphs by char budget.
 *  Always terminates, so it's the recursion floor for any node type. */
function splitToPlaintext(block, budget, ctx) {
  ctx.lossy = true;
  const text = flattenText({ type: "doc", version: 1, content: [block] });
  const wrap = (s) => ({ type: "paragraph", content: s ? [{ type: "text", text: s }] : [] });
  if (!text) return [wrap("")];
  const out = [];
  let rest = text;
  while (rest.length > 0) {
    const maxK = largestFittingPrefix(rest, (slice) => docLen([wrap(slice)]) <= budget);
    let take = maxK;
    if (take < rest.length) {
      const ws = lastWhitespaceBoundary(rest, take);
      if (ws > 0) take = ws;
    }
    if (take <= 0) take = Math.max(1, maxK);
    out.push(wrap(rest.slice(0, take)));
    rest = rest.slice(take);
  }
  return out.length ? out : [wrap("")];
}

/* ─────────────────────────────────────────────────────────────────────
 *  String helpers
 * ────────────────────────────────────────────────────────────────── */

/** Largest k in [1, str.length] such that fits(str.slice(0, k)). At least 1
 *  (forces progress even when a single char doesn't fit — pathological). */
function largestFittingPrefix(str, fits) {
  let lo = 1;
  let hi = str.length;
  let best = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fits(str.slice(0, mid))) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Index <= take just past the last whitespace run, searching back no more than
 *  halfway so we never produce a tiny chunk. Returns `take` if none found. */
function lastWhitespaceBoundary(str, take) {
  const floor = Math.floor(take / 2);
  for (let i = take; i > floor; i--) {
    if (/\s/.test(str[i - 1])) return i;
  }
  return take;
}

function hardSplitString(str, fits) {
  const out = [];
  let rest = str;
  while (rest.length > 0) {
    const k = largestFittingPrefix(rest, fits);
    out.push(rest.slice(0, k));
    rest = rest.slice(k);
  }
  return out.length ? out : [str];
}

module.exports = {
  splitAdfIntoParts,
  makeContinuationMarker,
  docLen,
  DEFAULT_SPLIT_BUDGET,
  // exported for tests
  _splitOversizedBlock: splitOversizedBlock,
};
