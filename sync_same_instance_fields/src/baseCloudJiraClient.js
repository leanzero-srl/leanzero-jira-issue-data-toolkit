const https = require("https");
const { URL } = require("url");

class CloudJiraClient {
  constructor(baseUrl, apiToken) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const parsed = new URL(this.baseUrl);
    this.hostname = parsed.hostname;
    this.apiToken = apiToken;
    this.requestCount = 0;
    this.errorCount = 0;
    this.rateLimitCount = 0;

    // Cache: parent issue key -> true/false (exists in Cloud)
    this._issueExistsCache = new Map();
    // Cache: issue key -> normalized issuelinks array (see getIssueLinks)
    this._issueLinksCache = new Map();
    // Cache: { names: Set<string>, byName: Map<name,{id,inward,outward}> } | null
    this._linkTypeCache = null;
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
  //  ISSUE READ
  // ─────────────────────────────────────────────────

  /**
   * Fetch a Cloud issue's parent field. Returns null if the issue doesn't exist.
   * Result: { key, parent: { key, ... } | null }
   */
  async getIssueParent(issueKey) {
    try {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=parent`,
      );
      return { key: res.key || issueKey, parent: res.fields?.parent || null };
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
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
  //  ISSUE UPDATE
  // ─────────────────────────────────────────────────

  async updateIssue(issueKey, payload) {
    try {
      await this.makeRequest(
        "PUT",
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}?notifyUsers=false`,
        payload,
      );
      return { success: true, error: null, isRateLimit: false };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        isRateLimit: error.isRateLimit || false,
      };
    }
  }

  async setIssueParent(issueKey, parentKey) {
    return this.updateIssue(issueKey, {
      fields: { parent: { key: parentKey } },
    });
  }

  /**
   * Fetch a Cloud issue's reporter. Returns null if the issue doesn't exist.
   * Result: { key, reporter: { accountId, displayName } | null }
   */
  async getIssueReporter(issueKey) {
    try {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=reporter`,
      );
      return { key: res.key || issueKey, reporter: res.fields?.reporter || null };
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }
  }

  /**
   * Batch-fetch reporter for a list of issue keys.
   * Returns Map<key, { exists, reporter: {accountId, displayName}|null }>.
   * Mirrors batchGetIssueParents — falls back to per-issue verify on batch error.
   */
  async batchGetIssueReporters(issueKeys, batchSize = 50) {
    const result = new Map();
    if (!issueKeys || issueKeys.length === 0) return result;

    for (let i = 0; i < issueKeys.length; i += batchSize) {
      const batch = issueKeys.slice(i, i + batchSize);
      const jql = `key in (${batch.join(",")})`;
      let issues = [];
      try {
        issues = await this.searchIssues(jql, "reporter", 100);
      } catch (e) {
        for (const k of batch) {
          try {
            const ok = await this.verifyIssueExists(k);
            result.set(k, { exists: ok, reporter: null });
          } catch {
            result.set(k, { exists: false, reporter: null });
          }
        }
        continue;
      }
      const seen = new Set();
      for (const issue of issues) {
        seen.add(issue.key);
        result.set(issue.key, {
          exists: true,
          reporter: issue.fields?.reporter || null,
        });
        this._issueExistsCache.set(issue.key, true);
      }
      for (const k of batch) {
        if (!seen.has(k)) {
          result.set(k, { exists: false, reporter: null });
          this._issueExistsCache.set(k, false);
        }
      }
    }

    return result;
  }

  /**
   * Search Cloud users via /rest/api/3/user/search.
   *   query: matches against displayName + emailAddress (prefix).
   * Returns an array of { accountId, accountType, active, displayName, emailAddress }.
   * Throws on non-2xx (with retry/backoff handled by makeRequest).
   */
  async searchUsers(query, maxResults = 50) {
    const path = `/rest/api/3/user/search?query=${encodeURIComponent(query)}&maxResults=${maxResults}`;
    const res = await this.makeRequest("GET", path);
    return Array.isArray(res) ? res : [];
  }

  /**
   * Batch-fetch parent + issuetype for a list of issue keys.
   * Returns Map<key, { exists, parent: {key,...}|null, issueType }>.
   * Keys not found in the search result are returned with exists=false.
   */
  async batchGetIssueParents(issueKeys, batchSize = 50) {
    const result = new Map();
    if (!issueKeys || issueKeys.length === 0) return result;

    for (let i = 0; i < issueKeys.length; i += batchSize) {
      const batch = issueKeys.slice(i, i + batchSize);
      const jql = `key in (${batch.join(",")})`;
      let issues = [];
      try {
        issues = await this.searchIssues(jql, "parent,issuetype", 100);
      } catch (e) {
        // Fall back to per-issue verifyIssueExists on this batch
        for (const k of batch) {
          try {
            const ok = await this.verifyIssueExists(k);
            result.set(k, { exists: ok, parent: null, issueType: null });
          } catch {
            result.set(k, { exists: false, parent: null, issueType: null });
          }
        }
        continue;
      }
      const seen = new Set();
      for (const issue of issues) {
        seen.add(issue.key);
        result.set(issue.key, {
          exists: true,
          parent: issue.fields?.parent || null,
          issueType: issue.fields?.issuetype?.name || null,
        });
        // Hot-prime the verify cache so later set-parent paths don't refetch
        this._issueExistsCache.set(issue.key, true);
      }
      for (const k of batch) {
        if (!seen.has(k)) {
          result.set(k, { exists: false, parent: null, issueType: null });
          this._issueExistsCache.set(k, false);
        }
      }
    }

    return result;
  }

  async updateIssuesBatch(updates, concurrency = 5) {
    const results = new Map();
    let idx = 0;

    const worker = async () => {
      while (idx < updates.length) {
        const current = idx++;
        const { issueKey, payload } = updates[current];
        const result = await this.updateIssue(issueKey, payload);
        results.set(issueKey, result);
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, updates.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    return results;
  }

  // ─────────────────────────────────────────────────
  //  ISSUE LINKS
  // ─────────────────────────────────────────────────

  /**
   * Fetch a Cloud issue's normalized issue-to-issue links. Cached by key.
   * Returns an array of
   *   { id, typeName, typeInward, typeOutward, direction:'inward'|'outward', otherKey }
   * (same shape as DatacenterClient.getIssueLinks().links).
   * Throws on non-2xx (callers catch 404 at preflight). Also primes the
   * issue-exists cache as a side effect.
   */
  async getIssueLinks(issueKey) {
    if (this._issueLinksCache.has(issueKey)) {
      return this._issueLinksCache.get(issueKey);
    }
    const res = await this.makeRequest(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=issuelinks`,
    );
    const links = this.normalizeRawLinks(res.fields?.issuelinks);
    this._issueLinksCache.set(issueKey, links);
    this._issueExistsCache.set(issueKey, true);
    return links;
  }

  /**
   * Prime the link cache for a key with raw issuelinks already in hand (e.g.
   * from a JQL search response), avoiding an extra GET.
   */
  primeIssueLinks(issueKey, rawLinks) {
    const links = this.normalizeRawLinks(rawLinks);
    this._issueLinksCache.set(issueKey, links);
    this._issueExistsCache.set(issueKey, true);
    return links;
  }

  invalidateIssueLinksCache(issueKey) {
    this._issueLinksCache.delete(issueKey);
  }

  /**
   * Normalize a raw `issuelinks` array into direction-tagged descriptors.
   * Raw shape is identical between DC v2 and Cloud v3.
   */
  normalizeRawLinks(rawLinks) {
    const out = [];
    for (const l of rawLinks || []) {
      const type = l.type || {};
      const typeName = type.name || null;
      if (!typeName) continue;
      let direction = null;
      let otherKey = null;
      if (l.outwardIssue && l.outwardIssue.key) {
        direction = "outward";
        otherKey = l.outwardIssue.key;
      } else if (l.inwardIssue && l.inwardIssue.key) {
        direction = "inward";
        otherKey = l.inwardIssue.key;
      } else {
        continue;
      }
      out.push({
        id: l.id || null,
        typeName,
        typeInward: type.inward || null,
        typeOutward: type.outward || null,
        direction,
        otherKey,
      });
    }
    return out;
  }

  /**
   * List the Cloud instance's issue link types. Cached.
   * Returns { names: Set<string>, byName: Map<name, {id, inward, outward}> }.
   */
  async getIssueLinkTypes() {
    if (this._linkTypeCache) return this._linkTypeCache;
    const res = await this.makeRequest("GET", "/rest/api/3/issueLinkType");
    const types = res?.issueLinkTypes || [];
    const names = new Set();
    const byName = new Map();
    for (const t of types) {
      if (!t.name) continue;
      names.add(t.name);
      byName.set(t.name, {
        id: t.id || null,
        inward: t.inward || null,
        outward: t.outward || null,
      });
    }
    this._linkTypeCache = { names, byName };
    return this._linkTypeCache;
  }

  /**
   * Create a single issue link reproducing "outwardKey {type.outward} inwardKey"
   * (outwardKey is the SUBJECT performing the outward verb — the same convention
   * our canonical triples use).
   *
   * IMPORTANT — verified empirically against the live instance (read back from
   * both endpoints): Jira's POST /issueLink treats the body's `inwardIssue` as
   * the SUBJECT that performs the OUTWARD verb, and `outwardIssue` as the object.
   * That is, POST {inwardIssue:X, outwardIssue:Y} renders as "X {type.outward} Y".
   * So to create "outwardKey {outward} inwardKey" we put outwardKey into the
   * POST's inwardIssue slot and inwardKey into outwardIssue. (This is the
   * notorious Jira issue-link direction inversion — do NOT "simplify" it.)
   *
   * Returns 201 with an EMPTY body, so there is no link id to capture.
   * Mirrors updateIssue()'s result envelope.
   */
  async createIssueLink(typeName, outwardKey, inwardKey) {
    try {
      await this.makeRequest("POST", "/rest/api/3/issueLink", {
        type: { name: typeName },
        inwardIssue: { key: outwardKey }, // subject (performs the outward verb)
        outwardIssue: { key: inwardKey }, // object
      });
      return { success: true, error: null, isRateLimit: false, statusCode: 201 };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        isRateLimit: error.isRateLimit || false,
        statusCode: error.statusCode || null,
      };
    }
  }

  /** Delete an issue link by its link id. */
  async deleteIssueLink(linkId) {
    try {
      await this.makeRequest(
        "DELETE",
        `/rest/api/3/issueLink/${encodeURIComponent(linkId)}`,
      );
      return { success: true, error: null };
    } catch (error) {
      return { success: false, error: error.message, statusCode: error.statusCode || null };
    }
  }

  /**
   * Concurrent worker-pool create of many links.
   * items: [{ tripleId, typeName, outwardKey, inwardKey }]
   * Returns Map<tripleId, { success, error, isRateLimit, statusCode }>.
   */
  async createIssueLinksBatch(items, concurrency = 5) {
    const results = new Map();
    let idx = 0;

    const worker = async () => {
      while (idx < items.length) {
        const current = idx++;
        const { tripleId, typeName, outwardKey, inwardKey } = items[current];
        const result = await this.createIssueLink(typeName, outwardKey, inwardKey);
        results.set(tripleId, result);
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, items.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    return results;
  }

  // ─────────────────────────────────────────────────
  //  NOTIFICATION SCHEMES (used by NotificationMuter)
  //  Per-project clone+mute+assign of "Issue Updated" so bulk parent PUTs
  //  don't trigger watcher emails.
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
