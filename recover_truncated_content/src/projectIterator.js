const fs = require("fs");
const path = require("path");

const CHECKPOINT_FILE = "checkpoint.jsonl";

function checkpointPath(logsDir) {
  return path.join(logsDir, CHECKPOINT_FILE);
}

/**
 * JSONL checkpoint compatible in spirit with find_missing_issues — one JSON
 * object per line, append-only. Used so re-runs with the same logs dir skip
 * already-processed Cloud projects.
 */
function loadCheckpoint(logsDir) {
  const file = checkpointPath(logsDir);
  if (!fs.existsSync(file)) return { entries: [], doneKeys: new Set() };
  const entries = [];
  const doneKeys = new Set();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.projectKey && !doneKeys.has(entry.projectKey)) {
        entries.push(entry);
        doneKeys.add(entry.projectKey);
      }
    } catch (e) {
      console.warn(`  checkpoint: skip malformed line: ${e.message}`);
    }
  }
  return { entries, doneKeys };
}

function appendCheckpoint(logsDir, entry) {
  fs.mkdirSync(logsDir, { recursive: true });
  fs.appendFileSync(checkpointPath(logsDir), JSON.stringify(entry) + "\n");
}

/**
 * Async generator yielding one Cloud issue at a time for a project, using the
 * token-paginated /rest/api/3/search/jql endpoint. Calls cloudClient.makeRequest
 * directly so we can yield issues page-by-page without holding the full
 * project in memory.
 *
 * `fields` is the comma-separated string passed verbatim to the Cloud API.
 * `limit` (0 = unlimited) caps total issues yielded.
 */
async function* iterateProjectIssues(
  cloudClient,
  projectKey,
  { fields = "description", limit = 0 } = {},
) {
  const jql = `project = "${projectKey}" ORDER BY created ASC`;
  const encoded = encodeURIComponent(jql);
  let nextPageToken = null;
  let yielded = 0;

  while (true) {
    let url = `/rest/api/3/search/jql?jql=${encoded}&maxResults=100&fields=${fields}`;
    if (nextPageToken) url += `&nextPageToken=${encodeURIComponent(nextPageToken)}`;
    const res = await cloudClient.makeRequest("GET", url);
    const batch = res?.issues || [];
    if (batch.length === 0) break;
    for (const issue of batch) {
      yield issue;
      yielded++;
      if (limit > 0 && yielded >= limit) return;
    }
    if (res.isLast === true || !res.nextPageToken) break;
    nextPageToken = res.nextPageToken;
  }
}

module.exports = {
  loadCheckpoint,
  appendCheckpoint,
  iterateProjectIssues,
  CHECKPOINT_FILE,
};
