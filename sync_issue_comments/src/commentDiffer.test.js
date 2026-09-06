/**
 * Standalone test for commentDiffer part-aware idempotency.
 * Run with: node src/commentDiffer.test.js
 *
 * Scenarios where every DC comment is already tagged (fully or partially) so the
 * heuristic pairer is never reached — that's exactly the new logic under test.
 */

const { diffComments, collectMigrationTags } = require("./commentDiffer");
const {
  MIGRATION_TAG_KEY,
  PART_INDEX_PROP_KEY,
  PART_TOTAL_PROP_KEY,
} = require("./cloudJiraClient");

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

// Build a Cloud comment carrying migration props for a given dc id / part.
function cloudComment(id, dcId, { partIndex, partTotal } = {}) {
  const properties = [{ key: MIGRATION_TAG_KEY, value: String(dcId) }];
  if (partIndex != null) properties.push({ key: PART_INDEX_PROP_KEY, value: partIndex });
  if (partTotal != null) properties.push({ key: PART_TOTAL_PROP_KEY, value: partTotal });
  return { id: String(id), created: "2024-01-01T00:00:00.000Z", properties };
}
function dc(id) {
  return { id: String(id), created: "2023-01-01T00:00:00.000Z", author: { name: "x" } };
}

(async () => {
  /* ── collectMigrationTags shapes ───────────────────────────────── */
  console.log("collectMigrationTags:");
  {
    const map = collectMigrationTags([
      cloudComment(1, "100"), // un-split, no part props
      cloudComment(2, "200", { partIndex: 1, partTotal: 3 }),
      cloudComment(3, "200", { partIndex: 2, partTotal: 3 }),
    ]);
    check("un-split comment reads as 1 of 1", map.get("100").total === 1 && map.get("100").parts.has(1));
    check("split comment records total=3", map.get("200").total === 3);
    check("split comment has parts {1,2}", map.get("200").parts.has(1) && map.get("200").parts.has(2) && map.get("200").parts.size === 2);
  }

  /* ── fully covered: un-split ───────────────────────────────────── */
  console.log("fully covered (un-split):");
  {
    const r = await diffComments({
      cloudComments: [cloudComment(1, "100")],
      dcComments: [dc("100")],
      resolveDcEmail: async () => null,
    });
    check("toCreate empty", r.toCreate.length === 0);
    check("skipped already_injected_tagged", r.skipped.some((s) => s.reason === "already_injected_tagged"));
    check("partial map empty", r.partial.size === 0);
  }

  /* ── fully covered: all 3 split parts present ──────────────────── */
  console.log("fully covered (split 3/3):");
  {
    const cloud = [
      cloudComment(1, "200", { partIndex: 1, partTotal: 3 }),
      cloudComment(2, "200", { partIndex: 2, partTotal: 3 }),
      cloudComment(3, "200", { partIndex: 3, partTotal: 3 }),
    ];
    const r = await diffComments({ cloudComments: cloud, dcComments: [dc("200")], resolveDcEmail: async () => null });
    check("toCreate empty (3/3 covered)", r.toCreate.length === 0);
    check("partial map empty", r.partial.size === 0);
  }

  /* ── partially covered: 1 of 3 parts present → top up ──────────── */
  console.log("partially covered (split 1/3):");
  {
    const cloud = [cloudComment(1, "200", { partIndex: 1, partTotal: 3 })];
    const r = await diffComments({ cloudComments: cloud, dcComments: [dc("200")], resolveDcEmail: async () => null });
    check("comment is in toCreate (top-up)", r.toCreate.some((d) => String(d.id) === "200"));
    check("recorded in partial map", r.partial.has("200"));
    const p = r.partial.get("200");
    check("partial total=3", p && p.total === 3);
    check("partial presentParts={1}", p && p.presentParts.has(1) && p.presentParts.size === 1);
    check("not skipped", !r.skipped.some((s) => String(s.dc.id) === "200"));
  }

  /* ── partially covered: 2 of 3 parts present → top up ──────────── */
  console.log("partially covered (split 2/3):");
  {
    const cloud = [
      cloudComment(1, "200", { partIndex: 1, partTotal: 3 }),
      cloudComment(2, "200", { partIndex: 2, partTotal: 3 }),
    ];
    const r = await diffComments({ cloudComments: cloud, dcComments: [dc("200")], resolveDcEmail: async () => null });
    check("comment in toCreate", r.toCreate.some((d) => String(d.id) === "200"));
    const p = r.partial.get("200");
    check("presentParts={1,2}", p && p.presentParts.has(1) && p.presentParts.has(2) && p.presentParts.size === 2);
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILURE(S)"}`);
  process.exit(failures === 0 ? 0 : 1);
})();
