#!/usr/bin/env node
/**
 * READ-ONLY. Parse the parent-mapped CSV, take a spread sample of Sub-Task rows,
 * and check current Cloud state: does the child exist (same key) and is it parented?
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });
const CloudJiraClient = require("./src/cloudJiraClient");

const CSV = process.argv[2] ||
  "./data/export_cleaned.parent-mapped.csv";
const N = parseInt(process.argv[3], 10) || 60;

function parseCsv(text) {
  const rows = []; let row = [], field = "", q = false, i = 0; const n = text.length;
  while (i < n) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += c; i++; continue;
    }
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
  const iKey = ci("issue key"), iType = ci("issue type"), iParent = ci("parent id");
  const subtasks = rows.slice(1).filter((r) => (r[iType] || "").trim().toLowerCase() === "sub-task");
  console.log(`Total data rows: ${rows.length - 1} | Sub-Task rows: ${subtasks.length}`);

  const step = Math.max(1, Math.floor(subtasks.length / N));
  const sample = [];
  for (let k = 0; k < subtasks.length && sample.length < N; k += step) sample.push(subtasks[k]);

  const cloud = new CloudJiraClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN);
  let exists = 0, existsParented = 0, existsNoParent = 0, missing = 0, blankMapped = 0;
  const missingKeys = [];
  for (const r of sample) {
    const key = r[iKey];
    if (!r[iParent] || !r[iParent].trim()) blankMapped++;
    try {
      const res = await cloud.makeRequest("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=parent,issuetype`);
      exists++;
      if (res.fields?.parent?.key) existsParented++; else existsNoParent++;
    } catch (e) {
      if (e.statusCode === 404) { missing++; missingKeys.push(key); }
      else { console.log(`  ${key}: ERR ${e.statusCode || ""} ${(e.message || "").slice(0, 50)}`); }
    }
  }
  console.log(`\nSampled ${sample.length} sub-tasks:`);
  console.log(`  EXIST in cloud (same key):     ${exists}`);
  console.log(`     -> with parent attached:    ${existsParented}`);
  console.log(`     -> WITHOUT parent:          ${existsNoParent}`);
  console.log(`  MISSING from cloud (404):      ${missing}`);
  console.log(`  (rows whose mapped Parent id was blanked/unresolved: ${blankMapped})`);
  if (missingKeys.length) console.log(`  sample missing keys: ${missingKeys.slice(0, 15).join(", ")}`);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
