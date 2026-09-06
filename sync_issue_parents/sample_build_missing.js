#!/usr/bin/env node
/** READ-ONLY. Sample BUILD's reported-missing keys from the May-12 checkpoint and
 *  check how many now exist in Cloud (quantifies report staleness). */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });
const CloudJiraClient = require("./src/cloudJiraClient");

const CKPT = "../find_missing_issues/reports/checkpoint.jsonl";
const N = parseInt(process.argv[2], 10) || 150;

async function main() {
  const lines = fs.readFileSync(CKPT, "utf8").split("\n").filter(Boolean);
  let build;
  for (const l of lines) { const e = JSON.parse(l); if (e.projectKey === "BUILD") { build = e; break; } }
  const keys = build.missing.map((m) => m.key);
  console.log(`BUILD reported-missing (May 12): ${keys.length}`);
  const step = Math.max(1, Math.floor(keys.length / N));
  const sample = [];
  for (let k = 0; k < keys.length && sample.length < N; k += step) sample.push(keys[k]);

  const cloud = new CloudJiraClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN);
  let exists = 0, missing = 0; const stillMissing = [];
  for (const key of sample) {
    try { await cloud.makeRequest("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`); exists++; }
    catch (e) { if (e.statusCode === 404) { missing++; stillMissing.push(key); } else console.log(`  ${key} ERR ${e.statusCode}`); }
  }
  console.log(`\nSampled ${sample.length} of the reported-missing BUILD keys:`);
  console.log(`  NOW EXIST in cloud: ${exists}  (${(100 * exists / sample.length).toFixed(1)}%)`);
  console.log(`  STILL missing:      ${missing}  (${(100 * missing / sample.length).toFixed(1)}%)`);
  if (stillMissing.length) console.log(`  still-missing sample: ${stillMissing.slice(0, 20).join(", ")}`);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
