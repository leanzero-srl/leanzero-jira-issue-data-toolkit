/**
 * Audit emitter — turns a plan file into human-readable CSV + Markdown so an
 * operator can spot-check what APPLY would do without running it.
 *
 * Plan shape (one entry per Cloud issue):
 *   plan.issues[issueKey] = {
 *     status: "pending"|"applied"|"failed"|"skipped",
 *     comments: [
 *       {
 *         commentId, cloudAuthor, dcAuthor, matchSource, confidence,
 *         skipReason,
 *         hashBefore, hashAfter,
 *         changes: { mentionsReplaced[], semicolonsCollapsed[], semicolonsAmbiguous[] },
 *         beforeSnippet, afterSnippet,
 *       }
 *     ],
 *   }
 */

const fs = require("fs");
const path = require("path");

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function summarizeMentions(replaced) {
  if (!Array.isArray(replaced) || replaced.length === 0) return "";
  const counts = { mention: 0, plain: 0, skip: 0 };
  for (const m of replaced) counts[m.mode] = (counts[m.mode] || 0) + 1;
  const parts = [];
  if (counts.mention) parts.push(`${counts.mention} resolved`);
  if (counts.plain) parts.push(`${counts.plain} plain-text`);
  if (counts.skip) parts.push(`${counts.skip} skipped`);
  return parts.join(", ");
}

function summarizeMentionDetails(replaced) {
  if (!Array.isArray(replaced) || replaced.length === 0) return "";
  return replaced
    .map((m) => {
      const targetId = m.accountId ? m.accountId.slice(-12) : "—";
      const note = m.note ? ` (${m.note})` : "";
      return `[~${m.dcUsername} → ${m.mode}:${targetId}${note}]`;
    })
    .join(" ");
}

function summarizeSemicolons(collapsed, ambiguous) {
  const c = Array.isArray(collapsed) ? collapsed.length : 0;
  const a = Array.isArray(ambiguous) ? ambiguous.length : 0;
  if (c === 0 && a === 0) return "";
  const parts = [];
  if (c) parts.push(`${c} collapsed`);
  if (a) parts.push(`${a} ambiguous`);
  return parts.join(", ");
}

function writeAuditCsv(rows, outPath) {
  const cols = [
    "issueKey",
    "commentId",
    "skipReason",
    "matchSource",
    "confidence",
    "cloudAuthor",
    "dcAuthor",
    "mentions",
    "mentionDetails",
    "semicolons",
    "hashBefore",
    "hashAfter",
    "beforeSnippet",
    "afterSnippet",
  ];
  const lines = [cols.join(",")];
  for (const r of rows) {
    lines.push(cols.map((c) => csvEscape(r[c])).join(","));
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
}

function writeAuditMd(rows, outPath, summary) {
  const lines = [];
  lines.push("# mend_comments — Audit");
  lines.push("");
  lines.push("## Run summary");
  for (const [k, v] of Object.entries(summary || {})) {
    lines.push(`- **${k}**: ${v}`);
  }
  lines.push("");
  lines.push("## Per-comment proposed edits");
  lines.push("");
  for (const r of rows) {
    lines.push(`### ${r.issueKey} / comment ${r.commentId}`);
    if (r.skipReason) lines.push(`*Skipped:* \`${r.skipReason}\``);
    lines.push(`- Match: \`${r.matchSource || "—"}\` (confidence: ${r.confidence || "—"})`);
    lines.push(`- Cloud author: \`${r.cloudAuthor || "—"}\` / DC author: \`${r.dcAuthor || "—"}\``);
    lines.push(`- Mentions: ${r.mentions || "—"}`);
    if (r.mentionDetails) lines.push(`  - ${r.mentionDetails}`);
    lines.push(`- Semicolons: ${r.semicolons || "—"}`);
    lines.push("");
    if (r.beforeSnippet || r.afterSnippet) {
      lines.push("```diff");
      lines.push("- " + (r.beforeSnippet || "").replace(/\n/g, "\n- "));
      lines.push("+ " + (r.afterSnippet || "").replace(/\n/g, "\n+ "));
      lines.push("```");
      lines.push("");
    }
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
}

/**
 * Flatten a loaded plan into per-comment rows ready for CSV/MD emission.
 */
function flattenPlan(plan) {
  const rows = [];
  const issues = plan && plan.issues ? plan.issues : {};
  for (const [issueKey, data] of Object.entries(issues)) {
    const comments = Array.isArray(data && data.comments) ? data.comments : [];
    for (const c of comments) {
      rows.push({
        issueKey,
        commentId: c.commentId || "",
        skipReason: c.skipReason || (data.status === "skipped" ? data.skipReason || "" : ""),
        matchSource: c.matchSource || "",
        confidence: c.confidence || "",
        cloudAuthor: c.cloudAuthor || "",
        dcAuthor: c.dcAuthor || "",
        mentions: summarizeMentions(c.changes && c.changes.mentionsReplaced),
        mentionDetails: summarizeMentionDetails(c.changes && c.changes.mentionsReplaced),
        semicolons: summarizeSemicolons(
          c.changes && c.changes.semicolonsCollapsed,
          c.changes && c.changes.semicolonsAmbiguous,
        ),
        hashBefore: c.hashBefore || "",
        hashAfter: c.hashAfter || "",
        beforeSnippet: c.beforeSnippet || "",
        afterSnippet: c.afterSnippet || "",
      });
    }
    if (comments.length === 0 && data.skipReason) {
      rows.push({
        issueKey,
        commentId: "",
        skipReason: data.skipReason,
        matchSource: "",
        confidence: "",
        cloudAuthor: "",
        dcAuthor: "",
        mentions: "",
        mentionDetails: "",
        semicolons: "",
        hashBefore: "",
        hashAfter: "",
        beforeSnippet: "",
        afterSnippet: "",
      });
    }
  }
  return rows;
}

module.exports = {
  flattenPlan,
  writeAuditCsv,
  writeAuditMd,
};
