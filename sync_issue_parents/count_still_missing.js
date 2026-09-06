#!/usr/bin/env node
/** READ-ONLY. For a project's reported-missing keys (from checkpoint.jsonl),
 *  check current Cloud existence and break down what's STILL missing by type.
 *  For still-missing sub-tasks, check whether the DC parent exists in Cloud. */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });
const DatacenterClient = require("./src/datacenterClient");
const CloudJiraClient = require("./src/cloudJiraClient");

const CKPT = "../find_missing_issues/reports/checkpoint.jsonl";
const PROJECT = process.argv[2] || "BUILD";
const CONC = parseInt(process.argv[3], 10) || 10;

async function runPool(items, conc, worker) {
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (true) { const i = idx++; if (i >= items.length) return; await worker(items[i], i); }
  }));
}

async function main() {
  const lines = fs.readFileSync(CKPT, "utf8").split("\n").filter(Boolean);
  let proj;
  for (const l of lines) { const e = JSON.parse(l); if (e.projectKey === PROJECT) { proj = e; break; } }
  if (!proj) { console.error(`No checkpoint for ${PROJECT}`); process.exit(1); }
  const missing = proj.missing; // [{key,summary,type,status,...}]
  console.log(`${PROJECT}: reported-missing (May 12) = ${missing.length}`);

  const cloud = new CloudJiraClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN);
  const stillMissing = [];
  let done = 0;
  await runPool(missing, CONC, async (m) => {
    try { await cloud.makeRequest("GET", `/rest/api/3/issue/${encodeURIComponent(m.key)}?fields=summary`); }
    catch (e) { if (e.statusCode === 404) stillMissing.push(m); }
    if (++done % 1000 === 0) console.log(`  checked ${done}/${missing.length} ...`);
  });

  const byType = {};
  for (const m of stillMissing) byType[m.type] = (byType[m.type] || 0) + 1;
  console.log(`\nNOW EXIST: ${missing.length - stillMissing.length}  |  STILL MISSING: ${stillMissing.length}`);
  console.log(`Still-missing by type:`, JSON.stringify(byType, null, 0));

  // For still-missing sub-tasks, check DC parent presence in cloud
  const subs = stillMissing.filter((m) => /sub-?task/i.test(m.type));
  if (subs.length) {
    const dc = new DatacenterClient(process.env.DC_BASE_URL, process.env.DC_USERNAME, process.env.DC_PASSWORD);
    let parentInCloud = 0, parentMissing = 0, noParent = 0, dcErr = 0;
    done = 0;
    await runPool(subs, CONC, async (m) => {
      let pk = null;
      try { const r = await dc.makeRequest("GET", `/rest/api/2/issue/${encodeURIComponent(m.key)}?fields=parent`); pk = r.fields?.parent?.key || null; }
      catch (e) { dcErr++; return; }
      if (!pk) { noParent++; return; }
      try { await cloud.makeRequest("GET", `/rest/api/3/issue/${encodeURIComponent(pk)}?fields=summary`); parentInCloud++; }
      catch (e) { if (e.statusCode === 404) parentMissing++; }
      if (++done % 200 === 0) console.log(`  subtask-parent checked ${done}/${subs.length} ...`);
    });
    console.log(`\nStill-missing SUB-TASKS: ${subs.length}`);
    console.log(`  parent EXISTS in cloud (create-with-parent now): ${parentInCloud}`);
    console.log(`  parent ALSO missing (must create parent first):  ${parentMissing}`);
    console.log(`  DC says no parent: ${noParent} | DC errors: ${dcErr}`);
  }

  // persist still-missing list for later use
  const outDir = path.resolve(__dirname, "logs");
  const outPath = path.join(outDir, `still_missing_${PROJECT}.json`);
  fs.writeFileSync(outPath, JSON.stringify(stillMissing, null, 2));
  console.log(`\nWrote still-missing list: ${outPath}`);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
