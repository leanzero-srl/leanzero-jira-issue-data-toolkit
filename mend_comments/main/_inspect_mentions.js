#!/usr/bin/env node
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const CloudJiraClient = require("../src/cloudJiraClient");
const DcClient = require("../src/datacenterClient");
const { walk, isUnknownMention, findMentionNodes } = require("../src/adfWalker");
const { extractDcMentions } = require("../src/mentionExtractor");

const cloud = new CloudJiraClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN);
const dc = process.env.DC_PAT
  ? new DcClient(process.env.DC_BASE_URL, { token: process.env.DC_PAT })
  : new DcClient(process.env.DC_BASE_URL, { username: process.env.DC_USERNAME, password: process.env.DC_PASSWORD });

(async () => {
  const KEY = process.argv[2] || "P2-240";
  const CMT = process.argv[3] || "9277044";

  // CLOUD
  const cloudCmt = await cloud.getComment(KEY, CMT);
  const allMentions = findMentionNodes(cloudCmt.body);
  console.log(`=== ${KEY} comment ${CMT} ===\n`);
  console.log(`CLOUD total mention nodes: ${allMentions.length}`);
  for (const f of allMentions) {
    const a = f.node.attrs || {};
    const flagged = isUnknownMention(f.node);
    console.log(`  ${flagged ? "[UNKNOWN]" : "[OK     ]"} attrs=${JSON.stringify({ id: a.id, text: a.text, accessLevel: a.accessLevel })}`);
  }
  const unknowns = allMentions.filter((f) => isUnknownMention(f.node));
  console.log(`CLOUD @unknown mention nodes: ${unknowns.length}`);

  // Plain text scan — look for "@" markers that might be visible @-prefixed text
  let plain = "";
  for (const f of walk(cloudCmt.body)) {
    const n = f.node;
    if (n && n.type === "text" && typeof n.text === "string") plain += n.text;
  }
  const atMatches = [...plain.matchAll(/@\S+/g)].map((m) => m[0]);
  console.log(`CLOUD text-with-@ markers (${atMatches.length}):`);
  for (const m of atMatches.slice(0, 30)) console.log("  ", m);

  // DC
  const dcRaw = await dc.makeRequest("GET", `/rest/api/2/issue/${KEY}?fields=comment&expand=renderedFields`);
  const dcCmts = dcRaw?.fields?.comment?.comments || [];
  const rfCmts = dcRaw?.renderedFields?.comment?.comments || [];
  const cloudHM = (cloudCmt.created || "").slice(11, 16);
  let dcCmtIdx = dcCmts.findIndex((c) => (c.created || "").slice(11, 16) === cloudHM);
  if (dcCmtIdx < 0) dcCmtIdx = dcCmts.findIndex((c) => c.author?.displayName === cloudCmt.author?.displayName);
  const dcCmt = dcCmts[dcCmtIdx] || dcCmts[0];
  const dcRf = rfCmts[dcCmtIdx] || rfCmts[0];
  console.log(`\nMATCHED DC comment id: ${dcCmt?.id} author: ${dcCmt?.author?.displayName}`);
  console.log(`DC body (first 300 chars):\n${(dcCmt?.body || "").substring(0, 300)}`);
  console.log(`DC rendered (first 300 chars):\n${(dcRf?.body || "").substring(0, 300)}`);
  const dcMentions = extractDcMentions({ storage: dcCmt?.body, rendered: dcRf?.body });
  console.log(`\nDC mentions extracted: ${dcMentions.length}`);
  for (const m of dcMentions) console.log(`  ${m.source}: username=${m.username} display=${m.displayName || ""} pos=${m.position}`);
})().catch((e) => { console.error("FAIL:", e.message); console.error(e.stack); process.exit(1); });
