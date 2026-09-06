// =============================================================================
// fieldIndex.js — DC <-> Cloud custom-field identity resolution.
//
// Field IDs differ between instances, so we map by NAME. Both sides also carry
// duplicate display names (and JCMA created "(migrated)"-suffixed Cloud dups),
// so resolution is per-issue and editmeta-driven:
//   - Only Cloud fields WRITABLE on the issue (in editmeta, with a `set` op) are
//     considered as targets.
//   - The DC source is the same-named DC field that has data on this issue and
//     is type-compatible with the Cloud target.
//   - Ambiguities (multiple Cloud targets on screen, multiple type-compatible DC
//     sources) are REPORTED, never guessed — pin them in field_overrides.json.
// =============================================================================

const registry = require("./typeRegistry");

const MIGRATED_RE = /\s*\(migrated\)\s*$/i;
const lcName = (n) => String(n == null ? "" : n).trim().toLowerCase();
const baseNameOf = (n) => lcName(String(n == null ? "" : n).replace(MIGRATED_RE, ""));
const isCustom = (id) => typeof id === "string" && id.startsWith("customfield_");

/** Build { byId, byName } from a /field catalog array. */
function buildIndex(fields) {
  const byId = new Map();
  const byName = new Map();
  for (const f of fields || []) {
    if (!f || !f.id) continue;
    byId.set(f.id, f);
    if (!f.custom) continue; // only custom fields participate in name matching
    const key = lcName(f.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(f);
  }
  return { byId, byName };
}

function buildIndexes(cloudFields, dcFields) {
  return { cloud: buildIndex(cloudFields), dc: buildIndex(dcFields) };
}

/**
 * Normalize the field_overrides.json structure into lookup maps.
 *   byCloudId: cloudFieldId -> { name, dcFieldId, cloudFieldId }
 */
function loadOverrides(overridesConfig) {
  const byCloudId = new Map();
  const list = (overridesConfig && overridesConfig.overrides) || [];
  for (const o of list) {
    if (o && o.cloudFieldId && o.dcFieldId) byCloudId.set(o.cloudFieldId, o);
  }
  return { byCloudId };
}

/**
 * Resolve DC->Cloud field pairs for a single issue.
 *
 * @param editmetaFields  Cloud editmeta `fields` object (writable fields).
 * @param dcIssueFields   DC issue's field-value object (id -> value).
 * @param indexes         { cloud, dc } from buildIndexes().
 * @param overrides       from loadOverrides().
 * @param options         { denylist: Set<lcName> }
 * @returns { pairs, ambiguities, skips }
 *   pairs:       [{ cloudFieldId, dcFieldId, name, cloudSchema, dcSchema, handler, reason }]
 *   ambiguities: [{ cloudFieldId, name, candidates, reason }]
 *   skips:       [{ cloudFieldId, name, reason }]
 */
function resolveForIssue(editmetaFields, dcIssueFields, indexes, overrides, options = {}) {
  const pairs = [];
  const ambiguities = [];
  const skips = [];
  const denylist = options.denylist || new Set();
  const em = editmetaFields || {};

  // Map baseName -> [cloudFieldId] across WRITABLE custom fields on this screen,
  // to detect "(migrated)"-duplicate target collisions.
  const cloudTargetsByBase = new Map();
  for (const [cfId, meta] of Object.entries(em)) {
    if (!isCustom(cfId)) continue;
    if (!Array.isArray(meta.operations) || !meta.operations.includes("set")) continue;
    const base = baseNameOf(meta.name);
    if (!cloudTargetsByBase.has(base)) cloudTargetsByBase.set(base, []);
    cloudTargetsByBase.get(base).push(cfId);
  }

  for (const [cloudFieldId, meta] of Object.entries(em)) {
    if (!isCustom(cloudFieldId)) continue; // system fields out of scope
    if (!Array.isArray(meta.operations) || !meta.operations.includes("set")) {
      continue; // not settable; not reported per-issue (tally elsewhere if needed)
    }
    const name = meta.name || cloudFieldId;
    const base = baseNameOf(name);

    if (denylist.has(base) || denylist.has(lcName(name))) {
      skips.push({ cloudFieldId, name, reason: "denylisted" });
      continue;
    }

    const handler = registry.resolve(meta.schema || {});
    if (!handler.syncable) {
      skips.push({
        cloudFieldId,
        name,
        reason: `unsupported_type:${handler.suffix || meta.schema?.type || "unknown"}`,
      });
      continue;
    }

    const override = overrides.byCloudId.get(cloudFieldId);

    // (a) explicit override pin wins, regardless of name/ambiguity.
    if (override) {
      const dcField = indexes.dc.byId.get(override.dcFieldId);
      if (!dcField) {
        skips.push({ cloudFieldId, name, reason: `override_dc_field_not_found:${override.dcFieldId}` });
        continue;
      }
      if (!registry.hasData(dcIssueFields[override.dcFieldId])) {
        continue; // nothing to copy this issue
      }
      pairs.push(makePair(cloudFieldId, dcField, name, meta.schema, handler, "override"));
      continue;
    }

    // (b) multiple writable Cloud targets share this base name -> refuse + report.
    const cloudDups = cloudTargetsByBase.get(base) || [];
    if (cloudDups.length > 1) {
      ambiguities.push({
        cloudFieldId,
        name,
        candidates: cloudDups.slice(),
        reason: "multiple_cloud_targets_on_screen",
      });
      continue;
    }

    // (c) find DC source candidates by base name that have data on this issue.
    const dcCandidates = (indexes.dc.byName.get(base) || []).filter((f) =>
      registry.hasData(dcIssueFields[f.id]),
    );
    if (dcCandidates.length === 0) {
      continue; // no DC data to copy — not an error
    }

    let dcField;
    if (dcCandidates.length === 1) {
      dcField = dcCandidates[0];
    } else {
      const compat = dcCandidates.filter((f) => registry.typeCompatible(f.schema, meta.schema));
      if (compat.length === 1) {
        dcField = compat[0];
      } else {
        ambiguities.push({
          cloudFieldId,
          name,
          candidates: dcCandidates.map((f) => f.id),
          reason:
            compat.length === 0
              ? "no_type_compatible_dc_source"
              : "multiple_type_compatible_dc_sources",
        });
        continue;
      }
    }

    // Final type-compatibility gate (cardinality mismatch guard).
    if (!registry.typeCompatible(dcField.schema, meta.schema)) {
      skips.push({
        cloudFieldId,
        name,
        reason: `dc_type_incompatible:${registry.categoryOf(dcField.schema)}->${registry.categoryOf(meta.schema)}`,
      });
      continue;
    }

    pairs.push(makePair(cloudFieldId, dcField, name, meta.schema, handler, base !== lcName(name) ? "migrated_dup" : "name_match"));
  }

  return { pairs, ambiguities, skips };
}

function makePair(cloudFieldId, dcField, name, cloudSchema, handler, reason) {
  return {
    cloudFieldId,
    dcFieldId: dcField.id,
    name,
    dcName: dcField.name,
    cloudSchema: cloudSchema || {},
    dcSchema: dcField.schema || {},
    handler,
    reason,
  };
}

module.exports = {
  buildIndexes,
  buildIndex,
  loadOverrides,
  resolveForIssue,
  baseNameOf,
  lcName,
};
