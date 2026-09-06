#!/usr/bin/env node

/**
 * Tempo Move Worklog 10K
 *
 * Jira Cloud enforces a hard limit of 10,000 worklogs per issue (announced late 2024).
 * This script moves the OLDEST worklogs from issues approaching that cap to an archive
 * issue, keeping the source under threshold.
 *
 * Two-phase workflow:
 *   scan - Find all issues above a worklog-count threshold
 *   move - Move oldest worklogs from one or more issues to an archive ticket
 *
 * Usage:
 *   node src/index.js scan --jql "project = PROJ AND type = Bug" [--threshold 7000] [--out results.jsonl]
 *
 *   # Move with an existing archive issue:
 *   node src/index.js move ISSUE-123 ARCHIVE-456 [--move-count 500] [--dry-run]
 *
 *   # Move and auto-create archive in same project (if --archive not given):
 *   node src/index.js move ISSUE-123 --create-archive [--move-count 500] [--dry-run]
 *
 *   # Move from multiple issues to one archive:
 *   node src/index.js move ISSUE-123,ISSUE-456,ISSUE-789 ARCHIVE-456 [--move-count 500]
 *
 *   # Move from scan results file (one or more lines):
 *   node src/index.js move --from-scan results.jsonl ARCHIVE-456 [--move-count 500]
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

const fs = require("fs");
const JiraClient = require("./jiraClient");
const { toADF } = require("./jiraClient");
const Scanner = require("./scanner");
const Mover = require("./mover");

// ── CLI parsing ────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--jql" && ++i < args.length) opts.jql = args[i];
    else if (a === "--threshold" && ++i < args.length) opts.threshold = parseInt(args[i], 10);
    else if (a === "--out" && ++i < args.length) opts.out = args[i];
    else if (a === "--move-count" && ++i < args.length) opts.moveCount = parseInt(args[i], 10);
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--keep-source") opts.keepSource = true;
    else if (a === "--create-archive") opts.createArchive = true;
    else if (a === "--from-scan" && ++i < args.length) opts.fromScan = args[i];
    else if (a === "--archive" && ++i < args.length) opts.archive = args[i];
    else if (a === "--bulk-move") opts.bulkMove = true;
    else if (a === "--help") opts.help = true;
    else positional.push(a);
  }

  return { ...opts, _positional: positional };
}

function usage() {
  console.log(`
Tempo Move Worklog 10K — move worklogs off Jira issues approaching the 10k cap

Commands:
  scan   Find issues with too many worklogs
  move   Move oldest worklogs to an archive issue

Scan options:
  --jql <query>       JQL for which issues to check (required)
  --threshold <n>     Flag issues at or above this count (default: 7000)
  --out <file>        Write results to file (JSONL, default: stdout)

Move options:
  Sources (pick one):
    positional args   ISSUE-123 [ISSUE-456 ...]  — issue keys to move from
    --from-scan <f>   Use scan output file as source list
  Destination (pick one):
    ARCHIVE key       Existing archive issue (positional, after sources)
    --archive <key>   Same as above (named flag)
    --create-archive  Auto-create an archive issue in the same project

  --move-count <n>    Number of oldest worklogs to move per issue (default: all)
  --dry-run           Show what would happen without making changes
  --keep-source       Copy to archive but don't delete from source

Examples:
  node src/index.js scan --jql "project = DC AND status != Done" --threshold 8000

  # Move 500 oldest worklogs, create archive automatically:
  node src/index.js move DC-1234 --create-archive --move-count 500

  # Dry-run: see what would happen for multiple issues → one archive:
  node src/index.js move DC-1234,DC-5678 DC-9999 --move-count 300 --dry-run

  # Move from scan results (all issues in file → single archive):
  node src/index.js move --from-scan logs/scan.jsonl DC-9999 --move-count 1000

NOTE: Moved worklogs are re-attributed to the API caller. Original author and date
      are preserved in the comment field as [migrated from KEY, orig: Name].
`);
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Create an archive issue in the given project. Tries "Task" first; on issuetype error,
 * falls back to the first available issue type per v3 createmeta.
 * Description is ADF-wrapped (v3 requires it).
 *
 * NOTE: Jira does NOT support `notifyUsers=false` on issue creation. The "Issue Created"
 * event will fire per the project's notification scheme (typically goes to project-role
 * admins; new issues have no watchers/assignee yet). This is one notification per
 * archive issue created — unavoidable on Cloud v3.
 */
