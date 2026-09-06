const https = require("https");

/**
 * Minimal Tempo Cloud REST API v4 client.
 *   Base: https://api.tempo.io/4
 *   Auth: Authorization: Bearer <TEMPO_API_TOKEN>
 *
 * Tempo keeps its OWN worklog store that shadows Jira worklogs. Each Tempo worklog
 * carries `tempoWorklogId` (Tempo's own id) and `jiraWorklogId` (the Jira worklog it
 * mirrors) plus `issue.id` (numeric Jira issue id). Moving a Jira worklog via the Jira
 * REST API does NOT update Tempo — hence the desync we are investigating.
 */
class TempoClient {
  constructor(token, base = "https://api.tempo.io/4") {
    this.token = token;
    this.base = base.replace(/\/$/, "");
    this.requestCount = 0;
  }

  request(method, pathOrUrl, body = null, retry = 0) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.base}${pathOrUrl}`;
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const headers = {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      };
      // Set Content-Length explicitly — required so DELETE-with-body (the bypass flag)
      // is sent reliably instead of as a chunked body some gateways drop.
      if (payload) headers["Content-Length"] = Buffer.byteLength(payload);
      const options = {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method,
        headers,
        timeout: 60000,
      };
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          this.requestCount++;
          if (res.statusCode === 429 && retry < 4) {
            const after = (parseInt(res.headers["retry-after"], 10) || 5) * 1000;
            return setTimeout(() => this.request(method, pathOrUrl, body, retry + 1).then(resolve, reject), after);
          }
          if (res.statusCode >= 500 && retry < 3) {
            return setTimeout(() => this.request(method, pathOrUrl, body, retry + 1).then(resolve, reject), 2000 * (retry + 1));
          }
          if (res.statusCode >= 400) {
            const e = new Error(`${method} ${u.pathname} -> ${res.statusCode}: ${data.slice(0, 500)}`);
            e.statusCode = res.statusCode;
            return reject(e);
          }
          try { resolve(data ? JSON.parse(data) : null); } catch { resolve(data); }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout ${method} ${u.pathname}`)); });
      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * Create a Tempo worklog. With bypass=true, passes bypassPeriodClosuresAndApprovals
   * (requires Tempo "Override Mode" enabled) so worklogs land in CLOSED periods and on
   * APPROVED timesheets. Author is set via body.authorAccountId (on-behalf logging).
   * NOTE: bypass does NOT skip the per-user 8h/day limit — free the day first.
   */
  createWorklog(body, bypass = true) {
    return this.request("POST", "/worklogs", bypass ? { ...body, bypassPeriodClosuresAndApprovals: true } : body);
  }

  /**
   * Delete a Tempo worklog by tempoWorklogId. The bypass MUST be a QUERY param on DELETE
   * (a body is ignored -> "Period is closed"); on Create it goes in the body.
   */
  deleteWorklog(tempoWorklogId, bypass = true) {
    const q = bypass ? "?bypassPeriodClosuresAndApprovals=true" : "";
    return this.request("DELETE", `/worklogs/${tempoWorklogId}${q}`);
  }

  /** Paginate any Tempo collection endpoint via metadata.next */
  async getAll(path) {
    const all = [];
    let next = path;
    while (next) {
      const res = await this.request("GET", next);
      const results = (res && res.results) || [];
      all.push(...results);
      next = res && res.metadata && res.metadata.next ? res.metadata.next : null;
    }
    return all;
  }

  /** All Tempo worklogs for a numeric Jira issue id */
  async worklogsForIssue(issueId) {
    return this.getAll(`/worklogs/issue/${issueId}?limit=1000`);
  }
}

module.exports = TempoClient;
