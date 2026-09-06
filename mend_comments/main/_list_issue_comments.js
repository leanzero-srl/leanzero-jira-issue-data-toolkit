#!/usr/bin/env node
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const CloudJiraClient = require("../src/cloudJiraClient");
const { findMentionNodes, isUnknownMention } = require("../src/adfWalker");

const cloud = new CloudJiraClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN);

(async () => {
  const KEY = process.argv[2] || "P2-240";
  const issue = await cloud.makeRequest("GET", `/rest/api/3/issue/${KEY}?fields=comment`);
  const comments = issue?.fields?.comment?.comments || [];
  console.log(`=== ${KEY} has ${comments.length} comment(s) ===\n`);
  for (const c of comments) {
    const mentions = findMentionNodes(c.body);
    const unknowns = mentions.filter((f) => isUnknownMention(f.node));
    const known = mentions.length - unknowns.length;
    console.log(`comment id=${c.id} created=${c.created} author=${c.author?.displayName || c.author?.accountId}`);
    console.log(`  mention nodes: ${mentions.length} total (${known} resolved, ${unknowns.length} UNKNOWN)`);
    for (const f of unknowns) {
      const a = f.node.attrs || {};
      console.log(`    [UNKNOWN] attrs=${JSON.stringify({ id: a.id, text: a.text, accessLevel: a.accessLevel })}`);
    }
  }
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
