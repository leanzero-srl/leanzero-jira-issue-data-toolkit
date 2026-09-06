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
    this._attachmentCache = new Map(); // issueKey -> [{ filename, size, ... }]
    this._configCache = null;
  }

  makeRequest(method, path, body = null, retryState = null) {
    const state = retryState || {
      rateLimitAttempts: 0,
      serverErrorAttempts: 0,
    };
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
        this.makeRequest(method, path, body, newState)
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
              () =>
                retry({
                  ...state,
                  rateLimitAttempts: state.rateLimitAttempts + 1,
                }),
              delay,
            );
            return;
          }

          if (
            res.statusCode >= 500 &&
            res.statusCode < 600 &&
            state.serverErrorAttempts < maxServerRetries
          ) {
            const delay = Math.min(
              1000 * Math.pow(2, state.serverErrorAttempts),
              10000,
            );
            console.log(
              `  [Cloud] Server error (${res.statusCode}), retrying in ${delay / 1000}s (attempt ${state.serverErrorAttempts + 1}/${maxServerRetries})`,
            );
            setTimeout(
              () =>
                retry({
                  ...state,
                  serverErrorAttempts: state.serverErrorAttempts + 1,
                }),
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
            () =>
              retry({
                ...state,
                serverErrorAttempts: state.serverErrorAttempts + 1,
              }),
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
          console.log(
            `  [Cloud] Request timeout, retrying in ${delay / 1000}s`,
          );
          setTimeout(
            () =>
              retry({
                ...state,
                serverErrorAttempts: state.serverErrorAttempts + 1,
              }),
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
   * Multipart upload. Cannot reuse makeRequest — different Content-Type,
   * different body shape, must stream the file (can't fit JSON serialization
   * model). Mirrors the same 429/5xx/timeout retry behavior.
   *
   * `bodyFactory()` MUST return a *new* Readable each call (retry-safe).
   */
  makeMultipartRequest(method, path, contentType, contentLength, bodyFactory, extraHeaders = {}, retryState = null) {
    const state = retryState || {
      rateLimitAttempts: 0,
      serverErrorAttempts: 0,
    };
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
        timeout: 300000, // 5 min — uploads can be slow for big files
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
              () =>
                retry({
                  ...state,
                  rateLimitAttempts: state.rateLimitAttempts + 1,
                }),
              delay,
            );
            return;
          }

          if (
            res.statusCode >= 500 &&
            res.statusCode < 600 &&
            state.serverErrorAttempts < maxServerRetries
          ) {
            const delay = Math.min(
              1000 * Math.pow(2, state.serverErrorAttempts),
              10000,
            );
            console.log(
              `  [Cloud up] ${res.statusCode}, retrying in ${delay / 1000}s`,
            );
            setTimeout(
              () =>
                retry({
                  ...state,
                  serverErrorAttempts: state.serverErrorAttempts + 1,
                }),
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
          console.log(
            `  [Cloud up] Connection error: ${err.message}, retrying in ${delay / 1000}s`,
          );
          setTimeout(
            () =>
              retry({
                ...state,
                serverErrorAttempts: state.serverErrorAttempts + 1,
              }),
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
            () =>
              retry({
                ...state,
                serverErrorAttempts: state.serverErrorAttempts + 1,
              }),
            delay,
          );
          return;
        }
        reject(new Error(`Cloud upload timeout: ${method} ${path}`));
      });

      const bodyStream = bodyFactory();
      bodyStream.on("error", (err) => {
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        reject(err);
      });
      bodyStream.pipe(req);
    });
  }

  async testConnection() {
    try {
      await this.makeRequest("GET", "/rest/api/3/serverInfo");
      return true;
    } catch (error) {
      console.error(`  [Cloud] Connection test failed: ${error.message}`);
      return false;
    }
  }

  // ─────────────────────────────────────────────────
  //  SEARCH
  // ─────────────────────────────────────────────────

  async searchIssues(jql, fields, maxResults = 100) {
    const encoded = encodeURIComponent(jql);
    const issues = [];
    let nextPageToken = null;

    while (true) {
      let url = `/rest/api/3/search/jql?jql=${encoded}&maxResults=${maxResults}&fields=${fields}`;
      if (nextPageToken) {
        url += `&nextPageToken=${encodeURIComponent(nextPageToken)}`;
      }
      const res = await this.makeRequest("GET", url);
      const batch = res.issues || [];
      issues.push(...batch);
      if (batch.length === 0) break;
      if (issues.length % 1000 < maxResults) {
        console.log(`    [Cloud search] ${issues.length} issues fetched so far...`);
      }
      if (res.isLast || !res.nextPageToken) break;
      nextPageToken = res.nextPageToken;
    }

    return issues;
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
  //  ATTACHMENTS
  // ─────────────────────────────────────────────────

  /**
   * List attachments currently on a Cloud issue.
   * Returns [] if the issue has none. Throws on 404 (caller decides).
   */
  async listAttachments(issueKey) {
    if (this._attachmentCache.has(issueKey)) {
      return this._attachmentCache.get(issueKey);
    }
    const res = await this.makeRequest(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=attachment`,
    );
    const attachments = (res.fields?.attachment || []).map((a) => ({
      id: a.id,
      filename: a.filename,
      size: typeof a.size === "number" ? a.size : null,
      mimeType: a.mimeType || null,
    }));
    this._attachmentCache.set(issueKey, attachments);
    this._issueExistsCache.set(issueKey, true);
    return attachments;
  }

  invalidateAttachmentCache(issueKey) {
    this._attachmentCache.delete(issueKey);
  }

  /**
   * Batch-fetch attachments for many issues via JQL `key in (...)`.
   * Returns Map<key, { exists, attachments }>.
   */
  async batchGetIssueAttachments(issueKeys, batchSize = 50) {
    const result = new Map();
    if (!issueKeys || issueKeys.length === 0) return result;

    for (let i = 0; i < issueKeys.length; i += batchSize) {
      const batch = issueKeys.slice(i, i + batchSize);
      const jql = `key in (${batch.join(",")})`;
      let issues = [];
      try {
        issues = await this.searchIssues(jql, "attachment", 100);
      } catch (e) {
        for (const k of batch) {
          try {
            const list = await this.listAttachments(k);
            result.set(k, { exists: true, attachments: list });
          } catch (err) {
            const exists = err.statusCode === 404 ? false : false;
            result.set(k, { exists, attachments: [] });
          }
        }
        continue;
      }
      const seen = new Set();
      for (const issue of issues) {
        seen.add(issue.key);
        const attachments = (issue.fields?.attachment || []).map((a) => ({
          id: a.id,
          filename: a.filename,
          size: typeof a.size === "number" ? a.size : null,
          mimeType: a.mimeType || null,
        }));
        result.set(issue.key, { exists: true, attachments });
        this._attachmentCache.set(issue.key, attachments);
        this._issueExistsCache.set(issue.key, true);
      }
      for (const k of batch) {
        if (!seen.has(k)) {
          result.set(k, { exists: false, attachments: [] });
          this._issueExistsCache.set(k, false);
        }
      }
    }

    return result;
  }

  /**
   * Upload one attachment to a Cloud issue.
   *   POST /rest/api/3/issue/{key}/attachments
   *   Headers: X-Atlassian-Token: no-check (REQUIRED; XSRF bypass for uploads)
   * Returns { success, response, error, isRateLimit }.
   * On success, response is the JSON array returned by Jira (1-element).
   */
  async uploadAttachment(issueKey, filePath, filename, mimeType) {
    let mp;
    try {
      mp = buildSingleFileMultipart({ filePath, filename, mimeType });
    } catch (e) {
      return { success: false, error: `multipart build failed: ${e.message}`, response: null, isRateLimit: false };
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
      // Cache invalidation so a subsequent listAttachments sees the new item
      this.invalidateAttachmentCache(issueKey);
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

  /**
   * Check whether an issue exists in Cloud. Cached.
   */
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
  //  NOTIFICATION SCHEMES (used by NotificationMuter)
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
