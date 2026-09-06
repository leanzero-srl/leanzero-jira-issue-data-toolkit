// FORKED FROM jira/jira-data/recover_truncated_content/src/cloudJiraClient.js @ 003579d
// Changes:
//   - dropped multipart upload + attachment helpers (this script never attaches files)
//   - added searchUsers() ported from sync_issue_parents
//   - added updateComment() (PUT comment with ?notifyUsers=false)
//   - added addComment() / deleteComment() — for the notify-test helper only
//   - added getComment() (single) for hash re-check at apply time
//   - added getCommentProperties() and getCommentProperty() for the JCMA source-id probe
//   - added getCurrentUser() for the notify-test default mention target

const https = require("https");
const { URL } = require("url");

class CloudJiraClient {
  constructor(baseUrl, apiToken) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const parsed = new URL(this.baseUrl);
    this.hostname = parsed.hostname;
    // Honor any path prefix on the base URL. This lets the same client target
    // the Atlassian API gateway for SCOPED API tokens:
    //   https://api.atlassian.com/ex/jira/<cloudId>
    // where every REST path must be prefixed with /ex/jira/<cloudId>. For the
    // normal tenant URL (https://site.atlassian.net) the pathname is empty, so
    // this is a no-op and existing callers are unaffected.
    this.basePath = parsed.pathname.replace(/\/$/, "");
    this.apiToken = apiToken;
    this.requestCount = 0;
    this.errorCount = 0;
    this.rateLimitCount = 0;

