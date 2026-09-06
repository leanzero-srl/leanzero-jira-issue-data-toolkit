// FORKED FROM jira/jira-data/recover_truncated_content/src/datacenterClient.js @ 003579d
// Changes:
//   - added getUser(username) — resolves DC username → {emailAddress, displayName, ...}.
//     Required for the Cloud accountId lookup path (DC username → email → Cloud user).
//     Results cached in-memory per client instance.

const https = require("https");
const http = require("http");
const { URL } = require("url");

/**
 * DC client — supports either:
 *   new DatacenterClient(baseUrl, { token: "..." })           // PAT bearer
 *   new DatacenterClient(baseUrl, { username, password })     // Basic
 *
 * Same retry/backoff shape as sync_issue_attachments' DC client
 * (5x for 429 with 120s cap, 5x for 5xx with 30s cap), plus methods to
 * fetch issue+rendered HTML and paginated comments with rendered bodies.
 */
class DatacenterClient {
  constructor(baseUrl, auth) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const parsed = new URL(this.baseUrl);
    this.protocol = parsed.protocol === "https:" ? https : http;
    this.hostname = parsed.hostname;
    this.port = parsed.port || (parsed.protocol === "https:" ? 443 : 80);
    this.basePath = parsed.pathname.replace(/\/$/, "");

    if (auth && auth.token) {
      this.authHeader = `Bearer ${auth.token}`;
    } else if (auth && auth.username && auth.password) {
      this.authHeader =
        "Basic " + Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
    } else {
      throw new Error(
        "DatacenterClient: provide either auth.token (PAT) or auth.username + auth.password",
      );
    }

