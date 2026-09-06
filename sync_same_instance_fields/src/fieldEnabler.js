// =============================================================================
// fieldEnabler.js — make (migrated)→target field pairs actually writable.
//
// The plan/apply phases only act on fields that are settable on an issue's
// edit screen (editmeta). On a fresh instance the native target fields are
// usually NOT writable yet, for up to four independent reasons. This module
// detects and (where safe) remediates them per resolved twin pair:
//
//   Layer 1  context applicability  — the field's context must cover the
//            project+issuetype. DETECT + WARN by default; with extendContexts=true
//            it auto-extends an existing context (add issue type / add project) via
//            a minimal, non-destructive edit (see decideContextExtension).
//   Layer 2  field-config visibility — field must not be "hidden" in the
//            project's field configuration. Auto un-hide (reversible).
//   Layer 3  select options          — source option values must exist in the
//            target context. Add all missing (reversible until used).
//   Layer 4  screen presence         — field must be on the Edit screen.
//            Add to the screen's first tab (reversible).
//
// All write ops are gated behind apply=true; buildPlan() is read-only.
// applyPlan() returns a manifest that restore() consumes to undo every change.
//
// REST contracts (verified against developer.atlassian.com + empirically on the
// sandbox, 2026-06-09):
//   POST   /rest/api/3/field/{id}/context/{ctx}/option   {options:[{value,disabled}]}  -> {options:[{id,...}]}
//   DELETE /rest/api/3/field/{id}/context/{ctx}/option/{optionId}
//   PUT    /rest/api/3/fieldconfiguration/{id}/fields     {fieldConfigurationItems:[{id,isHidden,isRequired}]}
//   POST   /rest/api/3/screens/{id}/tabs/{tab}/fields     {fieldId}
//   DELETE /rest/api/3/screens/{id}/tabs/{tab}/fields/{fieldId}
//   (resolution) /field/{id}/context, /context/projectmapping, /context/issuetypemapping,
//                /issuetypescreenscheme/project|mapping, /screenscheme,
//                /fieldconfigurationscheme/project|mapping, /fieldconfiguration/{id}/fields
//   NOTE: field-config-scheme + issuetypescreenscheme mappings only resolve for
//         company-managed (classic) projects.
// =============================================================================

const registry = require("./typeRegistry");
const { buildNameIndex, baseNameOf, lcName } = require("./fieldResolver");

const SELECT_CATEGORIES = new Set(["option", "multioption"]);

// Classify a failed admin write so the caller can distinguish an expected,
// benign rejection (a locked Atlassian/JSM field, a permission denial) from a
// real error. Locked native fields (Start date, Approvers, Impact, …) cannot be
// reconfigured in field configurations via the API — that's expected, not a bug.
function classifyError(e) {
  const msg = String((e && e.message) || e);
  const code = e && e.statusCode;
  if (/locked field/i.test(msg)) return "locked";
  if (code === 403 || code === 401 || /\bpermission\b/i.test(msg)) return "denied";
  return "error";
}

// Record a failed write into stats with a clear, classified log line.
// Returns the classification.
function recordFailure(stats, log, op, name, e) {
  const kind = classifyError(e);
  const detail = String((e && e.message) || e).replace(/\s+/g, " ").substring(0, 160);
  if (kind === "locked") {
    stats.locked++;
    log(`  [locked] ${op} ${name}: locked field — cannot ${op} via API (no action needed; locked fields are not hideable)`);
  } else if (kind === "denied") {
    stats.denied++;
    log(`  [denied] ${op} ${name}: permission/forbidden — ${detail}`);
  } else {
    stats.failed++;
    log(`  [FAIL] ${op} ${name}: ${detail}`);
  }
  return kind;
}

// ── paginated GET helper (startAt style) ─────────────────────────────────────
async function pagedValues(client, basePath) {
  const out = [];
  let startAt = 0;
  while (true) {
    const sep = basePath.includes("?") ? "&" : "?";
    const res = await client.makeRequest("GET", `${basePath}${sep}startAt=${startAt}&maxResults=100`);
    const vals = (res && (res.values || res)) || [];
    if (!Array.isArray(vals) || vals.length === 0) break;
    out.push(...vals);
    if (res.isLast || (res.total != null && out.length >= res.total)) break;
    startAt += vals.length;
  }
  return out;
}

