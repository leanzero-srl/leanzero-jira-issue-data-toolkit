#!/usr/bin/env node
/** READ-ONLY. For BUILD keys still missing from Cloud, look up DC type + parent,
 *  and check whether that parent currently exists in Cloud. */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });
const DatacenterClient = require("./src/datacenterClient");
const CloudJiraClient = require("./src/cloudJiraClient");

const CKPT = "../find_missing_issues/reports/checkpoint.jsonl";
const N = parseInt(process.argv[2], 10) || 120;

async function main() {
  const lines = fs.readFileSync(CKPT, "utf8").split("\n").filter(Boolean);
  let build;
  for (const l of lines) { const e = JSON.parse(l); if (e.projectKey === "BUILD") { build = e; break; } }
  const keys = build.missing.map((m) => m.key);
  const step = Math.max(1, Math.floor(keys.length / N));
  const sample = [];
  for (let k = 0; k < keys.length && sample.length < N; k += step) sample.push(keys[k]);

  const dc = new DatacenterClient(process.env.DC_BASE_URL, process.env.DC_USERNAME, process.env.DC_PASSWORD);
  const cloud = new CloudJiraClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN);

  const typeCount = {};
  let stillMissing = 0, subtask = 0, subtaskParentInCloud = 0, subtaskParentMissing = 0;
  for (const key of sample) {
    // only the ones actually still missing from cloud
    try { await cloud.makeRequest("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`); continue; }
    catch (e) { if (e.statusCode !== 404) continue; }
    stillMissing++;
    let dcIssue;
    try { dcIssue = await dc.makeRequest("GET", `/rest/api/2/issue/${encodeURIComponent(key)}?fields=issuetype,parent`); }
    catch (e) { typeCount["DC-ERR"] = (typeCount["DC-ERR"] || 0) + 1; continue; }
    const t = dcIssue.fields?.issuetype?.name || "?";
    typeCount[t] = (typeCount[t] || 0) + 1;
    const isSub = dcIssue.fields?.issuetype?.subtask;
    const parentKey = dcIssue.fields?.parent?.key;
    if (isSub && parentKey) {
      subtask++;
      try { await cloud.makeRequest("GET", `/rest/api/3/issue/${encodeURIComponent(parentKey)}?fields=summary`); subtaskParentInCloud++; }
      catch (e) { if (e.statusCode === 404) subtaskParentMissing++; }
    }
  }
  console.log(`Sampled ${sample.length}; still-missing-in-cloud: ${stillMissing}`);
  console.log(`Type breakdown of still-missing:`, JSON.stringify(typeCount));
  console.log(`Sub-tasks among still-missing: ${subtask}`);
  console.log(`  -> parent EXISTS in cloud (can create-with-parent): ${subtaskParentInCloud}`);
  console.log(`  -> parent ALSO missing (needs parent first):        ${subtaskParentMissing}`);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
