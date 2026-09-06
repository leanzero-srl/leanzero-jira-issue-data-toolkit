// =============================================================================
// fieldDiffer.js — per-issue, per-field diff. DC is the source of truth.
//
// For each resolved DC->Cloud pair:
//   1. translate the DC value into the Cloud write shape (type registry handler);
//   2. validate option/version values against editmeta allowedValues (skip+report
//      rather than provoke a 400);
//   3. normalize both the translated DC value and the current Cloud value, and
//      decide: match (no write) | set_missing (Cloud empty) | overwrite_diff.
// DC-empty fields never reach here (filtered during resolution) so Cloud is never
// blanked.
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
 * Only option/multioption/cascading/version categories have meaningful
 * allowedValues; everything else passes through.
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
 * @param resolution  { pairs } from fieldIndex.resolveForIssue
 * @param dcFields    DC issue field-value object
 * @param dcRendered  DC renderedFields object (HTML) for rich text
 * @param cloudFields Cloud issue field-value object
 * @param editmeta    Cloud editmeta `fields` (for allowedValues)
 * @param ctx         { userMapper, htmlToAdf, plaintextAdf, optionMaps:Map<lcName,map>, log }
 * @returns { fieldPlans, skips }
 */
async function diffIssue(resolution, dcFields, dcRendered, cloudFields, editmeta, ctx) {
  const fieldPlans = [];
  const skips = [];

  for (const pair of resolution.pairs) {
    const dcRaw = dcFields[pair.dcFieldId];
    if (!registry.hasData(dcRaw)) continue;

    const category = pair.handler.category;
    const optionMap =
      ctx.optionMaps && ctx.optionMaps.get(String(pair.name).trim().toLowerCase())
        ? ctx.optionMaps.get(String(pair.name).trim().toLowerCase())
        : null;

    const translateCtx = {
      userMapper: ctx.userMapper,
      htmlToAdf: ctx.htmlToAdf,
      plaintextAdf: ctx.plaintextAdf,
      optionMap,
      renderedHtml: dcRendered ? dcRendered[pair.dcFieldId] : null,
    };

    let writeValue;
    try {
      writeValue = await pair.handler.translate(dcRaw, pair.dcSchema, translateCtx);
    } catch (e) {
      skips.push({
        cloudFieldId: pair.cloudFieldId,
        dcFieldId: pair.dcFieldId,
        name: pair.name,
        reason: String(e.message || e).startsWith("user_unmappable")
          ? e.message
          : `translate_error:${e.message}`,
      });
      continue;
    }

    if (isEmptyWrite(writeValue)) {
      skips.push({ cloudFieldId: pair.cloudFieldId, dcFieldId: pair.dcFieldId, name: pair.name, reason: "translate_empty" });
      continue;
    }

    const allowed = validateAllowed(writeValue, category, editmeta?.[pair.cloudFieldId]?.allowedValues);
    if (!allowed.ok) {
      skips.push({
        cloudFieldId: pair.cloudFieldId,
        dcFieldId: pair.dcFieldId,
        name: pair.name,
        reason: `option_not_in_cloud_allowedvalues:${allowed.badValue}`,
      });
      continue;
    }

    const dcNorm = pair.handler.normalize(writeValue, pair.cloudSchema);
    const cloudCurrent = cloudFields[pair.cloudFieldId];
    const cloudNorm = pair.handler.normalize(cloudCurrent, pair.cloudSchema);

    if (registry.equalNorm(dcNorm, cloudNorm)) {
      continue; // already correct — natural idempotency
    }

    const action = registry.hasData(cloudCurrent) ? "overwrite_diff" : "set_missing";
    const fidelity =
      category === "richtext" ? `adf_from_${translateCtx._adfSource || "plaintext"}` : "exact";

    // Rich-text guard: DC->ADF is lossy (htmlToAdf can't reproduce JCMA's tables
    // / lists, so it falls back to plaintext, which would CLOBBER good Cloud ADF
    // with raw wiki markup). Only overwrite existing Cloud rich text when the
    // operator opts in. Filling an empty field (set_missing) is always allowed.
    if (category === "richtext" && action === "overwrite_diff") {
      const policy = ctx.richTextOverwrite || "missing_only";
      if (policy === "missing_only") {
        skips.push({ cloudFieldId: pair.cloudFieldId, dcFieldId: pair.dcFieldId, name: pair.name, reason: "richtext_overwrite_disabled" });
        continue;
      }
      if (policy === "high_fidelity" && translateCtx._adfSource === "plaintext") {
        skips.push({ cloudFieldId: pair.cloudFieldId, dcFieldId: pair.dcFieldId, name: pair.name, reason: "richtext_lowfidelity_skip" });
        continue;
      }
      // policy === "all" falls through and overwrites.
    }

    fieldPlans.push({
      cloudFieldId: pair.cloudFieldId,
      dcFieldId: pair.dcFieldId,
      name: pair.name,
      category,
      reason: pair.reason,
      action,
      writeValue,
      fidelity,
      dcPreview: preview(writeValue),
      cloudPreview: preview(cloudCurrent),
    });
  }

  return { fieldPlans, skips };
}

module.exports = { diffIssue, validateAllowed };
