// Tests for off-screen (migrated) source discovery in fieldResolver.resolveForIssue.
// Run: node test/resolverOffScreen.test.js
const assert = require("assert");
const r = require("../src/fieldResolver");

const SELECT = "com.atlassian.jira.plugin.system.customfieldtypes:select";
const catalog = [
  { id: "customfield_SRC", name: "Foo (migrated)", custom: true, schema: { type: "option", custom: SELECT, customId: 1 } },
  { id: "customfield_TGT", name: "Foo", custom: true, schema: { type: "option", custom: SELECT, customId: 2 } },
];
const nameIndex = r.buildNameIndex(catalog);
const idIndex = r.buildIdIndex(catalog);
const overrides = r.loadOverrides({ overrides: [] });
const opts = { denylist: new Set() };
// editmeta with the TARGET writable; source presence varies per test
const targetMeta = { name: "Foo", operations: ["set"], schema: { type: "option", custom: SELECT }, allowedValues: [{ value: "A" }] };
const sourceMeta = { name: "Foo (migrated)", operations: ["set"], schema: { type: "option", custom: SELECT } };

let passed = 0;
const tests = [];
const test = (n, f) => tests.push({ n, f });

test("off-screen source WITH data + writable target -> 1 pair (the fix)", () => {
  const editmeta = { customfield_TGT: targetMeta }; // source NOT on screen
  const res = r.resolveForIssue(editmeta, { customfield_SRC: { value: "A" }, customfield_TGT: null }, nameIndex, idIndex, overrides, [], opts);
  assert.strictEqual(res.pairs.length, 1, "expected one pair");
  assert.strictEqual(res.pairs[0].sourceFieldId, "customfield_SRC");
  assert.strictEqual(res.pairs[0].targetFieldId, "customfield_TGT");
  assert.strictEqual(res.pairs[0].sourceFieldName, "Foo (migrated)");
});

test("off-screen source with NO data -> no pair (don't flood for empty sources)", () => {
  const editmeta = { customfield_TGT: targetMeta };
  const res = r.resolveForIssue(editmeta, { customfield_SRC: null, customfield_TGT: null }, nameIndex, idIndex, overrides, [], opts);
  assert.strictEqual(res.pairs.length, 0);
});

test("off-screen source with data but target NOT writable -> no pair", () => {
  const editmeta = {}; // neither source nor target on screen
  const res = r.resolveForIssue(editmeta, { customfield_SRC: { value: "A" }, customfield_TGT: null }, nameIndex, idIndex, overrides, [], opts);
  assert.strictEqual(res.pairs.length, 0, "target must still be writable");
});

test("on-screen source still resolves (no regression)", () => {
  const editmeta = { customfield_SRC: sourceMeta, customfield_TGT: targetMeta };
  const res = r.resolveForIssue(editmeta, { customfield_SRC: { value: "A" }, customfield_TGT: null }, nameIndex, idIndex, overrides, [], opts);
  assert.strictEqual(res.pairs.length, 1);
  assert.strictEqual(res.pairs[0].sourceFieldId, "customfield_SRC");
});

test("denylist still applies to off-screen sources", () => {
  const editmeta = { customfield_TGT: targetMeta };
  const res = r.resolveForIssue(editmeta, { customfield_SRC: { value: "A" }, customfield_TGT: null }, nameIndex, idIndex, overrides, [], { denylist: new Set(["foo"]) });
  assert.strictEqual(res.pairs.length, 0, "denylisted base name -> no pair");
});

for (const { n, f } of tests) {
  try { f(); passed++; console.log(`  ok   ${n}`); }
  catch (e) { console.error(`  FAIL ${n}\n       ${e.message}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} passed${process.exitCode ? " — WITH FAILURES" : ""}`);
