/**
 * Standalone test for adfSplitter — run with: node src/adfSplitter.test.js
 * No test framework dependency; exits non-zero on first failure.
 */

const { splitAdfIntoParts, DEFAULT_SPLIT_BUDGET } = require("./adfSplitter");
const { flattenText } = require("../../mend_comments/src/adfWalker");

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

const BUDGET = DEFAULT_SPLIT_BUDGET; // 30000
const HARD_CAP = 32767;

function attribution() {
  return {
    type: "blockquote",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Originally posted by " },
          { type: "mention", attrs: { id: "557058:abc-123", text: "@J Doe", userType: "DEFAULT" } },
          { type: "text", text: " on 2024-03-01T10:00:00.000Z" },
        ],
      },
    ],
  };
}

function doc(...bodyBlocks) {
  return { type: "doc", version: 1, content: [attribution(), ...bodyBlocks] };
}

function para(text) {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function bodyText(part) {
  // text of a part excluding the framing (attribution or marker), best-effort:
  // for part 1 the attribution adds "Originally posted by @J Doe on ..."; for
  // parts 2+ the marker adds "(continued — part N of M)". We compare the WHOLE
  // concatenation across parts against the original body instead (see tests).
  return flattenText(part);
}

function assertAllPartsFit(name, parts) {
  for (let i = 0; i < parts.length; i++) {
    const len = JSON.stringify(parts[i]).length;
    check(`${name}: part ${i + 1}/${parts.length} fits (${len} <= ${HARD_CAP})`, len <= HARD_CAP, `len=${len}`);
    check(`${name}: part ${i + 1} <= budget (${len} <= ${BUDGET})`, len <= BUDGET + 500, `len=${len}`);
  }
}

function hasAttribution(part) {
  return part.content[0] && part.content[0].type === "blockquote";
}
function hasMarker(part) {
  const f = part.content[0];
  return f && f.type === "paragraph" && /^\(continued — part \d+ of \d+\)$/.test(flattenText({ type: "doc", version: 1, content: [f] }));
}

/* ── Test 1: many small paragraphs ─────────────────────────────────── */
(function () {
  const blocks = [];
  for (let i = 0; i < 4000; i++) blocks.push(para(`Line number ${i} with some filler text to add bulk.`));
  const full = doc(...blocks);
  const fullLen = JSON.stringify(full).length;
  console.log(`\nTest 1: many small paragraphs (full=${fullLen})`);
  check("Test 1: input actually exceeds budget", fullLen > BUDGET);
  const { parts, partTotal, lossy } = splitAdfIntoParts(full, { attributionNode: attribution() });
  check("Test 1: produced >1 part", parts.length > 1, `parts=${parts.length}`);
  check("Test 1: partTotal matches", partTotal === parts.length);
  check("Test 1: clean split is not lossy", lossy === false);
  assertAllPartsFit("Test 1", parts);
  check("Test 1: part 1 has attribution", hasAttribution(parts[0]));
  let markersOk = true;
  for (let i = 1; i < parts.length; i++) markersOk = markersOk && hasMarker(parts[i]);
  check("Test 1: parts 2..N have continuation marker", markersOk);
})();

/* ── Test 2: one 50k-char single paragraph (single oversized text node) ─ */
(function () {
  const big = "word ".repeat(11000); // ~55k chars
  const full = doc(para(big));
  console.log(`\nTest 2: one giant paragraph (full=${JSON.stringify(full).length})`);
  const { parts, lossy } = splitAdfIntoParts(full, { attributionNode: attribution() });
  check("Test 2: produced >1 part", parts.length > 1, `parts=${parts.length}`);
  assertAllPartsFit("Test 2", parts);
  // text preservation: concatenated body text contains all the words
  const joined = parts.map(bodyText).join("");
  const origWords = (big.match(/word/g) || []).length;
  const gotWords = (joined.match(/word/g) || []).length;
  check("Test 2: no words lost across split", gotWords === origWords, `orig=${origWords} got=${gotWords}`);
  check("Test 2: lossy flagged (single text node had to be string-split)", lossy === true);
})();

/* ── Test 3a: 50k code block WITH newlines ─────────────────────────── */
(function () {
  const lines = [];
  for (let i = 0; i < 3000; i++) lines.push(`const x${i} = doSomething(${i}); // comment ${i}`);
  const code = { type: "codeBlock", attrs: { language: "javascript" }, content: [{ type: "text", text: lines.join("\n") }] };
  const full = doc(code);
  console.log(`\nTest 3a: code block with newlines (full=${JSON.stringify(full).length})`);
  const { parts } = splitAdfIntoParts(full, { attributionNode: attribution() });
  check("Test 3a: produced >1 part", parts.length > 1, `parts=${parts.length}`);
  assertAllPartsFit("Test 3a", parts);
  // every body block in every part is a codeBlock with preserved language
  let allCode = true;
  for (const p of parts) {
    const body = p.content.filter((b) => b.type !== "blockquote" && !hasMarkerNode(b));
    for (const b of body) allCode = allCode && b.type === "codeBlock" && b.attrs && b.attrs.language === "javascript";
  }
  check("Test 3a: all body blocks remain codeBlocks with language preserved", allCode);
  // EXACT reconstruction — no newline lost at a seam (regression guard for M2).
  const reconstructed = parts.map(codeText).join("");
  check("Test 3a: code text reconstructed byte-for-byte across seams", reconstructed === lines.join("\n"), `len ${reconstructed.length} vs ${lines.join("\n").length}`);
})();

function codeText(part) {
  let s = "";
  for (const b of part.content) {
    if (b.type === "codeBlock") {
      for (const n of b.content || []) if (n && typeof n.text === "string") s += n.text;
    }
  }
  return s;
}

function hasMarkerNode(b) {
  return b && b.type === "paragraph" && /^\(continued — part \d+ of \d+\)$/.test(flattenText({ type: "doc", version: 1, content: [b] }));
}

/* ── Test 3b: 50k code block with NO newlines (minified) ───────────── */
(function () {
  const code = { type: "codeBlock", content: [{ type: "text", text: "x".repeat(60000) }] };
  const full = doc(code);
  console.log(`\nTest 3b: minified code block, no newlines (full=${JSON.stringify(full).length})`);
  const { parts, lossy } = splitAdfIntoParts(full, { attributionNode: attribution() });
  check("Test 3b: produced >1 part", parts.length > 1, `parts=${parts.length}`);
  assertAllPartsFit("Test 3b", parts);
  const totalX = parts.map((p) => flattenText(p)).join("").match(/x/g).length;
  check("Test 3b: all 60000 chars preserved", totalX === 60000, `got=${totalX}`);
  check("Test 3b: lossy flagged (hard char split)", lossy === true);
})();

/* ── Test 4: giant list ────────────────────────────────────────────── */
(function () {
  const items = [];
  for (let i = 0; i < 4000; i++) {
    items.push({ type: "listItem", content: [para(`Item ${i} with filler content to add bulk here.`)] });
  }
  const list = { type: "bulletList", content: items };
  const full = doc(list);
  console.log(`\nTest 4: giant bulletList (full=${JSON.stringify(full).length})`);
  const { parts, lossy } = splitAdfIntoParts(full, { attributionNode: attribution() });
  check("Test 4: produced >1 part", parts.length > 1, `parts=${parts.length}`);
  assertAllPartsFit("Test 4", parts);
  check("Test 4: bulletList split is not lossy", lossy === false);
})();

/* ── Test 5: giant blockquote ──────────────────────────────────────── */
(function () {
  const inner = [];
  for (let i = 0; i < 4000; i++) inner.push(para(`Quoted line ${i} with filler text content.`));
  const bq = { type: "blockquote", content: inner };
  const full = doc(bq);
  console.log(`\nTest 5: giant blockquote (full=${JSON.stringify(full).length})`);
  const { parts } = splitAdfIntoParts(full, { attributionNode: attribution() });
  check("Test 5: produced >1 part", parts.length > 1, `parts=${parts.length}`);
  assertAllPartsFit("Test 5", parts);
})();

/* ── Test 6: determinism ───────────────────────────────────────────── */
(function () {
  const blocks = [];
  for (let i = 0; i < 4000; i++) blocks.push(para(`Determinism line ${i} filler filler filler.`));
  console.log(`\nTest 6: determinism`);
  const a = splitAdfIntoParts(doc(...blocks), { attributionNode: attribution() });
  const b = splitAdfIntoParts(doc(...blocks), { attributionNode: attribution() });
  check("Test 6: identical partTotal", a.partTotal === b.partTotal);
  check("Test 6: byte-identical parts", JSON.stringify(a.parts) === JSON.stringify(b.parts));
})();

/* ── Test 7: small comment stays single-part-friendly ──────────────── */
(function () {
  console.log(`\nTest 7: small comment (under budget) — caller would not split, but splitter must still be safe`);
  const full = doc(para("Just a short comment."));
  check("Test 7: full is under budget", JSON.stringify(full).length <= BUDGET);
  const { parts, partTotal } = splitAdfIntoParts(full, { attributionNode: attribution() });
  check("Test 7: single part", partTotal === 1 && parts.length === 1);
  check("Test 7: single part has attribution", hasAttribution(parts[0]));
})();

/* ── Test 8: pathological single oversized inline node (giant mention) ─ */
(function () {
  // A mention whose attrs.text alone dwarfs the budget. Cannot be subdivided
  // structurally — must be flattened to plaintext, never emitted over-cap (C1).
  const mention = { type: "mention", attrs: { id: "x", text: "@" + "z".repeat(40000), userType: "DEFAULT" } };
  const full = doc({ type: "paragraph", content: [{ type: "text", text: "see " }, mention] });
  console.log(`\nTest 8: giant single mention (full=${JSON.stringify(full).length})`);
  const { parts, lossy } = splitAdfIntoParts(full, { attributionNode: attribution() });
  check("Test 8: produced >1 part", parts.length > 1, `parts=${parts.length}`);
  assertAllPartsFit("Test 8", parts);
  check("Test 8: lossy flagged (flattened to plaintext)", lossy === true);
})();

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
