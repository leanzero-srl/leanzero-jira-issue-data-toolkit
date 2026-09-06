// Unit tests for context-extension remediation. Run: node test/contextExtension.test.js
// No framework — plain assert + a tiny async runner. Exits non-zero on any failure.
const assert = require("assert");
const { decideContextExtension, buildPlan, restore } = require("../src/fieldEnabler");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const j = (v) => JSON.stringify(v);

// Build a context state: contexts=[{id, proj:"global"|[ids], it:"any"|[ids]}]
function mkState(contexts) {
  const projOf = new Map(), itOf = new Map(), list = [];
  for (const c of contexts) {
    list.push({ id: c.id });
    projOf.set(String(c.id), c.proj === "global" ? "global" : new Set(c.proj.map(String)));
    itOf.set(String(c.id), c.it === "any" ? "any" : new Set(c.it.map(String)));
  }
  return { contexts: list, projOf, itOf };
}
// A returned action must never violate the destructive-edit guards.
function assertSafe(state, action) {
  if (!action) return;
  assert(state.projOf.get(String(action.contextId)) !== "global", "action must never target a global context");
  if (action.addIssueTypeId) assert(state.itOf.get(String(action.contextId)) !== "any", "must never add issue types to an 'any' context");
}

const DATE = "com.atlassian.jira.plugin.system.customfieldtypes:datepicker";

test("Case A — owner has specific issue types missing IT -> add IT", () => {
  const s = mkState([{ id: "C1", proj: ["P"], it: ["IT2"] }]);
  const a = decideContextExtension(s, "P", "IT");
  assert.strictEqual(j(a), j({ contextId: "C1", addIssueTypeId: "IT" }));
  assertSafe(s, a);
});

test("Case B — owner is 'any' issue type -> null (never narrow)", () => {
  const s = mkState([{ id: "C1", proj: ["P"], it: "any" }]);
  const a = decideContextExtension(s, "P", "IT");
  assert.strictEqual(a, null);
  assertSafe(s, a);
});

test("Case C — add P to a context that is 'any' issue type", () => {
  const s = mkState([{ id: "C2", proj: ["PX"], it: "any" }]);
  const a = decideContextExtension(s, "P", "IT");
  assert.strictEqual(j(a), j({ contextId: "C2", addProjectId: "P" }));
  assertSafe(s, a);
});

test("Case C — add P to a specific context that already covers IT", () => {
  const s = mkState([{ id: "C2", proj: ["PX"], it: ["IT"] }]);
  const a = decideContextExtension(s, "P", "IT");
  assert.strictEqual(j(a), j({ contextId: "C2", addProjectId: "P" }));
  assertSafe(s, a);
});

test("Case C decline — only a specific context missing IT -> null (no compound edit)", () => {
  assert.strictEqual(decideContextExtension(mkState([{ id: "C2", proj: ["PX"], it: ["ITX"] }]), "P", "IT"), null);
});

test("Global-only context -> null, never targeted", () => {
  const s = mkState([{ id: "G", proj: "global", it: "any" }]);
  const a = decideContextExtension(s, "P", "IT");
  assert.strictEqual(a, null);
  assertSafe(s, a);
});

test("Prefer Case A over Case C when both apply", () => {
  const s = mkState([{ id: "C1", proj: ["P"], it: ["IT2"] }, { id: "C2", proj: ["PX"], it: "any" }]);
  assert.strictEqual(j(decideContextExtension(s, "P", "IT")), j({ contextId: "C1", addIssueTypeId: "IT" }));
});

