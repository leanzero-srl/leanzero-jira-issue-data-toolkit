#!/usr/bin/env node
/**
 * Probe the DC instance to discover:
 *   1. The Epic Link custom field id (search all custom fields).
 *   2. Any other parent-like custom fields (Parent Link, Portfolio Parent, etc.).
 *   3. The shape of a real DC issue from this run's JQL — what fields/links are populated.
 *   4. The available issue link types (any that imply parent-child semantics).
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const DatacenterClient = require("./src/datacenterClient");

const dc = new DatacenterClient(
  process.env.DC_BASE_URL,
  process.env.DC_USERNAME,
  process.env.DC_PASSWORD,
);

(async () => {
  // 1. Look for parent-like custom fields
  console.log("=== Custom fields whose name hints at parent/epic relation ===");
  const fields = await dc.makeRequest("GET", "/rest/api/2/field");
  const candidates = fields.filter((f) => {
    const n = (f.name || "").toLowerCase();
    return (
      n.includes("epic") ||
      n.includes("parent") ||
      n.includes("portfolio") ||
      n.includes("initiative") ||
      n.includes("feature")
    );
  });
  for (const f of candidates) {
    console.log(
      `  ${f.id.padEnd(22)} name="${f.name}" custom=${f.custom} schema=${JSON.stringify(f.schema || {})}`,
    );
  }

  // 2. Issue link types
  console.log("\n=== Issue link types ===");
  const links = await dc.makeRequest("GET", "/rest/api/2/issueLinkType");
  for (const t of links.issueLinkTypes || []) {
    console.log(`  id=${t.id}  name="${t.name}"  inward="${t.inward}"  outward="${t.outward}"`);
  }

  // 3. Sample DC issues — pick a few keys that are "Story" type in Cloud,
  //    likely candidates for an Epic Link. Read the latest plan to find them.
  console.log("\n=== Sample DC issues — full fields ===");
  const plan = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "logs/plan_1779101460206.json"),
      "utf8",
    ),
  );
  // Pick the first 5 entries that were skipped with reason no-dc-parent — these
  // are the ones where we likely missed the Epic Link
  const samples = Object.entries(plan.issues)
    .filter(([, d]) => d.status === "skipped" && d.skipReason === "no-dc-parent")
    .slice(0, 6)
    .map(([k]) => k);

  for (const key of samples) {
    console.log(`\n--- ${key} ---`);
    try {
      const issue = await dc.makeRequest(
        "GET",
        `/rest/api/2/issue/${encodeURIComponent(key)}`,
      );
      const f = issue.fields || {};
      console.log(`  type:    ${f.issuetype?.name}`);
      console.log(`  parent:  ${f.parent ? f.parent.key : "(none)"}`);
      // Print every custom field that has a non-null value
      const populatedCustom = Object.entries(f)
        .filter(
          ([k, v]) =>
            k.startsWith("customfield_") &&
            v !== null &&
            v !== undefined &&
            !(Array.isArray(v) && v.length === 0),
        )
        .map(([k, v]) => [
          k,
          typeof v === "string" ? v : JSON.stringify(v).slice(0, 200),
        ]);
      console.log(`  populated customfields:`);
      for (const [k, v] of populatedCustom) {
        console.log(`    ${k} = ${v}`);
      }
      // Issue links
      const ilks = (f.issuelinks || []).map((l) => {
        const dir = l.outwardIssue ? `-> ${l.outwardIssue.key}` : `<- ${l.inwardIssue.key}`;
        return `${l.type?.name} ${dir}`;
      });
      console.log(`  issuelinks: ${ilks.length ? ilks.join(", ") : "(none)"}`);
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
    }
  }
})();
