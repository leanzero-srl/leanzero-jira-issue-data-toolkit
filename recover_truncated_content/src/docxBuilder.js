const fs = require("fs");
const path = require("path");
const htmlToDocx = require("@turbodocx/html-to-docx");

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const DEFAULT_OPTIONS = {
  orientation: "portrait",
  font: "Calibri",
  fontSize: 22, // half-points → 11pt
  margins: { top: 720, right: 720, bottom: 720, left: 720 },
};

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Defensive pre-processing of Jira-rendered HTML before it goes into the docx
 * converter. Strips elements that would either break conversion or pull in
 * unauthorised resources, and replaces images with text placeholders (v1
 * limitation — see README).
 */
function sanitizeHtml(html) {
  if (!html) return "";
  let h = String(html);
  h = h.replace(/<script[\s\S]*?<\/script>/gi, "");
  h = h.replace(/<style[\s\S]*?<\/style>/gi, "");
  // Replace <img> with [Image: filename] placeholder for tags that have a src,
  // then strip any remaining <img> tags (srcless `<img role="presentation"/>`
  // and friends — turbodocx crashes on them with "Invalid base64 string").
  h = h.replace(/<img\b[^>]*src=["']([^"']+)["'][^>]*\/?>/gi, (_, src) => {
    const fname = (src.split("?")[0].split("/").pop() || "image").trim();
    return `<p><em>[Image: ${escapeHtml(fname)}]</em></p>`;
  });
  h = h.replace(/<img\b[^>]*\/?>/gi, "");
  h = h.replace(/\son\w+="[^"]*"/gi, "");
  h = h.replace(/\son\w+='[^']*'/gi, "");
  // html-to-docx crashes on inline `style="font-family: ..."` (calls createFont
  // on undefined). Easiest reliable fix is to drop inline style attributes
  // entirely — structural/inline tags still convey formatting, and our docx
  // options set a default font.
  h = h.replace(/\sstyle="[^"]*"/gi, "");
  h = h.replace(/\sstyle='[^']*'/gi, "");
  // Same library also chokes on <font face="..."> tags. Strip the wrapper but
  // keep the inner text.
  h = h.replace(/<font[^>]*>/gi, "");
  h = h.replace(/<\/font>/gi, "");
  return h;
}

function wrapDescription(issueKey, htmlBody) {
  return (
    `<!doctype html><html><body>` +
    `<h1>${escapeHtml(issueKey)} &mdash; Description</h1>` +
    `<div>${htmlBody || "<p><em>(no description)</em></p>"}</div>` +
    `</body></html>`
  );
}

function wrapComments(issueKey, sectionsHtml) {
  return (
    `<!doctype html><html><body>` +
    `<h1>${escapeHtml(issueKey)} &mdash; Comments</h1>` +
    sectionsHtml +
    `</body></html>`
  );
}

