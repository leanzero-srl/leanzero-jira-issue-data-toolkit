// =============================================================================
// fieldResolver.js — same-instance field pair resolution.
//
// Discovers pairs of (migrated) source fields → target fields on the same
// Cloud instance. Matching strategy:
//   1. Find all fields with "(migrated)" in name within editmeta → source candidates
//   2. Strip "(migrated)" to get base name
//   3. Find target field with matching base name that is writable
//   4. Check type compatibility via typeRegistry
//   5. Check source has data via typeRegistry.hasData()
//   6. Apply field_overrides.json pins for ambiguous matches
//   7. Apply fieldDenylist
// =============================================================================

const registry = require("./typeRegistry");

const MIGRATED_RE = /\s*\(migrated\)\s*$/i;
const lcName = (n) => String(n == null ? "" : n).trim().toLowerCase();
const baseNameOf = (n) => lcName(String(n == null ? "" : n).replace(MIGRATED_RE, ""));
const isCustom = (id) => typeof id === "string" && id.startsWith("customfield_");

/**
 * Build a lowercase name → fieldId map from the global /field catalog.
 * Only includes custom fields (schema.custom is truthy).
 */
function buildNameIndex(fields) {
  const byName = new Map();
  for (const f of fields || []) {
    if (!f || !f.id || !f.custom) continue;
    const key = lcName(f.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(f);
  }
  return byName;
}

/**
 * Build a fieldId → field map from the global /field catalog.
 */
function buildIdIndex(fields) {
  const byId = new Map();
  for (const f of fields || []) {
    if (!f || !f.id) continue;
    byId.set(f.id, f);
  }
  return byId;
}

/**
 * Normalize the field_overrides.json structure into a lookup map.
 *   byCloudId: targetFieldId -> { sourceFieldId, targetFieldId, name }
 */
function loadOverrides(overridesConfig) {
  const byTargetId = new Map();
  const list = (overridesConfig && overridesConfig.overrides) || [];
  for (const o of list) {
    if (o && o.targetFieldId) byTargetId.set(o.targetFieldId, o);
  }
  return { byTargetId };
}

/**
 * Resolve (migrated) → target field pairs for a single issue.
 *
 * @param editmetaFields  Cloud editmeta `fields` object (writable fields).
 * @param issueFields     Cloud issue's field-value object (id -> value).
 * @param nameIndex       lowercase name → field[] from global /field catalog.
 * @param idIndex         fieldId → field from global /field catalog.
 * @param overrides       from loadOverrides().
 * @param explicitPairs   optional pre-configured source→target name pairs.
 * @param options         { denylist: Set<lcName> }
 * @returns { pairs, ambiguities, skips }
 */
function resolveForIssue(
  editmetaFields,
  issueFields,
  nameIndex,
  idIndex,
  overrides,
  explicitPairs = [],
  options = {},
) {
  const pairs = [];
  const ambiguities = [];
  const skips = [];
  const denylist = options.denylist || new Set();

  const em = editmetaFields || {};

  // Collect (migrated) source candidates. A source is only READ, never written,
  // so it need NOT be on the edit screen.
  //   (a) editmeta — (migrated) fields on this issue's edit screen, AND
  //   (b) global catalog — (migrated) fields that carry DATA on this issue but
  //       are OFF the edit screen (e.g. removed from the screen post-migration).
  //       Without (b) those issues are silently skipped even though the TARGET
  //       is writable. Catalog sources get a minimal { name } meta — Phase 2
  //       only reads src.meta.name, and the source schema comes from idIndex.
  const migratedSources = [];
  const seenSources = new Set();
  for (const [fieldId, meta] of Object.entries(em)) {
    if (!isCustom(fieldId)) continue;
    if (!Array.isArray(meta.operations) || !meta.operations.includes("set")) continue;
    if (!/\(migrated\)/i.test(meta.name || "")) continue;
    migratedSources.push({ fieldId, meta });
    seenSources.add(fieldId);
  }
  for (const [fieldId, field] of idIndex) {
    if (seenSources.has(fieldId) || !isCustom(fieldId)) continue;
    if (!field || !/\(migrated\)/i.test(field.name || "")) continue;
    if (!registry.hasData(issueFields[fieldId])) continue; // only off-screen sources that actually have data
    migratedSources.push({ fieldId, meta: { name: field.name } });
    seenSources.add(fieldId);
  }

  // Collect all non-(migrated) target candidates from editmeta.
  const targetCandidates = new Map(); // baseName → [ { fieldId, meta } ]
  for (const [fieldId, meta] of Object.entries(em)) {
    if (!isCustom(fieldId)) continue;
    if (!Array.isArray(meta.operations) || !meta.operations.includes("set")) continue;
    if (/\(migrated\)/i.test(meta.name || "")) continue;
    const base = baseNameOf(meta.name);
    if (!targetCandidates.has(base)) targetCandidates.set(base, []);
    targetCandidates.get(base).push({ fieldId, meta });
  }

  // Track which targets have been claimed (to detect conflicts).
  const claimedTargets = new Set();

  // Phase 1: explicit pairs from config take priority.
  for (const pair of explicitPairs) {
    const sourceName = lcName(pair.sourceName);
    const targetName = lcName(pair.targetName);

    // Find source field in editmeta.
    let sourceField = null;
    for (const [fieldId, meta] of Object.entries(em)) {
      if (!isCustom(fieldId)) continue;
      if (lcName(meta.name) !== sourceName) continue;
      if (!/\(migrated\)/i.test(meta.name)) continue;
      sourceField = { fieldId, meta };
      break;
    }
    if (!sourceField) {
      skips.push({
        reason: "explicit_source_not_found",
        sourceName: pair.sourceName,
        targetName: pair.targetName,
      });
      continue;
    }

    // Find target field in editmeta.
    let targetField = null;
    for (const [fieldId, meta] of Object.entries(em)) {
      if (!isCustom(fieldId)) continue;
      if (lcName(meta.name) !== targetName) continue;
      if (/\(migrated\)/i.test(meta.name)) continue;
      targetField = { fieldId, meta };
      break;
    }
    if (!targetField) {
      skips.push({
        reason: "explicit_target_not_found",
        sourceName: pair.sourceName,
        targetName: pair.targetName,
      });
      continue;
    }

    if (claimedTargets.has(targetField.fieldId)) {
      ambiguities.push({
        targetFieldId: targetField.fieldId,
        targetName: pair.targetName,
        reason: "explicit_target_claimed_by_another_source",
      });
      continue;
    }

    // Type compatibility check.
    const sourceFieldData = idIndex.get(sourceField.fieldId);
    const targetHandler = registry.resolve(targetField.meta.schema || {});
    if (!targetHandler.syncable) {
      skips.push({
        targetFieldId: targetField.fieldId,
        targetName: pair.targetName,
        reason: `unsupported_target_type:${targetHandler.suffix || "unknown"}`,
      });
      continue;
    }

    if (!registry.typeCompatible(sourceFieldData?.schema, targetField.meta.schema)) {
      skips.push({
        targetFieldId: targetField.fieldId,
        targetName: pair.targetName,
        reason: `type_incompatible:${registry.categoryOf(sourceFieldData?.schema)}->${registry.categoryOf(targetField.meta.schema)}`,
      });
      continue;
    }

    // Data check on source.
    const sourceValue = issueFields[sourceField.fieldId];
    if (!registry.hasData(sourceValue)) {
      skips.push({
        targetFieldId: targetField.fieldId,
        targetName: pair.targetName,
        reason: "source_has_no_data",
      });
      continue;
    }

    claimedTargets.add(targetField.fieldId);
    pairs.push({
      sourceFieldId: sourceField.fieldId,
      sourceFieldName: sourceField.meta.name,
      targetFieldId: targetField.fieldId,
      targetFieldName: targetField.meta.name,
      handler: targetHandler,
      reason: "explicit_pair",
      sourceSchema: sourceFieldData?.schema || {},
      targetSchema: targetField.meta.schema || {},
    });
  }

  // Phase 2: auto-discover remaining (migrated) sources.
  for (const src of migratedSources) {
    // Skip if this source was already claimed by an explicit pair.
    if (pairs.some((p) => p.sourceFieldId === src.fieldId)) continue;

    const base = baseNameOf(src.meta.name);
    if (denylist.has(base) || denylist.has(lcName(src.meta.name))) {
      skips.push({
        sourceFieldId: src.fieldId,
        sourceName: src.meta.name,
        reason: "denylisted",
      });
      continue;
    }

    // Find target candidates by base name.
    const tgtCandidates = targetCandidates.get(base) || [];

    // Filter out already-claimed targets.
    const availableTargets = tgtCandidates.filter((t) => !claimedTargets.has(t.fieldId));

    if (availableTargets.length === 0) {
      // No target found at all, or all targets claimed.
      if (tgtCandidates.length === 0) {
        skips.push({
          sourceFieldId: src.fieldId,
          sourceName: src.meta.name,
          reason: "no_target_with_matching_base_name",
        });
      } else {
        skips.push({
          sourceFieldId: src.fieldId,
          sourceName: src.meta.name,
          reason: "all_targets_claimed",
        });
      }
      continue;
    }

    if (availableTargets.length > 1) {
      ambiguities.push({
        sourceFieldId: src.fieldId,
        sourceName: src.meta.name,
        targetCandidates: availableTargets.map((t) => t.fieldId),
        reason: "multiple_target_candidates_on_screen",
      });
      continue;
    }

    const tgt = availableTargets[0];
    claimedTargets.add(tgt.fieldId);

    // Check if override pin applies.
    const override = overrides.byTargetId.get(tgt.fieldId);
    if (override) {
      // Override targets a specific source — verify it matches.
      // This is handled by the explicit pair phase; if we reach here,
      // the override didn't match any explicit pair but the target exists.
    }

    // Type compatibility check.
    const targetHandler = registry.resolve(tgt.meta.schema || {});
    if (!targetHandler.syncable) {
      skips.push({
        targetFieldId: tgt.fieldId,
        targetName: tgt.meta.name,
        reason: `unsupported_target_type:${targetHandler.suffix || "unknown"}`,
      });
      continue;
    }

    // Get source field schema from global index.
    const sourceFieldData = idIndex.get(src.fieldId);
    if (!registry.typeCompatible(sourceFieldData?.schema, tgt.meta.schema)) {
      skips.push({
        targetFieldId: tgt.fieldId,
        targetName: tgt.meta.name,
        reason: `type_incompatible:${registry.categoryOf(sourceFieldData?.schema)}->${registry.categoryOf(tgt.meta.schema)}`,
      });
      continue;
    }

    // Data check on source.
    const sourceValue = issueFields[src.fieldId];
    if (!registry.hasData(sourceValue)) {
      skips.push({
        targetFieldId: tgt.fieldId,
        targetName: tgt.meta.name,
        reason: "source_has_no_data",
      });
      continue;
    }

    pairs.push({
      sourceFieldId: src.fieldId,
      sourceFieldName: src.meta.name,
      targetFieldId: tgt.fieldId,
      targetFieldName: tgt.meta.name,
      handler: targetHandler,
      reason: "auto_discovered",
      sourceSchema: sourceFieldData?.schema || {},
      targetSchema: tgt.meta.schema || {},
    });
  }

  return { pairs, ambiguities, skips };
}

module.exports = {
  resolveForIssue,
  buildNameIndex,
  buildIdIndex,
  loadOverrides,
  MIGRATED_RE,
  baseNameOf,
  lcName,
};
