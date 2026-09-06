#!/usr/bin/env node
/** READ-ONLY. (1) In-file vs external parent split of the parent-mapped CSV.
 *  (2) For a few sub-tasks, search Cloud by exact summary to detect whether a
 *      CSV import ever created a DUPLICATE (same summary, different/new key). */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });
const CloudJiraClient = require("./src/cloudJiraClient");

const CSV = "./data/export_cleaned.parent-mapped.csv";

function parseCsv(text) {
  const rows = []; let row = [], field = "", q = false, i = 0; const n = text.length;
  while (i < n) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; } field += c; i++; continue; }
    if (c === '"') { q = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function main() {
  const rows = parseCsv(fs.readFileSync(CSV, "utf8"));
  const h = rows[0];
  const ci = (name) => h.findIndex((x) => x.trim().toLowerCase() === name);
  const iKey = ci("issue key"), iId = ci("issue id"), iParent = ci("parent id"), iSum = ci("summary");
  const inFileIds = new Set(rows.slice(1).map((r) => (r[iId] || "").trim()).filter(Boolean));
  let inFile = 0, external = 0, blank = 0;
  for (const r of rows.slice(1)) {
    const p = (r[iParent] || "").trim();
    if (!p) { blank++; continue; }
    if (inFileIds.has(p)) inFile++; else external++;
  }
  console.log(`Rows: ${rows.length - 1}`);
  console.log(`Parent id present -> in-file(parent row also in CSV): ${inFile} | external(must link to existing): ${external} | blank: ${blank}`);

  // Dupe check: search cloud by exact summary for first 4 sub-tasks
  const cloud = new CloudJiraClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN);
  console.log(`\nDuplicate scan (cloud issues with same summary):`);
  for (const r of rows.slice(1, 5)) {
    const key = r[iKey]; const sum = (r[iSum] || "").replace(/"/g, '\\"');
    const jql = `project = BUILD AND summary ~ "${sum.slice(0, 50)}"`;
    try {
      const res = await cloud.searchIssues(jql, "summary,issuetype,parent", 10);
      const arr = (res || []).map((x) => x.key);
      console.log(`  ${key} "${sum.slice(0, 35)}" -> cloud matches: [${arr.join(", ")}]`);
    } catch (e) { console.log(`  ${key}: search ERR ${e.statusCode || e.message.slice(0, 40)}`); }
  }
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