// ── buildPlan integration (mock client) ──────────────────────────────────────
// Date target field whose context C1 owns project P but only issue type IT_OTHER;
// source data lives in (P, IT) and (P, IT3) — both uncovered, both Case A on C1.
function mockClient() {
  return { makeRequest: async (method, path) => {
    if (path.includes("/search/jql")) return { isLast: true, issues: [
      { fields: { project: { id: "P", key: "PA" }, issuetype: { id: "IT", name: "Task" }, customfield_SRC: "2026-01-01" } },
      { fields: { project: { id: "P", key: "PA" }, issuetype: { id: "IT3", name: "Bug" }, customfield_SRC: "2026-02-02" } },
    ]};
    if (/\/field\/customfield_TGT\/context(\?|$)/.test(path)) return { isLast: true, values: [{ id: "C1", isGlobalContext: false, isAnyIssueType: false }] };
    if (path.includes("/context/projectmapping")) return { isLast: true, values: [{ contextId: "C1", projectId: "P" }] };
    if (path.includes("/context/issuetypemapping")) return { isLast: true, values: [{ contextId: "C1", issueTypeId: "IT_OTHER" }] };
    if (path.includes("/fieldconfigurationscheme/project")) return { values: [{ fieldConfigurationScheme: { id: "FCS" } }] };
    if (path.includes("/fieldconfigurationscheme/mapping")) return { isLast: true, values: [{ issueTypeId: "default", fieldConfigurationId: "FC" }] };
    if (path.includes("/fieldconfiguration/FC/fields")) return { isLast: true, values: [{ id: "customfield_TGT", isHidden: false, isRequired: false }] };
    if (/\/screenscheme(\?|$)/.test(path)) return { isLast: true, values: [{ id: "SS", screens: { edit: "SCR" } }] };
    if (path.includes("/issuetypescreenscheme/project")) return { values: [{ issueTypeScreenScheme: { id: "ITSS" } }] };
    if (path.includes("/issuetypescreenscheme/mapping")) return { isLast: true, values: [{ issueTypeId: "default", screenSchemeId: "SS" }] };
    if (path.includes("/screens/SCR/tabs/TAB/fields")) return [{ id: "customfield_TGT" }]; // already on screen
    if (/\/screens\/SCR\/tabs(\?|$)/.test(path)) return [{ id: "TAB" }];
    return {};
  }};
}
const FIELDS = [
  { id: "customfield_SRC", name: "Foo (migrated)", custom: DATE, schema: { type: "date", custom: DATE, customId: 1 } },
  { id: "customfield_TGT", name: "Foo", custom: DATE, schema: { type: "date", custom: DATE, customId: 2 } },
];

test("buildPlan flag OFF — no extensions; gaps warned + counted remediable", async () => {
  const plan = await buildPlan(mockClient(), { fields: FIELDS, denylist: new Set(), log: () => {}, extendContexts: false });
  assert.strictEqual(plan.contextExtensions.length, 0, "no extensions when flag off");
  assert.strictEqual(plan.contextWarnings.length, 2, "both combos warned");
  assert.strictEqual(plan.extendableGaps, 2, "both gaps flagged remediable");
});

test("buildPlan flag ON — one row, deduped issue types, no warnings", async () => {
  const plan = await buildPlan(mockClient(), { fields: FIELDS, denylist: new Set(), log: () => {}, extendContexts: true });
  assert.strictEqual(plan.contextExtensions.length, 1, "one ctx extension row");
  const ce = plan.contextExtensions[0];
  assert.strictEqual(ce.contextId, "C1");
  assert.strictEqual(j(ce.addIssueTypeIds.slice().sort()), j(["IT", "IT3"]), "both issue types accumulated on one row");
  assert.strictEqual(j(ce.addIssueTypeNames.slice().sort()), j(["Bug", "Task"]));
  assert.strictEqual(ce.addProjectIds.length, 0);
  assert.strictEqual(plan.contextWarnings.length, 0, "no residual warnings");
});

test("Case C is deterministic — picks lexicographically smallest candidate id", () => {
  const a = decideContextExtension(mkState([{ id: "C3", proj: ["PX"], it: "any" }, { id: "C2", proj: ["PY"], it: "any" }]), "P", "IT");
  const b = decideContextExtension(mkState([{ id: "C2", proj: ["PY"], it: "any" }, { id: "C3", proj: ["PX"], it: "any" }]), "P", "IT");
  assert.strictEqual(a.contextId, "C2");
  assert.strictEqual(b.contextId, "C2", "same choice regardless of input order");
});

