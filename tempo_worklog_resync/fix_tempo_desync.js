#!/usr/bin/env node
/**
 * Fix the Tempo desync left by the Jira-REST worklog move.
 *
 * The old tool moved worklogs via Jira's /worklog/move (Jira-core only), so Tempo never
 * saw it: the ARCHIVE issue holds Jira-only copies authored by the Tempo app account
 * (wrong author, no Tempo record), while the SOURCE still holds the originals as Tempo
 * orphans (real author, no Jira backing).
 *
 * This re-does the move THROUGH Tempo so both stores stay in sync and the real author is
 * preserved. Per worklog (oldest set only — exactly what the prior move took, identified
 * via the archive copy's {tempo:{tempo_id}} property):
 *
 *   1. delete the Tempo orphan on SOURCE        (bypass closed period; frees the 8h/day)
 *   2. create it on ARCHIVE via Tempo           (bypass; real author + exact data)
 *      - if create fails -> recreate orphan on SOURCE (self-heal) and skip
 *   3. delete the wrong-author Jira copy on ARCHIVE (Jira REST)
 *
 * Usage:
 *   node fix_tempo_desync.js OPS-3300 OPS-5973 --dry-run        # plan only, no writes
 *   node fix_tempo_desync.js OPS-3300 OPS-5973 --limit 1        # canary: oldest 1
 *   node fix_tempo_desync.js OPS-3300 OPS-5973                  # full
 *
 * Resumable: the worklist is rebuilt from current state each run, so already-migrated
 * worklogs (archive copy gone) are naturally excluded. Failures are logged for manual review.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });
const fs = require("fs");
const path = require("path");
const JiraClient = require("./src/jiraClient");
const TempoClient = require("./src/tempoClient");

function parseArgs(argv) {
  const a = argv.slice(2);
  const pos = [];
  const opts = { dryRun: false, limit: 0, delayMs: 250 };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--dry-run") opts.dryRun = true;
    else if (a[i] === "--limit") opts.limit = parseInt(a[++i], 10);
    else if (a[i] === "--delay") opts.delayMs = parseInt(a[++i], 10);
    else pos.push(a[i]);
  }
  opts.src = pos[0]; opts.archive = pos[1];
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jiraWorklogs(jira, key) {
  const out = []; let startAt = 0;
  while (true) {
    const res = await jira.request("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/worklog?startAt=${startAt}&maxResults=5000&expand=properties`);
    const items = res.worklogs || []; out.push(...items);
    if (items.length === 0) break; startAt += items.length; if (startAt > 80000) break;
  }
  return out;
}

(async () => {
  const opts = parseArgs(process.argv);
  if (!opts.src || !opts.archive) { console.error("Usage: node fix_tempo_desync.js <SRC> <ARCHIVE> [--dry-run] [--limit N]"); process.exit(1); }

  const jira = new JiraClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN);
  const tempo = new TempoClient(process.env.TEMPO_API_TOKEN);
  const me = await jira.testConnection();
  console.log(`Jira as ${me.displayName}.  Tempo via ${process.env.TEMPO_API_TOKEN ? "token" : "(NO TOKEN)"}`);

  const srcIssue = await jira.getIssue(opts.src);
  const archIssue = await jira.getIssue(opts.archive);
  const srcId = Number(srcIssue.id), archId = Number(archIssue.id);
  console.log(`SOURCE ${opts.src} (id ${srcId})  ->  ARCHIVE ${opts.archive} (id ${archId})  "${archIssue.fields?.summary || ""}"`);

  // ---- Build worklist from the exact cross-walk ----
  console.log(`\nReading archive Jira copies + source Tempo orphans ...`);
  const archCopies = await jiraWorklogs(jira, opts.archive);
  const srcTempo = await tempo.worklogsForIssue(srcId);
  const srcById = new Map(srcTempo.map((w) => [String(w.tempoWorklogId), w]));

  const worklist = []; const unmatched = [];
  for (const c of archCopies) {
    const prop = (c.properties || []).find((p) => p.key === "tempo");
    const tid = prop && prop.value && prop.value.tempo_id != null ? String(prop.value.tempo_id) : null;
    if (!tid) { unmatched.push({ jiraCopyId: c.id, reason: "no tempo_id property" }); continue; }
    const orphan = srcById.get(tid);
    if (!orphan) { unmatched.push({ jiraCopyId: c.id, tempo_id: tid, reason: "orphan not on source (already migrated?)" }); continue; }
    worklist.push({
      tempoOrphanId: orphan.tempoWorklogId,
      jiraCopyId: c.id,
      authorAccountId: orphan.author && orphan.author.accountId,
      startDate: orphan.startDate,
      startTime: orphan.startTime || "08:00:00",
      timeSpentSeconds: orphan.timeSpentSeconds,
      billableSeconds: orphan.billableSeconds != null ? orphan.billableSeconds : orphan.timeSpentSeconds,
      description: orphan.description || "",
      attributes: (orphan.attributes && orphan.attributes.values || []).map((v) => ({ key: v.key, value: v.value })),
    });
  }
  // Oldest first — invariant: we only ever touch the oldest (already true; sort to be deterministic)
  worklist.sort((a, b) => (a.startDate + a.startTime + a.tempoOrphanId).localeCompare(b.startDate + b.startTime + b.tempoOrphanId));

  const dates = worklist.map((w) => w.startDate).sort();
  const authors = new Set(worklist.map((w) => w.authorAccountId));
  const withAttrs = worklist.filter((w) => w.attributes.length > 0).length;
  const srcRemainingMin = srcTempo.map((w) => w.startDate).filter((d) => !worklist.find((x) => x.startDate === d) || true).sort()[0];
  console.log(`\nWorklist: ${worklist.length} worklogs to migrate.  unmatched/skipped: ${unmatched.length}`);
  console.log(`  date span (OLDEST set): ${dates[0]} .. ${dates[dates.length - 1]}`);
  console.log(`  distinct real authors: ${authors.size}   worklogs carrying Tempo attributes: ${withAttrs}`);
  if (worklist[0]) console.log(`  oldest entry: orphan ${worklist[0].tempoOrphanId}, ${worklist[0].startDate} ${worklist[0].startTime}, ${worklist[0].timeSpentSeconds}s, author ${worklist[0].authorAccountId}, "${worklist[0].description}"`);

  const logDir = path.join(__dirname, "logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  if (opts.dryRun) {
    const planFile = path.join(logDir, `tempo_fix_plan_${opts.src}_${ts}.jsonl`);
    fs.writeFileSync(planFile, worklist.map((w) => JSON.stringify(w)).join("\n") + "\n");
    if (unmatched.length) fs.appendFileSync(planFile, unmatched.map((u) => JSON.stringify({ unmatched: u })).join("\n") + "\n");
    console.log(`\n[DRY RUN] No changes made. Full plan written to ${planFile}`);
    return;
  }

  const batch = opts.limit > 0 ? worklist.slice(0, opts.limit) : worklist;
  const auditFile = path.join(logDir, `tempo_fix_${opts.src}_${ts}.jsonl`);
  const log = (o) => fs.appendFileSync(auditFile, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");
  console.log(`\nEXECUTING on ${batch.length} worklog(s)${opts.limit ? ` (--limit ${opts.limit})` : ""}. Audit -> ${auditFile}\n`);

  let migrated = 0, failed = 0, healed = 0, copyLeft = 0;
  for (let i = 0; i < batch.length; i++) {
    const e = batch[i]; const tag = `${i + 1}/${batch.length}`;
    log({ action: "begin", ...e });
    // 1) delete orphan on source (frees the day)
    try {
      await tempo.deleteWorklog(e.tempoOrphanId);
      log({ action: "orphan_deleted", tempoOrphanId: e.tempoOrphanId });
    } catch (err) {
      console.log(`  ${tag} orphan delete FAILED (${e.tempoOrphanId}): ${String(err.message).slice(0, 140)}`);
      log({ action: "orphan_delete_failed", tempoOrphanId: e.tempoOrphanId, error: err.message });
      failed++; continue;
    }
    // 2) create on archive via Tempo (real author, exact data)
    const body = { issueId: archId, authorAccountId: e.authorAccountId, startDate: e.startDate, startTime: e.startTime, timeSpentSeconds: e.timeSpentSeconds, billableSeconds: e.billableSeconds, description: e.description };
    if (e.attributes.length) body.attributes = e.attributes;
    let newId = null;
    try {
      const res = await tempo.createWorklog(body);
      newId = res.tempoWorklogId;
      log({ action: "archive_created", newId, author: res.author && res.author.accountId });
    } catch (err) {
      console.log(`  ${tag} archive create FAILED: ${String(err.message).slice(0, 140)} — self-healing orphan back on source`);
      log({ action: "archive_create_failed", error: err.message });
      try {
        const restored = await tempo.createWorklog({ issueId: srcId, authorAccountId: e.authorAccountId, startDate: e.startDate, startTime: e.startTime, timeSpentSeconds: e.timeSpentSeconds, billableSeconds: e.billableSeconds, description: e.description, ...(e.attributes.length ? { attributes: e.attributes } : {}) });
        log({ action: "orphan_restored_on_source", restoredId: restored.tempoWorklogId });
        healed++;
      } catch (err2) {
        console.log(`  ${tag} !! SELF-HEAL FAILED — data lives only in archive Jira copy ${e.jiraCopyId}: ${String(err2.message).slice(0, 140)}`);
        log({ action: "self_heal_failed", jiraCopyId: e.jiraCopyId, error: err2.message });
      }
      failed++; continue;
    }
    // 3) delete the wrong-author Jira copy on archive.
    // Use a PLAIN delete (no overrideEditableFlag) — the override flag requires Connect/Forge
    // app perms (403 for a basic-auth token); plain delete of these app-authored copies works.
    try {
      await jira.request("DELETE", `/rest/api/3/issue/${encodeURIComponent(opts.archive)}/worklog/${e.jiraCopyId}?notifyUsers=false&adjustEstimate=leave`);
      log({ action: "jira_copy_deleted", jiraCopyId: e.jiraCopyId });
    } catch (err) {
      console.log(`  ${tag} jira-copy delete FAILED (${e.jiraCopyId}): ${String(err.message).slice(0, 140)} — leftover wrong-author copy remains`);
      log({ action: "jira_copy_delete_failed", jiraCopyId: e.jiraCopyId, newId, error: err.message });
      copyLeft++;
    }
    log({ action: "done", tempoOrphanId: e.tempoOrphanId, newId, jiraCopyId: e.jiraCopyId });
    migrated++;
    if ((i + 1) % 50 === 0) console.log(`  ${tag} ... migrated=${migrated} failed=${failed} healed=${healed}`);
    if (i + 1 < batch.length) await sleep(opts.delayMs);
  }

  console.log(`\nDone. migrated=${migrated}  failed=${failed}  self-healed=${healed}  leftover-jira-copies=${copyLeft}`);
  // Verify
  const [srcT, archT] = await Promise.all([tempo.worklogsForIssue(srcId), tempo.worklogsForIssue(archId)]);
  const archJ = await jira.getWorklogCount(opts.archive);
  const srcJ = await jira.getWorklogCount(opts.src);
  console.log(`\nPost-state:`);
  console.log(`  ${opts.src}:  jira-core=${srcJ}  tempo=${srcT.length}`);
  console.log(`  ${opts.archive}:  jira-core=${archJ}  tempo=${archT.length}`);
  console.log(`Audit log: ${auditFile}`);
})().catch((e) => { console.error("\nFatal:", e.message); process.exit(1); });