async function createArchiveIssue(client, projectKey, summary) {
  const description = toADF(
    "This issue holds migrated worklogs from issues that approached Jira's 10,000 worklog limit. Each worklog comment preserves the original author and date."
  );

  const tryCreate = async (issueTypeName) => {
    const fields = {
      project: { key: projectKey },
      summary,
      description,
      issuetype: { name: issueTypeName },
    };
    const created = await client.request("POST", "/rest/api/3/issue", { fields });
    return created.key || created.id;
  };

  try {
    return await tryCreate("Task");
  } catch (err) {
    // Issue-type not available → look up valid ones via createmeta and use the first
    const looksLikeIssueTypeErr =
      err.statusCode === 400 && /issuetype|issue type/i.test(String(err.message));
    if (!looksLikeIssueTypeErr) throw err;

    const types = await client.getProjectIssueTypes(projectKey);
    if (types.length === 0) throw new Error(`No issue types available in project ${projectKey}`);
    console.log(`  "Task" not available, using "${types[0].name}"`);
    return await tryCreate(types[0].name);
  }
}

// ── Main commands ──────────────────────────────────────────────

async function cmdScan(opts) {
  if (!opts.jql) { console.error("Error: --jql is required for scan"); process.exit(1); }

  const client = new JiraClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN);
  const me = await client.testConnection();
  console.log(`Connected to ${process.env.CLOUD_BASE_URL} as ${me.displayName} <${me.emailAddress || me.accountId}>`);

  const scanner = new Scanner(client);
  const results = await scanner.scan(opts.jql, opts.threshold || 7000);

  if (results.length === 0) {
    console.log("\nNo issues found at or above threshold.");
  } else {
    console.log(`\n${results.length} issue(s) at or above ${opts.threshold || 7000} worklogs:\n`);
    for (const r of results) {
      const bar = "█".repeat(Math.min(20, Math.floor(r.worklogCount / 500)));
      console.log(`  ${r.key.padEnd(14)} ${r.worklogCount.toString().padStart(6)} worklogs  ${bar}  ${r.summary.slice(0, 60)}`);
    }
  }

  // Write JSONL only when --out is given so stdout stays human-readable
  if (opts.out && results.length > 0) {
    const lines = results.map((r) => JSON.stringify(r));
    fs.writeFileSync(opts.out, lines.join("\n") + "\n", "utf8");
    console.log(`\nResults written to ${opts.out}`);
  } else if (opts.out) {
    fs.writeFileSync(opts.out, "", "utf8");
    console.log(`\nNo results — wrote empty file ${opts.out}`);
  }

  const stats = client.getStats();
  console.log(`\nAPI: ${stats.requests} requests, ${stats.errors} errors`);
}

