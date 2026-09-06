#!/usr/bin/env node
/**
 * Batched audit of the full pending plan: polls fresh state from DC and Cloud
 * for every pending row, then compares to the plan. Output groups results by
 * (discovery × parentSource) bucket so we can confirm Phase 1a and Phase 1b
 * separately before applying.
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const DatacenterClient = require("./src/datacenterClient");
const CloudJiraClient = require("./src/cloudJiraClient");

const planFile = process.argv[2];
if (!planFile) {
  console.error("Usage: node batched_verify.js <plan_*.json>");
  process.exit(1);
}

const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
const pending = Object.entries(plan.issues).filter(
  ([, d]) => d.status === "pending",
);

const dc = new DatacenterClient(
  process.env.DC_BASE_URL,
  process.env.DC_USERNAME,
  process.env.DC_PASSWORD,
);
const cloud = new CloudJiraClient(
  process.env.CLOUD_BASE_URL,
  process.env.CLOUD_API_TOKEN,
);

const bucketKey = (data) =>
  `${data.discovery || "imported-jql"} :: ${data.parentSource}`;

(async () => {
  const { epicLinkFieldId, parentLinkFieldId } = await dc.discoverParentFieldIds();
  console.log(
    `Discovered DC field ids: epic=${epicLinkFieldId}, parentLink=${parentLinkFieldId}`,
  );

  const buckets = new Map();
  for (const entry of pending) {
    const b = bucketKey(entry[1]);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(entry);
  }
  console.log(`\n${pending.length} pending entries across ${buckets.size} buckets:`);
  for (const [b, items] of buckets) {
    console.log(`  ${b.padEnd(50)} ${items.length}`);
  }

  // ─── 1. Cloud batch: state of every child ───
  const childKeys = pending.map(([k]) => k);
  console.log(`\nCloud batch GET parent+issuetype for ${childKeys.length} children...`);
  const cloudChild = await cloud.batchGetIssueParents(childKeys, 50);

  // ─── 2. Cloud batch: existence of every unique target parent ───
  const uniqueParents = [...new Set(pending.map(([, d]) => d.targetParentKey))];
  console.log(`Cloud batch GET parent existence for ${uniqueParents.length} unique parents...`);
  const cloudParent = await cloud.batchGetIssueParents(uniqueParents, 50);

  // ─── 3. DC batch: parent / Epic Link / Parent Link for every child ───
  console.log(`DC batch search for parent state of ${childKeys.length} children...`);
  const dcChild = new Map();
  const dcFields = ["parent", "issuetype"];
  if (epicLinkFieldId) dcFields.push(epicLinkFieldId);
  if (parentLinkFieldId) dcFields.push(parentLinkFieldId);
  const fieldsParam = dcFields.join(",");
  const batchSize = 100;

  for (let i = 0; i < childKeys.length; i += batchSize) {
    const batch = childKeys.slice(i, i + batchSize);
    const jql = `key in (${batch.join(",")})`;
    let startAt = 0;
    while (true) {
      const url = `/rest/api/2/search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=100&fields=${fieldsParam}`;
      let res;
      try {
        res = await dc.makeRequest("GET", url);
      } catch (e) {
        console.log(`  DC batch failed: ${e.message}`);
        break;
      }
      const issues = res.issues || [];
      for (const issue of issues) {
        const f = issue.fields || {};
        const rawParent = f.parent || null;
        const rawEpic = epicLinkFieldId ? f[epicLinkFieldId] || null : null;
        const rawPL = parentLinkFieldId ? f[parentLinkFieldId] || null : null;
        let parentKey = null;
        let parentSource = null;
        if (rawParent?.key) {
          parentKey = rawParent.key;
          parentSource = "fields.parent";
        } else if (rawEpic) {
          parentKey =
            typeof rawEpic === "string" ? rawEpic : rawEpic.key || null;
          if (parentKey) parentSource = epicLinkFieldId;
        } else if (rawPL) {
          if (typeof rawPL === "string") parentKey = rawPL;
          else if (rawPL.key) parentKey = rawPL.key;
          else if (rawPL.data?.key) parentKey = rawPL.data.key;
          if (parentKey) parentSource = parentLinkFieldId;
        }
        dcChild.set(issue.key, {
          parentKey,
          parentSource,
          issueType: f.issuetype?.name || null,
          rawPL,
        });
      }
      if (issues.length === 0 || startAt + issues.length >= (res.total || 0)) break;
      startAt += issues.length;
    }
  }

  // 3b. Fallback per-issue GET for Parent-Link entries that came back null
  // (the DC /search endpoint has a known quirk returning null for
  // com.atlassian.jpo:jpo-custom-field-parent values).
  const plPending = pending.filter(
    ([, d]) => d.parentSource === parentLinkFieldId,
  );
  const needFallback = plPending.filter(([k]) => {
    const cur = dcChild.get(k);
    return !cur || !cur.parentKey;
  });
  if (needFallback.length > 0) {
    console.log(
      `Per-issue fallback for ${needFallback.length} Parent-Link rows (DC search quirk)...`,
    );
    for (const [k] of needFallback) {
      const info = await dc.getIssueParentInfo(k, {
        epicLinkFieldId,
        parentLinkFieldId,
      });
      if (info.parentKey) {
        dcChild.set(k, {
          parentKey: info.parentKey,
          parentSource: info.parentSource,
          issueType: info.issueType,
          rawPL: info.rawParentLink,
        });
      }
    }
  }

  // ─── 4. Compare each row to fresh state ───
  const problemsByBucket = new Map();
  const okByBucket = new Map();
  for (const b of buckets.keys()) {
    problemsByBucket.set(b, []);
    okByBucket.set(b, 0);
  }
  const problems = [];

  for (const [key, data] of pending) {
    const cs = cloudChild.get(key);
    const cp = cloudParent.get(data.targetParentKey);
    const dcs = dcChild.get(key);

    const checks = {
      cloud_child_exists: !!cs?.exists,
      cloud_child_no_parent: !cs?.parent,
      cloud_parent_exists: !!cp?.exists,
      dc_parent_match: dcs?.parentKey === data.targetParentKey,
      dc_source_match: dcs?.parentSource === data.parentSource,
    };
    const allOk = Object.values(checks).every(Boolean);
    const b = bucketKey(data);
    if (allOk) {
      okByBucket.set(b, (okByBucket.get(b) || 0) + 1);
    } else {
      problems.push({
        key,
        planned_parent: data.targetParentKey,
        planned_source: data.parentSource,
        discovery: data.discovery,
        checks,
        cloud_child: cs,
        cloud_parent: cp,
        dc_child: dcs,
      });
      problemsByBucket.get(b).push(key);
    }
  }

  console.log("\n=== Verification summary by bucket ===");
  for (const [b, items] of buckets) {
    const ok = okByBucket.get(b);
    const probs = problemsByBucket.get(b).length;
    console.log(
      `${b.padEnd(50)} ${String(ok).padStart(4)}/${String(items.length).padStart(4)} OK` +
        (probs > 0 ? `  (${probs} problems)` : ""),
    );
  }
  console.log(`\nTOTAL: ${pending.length - problems.length}/${pending.length} OK, ${problems.length} problems`);

  if (problems.length > 0) {
    console.log(`\nFirst 15 problems:`);
    for (const p of problems.slice(0, 15)) {
      console.log(JSON.stringify(p, null, 2));
    }
    // Optionally save the full list for triage
    const outFile = path.join(__dirname, "logs", `verify_problems_${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(problems, null, 2));
    console.log(`\nFull problems list written to: ${outFile}`);
  }
})();
