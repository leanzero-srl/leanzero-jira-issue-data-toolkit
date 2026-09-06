#!/usr/bin/env node
/**
 * READ-ONLY verification of the parent-mapped CSV trick.
 * For each sample: orig DC parent id -> DC key  AND  mapped cloud id -> cloud key.
 * If the trick is sound, both sides resolve to the SAME issue key, and that
 * cloud issue actually exists.
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });
const DatacenterClient = require("./src/datacenterClient");
const CloudJiraClient = require("./src/cloudJiraClient");

// [childKey, origDcParentId, mappedCloudId]
const samples = [
  ["ENG-34891", "2296097", "1748974"],
  ["ENG-34893", "2296094", "1748973"],
  ["ENG-34896", "2295281", "1748971"],
  ["ENG-35042", "2270509", "1748951"],
];

async function main() {
  const dc = new DatacenterClient(process.env.DC_BASE_URL, process.env.DC_USERNAME, process.env.DC_PASSWORD);
  const cloud = new CloudJiraClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN);

  console.log("DC conn:", await dc.testConnection(), "| Cloud conn:", await cloud.testConnection(), "\n");

  for (const [childKey, dcParentId, cloudId] of samples) {
    let dcParentKey = "?", cloudKeyOfId = "?", cloudIdSummary = "?", childInCloud = "?";
    try {
      const r = await dc.makeRequest("GET", `/rest/api/2/issue/${dcParentId}?fields=summary,issuetype`);
      dcParentKey = r.key;
    } catch (e) { dcParentKey = "DC-ERR " + e.message.slice(0, 60); }
    try {
      const r = await cloud.makeRequest("GET", `/rest/api/3/issue/${cloudId}?fields=summary,issuetype`);
      cloudKeyOfId = r.key;
      cloudIdSummary = (r.fields?.summary || "").slice(0, 40);
    } catch (e) { cloudKeyOfId = "CLOUD-ERR " + e.message.slice(0, 60); }
    try {
      const r = await cloud.makeRequest("GET", `/rest/api/3/issue/${childKey}?fields=summary,parent,issuetype`);
      childInCloud = `EXISTS type=${r.fields?.issuetype?.name} parent=${r.fields?.parent?.key || "(none)"}`;
    } catch (e) { childInCloud = "MISSING (" + (e.statusCode || e.message.slice(0, 30)) + ")"; }

    const match = dcParentKey === cloudKeyOfId ? "✅ MATCH" : "❌ MISMATCH";
    console.log(`child ${childKey}`);
    console.log(`   DC parent id ${dcParentId} -> ${dcParentKey}`);
    console.log(`   cloud id ${cloudId} -> ${cloudKeyOfId}   "${cloudIdSummary}"   ${match}`);
    console.log(`   child in cloud: ${childInCloud}\n`);
  }
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