async function cmdMove(opts) {
  if (opts.help || (opts._positional.length < 1 && !opts.fromScan)) {
    usage();
    return;
  }

  const client = new JiraClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN);
  const me = await client.testConnection();
  console.log(`Connected to ${process.env.CLOUD_BASE_URL} as ${me.displayName} <${me.emailAddress || me.accountId}>`);

  // Resolve source issues
  let sources = [];

  if (opts.fromScan) {
    // Read JSONL scan results; each line is {key, summary, worklogCount}
    const raw = fs.readFileSync(opts.fromScan, "utf8").trim();
    if (!raw) { console.error("Scan file is empty"); process.exit(1); }
    sources = raw.split("\n").map((l) => JSON.parse(l));
    // Allow ARCHIVE-KEY as a trailing positional after --from-scan
    if (!opts.archive && !opts.createArchive && opts._positional.length > 0) {
      opts.archive = opts._positional[0];
    }
  } else {
    // Parse positional args: comma-separated issue keys or individual keys
    const keys = opts._positional.flatMap((p) => p.split(",")).filter(Boolean);

    if (keys.length < 1) { console.error("No source issues specified"); process.exit(1); }

    // Last key might be the archive — figure out which
    let srcKeys;
    if (opts.archive || opts.createArchive) {
      // All positional keys are sources
      srcKeys = keys;
    } else if (keys.length >= 2) {
      // Last key is the destination, rest are sources
      srcKeys = keys.slice(0, -1);
      opts.archive = keys[keys.length - 1];
    } else {
      // Single key provided without archive → must use --create-archive or --archive
      if (!opts.createArchive) {
        console.error("Single issue provided. Use --archive KEY or --create-archive to specify destination.");
        process.exit(1);
      }
      srcKeys = keys;
    }

    sources = srcKeys.map((k) => ({ key: k.trim() }));
  }

  if (sources.length === 0) { console.error("No source issues"); process.exit(1); }

  // Resolve destination
  let dstKey = opts.archive || null;

  if (!dstKey && !opts.createArchive) {
    console.error("No archive issue specified. Use --archive KEY or --create-archive.");
    process.exit(1);
  }

  if (opts.createArchive) {
    // Create one archive per unique project
    const projects = [...new Set(sources.map((s) => s.key.split("-")[0]))];

    if (projects.length > 1) {
      console.log(`\nMultiple projects detected: ${projects.join(", ")}`);
      console.log("Creating one archive issue per project...\n");

      // We'll create archives on-the-fly; for now set a placeholder and handle per-project
      dstKey = null; // signals "create per project" below
    } else {
      const project = projects[0];
      const summary = `Worklog archive (10k cap migration)`;

      if (opts.dryRun) {
        dstKey = `${project}-NEW-ARCHIVE`;
        console.log(`\n[DRY] Would create archive issue in project ${project} (placeholder key: ${dstKey})`);
      } else {
        console.log(`\nCreating archive issue in project ${project}...`);
        try {
          dstKey = await createArchiveIssue(client, project, summary);
          console.log(`  Created ${dstKey}`);
        } catch (err) {
          console.error(`Failed to create archive: ${err.message}`);
          process.exit(1);
        }
      }
    }
  }

  // Group sources by project if we need per-project archives
  let workItems = [];
  if (!dstKey && opts.createArchive) {
    // Per-project archives
    const byProject = {};
    for (const s of sources) {
      const proj = s.key.split("-")[0];
      if (!byProject[proj]) {
        if (opts.dryRun) {
          byProject[proj] = `${proj}-NEW-ARCHIVE`;
          console.log(`  [DRY] Would create archive for project ${proj} (placeholder key: ${byProject[proj]})`);
        } else {
          try {
            byProject[proj] = await createArchiveIssue(client, proj, `Worklog archive (10k cap migration)`);
            console.log(`  Created archive ${byProject[proj]} for project ${proj}`);
          } catch (err) {
            console.error(`  Failed to create archive for ${proj}: ${err.message}`);
            process.exit(1);
          }
        }
      }
      workItems.push({ source: s, dstKey: byProject[proj] });
    }
  } else {
    for (const s of sources) {
      workItems.push({ source: s, dstKey });
    }
  }

  // Execute moves
  const mover = new Mover(client, {
    dryRun: opts.dryRun || false,
    keepSource: opts.keepSource || false,
    moveCount: opts.moveCount || 0,
  });

  let totalCreated = 0;
  let totalDeleted = 0;
  let totalFailed = 0;

  for (const item of workItems) {
    const srcKey = item.source.key;
    const dst = item.dstKey;

    console.log(`\n${"═".repeat(60)}`);
    console.log(`${srcKey} → ${dst}${opts.moveCount > 0 ? ` (oldest ${opts.moveCount})` : " (all)"}`);
    console.log("═".repeat(60));

    try {
      const result = opts.bulkMove
        ? await mover.bulkMove(srcKey, dst)
        : await mover.move(srcKey, dst);
      totalCreated += result.created;
      totalDeleted += result.deleted;
      totalFailed += result.failed;

      if (result.failures && result.failures.length > 0) {
        console.log(`\n  ⚠ ${result.failures.length} failure(s):`);
        for (const f of result.failures.slice(0, 5)) {
          console.log(`    - worklog ${f.worklogId}: ${f.error.slice(0, 120)}`);
        }
      }

      // Check remaining count
      if (!opts.dryRun) {
        const remaining = await client.getWorklogCount(srcKey);
        console.log(`\n  ${srcKey} now has ${remaining} worklog(s)`);
      }
    } catch (err) {
      console.error(`Error moving from ${srcKey}: ${err.message}`);
      totalFailed++;
    }
  }

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log("SUMMARY");
  console.log("═".repeat(60));
  console.log(`  Created on archive: ${totalCreated}${opts.dryRun ? " (dry-run, not actually created)" : ""}`);
  console.log(`  Deleted from source: ${totalDeleted}${opts.dryRun ? " (dry-run, not actually deleted)" : ""}`);
  console.log(`  Failed: ${totalFailed}`);
  console.log(`  Plan log: ${mover.planFile}`);

  const stats = client.getStats();
  console.log(`\nAPI: ${stats.requests} requests, ${stats.errors} errors`);
}

// ── Entry point ────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.help && !opts._positional.length) {
    usage();
    return;
  }

  const cmd = opts._positional[0] || "scan";

  // Remove the command from positional args for sub-handlers
  const posWithoutCmd = opts._positional.slice(1);
  Object.assign(opts, { _positional: posWithoutCmd });

  if (cmd === "scan") {
    await cmdScan(opts);
  } else if (cmd === "move") {
    await cmdMove(opts);
  } else {
    console.error(`Unknown command: ${cmd}`);
    usage();
    process.exit(1);
  }
}

main().catch((err) => { console.error("\nFatal:", err.message); process.exit(1); });
