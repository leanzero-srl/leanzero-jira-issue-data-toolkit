// auditWriter.js — render a plan into a per-field CSV + a Markdown summary.
// Forked from sync_custom_fields/auditWriter.js for same-instance sync.
// Columns renamed: dcFieldId→sourceFieldId, dcValue→sourceValue.
// Removed lowFidelity tracking (no DC→ADF conversion on same instance).

const fs = require("fs");

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const CSV_COLUMNS = [
  "issueKey",
  "sourceFieldId",
  "sourceFieldName",
  "targetFieldId",
  "targetFieldName",
  "category",
  "action",
  "reason",
  "fidelity",
  "sourceValue",
  "targetValue",
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
  };

  for (const [issueKey, data] of Object.entries(plan.issues || {})) {
    summary.issues++;
    const fps = data.fieldPlans || [];
    if (fps.length) summary.issuesWithChanges++;

    for (const fp of fps) {
      if (fp.action === "set_missing") summary.setMissing++;
      else if (fp.action === "overwrite_diff") summary.overwriteDiff++;
      rows.push({
        issueKey,
        sourceFieldId: fp.sourceFieldId || "",
        sourceFieldName: fp.name,
        targetFieldId: fp.targetFieldId || fp.cloudFieldId,
        targetFieldName: fp.name,
        category: fp.category,
        action: fp.action,
        reason: fp.reason,
        fidelity: fp.fidelity || "",
        sourceValue: fp.sourcePreview || fp.dcPreview || "",
        targetValue: fp.targetPreview || fp.cloudPreview || "",
      });
    }

    for (const sk of data.skips || []) {
      const key = String(sk.reason || "skip").split(":")[0];
      summary.skips[key] = (summary.skips[key] || 0) + 1;
      rows.push({
        issueKey,
        sourceFieldId: sk.sourceFieldId || sk.dcFieldId || "",
        sourceFieldName: sk.name,
        targetFieldId: sk.targetFieldId || sk.cloudFieldId || "",
        targetFieldName: sk.name,
        category: "",
        action: "skip",
        reason: sk.reason,
        fidelity: "",
        sourceValue: "",
        targetValue: "",
      });
    }

    for (const am of data.ambiguities || []) {
      summary.ambiguities[am.reason] = (summary.ambiguities[am.reason] || 0) + 1;
      rows.push({
        issueKey,
        sourceFieldId: am.sourceFieldId || "",
        sourceFieldName: am.sourceName || am.name,
        targetFieldId: am.targetFieldId || am.cloudFieldId || "",
        targetFieldName: am.targetName || am.name,
        category: "",
        action: "ambiguity",
        reason: am.reason,
        fidelity: "",
        sourceValue: "",
        targetValue: "",
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
  L.push(`# Same-instance custom-field sync audit`);
  L.push("");
  if (meta.runId) L.push(`- runId: \`${meta.runId}\``);
  if (meta.planFile) L.push(`- plan: \`${meta.planFile}\``);
  L.push(`- issues scanned: **${summary.issues}**`);
  L.push(`- issues with changes: **${summary.issuesWithChanges}**`);
  L.push(`- fields to set (was empty): **${summary.setMissing}**`);
  L.push(`- fields to overwrite (differs): **${summary.overwriteDiff}**`);
  L.push("");
  L.push(`## Skips by reason`);
  const skipKeys = Object.keys(summary.skips).sort();
  if (!skipKeys.length) L.push(`_none_`);
  for (const k of skipKeys) L.push(`- ${k}: ${summary.skips[k]}`);
  L.push("");
  L.push(`## Ambiguities (need config/field_overrides.json pins)`);
  const amKeys = Object.keys(summary.ambiguities).sort();
  if (!amKeys.length) L.push(`_none_`);
  for (const k of amKeys) L.push(`- ${k}: ${summary.ambiguities[k]}`);
  L.push("");
  fs.writeFileSync(outPath, L.join("\n"));
}

module.exports = { flattenPlan, writeAuditCsv, writeAuditMd, CSV_COLUMNS };