    this.requestCount = 0;
    this.errorCount = 0;
    this._userCache = new Map(); // username -> {name, displayName, emailAddress, key, active} | null
    this._inFlightUserLookups = new Map(); // dedupe parallel lookups for the same username
  }

  makeRequest(method, path, body = null, retryState = null) {
    const state = retryState || { rateLimitAttempts: 0, serverErrorAttempts: 0 };
    const maxRateLimitRetries = 5;
    const maxServerRetries = 5;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.hostname,
        port: this.port,
        path: this.basePath + path,
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        timeout: 60000,
      };

      if (body) {
        const bodyStr = JSON.stringify(body);
        options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
      }

      const retry = (newState) =>
        this.makeRequest(method, path, body, newState).then(resolve).catch(reject);

      const req = this.protocol.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          this.requestCount++;

          if (res.statusCode === 429 && state.rateLimitAttempts < maxRateLimitRetries) {
            const retryAfter = res.headers["retry-after"];
            const delay = retryAfter
              ? parseInt(retryAfter, 10) * 1000
              : Math.min(5000 * Math.pow(2, state.rateLimitAttempts), 120000);
            console.log(
              `  [DC] Rate limited (429), retrying in ${delay / 1000}s (attempt ${state.rateLimitAttempts + 1}/${maxRateLimitRetries})`,
            );
            setTimeout(
              () => retry({ ...state, rateLimitAttempts: state.rateLimitAttempts + 1 }),
              delay,
            );
            return;
          }

          if (
            res.statusCode >= 500 &&
            res.statusCode < 600 &&
            state.serverErrorAttempts < maxServerRetries
          ) {
            const delay = Math.min(1000 * Math.pow(2, state.serverErrorAttempts), 30000);
            console.log(
              `  [DC] Server error (${res.statusCode}), retrying in ${delay / 1000}s (attempt ${state.serverErrorAttempts + 1}/${maxServerRetries})`,
            );
            setTimeout(
              () => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }),
              delay,
            );
            return;
          }

          if (res.statusCode >= 400) {
            this.errorCount++;
            const error = new Error(
              `DC API ${method} ${path} returned ${res.statusCode}: ${data.substring(0, 500)}`,
            );
            error.statusCode = res.statusCode;
            error.responseBody = data;
            reject(error);
            return;
          }

          try {
            resolve(data ? JSON.parse(data) : null);
          } catch {
            resolve(data);
          }
        });
      });

      req.on("error", (err) => {
        this.errorCount++;
        if (state.serverErrorAttempts < maxServerRetries) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          console.log(
            `  [DC] Connection error: ${err.message}, retrying in ${delay / 1000}s`,
          );
          setTimeout(
            () => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }),
            delay,
          );
          return;
        }
        reject(err);
      });

      req.on("timeout", () => {
        req.destroy();
        if (state.serverErrorAttempts < maxServerRetries) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          console.log(`  [DC] Request timeout, retrying in ${delay / 1000}s`);
          setTimeout(
            () => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }),
            delay,
          );
          return;
        }
        reject(new Error(`DC API request timeout: ${method} ${path}`));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  async testConnection() {
    try {
      await this.makeRequest("GET", "/rest/api/2/myself");
      return true;
    } catch (error) {
      console.error(`  [DC] Connection test failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Returns every project on DC the authenticated user can see.
   * Output: [{ key, name, id }, ...].
   * DC's /project endpoint is non-paginated by default.
   */
  async listProjects() {
    const res = await this.makeRequest("GET", "/rest/api/2/project");
    if (!Array.isArray(res)) return [];
    return res.map((p) => ({ key: p.key, name: p.name, id: p.id }));
  }

  /**
   * Async generator streaming one DC issue at a time for a project. Yields
   * the raw issue payload (key + fields.description + fields.comment.comments[]).
   * Memory-bounded: holds at most one page (default 100) in memory at a time.
   *
   * `fields` controls what comes back — defaults to description+comment so the
   * caller can compute body lengths without a second round-trip.
   * `limit` (0 = unlimited) caps the total yielded.
   */
  async *iterateProjectIssues(projectKey, { fields = "description,comment", limit = 0 } = {}) {
    const jql = encodeURIComponent(`project = "${projectKey}" ORDER BY created ASC`);
    const pageSize = 100;
    let startAt = 0;
    let yielded = 0;
    while (true) {
      const path = `/rest/api/2/search?jql=${jql}&fields=${fields}&startAt=${startAt}&maxResults=${pageSize}`;
      let page;
      try {
        page = await this.makeRequest("GET", path);
      } catch (e) {
        if (e.statusCode === 400) return; // unknown project / bad JQL — stop quietly
        throw e;
      }
      const issues = page?.issues || [];
      if (issues.length === 0) return;
      for (const issue of issues) {
        yield issue;
        yielded++;
        if (limit > 0 && yielded >= limit) return;
      }
      const total = typeof page?.total === "number" ? page.total : null;
      if (issues.length < pageSize) return;
      if (total !== null && startAt + issues.length >= total) return;
      startAt += pageSize;
      if (startAt > 500000) return; // safety cap
    }
  }

  /**
   * Fetch a DC issue with description + comment storage bodies AND their
   * rendered (HTML) counterparts. Returns:
   *   {
   *     key,
   *     description: { storage, rendered },          // either may be null
   *     commentTotal,                                // from fields.comment.total
   *     comments: [
   *       { id, author: {name, displayName}, created, updated, storage, rendered }
   *     ]
   *   }
   * Throws on HTTP error (caller decides).
   */
  async getIssueWithRenderedBodies(issueKey) {
    const path =
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}` +
      `?fields=description,comment&expand=renderedFields,names`;
    const res = await this.makeRequest("GET", path);

    const fields = res?.fields || {};
    const rf = res?.renderedFields || {};

    const description = {
      storage: typeof fields.description === "string" ? fields.description : null,
      rendered: typeof rf.description === "string" ? rf.description : null,
    };

    const storageComments = Array.isArray(fields.comment?.comments)
      ? fields.comment.comments
      : [];
    const renderedComments = Array.isArray(rf.comment?.comments)
      ? rf.comment.comments
      : Array.isArray(rf.comment)
      ? rf.comment
      : [];
    const renderedById = new Map();
    for (const rc of renderedComments) {
      if (rc && rc.id) renderedById.set(String(rc.id), rc.body);
    }

    const comments = storageComments.map((c) => ({
      id: c.id,
      author: c.author
        ? { name: c.author.name || null, displayName: c.author.displayName || null }
        : null,
      created: c.created || null,
      updated: c.updated || null,
      storage: typeof c.body === "string" ? c.body : null,
      rendered:
        renderedById.get(String(c.id)) ||
        (typeof c.renderedBody === "string" ? c.renderedBody : null),
    }));

    return {
      key: res?.key || issueKey,
      description,
      commentTotal:
        typeof fields.comment?.total === "number"
          ? fields.comment.total
          : storageComments.length,
      comments,
    };
  }

  /**
   * Fallback path when the inline comment array is capped. DC's
   * /comment endpoint pages with startAt+maxResults and exposes a rendered
   * HTML body via `expand=renderedBody`. Returns comments in created-ASC order.
   */
  async getCommentsPaginated(issueKey) {
    const out = [];
    let startAt = 0;
    const maxResults = 100;
    while (true) {
      const path =
        `/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment` +
        `?startAt=${startAt}&maxResults=${maxResults}&expand=renderedBody&orderBy=created`;
      const res = await this.makeRequest("GET", path);
      const batch = Array.isArray(res?.comments) ? res.comments : [];
      for (const c of batch) {
        out.push({
          id: c.id,
          author: c.author
            ? { name: c.author.name || null, displayName: c.author.displayName || null }
            : null,
          created: c.created || null,
          updated: c.updated || null,
          storage: typeof c.body === "string" ? c.body : null,
          rendered: typeof c.renderedBody === "string" ? c.renderedBody : null,
        });
      }
      const total = typeof res?.total === "number" ? res.total : null;
      if (batch.length < maxResults) break;
      if (total !== null && startAt + batch.length >= total) break;
      startAt += batch.length;
      if (startAt > 100000) break;
    }
    out.sort((a, b) => {
      const ta = a.created ? Date.parse(a.created) : 0;
      const tb = b.created ? Date.parse(b.created) : 0;
      return ta - tb;
    });
    return out;
  }

  /**
   * Resolve a DC username to its full user record. Returns null when DC reports
   * 404 (user does not exist or was deleted). Other errors propagate.
   * Cached per client instance — same username is fetched at most once.
   */
  async getUser(username) {
    if (!username) return null;
    if (this._userCache.has(username)) return this._userCache.get(username);
    if (this._inFlightUserLookups.has(username)) {
      return this._inFlightUserLookups.get(username);
    }
    const p = (async () => {
      const path = `/rest/api/2/user?username=${encodeURIComponent(username)}`;
      try {
        const res = await this.makeRequest("GET", path);
        const user = res
          ? {
              name: res.name || null,
              displayName: res.displayName || null,
              emailAddress: res.emailAddress || null,
              key: res.key || null,
              active: typeof res.active === "boolean" ? res.active : null,
            }
          : null;
        this._userCache.set(username, user);
        return user;
      } catch (e) {
        if (e.statusCode === 404) {
          this._userCache.set(username, null);
          return null;
        }
        throw e;
      } finally {
        this._inFlightUserLookups.delete(username);
      }
    })();
    this._inFlightUserLookups.set(username, p);
    return p;
  }

  getStats() {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      userCacheSize: this._userCache.size,
    };
  }
}

module.exports = DatacenterClient;
