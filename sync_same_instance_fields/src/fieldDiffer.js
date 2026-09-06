// =============================================================================
// fieldDiffer.js — same-instance per-field diff engine.
//
// For each resolved (migrated) source → target pair:
//   1. Read the source field value from issueFields.
//   2. Translate via the type handler (identity for same-instance).
//   3. Validate against target's allowedValues.
//   4. Normalize both values and compare.
//   5. Decide: match (skip) | set_missing (target empty) | overwrite_diff.
//
// Simplified vs DC-to-Cloud:
//   - No UserMapper: users on same instance already have accountId.
//   - No htmlToAdf: rich text is already ADF on both sides.
//   - No DC value translation: all types are identity on same instance.
// =============================================================================

const registry = require("./typeRegistry");

function preview(v) {
  if (v == null) return "";
  let s;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > 140 ? s.substring(0, 140) + "…" : s;
}

/**
 * Validate a translated write value against a Cloud field's allowedValues.
 * Returns { ok: true } or { ok: false, badValue }.
 */
function validateAllowed(writeValue, category, allowedValues) {
  if (!Array.isArray(allowedValues) || allowedValues.length === 0) return { ok: true };
  const lc = (s) => String(s == null ? "" : s).trim().toLowerCase();

  if (category === "option") {
    const ok = allowedValues.some((av) => lc(av.value) === lc(writeValue.value));
    return ok ? { ok: true } : { ok: false, badValue: writeValue.value };
  }
  if (category === "multioption") {
    for (const item of writeValue) {
      const ok = allowedValues.some((av) => lc(av.value) === lc(item.value));
      if (!ok) return { ok: false, badValue: item.value };
    }
    return { ok: true };
  }
  if (category === "cascading") {
    const parent = allowedValues.find((av) => lc(av.value) === lc(writeValue.value));
    if (!parent) return { ok: false, badValue: writeValue.value };
    if (writeValue.child) {
      const children = parent.children || parent.cascadingOptions || [];
      const ok = children.some((c) => lc(c.value) === lc(writeValue.child.value));
      if (!ok) return { ok: false, badValue: `${writeValue.value} / ${writeValue.child.value}` };
    }
    return { ok: true };
  }
  if (category === "version" || category === "multiversion") {
    const items = category === "version" ? [writeValue] : writeValue;
    for (const it of items) {
      const ok = allowedValues.some((av) => lc(av.name) === lc(it.name));
      if (!ok) return { ok: false, badValue: it.name };
    }
    return { ok: true };
  }
  return { ok: true };
}

function isEmptyWrite(v) {
  if (v == null) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

/**
 * @param pairs           resolved source→target pairs from fieldResolver.
 * @param issueFields     Cloud issue field-value object (both source and target).
 * @param editmeta        Cloud editmeta fields (for allowedValues).
 * @param ctx             { optionMaps: Map<lcName,map>, richTextOverwrite: string }
 * @returns { fieldPlans, skips }
 */
async function diffIssue(pairs, issueFields, editmeta, ctx) {
  const fieldPlans = [];
  const skips = [];

  for (const pair of pairs) {
    const sourceRaw = issueFields[pair.sourceFieldId];
    if (!registry.hasData(sourceRaw)) continue;

    const category = pair.handler.category;
    const optionMap =
      ctx.optionMaps && ctx.optionMaps.get(String(pair.targetName).trim().toLowerCase())
        ? ctx.optionMaps.get(String(pair.targetName).trim().toLowerCase())
        : null;

    // Translate the source value to the Cloud write shape.
    // For same-instance, this is effectively identity for most types,
    // but the optionMap remap may still apply.
    const translateCtx = { optionMap };
    let writeValue;
    try {
      if (category === "user" || category === "multiuser") {
        // Same-instance: source users already carry Cloud accountIds, so copy
        // them straight through. The shared DC→Cloud user handler resolves by
        // email via a userMapper we intentionally don't wire here — and many of
        // these accounts have no email exposed, which would make it throw.
        const arr = Array.isArray(sourceRaw) ? sourceRaw : [sourceRaw];
        const accts = arr
          .filter((u) => u && u.accountId)
          .map((u) => ({ accountId: u.accountId }));
        writeValue = category === "user" ? accts[0] || null : accts;
      } else {
        writeValue = await pair.handler.translate(sourceRaw, pair.sourceSchema, translateCtx);
      }
    } catch (e) {
      skips.push({
        targetFieldId: pair.targetFieldId,
        sourceFieldId: pair.sourceFieldId,
        targetName: pair.targetFieldName,
        reason: String(e.message || e).startsWith("user_unmappable")
          ? e.message
          : `translate_error:${e.message}`,
      });
      continue;
    }

    if (isEmptyWrite(writeValue)) {
      skips.push({
        targetFieldId: pair.targetFieldId,
        sourceFieldId: pair.sourceFieldId,
        targetName: pair.targetFieldName,
        reason: "translate_empty",
      });
      continue;
    }

    // Validate against target's allowedValues.
    const allowed = validateAllowed(
      writeValue,
      category,
      editmeta?.[pair.targetFieldId]?.allowedValues,
    );
    if (!allowed.ok) {
      skips.push({
        targetFieldId: pair.targetFieldId,
        sourceFieldId: pair.sourceFieldId,
        targetName: pair.targetFieldName,
        reason: `option_not_in_target_allowedvalues:${allowed.badValue}`,
      });
      continue;
    }

    // Normalize and compare.
    const sourceNorm = pair.handler.normalize(writeValue, pair.targetSchema);
    const targetCurrent = issueFields[pair.targetFieldId];
    const targetNorm = pair.handler.normalize(targetCurrent, pair.targetSchema);

    if (registry.equalNorm(sourceNorm, targetNorm)) {
      continue; // already correct — natural idempotency
    }

    const action = registry.hasData(targetCurrent) ? "overwrite_diff" : "set_missing";
    const fidelity = "exact"; // same-instance: no conversion fidelity issues

    // Rich-text guard: even though both are ADF, the proseKey comparison
    // may miss structural differences. Allow overwrite only when policy permits.
    if (category === "richtext" && action === "overwrite_diff") {
      const policy = ctx.richTextOverwrite || "missing_only";
      if (policy === "missing_only") {
        skips.push({
          targetFieldId: pair.targetFieldId,
          sourceFieldId: pair.sourceFieldId,
          targetName: pair.targetFieldName,
          reason: "richtext_overwrite_disabled",
        });
        continue;
      }
      if (policy === "high_fidelity") {
        // On same-instance, both are already ADF — this is always high fidelity.
        // No skip needed.
      }
    }

    fieldPlans.push({
      targetFieldId: pair.targetFieldId,
      sourceFieldId: pair.sourceFieldId,
      name: pair.targetFieldName,
      category,
      reason: pair.reason,
      action,
      writeValue,
      fidelity,
      sourcePreview: preview(writeValue),
      targetPreview: preview(targetCurrent),
    });
  }

  return { fieldPlans, skips };
}

module.exports = { diffIssue, validateAllowed };
