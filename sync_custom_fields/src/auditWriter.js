// auditWriter.js — render a plan into a per-field CSV + a Markdown summary.
const fs = require("fs");

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const CSV_COLUMNS = [
  "issueKey",
  "cloudFieldId",
  "dcFieldId",
  "fieldName",
  "category",
  "action",
  "reason",
  "fidelity",
  "dcValue",
  "cloudValue",
];

/**
 * Flatten a plan into one row per field-plan AND one row per skip.
 * Returns { rows, summary }.
 */
function flattenPlan(plan) {
  const rows = [];
  const summary = {
    issues: 0,
    issuesWithChanges: 0,
    setMissing: 0,
    overwriteDiff: 0,
    skips: {},
    ambiguities: {},
    fidelity: {},
    lowFidelity: 0,
  };

  for (const [issueKey, data] of Object.entries(plan.issues || {})) {
    summary.issues++;
    const fps = data.fieldPlans || [];
    if (fps.length) summary.issuesWithChanges++;

    for (const fp of fps) {
      if (fp.action === "set_missing") summary.setMissing++;
      else if (fp.action === "overwrite_diff") summary.overwriteDiff++;
      summary.fidelity[fp.fidelity] = (summary.fidelity[fp.fidelity] || 0) + 1;
      if (fp.fidelity === "adf_from_plaintext") summary.lowFidelity++;
      rows.push({
        issueKey,
        cloudFieldId: fp.cloudFieldId,
        dcFieldId: fp.dcFieldId,
        fieldName: fp.name,
        category: fp.category,
        action: fp.action,
        reason: fp.reason,
        fidelity: fp.fidelity,
        dcValue: fp.dcPreview,
        cloudValue: fp.cloudPreview,
      });
    }

    for (const sk of data.skips || []) {
      const key = String(sk.reason || "skip").split(":")[0];
      summary.skips[key] = (summary.skips[key] || 0) + 1;
      rows.push({
        issueKey,
        cloudFieldId: sk.cloudFieldId,
        dcFieldId: sk.dcFieldId || "",
        fieldName: sk.name,
        category: "",
        action: "skip",
        reason: sk.reason,
        fidelity: "",
        dcValue: "",
        cloudValue: "",
      });
    }

    for (const am of data.ambiguities || []) {
      summary.ambiguities[am.reason] = (summary.ambiguities[am.reason] || 0) + 1;
      rows.push({
        issueKey,
        cloudFieldId: am.cloudFieldId,
        dcFieldId: (am.candidates || []).join(" | "),
        fieldName: am.name,
        category: "",
        action: "ambiguity",
        reason: am.reason,
        fidelity: "",
        dcValue: "",
        cloudValue: "",
      });
    }
  }

  return { rows, summary };
}

function writeAuditCsv(rows, outPath) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(CSV_COLUMNS.map((c) => csvEscape(r[c])).join(","));
  }
  fs.writeFileSync(outPath, lines.join("\n") + "\n");
}

function writeAuditMd(summary, outPath, meta = {}) {
  const L = [];
  L.push(`# Custom-field sync audit`);
  L.push("");
  if (meta.runId) L.push(`- runId: \`${meta.runId}\``);
  if (meta.planFile) L.push(`- plan: \`${meta.planFile}\``);
  L.push(`- issues scanned: **${summary.issues}**`);
  L.push(`- issues with changes: **${summary.issuesWithChanges}**`);
  L.push(`- fields to set (was empty): **${summary.setMissing}**`);
  L.push(`- fields to overwrite (differs): **${summary.overwriteDiff}**`);
  L.push(`- low-fidelity ADF conversions (plaintext fallback): **${summary.lowFidelity}**`);
  L.push("");
  L.push(`## Skips by reason`);
  const skipKeys = Object.keys(summary.skips).sort();
  if (!skipKeys.length) L.push(`_none_`);
  for (const k of skipKeys) L.push(`- ${k}: ${summary.skips[k]}`);
  L.push("");
  L.push(`## Ambiguities (need field_overrides.json pins)`);
  const amKeys = Object.keys(summary.ambiguities).sort();
  if (!amKeys.length) L.push(`_none_`);
  for (const k of amKeys) L.push(`- ${k}: ${summary.ambiguities[k]}`);
  L.push("");
  L.push(`## Fidelity breakdown`);
  for (const k of Object.keys(summary.fidelity).sort()) L.push(`- ${k}: ${summary.fidelity[k]}`);
  L.push("");
  fs.writeFileSync(outPath, L.join("\n"));
}

module.exports = { flattenPlan, writeAuditCsv, writeAuditMd, CSV_COLUMNS };