// ── twin resolution (catalog level) ──────────────────────────────────────────
// Returns [{ sourceFieldId, sourceName, targetFieldId, targetName, category, handler }]
function resolveTwins(fields, denylist = new Set()) {
  const nameIndex = buildNameIndex(fields);
  const pairs = [];
  for (const f of fields) {
    if (!f || !f.custom || !/\(migrated\)/i.test(f.name || "")) continue;
    const base = baseNameOf(f.name);
    if (denylist.has(base) || denylist.has(lcName(f.name))) continue;
    const candidates = (nameIndex.get(base) || []).filter((t) => !/\(migrated\)/i.test(t.name || ""));
    if (candidates.length !== 1) continue; // skip ambiguous / no-twin
    const target = candidates[0];
    const handler = registry.resolve(target.schema || {});
    if (!handler.syncable) continue;
    pairs.push({
      sourceFieldId: f.id,
      sourceName: f.name,
      targetFieldId: target.id,
      targetName: target.name,
      category: handler.category,
      handler,
    });
  }
  return pairs;
}

// ── distribution scan: distinct (project,issuetype) combos, each carrying its
//    OWN distinct source option values (not a global union), for one source
//    field. Per-combo values let options be diffed against the context that
//    actually governs that project/issuetype. Optionally restricted to
//    projectKeys (honors --projects). MAY THROW if the source field has no JQL
//    searcher (400) — the caller guards this. ──────────────────────────────────
async function scanField(client, sourceFieldId, collectValues, log, projectKeys) {
  const jqlField = `cf[${sourceFieldId.replace("customfield_", "")}]`;
  let jql = `${jqlField} is not EMPTY`;
  if (projectKeys && projectKeys.length) jql += ` AND project in (${projectKeys.join(",")})`;
  const combos = new Map(); // `${projectId}|${issueTypeId}` -> combo
  let token = null;
  let scanned = 0;
  while (true) {
    let url =
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}` +
      `&maxResults=100&fields=project,issuetype${collectValues ? "," + sourceFieldId : ""}`;
    if (token) url += `&nextPageToken=${encodeURIComponent(token)}`;
    const res = await client.makeRequest("GET", url);
    const issues = res.issues || [];
    for (const it of issues) {
      const pid = it.fields?.project?.id;
      const itid = it.fields?.issuetype?.id;
      if (pid == null || itid == null) continue; // skip malformed rows
      const k = `${pid}|${itid}`;
      if (!combos.has(k)) combos.set(k, { projectId: String(pid), projectKey: it.fields?.project?.key, issueTypeId: String(itid), issueTypeName: it.fields?.issuetype?.name, count: 0, values: new Set() });
      const combo = combos.get(k);
      combo.count++;
      if (collectValues) {
        const v = it.fields?.[sourceFieldId];
        for (const item of Array.isArray(v) ? v : [v]) {
          const s = item && (item.value != null ? item.value : item.name != null ? item.name : item);
          if (s != null && typeof s !== "object") combo.values.add(String(s));
        }
      }
    }
    scanned += issues.length;
    if (res.isLast || !res.nextPageToken || issues.length === 0) break;
    token = res.nextPageToken;
  }
  if (log) log(`    scanField ${sourceFieldId}: ${scanned} issues, ${combos.size} combos`);
  return [...combos.values()];
}

// Map an option value through a per-field optionMap remap (case-insensitive).
// Mirrors typeRegistry's remapOption so prepare adds the option that apply will
// actually write (the remapped/target spelling), not the raw source spelling.
function remapValue(value, map) {
  if (!map) return value;
  const hit = Object.keys(map).find((k) => lcName(k) === lcName(value));
  return hit ? map[hit] : value;
}

// ── per-instance resolver with caches ────────────────────────────────────────
class Resolvers {
  constructor(client, log) {
    this.client = client;
    this.log = log || (() => {});
    this._screenSchemeEdit = null;      // Map screenSchemeId -> editScreenId
    this._projItss = new Map();         // projectId -> {typeToSS, defaultSS}
    this._screenTabs = new Map();       // screenId -> {tabId, fieldIds:Set}
    this._projFcs = new Map();          // projectId -> {typeToFc, defaultFc}
    this._fcItems = new Map();          // fieldConfigId -> Map fieldId->{isHidden,isRequired}
    this._fieldCtx = new Map();         // fieldId -> {contexts, projOf:Map ctx->Set(projId)|"global", itOf:Map ctx->Set(itId)|"any"}
  }

  async _allScreenSchemes() {
    if (this._screenSchemeEdit) return this._screenSchemeEdit;
    const list = await pagedValues(this.client, "/rest/api/3/screenscheme");
    const m = new Map();
    for (const s of list) m.set(String(s.id), s.screens?.edit || s.screens?.default || null);
    this._screenSchemeEdit = m;
    return m;
  }

  async _itssFor(projectId) {
    if (this._projItss.has(projectId)) return this._projItss.get(projectId);
    const resp = await this.client.makeRequest("GET", `/rest/api/3/issuetypescreenscheme/project?projectId=${projectId}`);
    const itssId = resp.values?.[0]?.issueTypeScreenScheme?.id;
    const out = { typeToSS: new Map(), defaultSS: null };
    if (itssId) {
      const map = await this.client.makeRequest("GET", `/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${itssId}&maxResults=100`);
      for (const m of map.values || []) {
        if (m.issueTypeId === "default") out.defaultSS = String(m.screenSchemeId);
        else out.typeToSS.set(String(m.issueTypeId), String(m.screenSchemeId));
      }
    }
    this._projItss.set(projectId, out);
    return out;
  }

  // Resolve the Edit screen + first tab for (project, issuetype). Returns {screenId, tabId} or null.
  async editScreen(projectId, issueTypeId) {
    const ssEdit = await this._allScreenSchemes();
    const itss = await this._itssFor(projectId);
    const ssId = itss.typeToSS.get(String(issueTypeId)) || itss.defaultSS;
    const screenId = ssId && ssEdit.get(ssId);
    if (!screenId) return null;
    const tab = await this._screenInfo(screenId);
    return { screenId, tabId: tab.tabId };
  }

  async _screenInfo(screenId) {
    if (this._screenTabs.has(screenId)) return this._screenTabs.get(screenId);
    const tabs = await this.client.makeRequest("GET", `/rest/api/3/screens/${screenId}/tabs`);
    const tabId = (tabs || [])[0]?.id;
    const fieldIds = new Set();
    for (const t of tabs || []) {
      const fs = await this.client.makeRequest("GET", `/rest/api/3/screens/${screenId}/tabs/${t.id}/fields`);
      for (const f of fs || []) fieldIds.add(f.id);
    }
    const info = { tabId, fieldIds };
    this._screenTabs.set(screenId, info);
    return info;
  }

  async isOnScreen(screenId, fieldId) {
    const info = await this._screenInfo(screenId);
    return info.fieldIds.has(fieldId);
  }

  async _fcsFor(projectId) {
    if (this._projFcs.has(projectId)) return this._projFcs.get(projectId);
    const resp = await this.client.makeRequest("GET", `/rest/api/3/fieldconfigurationscheme/project?projectId=${projectId}`);
    const schemeId = resp.values?.[0]?.fieldConfigurationScheme?.id;
    const out = { typeToFc: new Map(), defaultFc: null };
    if (schemeId) {
      const map = await this.client.makeRequest("GET", `/rest/api/3/fieldconfigurationscheme/mapping?fieldConfigurationSchemeId=${schemeId}&maxResults=100`);
      for (const m of map.values || []) {
        if (m.issueTypeId === "default") out.defaultFc = String(m.fieldConfigurationId);
        else out.typeToFc.set(String(m.issueTypeId), String(m.fieldConfigurationId));
      }
    }
    this._projFcs.set(projectId, out);
    return out;
  }

  // Resolve field configuration id governing (project, issuetype), or null.
  async fieldConfig(projectId, issueTypeId) {
    const fcs = await this._fcsFor(projectId);
    return fcs.typeToFc.get(String(issueTypeId)) || fcs.defaultFc || null;
  }

  async _fcItemsFor(fieldConfigId) {
    if (this._fcItems.has(fieldConfigId)) return this._fcItems.get(fieldConfigId);
    const items = await pagedValues(this.client, `/rest/api/3/fieldconfiguration/${fieldConfigId}/fields`);
    const m = new Map();
    for (const it of items) m.set(it.id, { isHidden: !!it.isHidden, isRequired: !!it.isRequired });
    this._fcItems.set(fieldConfigId, m);
    return m;
  }

  // Returns {isHidden, isRequired} for a field in a config, or null if absent.
  async fieldConfigItem(fieldConfigId, fieldId) {
    const m = await this._fcItemsFor(fieldConfigId);
    return m.get(fieldId) || null;
  }

  async _ctxFor(fieldId) {
    if (this._fieldCtx.has(fieldId)) return this._fieldCtx.get(fieldId);
    const contexts = await pagedValues(this.client, `/rest/api/3/field/${fieldId}/context`);
    const projMap = await pagedValues(this.client, `/rest/api/3/field/${fieldId}/context/projectmapping`);
    const itMap = await pagedValues(this.client, `/rest/api/3/field/${fieldId}/context/issuetypemapping`);
    const projOf = new Map(); // ctxId -> Set(projectId) | "global"
    for (const c of contexts) projOf.set(String(c.id), c.isGlobalContext ? "global" : new Set());
    for (const m of projMap) {
      const cid = String(m.contextId);
      if (m.isGlobalContext) projOf.set(cid, "global");
      else if (projOf.get(cid) instanceof Set) projOf.get(cid).add(String(m.projectId));
    }
    const itOf = new Map(); // ctxId -> Set(issueTypeId) | "any"
    for (const c of contexts) itOf.set(String(c.id), c.isAnyIssueType ? "any" : new Set());
    for (const m of itMap) {
      const cid = String(m.contextId);
      if (m.isAnyIssueType) itOf.set(cid, "any");
      else if (itOf.get(cid) instanceof Set) itOf.get(cid).add(String(m.issueTypeId));
    }
    const out = { contexts, projOf, itOf };
    this._fieldCtx.set(fieldId, out);
    return out;
  }

  // Resolve the context id governing (project, issuetype) for a field, or null.
  async context(fieldId, projectId, issueTypeId) {
    const { contexts, projOf, itOf } = await this._ctxFor(fieldId);
    for (const c of contexts) {
      const cid = String(c.id);
      const ps = projOf.get(cid);
      const its = itOf.get(cid);
      const projOk = ps === "global" || (ps instanceof Set && ps.has(String(projectId)));
      const itOk = its === "any" || (its instanceof Set && its.has(String(issueTypeId)));
      if (projOk && itOk) return cid;
    }
    return null;
  }

  async contextOptions(fieldId, contextId) {
    const opts = await pagedValues(this.client, `/rest/api/3/field/${fieldId}/context/${contextId}/option`);
    return opts; // [{id, value, disabled}]
  }

  // Plan a minimal, non-destructive context extension covering (projectId,
  // issueTypeId), or null if un-remediable. See decideContextExtension().
  async planContextExtension(fieldId, projectId, issueTypeId) {
    const state = await this._ctxFor(fieldId);
    return decideContextExtension(state, projectId, issueTypeId);
  }

  // Optimistically reflect a planned extension in the cached context state so
  // later combos (and the downstream field-config/screen layers) in the SAME
  // run observe the coverage and don't re-plan or re-warn.
  async notePlannedExtension(fieldId, action) {
    const { projOf, itOf } = await this._ctxFor(fieldId);
    const cid = String(action.contextId);
    if (action.addIssueTypeId && itOf.get(cid) instanceof Set) itOf.get(cid).add(String(action.addIssueTypeId));
    if (action.addProjectId && projOf.get(cid) instanceof Set) projOf.get(cid).add(String(action.addProjectId));
  }
}

// ── context-extension decision (pure, unit-tested) ───────────────────────────
// Given a field's context state and an UNCOVERED (projectId, issueTypeId),
// return the minimal single edit that would cover it, or null (leave a warning).
//   state: { contexts:[{id}], projOf:Map(ctxId->"global"|Set(projId)),
//                              itOf:Map(ctxId->"any"|Set(issueTypeId)) }
//   returns { contextId, addIssueTypeId? } | { contextId, addProjectId? } | null
// Never targets a global context; never adds issue types to an "any" context
// (that would NARROW it). See the plan's algorithm for the full rationale.
function decideContextExtension(state, projectId, issueTypeId) {
  const P = String(projectId);
  const IT = String(issueTypeId);
  const { contexts, projOf, itOf } = state;

  // ownerOfP: the (<=1, by Jira uniqueness) context whose projOf Set contains P.
  // Global contexts cover P implicitly but are NOT owners and must never be touched.
  let ownerOfP = null;
  for (const c of contexts) {
    const ps = projOf.get(String(c.id));
    if (ps instanceof Set && ps.has(P)) { ownerOfP = String(c.id); break; }
  }

  if (ownerOfP) {
    const its = itOf.get(ownerOfP);
    // Case A (primary, safe): owner has SPECIFIC issue types missing IT -> add IT.
    // Non-global => PUT allowed; Set (not "any") => expands, never narrows.
    if (its instanceof Set && !its.has(IT)) {
      return { contextId: ownerOfP, addIssueTypeId: IT };
    }
    // Case B: owner is "any" issue type => it already covers (P,IT), so this
    // combo wouldn't be a warning (unreachable). Never narrow an "any" context.
    return null;
  }

  // Case C (fallback): P is owned by no specific context. Add P to a non-global
  // context that already covers IT ("any" or specific-incl-IT) so a single PUT
  // achieves coverage. P is in no other context => no uniqueness collision.
  // Sort candidates by id for deterministic, reproducible selection (the
  // /context list order is not contractually stable).
  const sorted = [...contexts].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const c of sorted) {
    const cid = String(c.id);
    const ps = projOf.get(cid);
    if (!(ps instanceof Set)) continue; // skip global (untouchable)
    const its = itOf.get(cid);
    const coversIT = its === "any" || (its instanceof Set && its.has(IT));
    if (coversIT) return { contextId: cid, addProjectId: P };
  }

  // Otherwise un-remediable without a compound/destructive edit — warn.
  return null;
}

// ── plan builder (read-only) ─────────────────────────────────────────────────
// opts: { fields, denylist, log, projects?, optionMaps?, extendContexts? }
//   projects        — optional [projectKey] to scope the scan (honors --projects)
//   optionMaps      — Map(lcTargetName -> {srcVal: tgtVal}) so option-adds use
//                     the spelling apply will actually write (see remapValue).
//   extendContexts  — when true, an uncovered (project,issuetype) is auto-fixed
//                     by extending an existing context (Case A/C) instead of
//                     warned. When false, gaps stay warnings (today's behavior)
//                     but remediable ones are counted in `extendableGaps`.
// Returns { pairs, screenAdds, fieldConfigUnhides, optionAdds, contextExtensions,
//           contextWarnings, extendableGaps }.
async function buildPlan(client, { fields, denylist, log, projects, optionMaps, extendContexts }) {
  const R = new Resolvers(client, log);
  const pairs = resolveTwins(fields, denylist || new Set());
  const maps = optionMaps || new Map();
  log(`  Resolved ${pairs.length} non-denylisted twin pair(s) to enable`);

  const screenAdds = new Map();        // `${screenId}|${fieldId}` -> {...}
  const fieldConfigUnhides = new Map();// `${fcId}|${fieldId}` -> {...}
  const optionAdds = new Map();        // `${fieldId}|${contextId}` -> {fieldId, fieldName, contextId, values:[]}
  const contextExtensions = new Map(); // `${fieldId}|${contextId}` -> {fieldId, fieldName, contextId, addIssueTypeIds, addIssueTypeNames, addProjectIds, addProjectKeys}
  const contextWarnings = [];
  let extendableGaps = 0;              // remediable gaps seen while extendContexts is OFF (advisory)

  for (const pair of pairs) {
    const isSelect = SELECT_CATEGORIES.has(pair.category);

    // A non-searchable source field 400s here — guard so one bad field can't
    // abort the whole prepare.
    let combos;
    try {
      combos = await scanField(client, pair.sourceFieldId, isSelect, log, projects);
    } catch (e) {
      log(`  [warn] ${pair.sourceName}: distribution scan failed (${String(e.message).replace(/\s+/g, " ").substring(0, 120)}) — skipping pair`);
      continue;
    }
    if (combos.length === 0) {
      log(`  [skip] ${pair.sourceName}: 0 issues with data in scanned scope — nothing to enable`);
      continue;
    }

    try {
      // Pass 0 — Layer 1: context applicability. Extend (if enabled) or warn.
      // MUST precede the option pass: extending a context here (via the cache)
      // lets the option pass attribute the newly-covered combos' values to it,
      // so the extended context isn't left missing options that apply() needs.
      for (const combo of combos) {
        const ctxId = await R.context(pair.targetFieldId, combo.projectId, combo.issueTypeId);
        if (ctxId) continue;
        const action = await R.planContextExtension(pair.targetFieldId, combo.projectId, combo.issueTypeId);
        if (action && extendContexts) {
          const key = `${pair.targetFieldId}|${action.contextId}`;
          if (!contextExtensions.has(key)) contextExtensions.set(key, { fieldId: pair.targetFieldId, fieldName: pair.targetName, contextId: action.contextId, addIssueTypeIds: [], addIssueTypeNames: [], addProjectIds: [], addProjectKeys: [] });
          const ce = contextExtensions.get(key);
          if (action.addIssueTypeId && !ce.addIssueTypeIds.includes(action.addIssueTypeId)) { ce.addIssueTypeIds.push(action.addIssueTypeId); ce.addIssueTypeNames.push(combo.issueTypeName); }
          if (action.addProjectId && !ce.addProjectIds.includes(action.addProjectId)) { ce.addProjectIds.push(action.addProjectId); ce.addProjectKeys.push(combo.projectKey); }
          await R.notePlannedExtension(pair.targetFieldId, action); // cache now reflects coverage for passes 1 & 2
        } else {
          if (action) extendableGaps++; // remediable, but flag is off — advisory only
          contextWarnings.push({ fieldId: pair.targetFieldId, fieldName: pair.targetName, projectKey: combo.projectKey, issueTypeName: combo.issueTypeName });
        }
      }

      // Pass 1 — Layer 3: options. Diff PER governing context (incl. any extended
      // in pass 0) using only the source values that context governs (no cross-
      // project leakage), remapped to the spelling apply will write.
      if (isSelect) {
        const remap = maps.get(lcName(pair.targetName)) || null;
        const byContext = new Map(); // ctxId -> Set(target option values wanted)
        for (const combo of combos) {
          const ctxId = await R.context(pair.targetFieldId, combo.projectId, combo.issueTypeId);
          if (!ctxId) continue;
          if (!byContext.has(ctxId)) byContext.set(ctxId, new Set());
          const wanted = byContext.get(ctxId);
          for (const v of combo.values) wanted.add(remapValue(v, remap));
        }
        for (const [ctxId, wanted] of byContext) {
          if (!wanted.size) continue;
          const existing = await R.contextOptions(pair.targetFieldId, ctxId);
          const have = new Set(existing.map((o) => lcName(o.value)));
          const missing = [...wanted].filter((v) => !have.has(lcName(v)));
          if (missing.length) {
            optionAdds.set(`${pair.targetFieldId}|${ctxId}`, { fieldId: pair.targetFieldId, fieldName: pair.targetName, contextId: ctxId, values: missing });
          }
        }
      }

      // Pass 2 — Layers 2 & 4: field-config (un-hide) + screen (add) for combos
      // now covered. Un-remediable gaps were already warned in pass 0 and resolve
      // to a null context here, so they are skipped.
      for (const combo of combos) {
        const ctxId = await R.context(pair.targetFieldId, combo.projectId, combo.issueTypeId);
        if (!ctxId) continue;

        const fcId = await R.fieldConfig(combo.projectId, combo.issueTypeId);
        if (fcId) {
          const item = await R.fieldConfigItem(fcId, pair.targetFieldId);
          if (item && item.isHidden) {
            const key = `${fcId}|${pair.targetFieldId}`;
            if (!fieldConfigUnhides.has(key)) fieldConfigUnhides.set(key, { fieldConfigId: fcId, fieldId: pair.targetFieldId, fieldName: pair.targetName, isRequired: item.isRequired });
          }
        }

        const es = await R.editScreen(combo.projectId, combo.issueTypeId);
        if (es && es.tabId && !(await R.isOnScreen(es.screenId, pair.targetFieldId))) {
          const key = `${es.screenId}|${pair.targetFieldId}`;
          if (!screenAdds.has(key)) screenAdds.set(key, { screenId: es.screenId, tabId: es.tabId, fieldId: pair.targetFieldId, fieldName: pair.targetName });
        }
      }
    } catch (e) {
      log(`  [warn] ${pair.targetName}: prerequisite resolution failed (${String(e.message).replace(/\s+/g, " ").substring(0, 120)}) — partial plan for this pair`);
      continue;
    }
  }

  return {
    pairs,
    screenAdds: [...screenAdds.values()],
    fieldConfigUnhides: [...fieldConfigUnhides.values()],
    optionAdds: [...optionAdds.values()],
    contextExtensions: [...contextExtensions.values()],
    contextWarnings,
    extendableGaps,
  };
}

// ── apply (mutations) ────────────────────────────────────────────────────────
// Returns { manifest, stats }. manifest is consumed by restore().
async function applyPlan(client, plan, { dryRun, log }) {
  const manifest = { at: new Date().toISOString(), contextExtensions: [], optionAdds: [], fieldConfigUnhides: [], screenAdds: [] };
  const stats = { contextIssueTypesAdded: 0, contextProjectsAdded: 0, optionsAdded: 0, fieldsUnhidden: 0, screensFieldsAdded: 0, locked: 0, denied: 0, failed: 0 };

  // Layer 1 — extend contexts FIRST: everything below depends on the field
  // applying to the (project,issuetype). Each granular add is recorded for restore.
  for (const ce of plan.contextExtensions || []) {
    if (dryRun) { log(`  [dry] extend ${ce.fieldName} ctx ${ce.contextId}:${ce.addIssueTypeNames.length ? ` +issuetypes[${ce.addIssueTypeNames.join(", ")}]` : ""}${ce.addProjectKeys.length ? ` +projects[${ce.addProjectKeys.join(", ")}]` : ""}`); continue; }
    try {
      if (ce.addIssueTypeIds.length) {
        await client.makeRequest("PUT", `/rest/api/3/field/${ce.fieldId}/context/${ce.contextId}/issuetype`, { issueTypeIds: ce.addIssueTypeIds });
        ce.addIssueTypeIds.forEach((id, i) => manifest.contextExtensions.push({ fieldId: ce.fieldId, contextId: ce.contextId, kind: "issuetype", issueTypeId: id, issueTypeName: ce.addIssueTypeNames[i] }));
        stats.contextIssueTypesAdded += ce.addIssueTypeIds.length;
      }
      if (ce.addProjectIds.length) {
        await client.makeRequest("PUT", `/rest/api/3/field/${ce.fieldId}/context/${ce.contextId}/project`, { projectIds: ce.addProjectIds });
        ce.addProjectIds.forEach((id, i) => manifest.contextExtensions.push({ fieldId: ce.fieldId, contextId: ce.contextId, kind: "project", projectId: id, projectKey: ce.addProjectKeys[i] }));
        stats.contextProjectsAdded += ce.addProjectIds.length;
      }
      log(`  [ctx] extended ${ce.fieldName} ctx ${ce.contextId} (+${ce.addIssueTypeIds.length} issuetype, +${ce.addProjectIds.length} project)`);
    } catch (e) { recordFailure(stats, log, "extend-context", `${ce.fieldName} ctx ${ce.contextId}`, e); }
  }

  // Layer 3 — add options (do first: a field must have the option before a value validates).
  for (const oa of plan.optionAdds) {
    if (dryRun) { log(`  [dry] add ${oa.values.length} option(s) to ${oa.fieldName} ctx ${oa.contextId}: ${oa.values.join(", ")}`); continue; }
    try {
      const body = { options: oa.values.map((v) => ({ value: v, disabled: false })) };
      const res = await client.makeRequest("POST", `/rest/api/3/field/${oa.fieldId}/context/${oa.contextId}/option`, body);
      const created = (res && res.options) || [];
      for (const c of created) manifest.optionAdds.push({ fieldId: oa.fieldId, contextId: oa.contextId, optionId: c.id, value: c.value });
      stats.optionsAdded += created.length;
      log(`  [opt] ${oa.fieldName} ctx ${oa.contextId} +${created.length}: ${created.map((c) => c.value).join(", ")}`);
    } catch (e) { recordFailure(stats, log, "add-option", `${oa.fieldName} ctx ${oa.contextId}`, e); }
  }

  // Layer 2 — un-hide in field config. Locked native fields (Start date, Approvers,
  // …) reject this with 403; that's expected and harmless (they're never hidden).
  for (const fu of plan.fieldConfigUnhides) {
    if (dryRun) { log(`  [dry] un-hide ${fu.fieldName} in field config ${fu.fieldConfigId}`); continue; }
    try {
      await client.makeRequest("PUT", `/rest/api/3/fieldconfiguration/${fu.fieldConfigId}/fields`, {
        fieldConfigurationItems: [{ id: fu.fieldId, isHidden: false, isRequired: !!fu.isRequired }],
      });
      manifest.fieldConfigUnhides.push({ fieldConfigId: fu.fieldConfigId, fieldId: fu.fieldId, isRequired: !!fu.isRequired });
      stats.fieldsUnhidden++;
      log(`  [unhide] ${fu.fieldName} in field config ${fu.fieldConfigId}`);
    } catch (e) { recordFailure(stats, log, "un-hide", `${fu.fieldName} fc ${fu.fieldConfigId}`, e); }
  }

  // Layer 4 — add to edit screen.
  for (const sa of plan.screenAdds) {
    if (dryRun) { log(`  [dry] add ${sa.fieldName} to screen ${sa.screenId} tab ${sa.tabId}`); continue; }
    try {
      await client.makeRequest("POST", `/rest/api/3/screens/${sa.screenId}/tabs/${sa.tabId}/fields`, { fieldId: sa.fieldId });
      manifest.screenAdds.push({ screenId: sa.screenId, tabId: sa.tabId, fieldId: sa.fieldId });
      stats.screensFieldsAdded++;
      log(`  [screen] ${sa.fieldName} -> screen ${sa.screenId} tab ${sa.tabId}`);
    } catch (e) { recordFailure(stats, log, "add-to-screen", `${sa.fieldName} screen ${sa.screenId}`, e); }
  }

  return { manifest, stats };
}

// ── restore (undo from manifest) ─────────────────────────────────────────────
async function restore(client, manifest, { log }) {
  const stats = { optionsDeleted: 0, fieldsRehidden: 0, screenFieldsRemoved: 0, contextExtensionsReverted: 0, locked: 0, denied: 0, failed: 0 };

  for (const sa of manifest.screenAdds || []) {
    try { await client.makeRequest("DELETE", `/rest/api/3/screens/${sa.screenId}/tabs/${sa.tabId}/fields/${sa.fieldId}`); stats.screenFieldsRemoved++; }
    catch (e) { recordFailure(stats, log, "restore-screen", `${sa.screenId}/${sa.fieldId}`, e); }
  }
  for (const fu of manifest.fieldConfigUnhides || []) {
    try {
      await client.makeRequest("PUT", `/rest/api/3/fieldconfiguration/${fu.fieldConfigId}/fields`, {
        fieldConfigurationItems: [{ id: fu.fieldId, isHidden: true, isRequired: !!fu.isRequired }],
      });
      stats.fieldsRehidden++;
    } catch (e) { recordFailure(stats, log, "restore-hide", `${fu.fieldConfigId}/${fu.fieldId}`, e); }
  }
  for (const oa of manifest.optionAdds || []) {
    // Deleting an option fails if an issue is already set to it — expected/safe; leave it.
    try { await client.makeRequest("DELETE", `/rest/api/3/field/${oa.fieldId}/context/${oa.contextId}/option/${oa.optionId}`); stats.optionsDeleted++; }
    catch (e) { recordFailure(stats, log, "restore-option", `${oa.fieldId}/${oa.optionId} (${oa.value})`, e); }
  }
  // Context extensions reverted LAST (coverage torn down only after dependents).
  // Removal is POST .../remove with an array body — there is NO DELETE-by-id route
  // (verified live: DELETE .../issuetype/{id} returns 404). Grouped per (field,
  // context, kind). A contraction can be refused if issues already depend on the
  // scoping — expected/safe; classified via recordFailure and left in place.
  const ceGroups = new Map(); // `${fieldId}|${contextId}|${kind}` -> {fieldId, contextId, kind, ids:[]}
  for (const ce of manifest.contextExtensions || []) {
    const k = `${ce.fieldId}|${ce.contextId}|${ce.kind}`;
    if (!ceGroups.has(k)) ceGroups.set(k, { fieldId: ce.fieldId, contextId: ce.contextId, kind: ce.kind, ids: [] });
    ceGroups.get(k).ids.push(ce.kind === "issuetype" ? String(ce.issueTypeId) : String(ce.projectId));
  }
  for (const g of ceGroups.values()) {
    const path = g.kind === "issuetype"
      ? `/rest/api/3/field/${g.fieldId}/context/${g.contextId}/issuetype/remove`
      : `/rest/api/3/field/${g.fieldId}/context/${g.contextId}/project/remove`;
    const body = g.kind === "issuetype" ? { issueTypeIds: g.ids } : { projectIds: g.ids };
    try { await client.makeRequest("POST", path, body); stats.contextExtensionsReverted += g.ids.length; }
    catch (e) { recordFailure(stats, log, "restore-context", `${g.fieldId}/${g.contextId}/${g.kind}`, e); }
  }
  return stats;
}

module.exports = { resolveTwins, scanField, buildPlan, applyPlan, restore, decideContextExtension, Resolvers };
