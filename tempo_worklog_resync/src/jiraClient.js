const https = require("https");
const { URL } = require("url");

class JiraClient {
  constructor(baseUrl, apiToken) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const parsed = new URL(this.baseUrl);
    this.hostname = parsed.hostname;
    this.apiToken = apiToken;
    this.requestCount = 0;
    this.errorCount = 0;
  }

  async request(method, path, body = null, retryState = { rl: 0, srv: 0 }) {
    const MAX_RL = 3;
    const MAX_SRV = 3;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.hostname,
        port: 443,
        path,
        method,
        headers: {
          Authorization: `Basic ${this.apiToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        timeout: 60000,
      };

      if (body) {
        const raw = JSON.stringify(body);
        options.headers["Content-Length"] = Buffer.byteLength(raw);
      }

      const retry = () => this.request(method, path, body, retryState).then(resolve).catch(reject);

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          this.requestCount++;

          if (res.statusCode === 429) {
            if (retryState.rl >= MAX_RL) return reject(new Error(`Rate limited ${method} ${path}`));
            const after = res.headers["retry-after"] ? parseInt(res.headers["retry-after"], 10) * 1000 : Math.min(5000 * 2 ** retryState.rl, 60000);
            console.log(`    Rate limited, waiting ${Math.round(after / 1000)}s`);
            setTimeout(() => { retryState.rl++; retry(); }, after);
            return;
          }

          if (res.statusCode >= 500 && retryState.srv < MAX_SRV) {
            const delay = Math.min(2000 * 2 ** retryState.srv, 10000);
            console.log(`    Server ${res.statusCode}, retry in ${delay / 1000}s`);
            setTimeout(() => { retryState.srv++; retry(); }, delay);
            return;
          }

          if (res.statusCode === 204) return resolve(null);
          if (res.statusCode >= 400) { this.errorCount++; const e = new Error(`${method} ${path} -> ${res.statusCode}: ${data.slice(0, 400)}`); e.statusCode = res.statusCode; return reject(e); }

          try { resolve(data ? JSON.parse(data) : null); }
          catch { resolve(data); }
        });
      });

      req.on("error", (err) => { if (retryState.srv < MAX_SRV) setTimeout(() => { retryState.srv++; retry(); }, 2000 * (retryState.srv + 1)); else reject(err); });
      req.on("timeout", () => { req.destroy(); if (retryState.srv < MAX_SRV) setTimeout(() => { retryState.srv++; retry(); }, 3000); else reject(new Error(`Timeout ${method} ${path}`)); });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async testConnection() {
    // Hit /myself (not /serverInfo) so a bad/empty token surfaces as 401 immediately
    // instead of silently running as the anonymous user.
    const me = await this.request("GET", "/rest/api/3/myself");
    return me;
  }

  /** Paginated GET /rest/api/3/search/jql */
  async search(jql, fields = "", maxResults = 50) {
    const issues = [];
    let token = null;
    while (true) {
      let url = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=${encodeURIComponent(fields)}`;
      if (token) url += `&nextPageToken=${encodeURIComponent(token)}`;
      const res = await this.request("GET", url);
      issues.push(...(res.issues || []));
      if (!res.nextPageToken || res.isLast) break;
      token = res.nextPageToken;
    }
    return issues;
  }

  /** GET /rest/api/3/issue/{key}/worklog -- paginated, returns all */
  async getWorklogs(issueKey, maxResults = 100) {
    const all = [];
    let startAt = 0;
    while (true) {
      const res = await this.request("GET", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog?startAt=${startAt}&maxResults=${maxResults}&expand=properties`);
      const items = res.worklogs || [];
      all.push(...items);
      if (items.length === 0) break;
      if (typeof res.total === "number" && all.length >= res.total) break;
      startAt += items.length;
    }
    return all;
  }

  /** POST /rest/api/3/issue/{key}/worklog -- create one worklog (silent: no notifications, no estimate change) */
  async createWorklog(issueKey, body) {
    const res = await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog?notifyUsers=false&adjustEstimate=leave&overrideEditableFlag=true`, body);
    return res;
  }

  /** DELETE /rest/api/3/issue/{key}/worklog/{id} (silent: no notifications, no estimate change) */
  async deleteWorklog(issueKey, worklogId) {
    await this.request("DELETE", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog/${worklogId}?notifyUsers=false&adjustEstimate=leave&overrideEditableFlag=true`);
  }

  /**
   * Atlassian Bulk Move Worklog API (announced Aug 2024 for the 10k cap).
   * POST /rest/api/3/issue/{srcKey}/worklog/move
   * Body: { issueIdOrKey: <dstKey>, ids: [worklogId, ...] }   // max 5000 IDs per call
   * Server-side move: worklog IDs and all fields (author, started, comment, properties) are preserved.
   * Caveats from the Atlassian runbook: does NOT update the time-tracking field, does NOT update change history.
   */
  async bulkMoveWorklogs(srcKey, dstKey, worklogIds) {
    if (worklogIds.length === 0) return { moved: 0 };
    if (worklogIds.length > 5000) throw new Error(`bulkMoveWorklogs: ${worklogIds.length} > 5000 max per call`);
    const body = { issueIdOrKey: dstKey, ids: worklogIds.map(String) };
    return await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(srcKey)}/worklog/move`, body);
  }

  /** Get issue key from numeric ID -- GET /rest/api/3/issue/{id} */
  async getIssue(idOrKey) {
    const res = await this.request("GET", `/rest/api/3/issue/${encodeURIComponent(String(idOrKey))}?fields=summary`);
    return res;
  }

  /** Get total worklog count via the `total` field on a 1-item page */
  async getWorklogCount(issueKey) {
    const res = await this.request("GET", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog?maxResults=1&expand=`);
    return res.total || 0;
  }

  /** List issue types for a project (v3 createmeta). Excludes subtasks since they require a parent. */
  async getProjectIssueTypes(projectKey) {
    const res = await this.request("GET", `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`);
    return (res.issueTypes || res.values || [])
      .filter((t) => t.name && !t.subtask)
      .map((t) => ({ id: t.id, name: t.name }));
  }

  getStats() {
    return { requests: this.requestCount, errors: this.errorCount };
  }
}

/** Wrap a plain string as a minimal ADF document. Required by v3 for comment/description. */
function toADF(text) {
  const s = text == null ? "" : String(text);
  return {
    type: "doc",
    version: 1,
    content: [
      s ? { type: "paragraph", content: [{ type: "text", text: s }] } : { type: "paragraph" },
    ],
  };
}

/** Extract plain text from an ADF document (or pass through if already string). */
function adfToPlainText(adf) {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  if (typeof adf !== "object") return "";
  const parts = [];
  (function walk(node) {
    if (!node) return;
    if (typeof node.text === "string") parts.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(walk);
  })(adf);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

module.exports = JiraClient;
module.exports.toADF = toADF;
module.exports.adfToPlainText = adfToPlainText;