// SELECT target with a context gap: the value of the newly-covered combo must be
// planned as an option-add on the EXTENDED context (regression for the P0 ordering bug).
const SELECT = "com.atlassian.jira.plugin.system.customfieldtypes:select";
function mockSelect() {
  return { makeRequest: async (method, path) => {
    if (path.includes("/search/jql")) return { isLast: true, issues: [
      { fields: { project: { id: "P", key: "PA" }, issuetype: { id: "IT", name: "Task" }, customfield_SRC: { value: "Gamma" } } },
    ]};
    if (/\/field\/customfield_TGT\/context(\?|$)/.test(path)) return { isLast: true, values: [{ id: "C1", isGlobalContext: false, isAnyIssueType: false }] };
    if (path.includes("/context/projectmapping")) return { isLast: true, values: [{ contextId: "C1", projectId: "P" }] };
    if (path.includes("/context/issuetypemapping")) return { isLast: true, values: [{ contextId: "C1", issueTypeId: "IT_OTHER" }] };
    if (path.includes("/context/C1/option")) return { isLast: true, values: [{ id: "o1", value: "Alpha" }] }; // missing "Gamma"
    if (path.includes("/fieldconfigurationscheme/project")) return { values: [{ fieldConfigurationScheme: { id: "FCS" } }] };
    if (path.includes("/fieldconfigurationscheme/mapping")) return { isLast: true, values: [{ issueTypeId: "default", fieldConfigurationId: "FC" }] };
    if (path.includes("/fieldconfiguration/FC/fields")) return { isLast: true, values: [{ id: "customfield_TGT", isHidden: false, isRequired: false }] };
    if (/\/screenscheme(\?|$)/.test(path)) return { isLast: true, values: [{ id: "SS", screens: { edit: "SCR" } }] };
    if (path.includes("/issuetypescreenscheme/project")) return { values: [{ issueTypeScreenScheme: { id: "ITSS" } }] };
    if (path.includes("/issuetypescreenscheme/mapping")) return { isLast: true, values: [{ issueTypeId: "default", screenSchemeId: "SS" }] };
    if (path.includes("/screens/SCR/tabs/TAB/fields")) return [{ id: "customfield_TGT" }];
    if (/\/screens\/SCR\/tabs(\?|$)/.test(path)) return [{ id: "TAB" }];
    return {};
  }};
}
const SELECT_FIELDS = [
  { id: "customfield_SRC", name: "Foo (migrated)", custom: SELECT, schema: { type: "option", custom: SELECT, customId: 1 } },
  { id: "customfield_TGT", name: "Foo", custom: SELECT, schema: { type: "option", custom: SELECT, customId: 2 } },
];

test("P0 ordering — extended context gets the newly-covered combo's missing option", async () => {
  const plan = await buildPlan(mockSelect(), { fields: SELECT_FIELDS, denylist: new Set(), log: () => {}, extendContexts: true });
  assert.strictEqual(plan.contextExtensions.length, 1, "context extended");
  assert.strictEqual(plan.optionAdds.length, 1, "missing option planned for the extended context");
  assert.strictEqual(plan.optionAdds[0].contextId, "C1");
  assert.strictEqual(j(plan.optionAdds[0].values), j(["Gamma"]), "the gap combo's value is added");
  assert.strictEqual(plan.contextWarnings.length, 0);
});

test("P0 ordering — flag OFF: no extension, no options, gap warned", async () => {
  const plan = await buildPlan(mockSelect(), { fields: SELECT_FIELDS, denylist: new Set(), log: () => {}, extendContexts: false });
  assert.strictEqual(plan.contextExtensions.length, 0);
  assert.strictEqual(plan.optionAdds.length, 0);
  assert.strictEqual(plan.contextWarnings.length, 1);
  assert.strictEqual(plan.extendableGaps, 1);
});

test("P0 restore — uses POST .../remove with array body, never DELETE-by-id", async () => {
  const calls = [];
  const client = { makeRequest: async (method, path, body) => { calls.push({ method, path, body }); return {}; } };
  const manifest = { contextExtensions: [
    { fieldId: "customfield_T", contextId: "C1", kind: "issuetype", issueTypeId: "IT1" },
    { fieldId: "customfield_T", contextId: "C1", kind: "issuetype", issueTypeId: "IT2" },
    { fieldId: "customfield_T", contextId: "C1", kind: "project", projectId: "P1" },
  ]};
  const stats = await restore(client, manifest, { log: () => {} });
  assert(!calls.some((c) => c.method === "DELETE" && /\/(issuetype|project)\//.test(c.path)), "must NOT use DELETE-by-id");
  const itRm = calls.find((c) => c.method === "POST" && c.path.endsWith("/issuetype/remove"));
  assert(itRm, "POST issuetype/remove issued");
  assert.strictEqual(j(itRm.body.issueTypeIds.slice().sort()), j(["IT1", "IT2"]), "issue types batched in one remove call");
  const prRm = calls.find((c) => c.method === "POST" && c.path.endsWith("/project/remove"));
  assert(prRm, "POST project/remove issued");
  assert.strictEqual(j(prRm.body.projectIds), j(["P1"]));
  assert.strictEqual(stats.contextExtensionsReverted, 3);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed${process.exitCode ? " — WITH FAILURES" : ""}`);
})();
