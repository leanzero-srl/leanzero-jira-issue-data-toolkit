const https = require("https");
const { URL } = require("url");
const { buildSingleFileMultipart } = require("./multipartBuilder");

class CloudJiraClient {
  constructor(baseUrl, apiToken) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const parsed = new URL(this.baseUrl);
    this.hostname = parsed.hostname;
    this.apiToken = apiToken;
    this.requestCount = 0;
    this.errorCount = 0;
    this.rateLimitCount = 0;

    this._issueExistsCache = new Map();
    this._configCache = null;
    this._permissionCache = new Map(); // projectKey -> { CREATE_ATTACHMENTS, EDIT_ISSUES, ... }
  }

  makeRequest(method, path, body = null, retryState = null) {
    const state = retryState || { rateLimitAttempts: 0, serverErrorAttempts: 0 };
    const maxRateLimitRetries = 3;
    const maxServerRetries = 3;

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

  /**
   * Multipart upload (file). Same retry shape as makeRequest but streams body
   * via bodyFactory() so retries can re-create the stream cheaply.
   */
  makeMultipartRequest(
    method,
    path,
    contentType,
    contentLength,
    bodyFactory,
    extraHeaders = {},
    retryState = null,
  ) {
    const state = retryState || { rateLimitAttempts: 0, serverErrorAttempts: 0 };
    const maxRateLimitRetries = 3;
    const maxServerRetries = 3;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.hostname,
        port: 443,
        path,
        method,
        headers: {
          Authorization: `Basic ${this.apiToken}`,
          Accept: "application/json",
          "Content-Type": contentType,
          "Content-Length": contentLength,
          ...extraHeaders,
        },
        timeout: 300000,
      };

      const retry = (newState) =>
        this.makeMultipartRequest(
          method,
          path,
          contentType,
          contentLength,
          bodyFactory,
          extraHeaders,
          newState,
        )
          .then(resolve)
          .catch(reject);

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          this.requestCount++;

          if (res.statusCode === 429) {
            this.rateLimitCount++;
            if (state.rateLimitAttempts >= maxRateLimitRetries) {
              const error = new Error(
                `Cloud upload rate-limited after ${maxRateLimitRetries} retries: ${method} ${path}`,
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
              `  [Cloud up] 429, retrying in ${delay / 1000}s (attempt ${state.rateLimitAttempts + 1}/${maxRateLimitRetries})`,
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
            console.log(`  [Cloud up] ${res.statusCode}, retrying in ${delay / 1000}s`);
            setTimeout(
              () => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }),
              delay,
            );
            return;
          }

          if (res.statusCode >= 400) {
            this.errorCount++;
            const error = new Error(
              `Cloud upload ${method} ${path} returned ${res.statusCode}: ${data.substring(0, 500)}`,
            );
            error.statusCode = res.statusCode;
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
          console.log(`  [Cloud up] Connection error: ${err.message}, retrying in ${delay / 1000}s`);
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
          console.log(`  [Cloud up] timeout, retrying in ${delay / 1000}s`);
          setTimeout(
            () => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }),
            delay,
          );
          return;
        }
        reject(new Error(`Cloud upload timeout: ${method} ${path}`));
      });

      const bodyStream = bodyFactory();
      bodyStream.on("error", (err) => {
        try { req.destroy(); } catch { /* ignore */ }
        reject(err);
      });
      bodyStream.pipe(req);
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

  // ─────────────────────────────────────────────────
  //  PROJECTS
  // ─────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────
  //  PERMISSIONS
  // ─────────────────────────────────────────────────

  async verifyEditPermission(projectKey) {
    if (this._permissionCache.has(projectKey)) {
      return this._permissionCache.get(projectKey);
    }
    const path =
      `/rest/api/3/mypermissions?projectKey=${encodeURIComponent(projectKey)}` +
      `&permissions=CREATE_ATTACHMENTS,EDIT_ISSUES`;
    try {
      const res = await this.makeRequest("GET", path);
      const perms = res?.permissions || {};
      const result = {
        CREATE_ATTACHMENTS: !!(perms.CREATE_ATTACHMENTS && perms.CREATE_ATTACHMENTS.havePermission),
        EDIT_ISSUES: !!(perms.EDIT_ISSUES && perms.EDIT_ISSUES.havePermission),
      };
      this._permissionCache.set(projectKey, result);
      return result;
    } catch (e) {
      const result = { CREATE_ATTACHMENTS: false, EDIT_ISSUES: false, error: e.message };
      this._permissionCache.set(projectKey, result);
      return result;
    }
  }

  // ─────────────────────────────────────────────────
  //  SEARCH (token-paginated v3 /search/jql)
  // ─────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────
  //  CONFIGURATION
  // ─────────────────────────────────────────────────

  async getConfiguration() {
    if (this._configCache) return this._configCache;
    const cfg = await this.makeRequest("GET", "/rest/api/3/configuration");
    this._configCache = cfg || {};
    return this._configCache;
  }

  // ─────────────────────────────────────────────────
  //  ISSUE / COMMENTS
  // ─────────────────────────────────────────────────

  async getIssue(key, fields = "description") {
    const path = `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(fields)}`;
    return this.makeRequest("GET", path);
  }

  /**
   * Page through every comment on a Cloud issue. Returns array sorted by
   * `created` ascending (the API default, but we don't trust it — sort defensively).
   * Each entry: { id, author, body, created, updated, ... } as Cloud returns.
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

  // ─────────────────────────────────────────────────
  //  ATTACHMENTS / UPLOAD
  // ─────────────────────────────────────────────────

  async uploadAttachment(issueKey, filePath, filename, mimeType) {
    let mp;
    try {
      mp = buildSingleFileMultipart({ filePath, filename, mimeType });
    } catch (e) {
      return {
        success: false,
        error: `multipart build failed: ${e.message}`,
        response: null,
        isRateLimit: false,
      };
    }

    const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments?notifyUsers=false`;
    try {
      const response = await this.makeMultipartRequest(
        "POST",
        path,
        mp.contentType,
        mp.contentLength,
        mp.createBodyStream,
        { "X-Atlassian-Token": "no-check" },
      );
      return { success: true, response, error: null, isRateLimit: false };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        response: null,
        isRateLimit: error.isRateLimit || false,
        statusCode: error.statusCode || null,
      };
    }
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

  // ─────────────────────────────────────────────────
  //  NOTIFICATION SCHEMES
  //
  //  Used by NotificationMuter to clone-mute-assign a temporary scheme per
  //  project during bulk writes so users don't get spammed with "Issue
  //  Updated" emails for thousands of attachment uploads.
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

  /**
   * Create a new notification scheme. Returns the created scheme (includes id).
   * Payload shape:
   *   { name, description, notificationSchemeEvents: [{ event:{id}, notifications:[{notificationType, parameter?}] }] }
   */
  async createNotificationScheme(payload) {
    return this.makeRequest("POST", "/rest/api/3/notificationscheme", payload);
  }

  async deleteNotificationScheme(schemeId) {
    return this.makeRequest(
      "DELETE",
      `/rest/api/3/notificationscheme/${encodeURIComponent(schemeId)}`,
    );
  }

  /**
   * Assign a notification scheme to a project. Cloud uses the project PUT
   * endpoint with `notificationScheme: <id>`. Note: the project PUT also
   * accepts other fields; we send only what we need.
   */
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
