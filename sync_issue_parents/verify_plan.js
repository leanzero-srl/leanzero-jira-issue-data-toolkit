#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const DatacenterClient = require("./src/datacenterClient");
const CloudJiraClient = require("./src/cloudJiraClient");

const planFile = process.argv[2];
if (!planFile) {
  console.error("Usage: node verify_plan.js <plan_*.json>");
  process.exit(1);
}

const sampleArg = process.argv.indexOf("--sample");
const samplePerBucket = sampleArg > 0 ? parseInt(process.argv[sampleArg + 1], 10) : 0;

const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
let pending = Object.entries(plan.issues).filter(
  ([, d]) => d.status === "pending",
);

if (samplePerBucket > 0) {
  const buckets = new Map();
  for (const entry of pending) {
    const discovery = entry[1].discovery || "imported-jql";
    const src = entry[1].parentSource || "(none)";
    const k = `${discovery} :: ${src}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(entry);
  }
  pending = [];
  for (const [k, items] of buckets) {
    const take = items.slice(0, samplePerBucket);
    if (items.length > samplePerBucket) take.push(items[items.length - 1]);
    console.log(`Sampling bucket "${k}": ${take.length} of ${items.length} total`);
    pending.push(...take);
  }
}

const dc = new DatacenterClient(
  process.env.DC_BASE_URL,
  process.env.DC_USERNAME,
  process.env.DC_PASSWORD,
);
const cloud = new CloudJiraClient(
  process.env.CLOUD_BASE_URL,
  process.env.CLOUD_API_TOKEN,
);

(async () => {
  console.log("Discovering DC parent-related custom field ids...");
  const { epicLinkFieldId, parentLinkFieldId } = await dc.discoverParentFieldIds();
  console.log(`  epicLinkFieldId=${epicLinkFieldId}, parentLinkFieldId=${parentLinkFieldId}\n`);

  console.log(`Verifying ${pending.length} pending entries...\n`);

  let ok = 0;
  let problems = 0;

  for (const [childKey, data] of pending) {
    const target = data.targetParentKey;
    const checks = { child: childKey, planned_parent: target };

    // 1. Cloud child should currently have NO parent
    try {
      const cloudChild = await cloud.makeRequest(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(childKey)}?fields=parent,issuetype,summary`,
      );
      checks.cloud_child_summary = cloudChild.fields?.summary || null;
      checks.cloud_child_type = cloudChild.fields?.issuetype?.name || null;
      checks.cloud_child_has_parent = !!cloudChild.fields?.parent;
      checks.cloud_child_existing_parent = cloudChild.fields?.parent?.key || null;
    } catch (e) {
      checks.cloud_child_error = e.message;
    }

    // 2. DC child should have parent = target
    try {
      const dcInfo = await dc.getIssueParentInfo(childKey, {
        epicLinkFieldId,
        parentLinkFieldId,
      });
      checks.dc_child_type = dcInfo.issueType;
      checks.dc_child_is_subtask = dcInfo.isSubtask;
      checks.dc_child_parent = dcInfo.parentKey;
      checks.dc_child_parent_source = dcInfo.parentSource;
      checks.dc_matches_plan = dcInfo.parentKey === target;
    } catch (e) {
      checks.dc_child_error = e.message;
    }

    // 3. Cloud parent should exist
    try {
      const cloudParent = await cloud.makeRequest(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(target)}?fields=summary,issuetype`,
      );
      checks.cloud_parent_exists = true;
      checks.cloud_parent_summary = cloudParent.fields?.summary || null;
      checks.cloud_parent_type = cloudParent.fields?.issuetype?.name || null;
    } catch (e) {
      checks.cloud_parent_exists = false;
      checks.cloud_parent_error = e.message;
    }

    // Summary verdict
    const safe =
      checks.cloud_child_has_parent === false &&
      checks.dc_matches_plan === true &&
      checks.cloud_parent_exists === true;

    console.log(
      `${safe ? "OK " : "!! "} ${childKey} -> ${target}  | ` +
        `cloud_child_parent=${checks.cloud_child_existing_parent ?? "(empty)"} | ` +
        `dc_parent=${checks.dc_child_parent} | ` +
        `cloud_parent_exists=${checks.cloud_parent_exists}`,
    );
    if (!safe) {
      problems++;
      console.log("    DETAIL:", JSON.stringify(checks, null, 2));
    } else {
      ok++;
    }
  }

  console.log(`\nVerified: ${ok} safe, ${problems} problems`);
})();