function commentSection(c, index) {
  const author = c.author?.displayName || c.author?.name || "Unknown";
  const created = c.created || "(unknown date)";
  const body = sanitizeHtml(c.rendered || c.storage || "<p><em>(empty)</em></p>");
  return (
    `<hr>` +
    `<h2>Comment #${index + 1} &mdash; ${escapeHtml(author)} &mdash; ${escapeHtml(created)}</h2>` +
    `<div>${body}</div>`
  );
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function unlinkSafe(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/**
 * Idempotency: remove any prior artifacts for this issue+type before writing
 * so re-runs don't leave stale `_2.docx` files when the new content fits in
 * one part. Matches both `{KEY}_{type}.docx` and `{KEY}_{type}_<n>.docx`.
 */
function cleanupExistingArtifacts(outDir, issueKey, type) {
  if (!fs.existsSync(outDir)) return;
  const exact = `${issueKey}_${type}.docx`;
  const splitPrefix = `${issueKey}_${type}_`;
  for (const f of fs.readdirSync(outDir)) {
    if (f === exact) {
      unlinkSafe(path.join(outDir, f));
    } else if (f.startsWith(splitPrefix) && f.endsWith(".docx")) {
      unlinkSafe(path.join(outDir, f));
    }
  }
}

async function buildDescriptionDocx({ issueKey, html, outDir, options = {} }) {
  ensureDir(outDir);
  cleanupExistingArtifacts(outDir, issueKey, "description");
  const sanitized = sanitizeHtml(html);
  const fullHtml = wrapDescription(issueKey, sanitized);
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const buf = await htmlToDocx(fullHtml, null, opts);
  const filename = `${issueKey}_description.docx`;
  const outPath = path.join(outDir, filename);
  fs.writeFileSync(outPath, buf);
  return [{ path: outPath, size: buf.length, type: "description" }];
}

/**
 * Build one or more `{KEY}_comment[.docx | _<n>.docx]` files.
 * Algorithm:
 *   1. Try a single file containing all comments. If it fits, write it
 *      unsuffixed and return.
 *   2. Otherwise, greedily accumulate comment sections; whenever adding the
 *      next section would push the converted buffer over `maxBytes`, flush
 *      the current accumulation as `_<n>.docx` and start the next part.
 *   3. If a single section alone exceeds the cap, write it alone (oversize:true
 *      on the result) and log a warning — Cloud will reject if > maxAttachmentSize,
 *      caller decides what to do.
 *
 * The greedy approach re-converts at each step (O(N²)), which is fine because
 * the truncation hit-rate is rare; typical issues with truncated comments will
 * have a handful of sections at most.
 */
async function buildCommentsDocx({
  issueKey,
  comments,
  outDir,
  options = {},
  maxBytes = 10485760,
  log = console.log,
}) {
  ensureDir(outDir);
  cleanupExistingArtifacts(outDir, issueKey, "comment");
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const sections = comments.map((c, i) => commentSection(c, i));

  if (sections.length === 0) {
    const fullHtml = wrapComments(issueKey, `<p><em>(no comments)</em></p>`);
    const buf = await htmlToDocx(fullHtml, null, opts);
    const outPath = path.join(outDir, `${issueKey}_comment.docx`);
    fs.writeFileSync(outPath, buf);
    return [{ path: outPath, size: buf.length, type: "comment" }];
  }

  // Single-file attempt
  const allBuf = await htmlToDocx(
    wrapComments(issueKey, sections.join("\n")),
    null,
    opts,
  );
  if (allBuf.length <= maxBytes) {
    const outPath = path.join(outDir, `${issueKey}_comment.docx`);
    fs.writeFileSync(outPath, allBuf);
    return [{ path: outPath, size: allBuf.length, type: "comment" }];
  }

  // Split
  log(
    `    [docx] ${issueKey}: single-file ${allBuf.length}B > ${maxBytes}B cap, splitting...`,
  );
  const results = [];
  let currentSections = [];
  let currentBuf = null;
  let partIndex = 1;

  for (const section of sections) {
    const trialBuf = await htmlToDocx(
      wrapComments(issueKey, [...currentSections, section].join("\n")),
      null,
      opts,
    );

    if (trialBuf.length <= maxBytes) {
      currentSections.push(section);
      currentBuf = trialBuf;
      continue;
    }

    if (currentBuf == null) {
      // The single section alone is over the cap.
      const outPath = path.join(outDir, `${issueKey}_comment_${partIndex}.docx`);
      fs.writeFileSync(outPath, trialBuf);
      results.push({
        path: outPath,
        size: trialBuf.length,
        type: "comment",
        oversize: true,
      });
      log(
        `    [docx] ${issueKey}: single comment exceeds cap (${trialBuf.length}B) — wrote ${path.basename(outPath)} anyway`,
      );
      partIndex++;
      currentSections = [];
      currentBuf = null;
      continue;
    }

    const outPath = path.join(outDir, `${issueKey}_comment_${partIndex}.docx`);
    fs.writeFileSync(outPath, currentBuf);
    results.push({ path: outPath, size: currentBuf.length, type: "comment" });
    partIndex++;
    currentSections = [section];
    currentBuf = await htmlToDocx(
      wrapComments(issueKey, currentSections.join("\n")),
      null,
      opts,
    );
  }

  if (currentSections.length > 0 && currentBuf != null) {
    const outPath = path.join(outDir, `${issueKey}_comment_${partIndex}.docx`);
    fs.writeFileSync(outPath, currentBuf);
    results.push({ path: outPath, size: currentBuf.length, type: "comment" });
  }

  return results;
}

module.exports = {
  buildDescriptionDocx,
  buildCommentsDocx,
  DOCX_MIME,
  // Exposed for tests / re-use
  _internal: { sanitizeHtml, escapeHtml, commentSection },
};
