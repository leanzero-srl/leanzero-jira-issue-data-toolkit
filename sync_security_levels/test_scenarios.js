#!/usr/bin/env node

/**
 * Test script for verifying sync_security_levels end-to-end in isolation.
 *
 * Strategy:
 *   1. Get all projects with security schemes from both DC and Cloud
 *   2. For scenario 2: skip projects where Cloud has all DC security levels
 *   3. Per project, compare counts: DC issues with security vs Cloud issues with security
 *   4. If Cloud count is lower, fetch Cloud issues WITHOUT security level
 *   5. Cross-check those against DC to find what's missing
 *   6. Stop at first actionable issue
 *
 * Usage:
 *   node test_scenarios.js --scenario 1 [--dry-run] [--project <KEY>]
 *   node test_scenarios.js --scenario 2 [--dry-run] [--project <KEY>]
 *   node test_scenarios.js --scenario auto [--dry-run] [--project <KEY>]
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const DatacenterClient = require("./src/datacenterClient");
const CloudJiraClient = require("./src/cloudJiraClient");

// ── CLI ──
const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const SCENARIO = getArg("--scenario") || "auto";
const PROJECT_FILTER = getArg("--project");
const DRY_RUN = args.includes("--dry-run");

if (args.includes("--help")) {
  console.log(`
Usage:
  node test_scenarios.js --scenario <1|2|auto> [--dry-run] [--project <KEY>]

Scenarios:
  1     Find first issue where Cloud level EXISTS in scheme but is missing/wrong on issue -> set it
  2     Find first issue where Cloud level OR scheme is MISSING -> create it, then set it
  auto  Handle whichever case it finds first

Options:
  --project <KEY>   Only check this project
  --dry-run         Preview without making changes
  --help            Show this help
`);
  process.exit(0);
}

const dcClient = new DatacenterClient(
  process.env.DC_BASE_URL,
  process.env.DC_USERNAME,
  process.env.DC_PASSWORD,
);

const cloudClient = new CloudJiraClient(
  process.env.CLOUD_BASE_URL,
  process.env.CLOUD_API_TOKEN,
);

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─────────────────────────────────────────────────
//  HELPERS: JQL COUNTS
// ─────────────────────────────────────────────────

async function dcCount(jql) {
  const encoded = encodeURIComponent(jql);
  try {
    const res = await dcClient.makeRequest(
      "GET",
      `/rest/api/2/search?jql=${encoded}&maxResults=0`,
    );
    return res.total || 0;
  } catch (err) {
    if (err.statusCode === 400) return 0;
    throw err;
  }
}

async function cloudCount(jql) {
  const encoded = encodeURIComponent(jql);
  const res = await cloudClient.makeRequest(
    "GET",
    `/rest/api/3/search/jql?jql=${encoded}&maxResults=0`,
  );
  return res.total || 0;
}

async function cloudSearchIssues(jql, fields, maxResults = 50) {
  const encoded = encodeURIComponent(jql);
  const issues = [];
  let startAt = 0;

  while (true) {
    const res = await cloudClient.makeRequest(
      "GET",
      `/rest/api/3/search/jql?jql=${encoded}&startAt=${startAt}&maxResults=${maxResults}&fields=${fields}`,
    );
    const batch = res.issues || [];
    issues.push(...batch);
    if (startAt + batch.length >= (res.total || 0) || batch.length === 0) break;
    startAt += batch.length;
  }

  return issues;
}

async function dcGetIssue(issueKey) {
  return dcClient.makeRequest(
    "GET",
    `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=security,project`,
  );
}

// ─────────────────────────────────────────────────
//  STEP 1: DISCOVER PROJECTS WITH SECURITY LEVELS
// ─────────────────────────────────────────────────

async function discoverProjects() {
  log("Step 1: Discovering DC projects with security schemes...");

  // Get ALL DC projects
  const allProjects = await dcClient.makeRequest("GET", "/rest/api/2/project");
  log(`  ${allProjects.length} total DC projects`);

  // Check which have security schemes
  const projectSchemes = new Map(); // projectKey -> { schemeName, schemeId }

  for (const p of allProjects) {
    if (PROJECT_FILTER && p.key !== PROJECT_FILTER) continue;
    try {
      const scheme = await dcClient.fetchProjectSecurityScheme(p.key);
      if (scheme && scheme.id) {
        projectSchemes.set(p.key, { schemeName: scheme.name, schemeId: String(scheme.id) });
      }
    } catch {
      // no scheme
    }
  }

  log(`  ${projectSchemes.size} project(s) with security schemes`);

  // Get issue counts for projects that have schemes
  log("\n  Getting issue counts per project...");
  const projectCounts = new Map(); // projectKey -> dcCount

  for (const [projectKey] of projectSchemes) {
    const count = await dcCount(`level is not EMPTY AND project = "${projectKey}"`);
    if (count > 0) {
      projectCounts.set(projectKey, count);
    }
  }

  log(`  ${projectCounts.size} project(s) with actual security-level issues\n`);
  for (const [key, count] of projectCounts) {
    const scheme = projectSchemes.get(key);
    log(`    ${key}: ${count} issues (scheme: "${scheme.schemeName}")`);
  }

  return projectCounts;
}

// ─────────────────────────────────────────────────
//  STEP 2: COMPARE COUNTS & FIND GAPS
// ─────────────────────────────────────────────────

async function findCandidate(wantedType) {
  const dcProjectCounts = await discoverProjects();

  if (dcProjectCounts.size === 0) {
    log("\nNo projects with security levels found in DC.");
    return null;
  }

  // Get Cloud security schemes and levels
  log("\nStep 2: Fetching Cloud security schemes and levels...");
  const cloudSchemes = await cloudClient.fetchAllSecuritySchemes();
  const cloudSchemeMap = new Map(); // schemeId -> { name, levels: Map<name, id> }

  if (cloudSchemes.length > 0) {
    const schemeIds = cloudSchemes.map((s) => s.id);
    const cloudLevels = await cloudClient.fetchSecurityLevels(schemeIds);

    for (const scheme of cloudSchemes) {
      cloudSchemeMap.set(String(scheme.id), { name: scheme.name, levels: new Map() });
    }
    for (const level of cloudLevels) {
      const scheme = cloudSchemeMap.get(String(level.issueSecuritySchemeId));
      if (scheme) scheme.levels.set(level.name, String(level.id));
    }
  }

  // Get Cloud project-to-scheme associations
  const associations = await cloudClient.fetchProjectSchemeAssociations();
  const projectSchemeMap = new Map(); // projectId -> schemeId
  for (const a of associations) {
    projectSchemeMap.set(String(a.projectId), String(a.issueSecuritySchemeId));
  }

  log(`  ${cloudSchemes.length} scheme(s), ${associations.length} project-scheme association(s)`);

  // Process each project
  log("\nStep 3: Comparing per-project counts...\n");

  for (const [projectKey, dcTotal] of dcProjectCounts) {
    log(`── Project: ${projectKey} (${dcTotal} DC issues with security) ──`);

    // Check Cloud project exists
    const cloudProject = await cloudClient.getProjectByKey(projectKey);
    if (!cloudProject) {
      log(`  SKIP: project not found in Cloud`);
      continue;
    }

    // Check Cloud scheme
    const cloudSchemeId = projectSchemeMap.get(String(cloudProject.id));

    if (!cloudSchemeId) {
      log(`  Project has NO security scheme in Cloud`);
      if (wantedType === "set") {
        log(`  Skipping (looking for scenario 1)`);
        continue;
      }

      // Scenario 2: no scheme — get DC scheme info
      const dcScheme = await dcClient.fetchProjectSecurityScheme(projectKey);
      // Grab the first DC issue to use as our candidate
      const jql = `level is not EMPTY AND project = "${projectKey}" ORDER BY key ASC`;
      const encoded = encodeURIComponent(jql);
      const res = await dcClient.makeRequest(
        "GET",
        `/rest/api/2/search?jql=${encoded}&maxResults=1&fields=security,project`,
      );
      const issue = res.issues?.[0];
      if (!issue) continue;

      return {
        type: "no_scheme",
        issueKey: issue.key,
        projectKey,
        dcLevelName: issue.fields.security.name,
        dcLevelDescription: issue.fields.security.description || "",
        dcSchemeName: dcScheme?.name || `${projectKey} Security Scheme`,
        dcSchemeDescription: dcScheme?.description || "",
        dcSchemeId: dcScheme ? String(dcScheme.id) : null,
        cloudProjectId: cloudProject.id,
      };
    }

    const cloudScheme = cloudSchemeMap.get(cloudSchemeId);
    if (!cloudScheme) {
      log(`  SKIP: scheme ${cloudSchemeId} not found in scheme map`);
      continue;
    }

    log(`  Cloud scheme: "${cloudScheme.name}" (${cloudScheme.levels.size} levels)`);

    // Scenario 2 check: does Cloud scheme have all DC levels?
    if (wantedType === "create" || wantedType === "any") {
      const dcLevels = await dcClient.fetchProjectSecurityLevels(projectKey);
      const missingLevels = dcLevels.filter((l) => !cloudScheme.levels.has(l.name));

      if (missingLevels.length > 0) {
        log(`  MISSING ${missingLevels.length} level(s) in Cloud: ${missingLevels.map((l) => `"${l.name}"`).join(", ")}`);

        // Find an issue that uses one of the missing levels
        const missingName = missingLevels[0].name;
        const jql = `level is not EMPTY AND project = "${projectKey}" ORDER BY key ASC`;
        const encoded = encodeURIComponent(jql);
        let searchStart = 0;

        while (true) {
          const res = await dcClient.makeRequest(
            "GET",
            `/rest/api/2/search?jql=${encoded}&startAt=${searchStart}&maxResults=100&fields=security`,
          );
          const issues = res.issues || [];
          if (issues.length === 0) break;

          for (const issue of issues) {
            if (issue.fields?.security?.name === missingName) {
              return {
                type: "create",
                issueKey: issue.key,
                projectKey,
                dcLevelName: missingName,
                dcLevelDescription: missingLevels[0].description || "",
                cloudScheme: {
                  schemeId: cloudSchemeId,
                  schemeName: cloudScheme.name,
                  levels: [], // not needed for create
                  projectId: cloudProject.id,
                },
              };
            }
          }

          searchStart += issues.length;
          if (searchStart >= (res.total || 0)) break;
        }
      } else if (wantedType === "create") {
        log(`  Cloud scheme has all DC levels — skipping (looking for scenario 2)`);
        continue;
      }
    }

    // Count comparison for scenario 1
    const cloudTotal = await cloudCount(`project = "${projectKey}" AND level is not EMPTY`);
    log(`  Counts: DC=${dcTotal}, Cloud=${cloudTotal}`);

    if (cloudTotal >= dcTotal) {
      log(`  Cloud count >= DC count — likely in sync, skipping`);
      continue;
    }

    const gap = dcTotal - cloudTotal;
    log(`  GAP: ${gap} issue(s) may be missing security levels in Cloud`);

    // Fetch Cloud issues WITHOUT security level (these are our candidates)
    log(`  Fetching Cloud issues without security level...`);
    const cloudMissingJql = `project = "${projectKey}" AND level is EMPTY ORDER BY key ASC`;
    const cloudMissing = await cloudSearchIssues(cloudMissingJql, "summary", 200);
    log(`  Found ${cloudMissing.length} Cloud issues without security level`);

    if (cloudMissing.length === 0) {
      log(`  No issues without security level — gap may be due to deleted issues`);
      continue;
    }

    // Cross-check against DC: find the first one that has a security level in DC
    log(`  Cross-checking against DC...`);
    for (const cloudIssue of cloudMissing) {
      let dcIssue;
      try {
        dcIssue = await dcGetIssue(cloudIssue.key);
      } catch (err) {
        if (err.statusCode === 404) continue; // Issue doesn't exist in DC
        throw err;
      }

      const dcSecurity = dcIssue.fields?.security;
      if (!dcSecurity) continue; // No security level in DC either

      log(`  FOUND: ${cloudIssue.key} — DC has "${dcSecurity.name}", Cloud has none`);

      // Check if the level exists in Cloud scheme
      const cloudLevelId = cloudScheme.levels.get(dcSecurity.name);

      if (cloudLevelId) {
        if (wantedType === "create") {
          log(`    Level exists in Cloud scheme — skipping (looking for scenario 2)`);
          continue;
        }
        return {
          type: "set",
          issueKey: cloudIssue.key,
          projectKey,
          dcLevelName: dcSecurity.name,
          cloudLevelId,
          cloudLevelName: dcSecurity.name,
          cloudScheme: {
            schemeId: cloudSchemeId,
            schemeName: cloudScheme.name,
            levels: Array.from(cloudScheme.levels.entries()).map(([n, id]) => ({ name: n, id })),
            projectId: cloudProject.id,
          },
        };
      } else {
        if (wantedType === "set") {
          log(`    Level missing from Cloud scheme — skipping (looking for scenario 1)`);
          continue;
        }
        return {
          type: "create",
          issueKey: cloudIssue.key,
          projectKey,
          dcLevelName: dcSecurity.name,
          dcLevelDescription: dcSecurity.description || "",
          cloudScheme: {
            schemeId: cloudSchemeId,
            schemeName: cloudScheme.name,
            levels: [],
            projectId: cloudProject.id,
          },
        };
      }
    }

    log(`  No actionable issues found in this project`);
  }

  log(`\nNo candidate found for scenario "${wantedType}".`);
  return null;
}

// ─────────────────────────────────────────────────
//  EXECUTE: SET EXISTING LEVEL (scenario 1)
// ─────────────────────────────────────────────────

async function executeSet(candidate) {
  log(`\n${"─".repeat(60)}`);
  log(`SCENARIO 1: Set existing Cloud level on issue`);
  log(`${"─".repeat(60)}`);
  log(`  Issue:       ${candidate.issueKey}`);
  log(`  Project:     ${candidate.projectKey}`);
  log(`  DC level:    "${candidate.dcLevelName}"`);
  log(`  Cloud level: id ${candidate.cloudLevelId} ("${candidate.cloudLevelName}")`);
  log(`  Scheme:      "${candidate.cloudScheme.schemeName}" (id: ${candidate.cloudScheme.schemeId})`);

  if (DRY_RUN) {
    log(`\n  [DRY RUN] Would set ${candidate.issueKey} security level to "${candidate.cloudLevelName}" (id: ${candidate.cloudLevelId})`);
    return;
  }

  log(`\n  Setting security level...`);
  const result = await cloudClient.updateIssue(candidate.issueKey, {
    fields: { security: { id: candidate.cloudLevelId } },
  });

  if (result.success) {
    log(`  SUCCESS`);

    log(`  Verifying...`);
    const cloudState = await cloudClient.searchIssuesByKeys([candidate.issueKey]);
    const state = cloudState.get(candidate.issueKey);
    if (state && state.securityLevelId === candidate.cloudLevelId) {
      log(`  VERIFIED: ${candidate.issueKey} now has security level "${state.securityLevelName}" (id: ${state.securityLevelId})`);
    } else {
      log(`  WARNING: Verification returned unexpected state: ${JSON.stringify(state)}`);
    }
  } else {
    log(`  FAILED: ${result.error}`);
  }
}

// ─────────────────────────────────────────────────
//  EXECUTE: CREATE LEVEL IN EXISTING SCHEME + SET
// ─────────────────────────────────────────────────

async function executeCreateLevel(candidate) {
  log(`\n${"─".repeat(60)}`);
  log(`SCENARIO 2a: Create missing level in existing scheme, then set on issue`);
  log(`${"─".repeat(60)}`);
  log(`  Issue:       ${candidate.issueKey}`);
  log(`  Project:     ${candidate.projectKey}`);
  log(`  DC level:    "${candidate.dcLevelName}"`);
  log(`  Description: "${candidate.dcLevelDescription}"`);
  log(`  Scheme:      "${candidate.cloudScheme.schemeName}" (id: ${candidate.cloudScheme.schemeId})`);

  // Look up members from the same-named level in another Cloud scheme
  log(`\n  Looking up members for "${candidate.dcLevelName}" from existing Cloud schemes...`);
  const members = await cloudClient.findLevelMembersByName(
    candidate.dcLevelName,
    candidate.cloudScheme.schemeId,
  );
  if (members.length > 0) {
    log(`  Found ${members.length} member(s) to copy:`);
    for (const m of members) {
      log(`    - ${m.type}: ${m.parameter}`);
    }
  } else {
    log(`  WARNING: No members found for "${candidate.dcLevelName}" in any Cloud scheme`);
    log(`  The level will be created without members — issues may become invisible!`);
  }

  if (DRY_RUN) {
    log(`\n  [DRY RUN] Would create level "${candidate.dcLevelName}" in scheme ${candidate.cloudScheme.schemeId} with ${members.length} member(s)`);
    log(`  [DRY RUN] Would then set ${candidate.issueKey} security level to the new level`);
    return;
  }

  log(`\n  Creating level "${candidate.dcLevelName}" in scheme ${candidate.cloudScheme.schemeId} with ${members.length} member(s)...`);
  try {
    await cloudClient.createSecurityLevel(
      candidate.cloudScheme.schemeId,
      candidate.dcLevelName,
      candidate.dcLevelDescription,
      members,
    );
    log(`  Level creation request sent`);
  } catch (error) {
    log(`  FAILED to create level: ${error.message}`);
    return;
  }

  log(`  Re-fetching Cloud levels...`);
  const updatedLevels = await cloudClient.fetchSecurityLevels([candidate.cloudScheme.schemeId]);
  const newLevel = updatedLevels.find((l) => l.name === candidate.dcLevelName);

  if (!newLevel) {
    log(`  ERROR: Level "${candidate.dcLevelName}" not found after creation.`);
    return;
  }

  const newLevelId = String(newLevel.id);
  log(`  Created: "${newLevel.name}" (id: ${newLevelId})`);

  log(`\n  Setting ${candidate.issueKey} security level to "${candidate.dcLevelName}" (id: ${newLevelId})...`);
  const result = await cloudClient.updateIssue(candidate.issueKey, {
    fields: { security: { id: newLevelId } },
  });

  if (result.success) {
    log(`  SUCCESS`);
    log(`  Verifying...`);
    const cloudState = await cloudClient.searchIssuesByKeys([candidate.issueKey]);
    const state = cloudState.get(candidate.issueKey);
    if (state && state.securityLevelId === newLevelId) {
      log(`  VERIFIED: ${candidate.issueKey} now has security level "${state.securityLevelName}"`);
    } else {
      log(`  WARNING: Verification returned unexpected state: ${JSON.stringify(state)}`);
    }
  } else {
    log(`  FAILED: ${result.error}`);
  }
}

// ─────────────────────────────────────────────────
//  EXECUTE: CREATE SCHEME + LEVEL + ASSOCIATE + SET
// ─────────────────────────────────────────────────

async function executeCreateScheme(candidate) {
  log(`\n${"─".repeat(60)}`);
  log(`SCENARIO 2b: Create scheme + level, associate to project, then set on issue`);
  log(`${"─".repeat(60)}`);
  log(`  Issue:          ${candidate.issueKey}`);
  log(`  Project:        ${candidate.projectKey} (Cloud id: ${candidate.cloudProjectId})`);
  log(`  DC level:       "${candidate.dcLevelName}"`);
  log(`  DC scheme:      "${candidate.dcSchemeName}" (id: ${candidate.dcSchemeId})`);

  let dcLevels = [];
  if (candidate.dcSchemeId) {
    log(`\n  Fetching all levels from DC scheme "${candidate.dcSchemeName}"...`);
    try {
      const dcSchemeFull = await dcClient.fetchSecurityScheme(candidate.dcSchemeId);
      dcLevels = (dcSchemeFull.levels || []).map((l) => ({
        name: l.name,
        description: l.description || "",
      }));
      log(`  Found ${dcLevels.length} level(s):`);
      for (const l of dcLevels) log(`    - "${l.name}"`);
    } catch (error) {
      log(`  WARNING: Could not fetch DC scheme levels: ${error.message}`);
      dcLevels = [{ name: candidate.dcLevelName, description: candidate.dcLevelDescription }];
    }
  } else {
    dcLevels = [{ name: candidate.dcLevelName, description: candidate.dcLevelDescription }];
  }

  if (DRY_RUN) {
    log(`\n  [DRY RUN] Would create Cloud security scheme "${candidate.dcSchemeName}" with ${dcLevels.length} level(s)`);
    log(`  [DRY RUN] Would associate scheme with project ${candidate.projectKey}`);
    log(`  [DRY RUN] Would then set ${candidate.issueKey} security level to "${candidate.dcLevelName}"`);
    return;
  }

  // Check if scheme with same name exists
  log(`\n  Checking if scheme "${candidate.dcSchemeName}" already exists in Cloud...`);
  const existingSchemes = await cloudClient.fetchAllSecuritySchemes();
  let cloudSchemeId = null;

  const existingScheme = existingSchemes.find(
    (s) => s.name.toLowerCase() === candidate.dcSchemeName.toLowerCase(),
  );

  if (existingScheme) {
    cloudSchemeId = String(existingScheme.id);
    log(`  Reusing existing scheme (id: ${cloudSchemeId})`);

    const existingLevels = await cloudClient.fetchSecurityLevels([cloudSchemeId]);
    const existingNames = new Set(existingLevels.map((l) => l.name));
    const levelsToAdd = dcLevels.filter((l) => !existingNames.has(l.name));

    if (levelsToAdd.length > 0) {
      log(`  Adding ${levelsToAdd.length} missing level(s)...`);
      for (const level of levelsToAdd) {
        try {
          await cloudClient.createSecurityLevel(cloudSchemeId, level.name, level.description);
          log(`    Created "${level.name}"`);
        } catch (error) {
          log(`    FAILED "${level.name}": ${error.message}`);
        }
      }
    }
  } else {
    log(`  Creating scheme "${candidate.dcSchemeName}" with ${dcLevels.length} level(s)...`);
    try {
      const result = await cloudClient.createSecurityScheme(candidate.dcSchemeName, "", dcLevels);
      cloudSchemeId = String(result.id);
      log(`  Created (id: ${cloudSchemeId})`);
    } catch (error) {
      log(`  FAILED: ${error.message}`);
      return;
    }
  }

  // Associate
  log(`\n  Associating scheme with project ${candidate.projectKey}...`);
  try {
    const taskResponse = await cloudClient.associateSchemeToProject(cloudSchemeId, candidate.cloudProjectId);
    if (taskResponse && taskResponse.taskId) {
      log(`  Task ${taskResponse.taskId}, waiting...`);
      await cloudClient.waitForTask(taskResponse.taskId, 60000);
    } else {
      await new Promise((r) => setTimeout(r, 3000));
    }
    log(`  Association complete`);
  } catch (error) {
    log(`  FAILED: ${error.message}`);
    return;
  }

  // Find level ID
  log(`\n  Fetching levels from scheme ${cloudSchemeId}...`);
  const cloudLevels = await cloudClient.fetchSecurityLevels([cloudSchemeId]);
  const targetLevel = cloudLevels.find((l) => l.name === candidate.dcLevelName);

  if (!targetLevel) {
    log(`  ERROR: Level "${candidate.dcLevelName}" not found after creation`);
    return;
  }

  const targetLevelId = String(targetLevel.id);

  // Set on issue
  log(`\n  Setting ${candidate.issueKey} security level to "${candidate.dcLevelName}" (id: ${targetLevelId})...`);
  const result = await cloudClient.updateIssue(candidate.issueKey, {
    fields: { security: { id: targetLevelId } },
  });

  if (result.success) {
    log(`  SUCCESS`);
    log(`  Verifying...`);
    const cloudState = await cloudClient.searchIssuesByKeys([candidate.issueKey]);
    const state = cloudState.get(candidate.issueKey);
    if (state && state.securityLevelId === targetLevelId) {
      log(`  VERIFIED: ${candidate.issueKey} now has security level "${state.securityLevelName}"`);
    } else {
      log(`  WARNING: Verification returned unexpected state: ${JSON.stringify(state)}`);
    }
  } else {
    log(`  FAILED: ${result.error}`);
  }
}

// ─────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────

async function main() {
  log("═══════════════════════════════════════════");
  log("Test: sync_security_levels");
  log("═══════════════════════════════════════════");
  log(`  DC:       ${process.env.DC_BASE_URL}`);
  log(`  Cloud:    ${process.env.CLOUD_BASE_URL}`);
  log(`  Scenario: ${SCENARIO}`);
  if (PROJECT_FILTER) log(`  Project:  ${PROJECT_FILTER}`);
  if (DRY_RUN) log(`  Mode:     DRY RUN`);
  log("");

  const dcOk = await dcClient.testConnection();
  if (!dcOk) throw new Error("Cannot connect to DC");
  log("DC connection: OK");

  const cloudOk = await cloudClient.testConnection();
  if (!cloudOk) throw new Error("Cannot connect to Cloud");
  log("Cloud connection: OK\n");

  let wantedType;
  if (SCENARIO === "1") wantedType = "set";
  else if (SCENARIO === "2") wantedType = "create";
  else wantedType = "any";

  const candidate = await findCandidate(wantedType);

  if (!candidate) {
    log(`\nNo candidate found.`);
  } else if (candidate.type === "set") {
    await executeSet(candidate);
  } else if (candidate.type === "create") {
    await executeCreateLevel(candidate);
  } else if (candidate.type === "no_scheme") {
    await executeCreateScheme(candidate);
  }

  log(`\n═══════════════════════════════════════════`);
  log(`Test complete`);
  log(`  DC API requests:    ${dcClient.getStats().requestCount}`);
  log(`  Cloud API requests: ${cloudClient.getStats().requestCount}`);
  log(`═══════════════════════════════════════════`);
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
