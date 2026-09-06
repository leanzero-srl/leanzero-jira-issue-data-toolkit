#!/usr/bin/env node
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const CloudJiraClient = require("../src/cloudJiraClient");
const DcClient = require("../src/datacenterClient");
const { walk } = require("../src/adfWalker");

const cloud = new CloudJiraClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN);
const dc = process.env.DC_PAT
  ? new DcClient(process.env.DC_BASE_URL, { token: process.env.DC_PAT })
  : new DcClient(process.env.DC_BASE_URL, { username: process.env.DC_USERNAME, password: process.env.DC_PASSWORD });

function extractPlain(adf) {
  let out = "";
  for (const f of walk(adf)) {
    const n = f.node;
    if (n && n.type === "text" && typeof n.text === "string") out += n.text;
  }
  return out;
}

function findRuns(s, min = 2) {
  const r = [];
  for (let i = 0; i < s.length; ) {
    if (s[i] === ";") {
      let j = i;
      while (j < s.length && s[j] === ";") j++;
      if (j - i >= min) r.push({ start: i, len: j - i, ctxLeft: s.slice(Math.max(0, i - 25), i), ctxRight: s.slice(j, Math.min(s.length, j + 25)) });
      i = j;
    } else i++;
  }
  return r;
}

(async () => {
  const KEY = process.argv[2] || "P2-288";
  const CMT = process.argv[3] || "9277967";

  console.log(`=== ${KEY} comment ${CMT} ===\n`);

  // CLOUD
  const cloudCmt = await cloud.getComment(KEY, CMT);
  const cloudPlain = extractPlain(cloudCmt.body);
  const cloudRuns = findRuns(cloudPlain, 2);
  console.log("CLOUD plain text length:", cloudPlain.length);
  console.log("CLOUD ;;+ run count:", cloudRuns.length);
  cloudRuns.slice(0, 10).forEach((r, i) => {
    console.log(`  #${i + 1} len=${r.len} ;${"".padEnd(r.len, ";")} | left="${r.ctxLeft.slice(-15)}" right="${r.ctxRight.slice(0, 15)}"`);
  });

  // DC
  const dcRaw = await dc.makeRequest("GET", `/rest/api/2/issue/${KEY}?fields=comment`);
  const dcCmts = dcRaw?.fields?.comment?.comments || [];
  // Match by created timestamp - 1h (UTC shift)
  // Cloud created: cloudCmt.created
  const cloudCreated = cloudCmt.created || "";
  const cloudCreatedHM = cloudCreated.slice(11, 16); // HH:MM
  let dcCmt = dcCmts.find((c) => (c.created || "").slice(11, 16) === cloudCreatedHM);
  if (!dcCmt && dcCmts.length === cloudRuns.length) {} // no helpful default
  if (!dcCmt) {
    // fall back to author + nearest minute match
    const sameAuthor = dcCmts.filter((c) => c.author?.displayName === cloudCmt.author?.displayName);
    dcCmt = sameAuthor[0] || dcCmts[0];
  }
  console.log("\nMATCHED DC comment id:", dcCmt?.id, "author:", dcCmt?.author?.displayName, "created:", dcCmt?.created);
  const dcBody = dcCmt?.body || "";
  const dcRuns = findRuns(dcBody, 2);
  console.log("DC body length:", dcBody.length);
  console.log("DC ;;+ run count:", dcRuns.length);
  dcRuns.slice(0, 10).forEach((r, i) => {
    console.log(`  #${i + 1} len=${r.len} ;${"".padEnd(r.len, ";")} | left="${r.ctxLeft.slice(-15)}" right="${r.ctxRight.slice(0, 15)}"`);
  });

  console.log("\nDC ; (single+) total count:", (dcBody.match(/;/g) || []).length);
  console.log("CLOUD ; (single+) total count:", (cloudPlain.match(/;/g) || []).length);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
