/**
 * Audit emission for sync_issue_comments plans.
 *
 * Plan shape per issue:
 *   issues[issueKey] = {
 *     status: "pending" | ...,
 *     toCreate: [{ dcCommentId, dcAuthor, created, internal, visibilityFallback,
 *                  visibility, fidelity, unknownTags, snippet, adfSize,
 *                  partTotal, parts }, ...],   // partTotal>1 ⇒ oversized, split
 *     skipped:  [{ dcCommentId, dcAuthor, created, reason }, ...],
 *   }
 */

const fs = require("fs");
const path = require("path");

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const CSV_COLS = [
  "issueKey",
  "dcCommentId",
  "kind",
  "reason",
  "created",
  "dcAuthor",
  "internal",
  "visibilityFallback",
  "visibility",
  "fidelity",
  "unknownTags",
  "adfSize",
  "partTotal",
  "snippet",
];

function flattenPlan(plan) {
  const rows = [];
  const issues = plan && plan.issues ? plan.issues : {};
  for (const [issueKey, data] of Object.entries(issues)) {
    for (const c of data.toCreate || []) {
      rows.push({
        issueKey,
        dcCommentId: c.dcCommentId || "",
        kind: "create",
        reason: "",
        created: c.created || "",
        dcAuthor: c.dcAuthor || "",
        internal: c.internal === true ? "internal" : c.internal === false ? "public" : "",
        visibilityFallback: c.visibilityFallback || "",
        visibility: c.visibility ? JSON.stringify(c.visibility) : "",
        fidelity: c.fidelity || "",
        unknownTags: Array.isArray(c.unknownTags) ? c.unknownTags.join("|") : "",
        adfSize: c.adfSize != null ? c.adfSize : "",
        partTotal: c.partTotal != null ? c.partTotal : (Array.isArray(c.parts) ? c.parts.length : 1),
        snippet: c.snippet || "",
      });
    }
    for (const s of data.skipped || []) {
      rows.push({
        issueKey,
        dcCommentId: s.dcCommentId || "",
        kind: "skip",
        reason: s.reason || "",
        created: s.created || "",
        dcAuthor: s.dcAuthor || "",
        internal: "",
        visibilityFallback: "",
        visibility: "",
        fidelity: "",
        unknownTags: "",
        adfSize: "",
        snippet: s.snippet || "",
      });
    }
    if ((data.toCreate || []).length === 0 && (data.skipped || []).length === 0) {
      rows.push({
        issueKey,
        dcCommentId: "",
        kind: "issue",
        reason: data.skipReason || data.status || "no_changes",
        created: "",
        dcAuthor: "",
        internal: "",
        visibilityFallback: "",
        visibility: "",
        fidelity: "",
        unknownTags: "",
        adfSize: "",
        snippet: "",
      });
    }
  }
  return rows;
}

function writeAuditCsv(rows, outPath) {
  const lines = [CSV_COLS.join(",")];
  for (const r of rows) lines.push(CSV_COLS.map((c) => csvEscape(r[c])).join(","));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
}

function writeAuditMd(rows, outPath, summary) {
  const lines = [];
  lines.push("# sync_issue_comments — Audit");
  lines.push("");
  lines.push("## Run summary");
  for (const [k, v] of Object.entries(summary || {})) {
    lines.push(`- **${k}**: ${v}`);
  }
  lines.push("");

  const byIssue = new Map();
  for (const r of rows) {
    if (!byIssue.has(r.issueKey)) byIssue.set(r.issueKey, []);
    byIssue.get(r.issueKey).push(r);
  }
  lines.push("## Per-issue plan");
  lines.push("");
  for (const [issueKey, issueRows] of byIssue) {
    lines.push(`### ${issueKey}`);
    const creates = issueRows.filter((r) => r.kind === "create");
    const skips = issueRows.filter((r) => r.kind === "skip");
    lines.push(`- to inject: **${creates.length}**, skipped (already covered): **${skips.length}**`);
    for (const c of creates) {
      const flags = [];
      if (c.internal) flags.push(c.internal);
      if (c.visibilityFallback) flags.push(`fallback=${c.visibilityFallback}`);
      if (c.fidelity && c.fidelity !== "adf_full") flags.push(c.fidelity);
      if (Number(c.partTotal) > 1) flags.push(`split into ${c.partTotal} parts`);
      if (c.visibility) flags.push("visibility=" + c.visibility);
      lines.push(
        `  - **${c.dcCommentId}** @ ${c.created} by \`${c.dcAuthor}\`` +
        (flags.length ? ` — ${flags.join(", ")}` : ""),
      );
      if (c.snippet) lines.push(`    > ${c.snippet}`);
    }
    if (skips.length > 0) {
      lines.push("  - skipped:");
      for (const s of skips) {
        lines.push(`    - ${s.dcCommentId}: \`${s.reason}\``);
      }
    }
    lines.push("");
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
}

module.exports = {
  flattenPlan,
  writeAuditCsv,
  writeAuditMd,
};