    this._issueExistsCache = new Map();
    this._permissionCache = new Map();
  }

  makeRequest(method, path, body = null, retryState = null) {
    const state = retryState || { rateLimitAttempts: 0, serverErrorAttempts: 0 };
    const maxRateLimitRetries = 3;
    const maxServerRetries = 3;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.hostname,
        port: 443,
        path: this.basePath + path,
        method,
        headers: {
          Authorization: `Basic ${this.apiToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        timeout: 30000,
      };

      if (body) {
        const bodyStr = JSON.stringify(body);
        options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
      }

      const retry = (newState) =>
        this.makeRequest(method, path, body, newState).then(resolve).catch(reject);

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          this.requestCount++;

          if (res.statusCode === 429) {
            this.rateLimitCount++;
            if (state.rateLimitAttempts >= maxRateLimitRetries) {
              const error = new Error(
                `Cloud API rate limit exceeded after ${maxRateLimitRetries} attempts: ${method} ${path}`,
              );
              error.statusCode = 429;
              error.isRateLimit = true;
              reject(error);
              return;
            }
            const retryAfter = res.headers["retry-after"];
            const delay = retryAfter
              ? parseInt(retryAfter, 10) * 1000
              : Math.min(5000 * Math.pow(2, state.rateLimitAttempts), 60000);
            console.log(
              `  [Cloud] Rate limited (429), waiting ${delay / 1000}s (attempt ${state.rateLimitAttempts + 1}/${maxRateLimitRetries})`,
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
            const delay = Math.min(1000 * Math.pow(2, state.serverErrorAttempts), 10000);
            console.log(
              `  [Cloud] Server error (${res.statusCode}), retrying in ${delay / 1000}s (attempt ${state.serverErrorAttempts + 1}/${maxServerRetries})`,
            );
            setTimeout(
              () => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }),
              delay,
            );
            return;
          }

          if (res.statusCode === 204) {
            resolve(null);
            return;
          }

          if (res.statusCode >= 400) {
            this.errorCount++;
            const error = new Error(
              `Cloud API ${method} ${path} returned ${res.statusCode}: ${data.substring(0, 500)}`,
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
            `  [Cloud] Connection error: ${err.message}, retrying in ${delay / 1000}s`,
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
          console.log(`  [Cloud] Request timeout, retrying in ${delay / 1000}s`);
          setTimeout(
            () => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }),
            delay,
          );
          return;
        }
        reject(new Error(`Cloud API request timeout: ${method} ${path}`));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  async testConnection() {
    try {
      await this.makeRequest("GET", "/rest/api/3/myself");
      return true;
    } catch (error) {
      console.error(`  [Cloud] Connection test failed: ${error.message}`);
      return false;
    }
  }

  async getCurrentUser() {
    return this.makeRequest("GET", "/rest/api/3/myself");
  }

  async listProjects() {
    const projects = [];
    let startAt = 0;
    const maxResults = 50;
    while (true) {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/project/search?startAt=${startAt}&maxResults=${maxResults}`,
      );
      const values = res?.values || [];
      for (const p of values) projects.push({ key: p.key, name: p.name, id: p.id });
      if (values.length < maxResults) break;
      if (res.isLast === true) break;
      startAt += values.length;
      if (startAt > 100000) break;
    }
    return projects;
  }

  async verifyEditPermission(projectKey) {
    if (this._permissionCache.has(projectKey)) {
      return this._permissionCache.get(projectKey);
    }
    const path =
      `/rest/api/3/mypermissions?projectKey=${encodeURIComponent(projectKey)}` +
      `&permissions=EDIT_ISSUES`;
    try {
      const res = await this.makeRequest("GET", path);
      const perms = res?.permissions || {};
      const result = {
        EDIT_ISSUES: !!(perms.EDIT_ISSUES && perms.EDIT_ISSUES.havePermission),
      };
      this._permissionCache.set(projectKey, result);
      return result;
    } catch (e) {
      const result = { EDIT_ISSUES: false, error: e.message };
      this._permissionCache.set(projectKey, result);
      return result;
    }
  }

  /**
   * Token-paginated /rest/api/3/search/jql.
   * If onPage(issues) is provided, called per page; return false to stop.
   * Otherwise returns the full accumulated array.
   */
  async searchIssues(jql, fields, maxResults = 100, onPage = null) {
    const encoded = encodeURIComponent(jql);
    const accumulated = [];
    let nextPageToken = null;

    while (true) {
      let url = `/rest/api/3/search/jql?jql=${encoded}&maxResults=${maxResults}&fields=${fields}`;
      if (nextPageToken) {
        url += `&nextPageToken=${encodeURIComponent(nextPageToken)}`;
      }
      const res = await this.makeRequest("GET", url);
      const batch = res?.issues || [];
      if (batch.length === 0) break;

      if (onPage) {
        const cont = await onPage(batch);
        if (cont === false) break;
      } else {
        accumulated.push(...batch);
      }

      if (res.isLast === true || !res.nextPageToken) break;
      nextPageToken = res.nextPageToken;
    }

    return accumulated;
  }

  async getIssue(key, fields = "summary") {
    const path = `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(fields)}`;
    return this.makeRequest("GET", path);
  }

  async verifyIssueExists(issueKey) {
    if (this._issueExistsCache.has(issueKey)) {
      return this._issueExistsCache.get(issueKey);
    }
    try {
      await this.makeRequest(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary`,
      );
      this._issueExistsCache.set(issueKey, true);
      return true;
    } catch (error) {
      if (error.statusCode === 404) {
        this._issueExistsCache.set(issueKey, false);
        return false;
      }
      throw error;
    }
  }

  /**
   * Page through every comment on a Cloud issue. Returns array sorted by
   * `created` ascending. Each entry has { id, author, body, created, updated, ... }.
   */
  async getComments(issueKey) {
    const out = [];
    let startAt = 0;
    const maxResults = 100;
    while (true) {
      const path =
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment` +
        `?startAt=${startAt}&maxResults=${maxResults}&orderBy=created`;
      const res = await this.makeRequest("GET", path);
      const batch = res?.comments || [];
      out.push(...batch);
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
   * GET a single comment — used at apply time to recompute the body hash and
   * confirm no one edited the comment between PLAN and APPLY.
   */
  async getComment(issueKey, commentId) {
    const path =
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`;
    return this.makeRequest("GET", path);
  }

  /**
   * PUT /rest/api/3/issue/{key}/comment/{id}?notifyUsers=false
   * Per Atlassian OpenAPI spec, `notifyUsers` is a documented query parameter
   * (default true) that disables watcher emails for the update event.
   */
  async updateComment(issueKey, commentId, adfBody) {
    const path =
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}` +
      `?notifyUsers=false`;
    return this.makeRequest("PUT", path, { body: adfBody });
  }

  /**
   * Used by the notify-test helper only. POST does NOT support notifyUsers per
   * the OpenAPI spec, so this fires an email (expected behavior of the test).
   */
  async addComment(issueKey, adfBody) {
    const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`;
    return this.makeRequest("POST", path, { body: adfBody });
  }

  async deleteComment(issueKey, commentId) {
    const path =
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`;
    return this.makeRequest("DELETE", path);
  }

  async getCommentProperties(commentId) {
    const path = `/rest/api/3/comment/${encodeURIComponent(commentId)}/properties`;
    return this.makeRequest("GET", path);
  }

  async getCommentProperty(commentId, propertyKey) {
    const path =
      `/rest/api/3/comment/${encodeURIComponent(commentId)}/properties/${encodeURIComponent(propertyKey)}`;
    return this.makeRequest("GET", path);
  }

  /**
   * GET /rest/api/3/user/search?query=<str>&maxResults=<n>
   * Returns [] of { accountId, accountType, active, displayName, emailAddress }.
   * Throws on non-2xx after retry; returns [] on empty result.
   */
  async searchUsers(query, maxResults = 50) {
    const path = `/rest/api/3/user/search?query=${encodeURIComponent(query)}&maxResults=${maxResults}`;
    const res = await this.makeRequest("GET", path);
    return Array.isArray(res) ? res : [];
  }

  // ─────────────────────────────────────────────────
  //  NOTIFICATION SCHEMES (used by NotificationMuter as belt-and-suspenders
  //  alongside notifyUsers=false on PUT /comment/{id}; some sites/plugins
  //  silently ignore the flag, so the muter is the guaranteed suppressor.)
  // ─────────────────────────────────────────────────

  async getProjectNotificationScheme(projectKey) {
    return this.makeRequest(
      "GET",
      `/rest/api/3/project/${encodeURIComponent(projectKey)}/notificationscheme`,
    );
  }

  async getNotificationScheme(schemeId) {
    return this.makeRequest(
      "GET",
      `/rest/api/3/notificationscheme/${encodeURIComponent(schemeId)}?expand=notificationSchemeEvents,user,group,projectRole,field,all`,
    );
  }

  async createNotificationScheme(payload) {
    return this.makeRequest("POST", "/rest/api/3/notificationscheme", payload);
  }

  async deleteNotificationScheme(schemeId) {
    return this.makeRequest(
      "DELETE",
      `/rest/api/3/notificationscheme/${encodeURIComponent(schemeId)}`,
    );
  }

  async setProjectNotificationScheme(projectKey, schemeId) {
    return this.makeRequest(
      "PUT",
      `/rest/api/3/project/${encodeURIComponent(projectKey)}`,
      { notificationScheme: Number(schemeId) || schemeId },
    );
  }

  getStats() {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      rateLimitCount: this.rateLimitCount,
    };
  }
}

module.exports = CloudJiraClient;
