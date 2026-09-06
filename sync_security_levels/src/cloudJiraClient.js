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

    // Cache: projectKey -> { id, key, name }
    this._projectCache = new Map();
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
  //  SECURITY SCHEMES & LEVELS
  // ─────────────────────────────────────────────────

  async fetchAllSecuritySchemes() {
    const res = await this.makeRequest(
      "GET",
      "/rest/api/3/issuesecurityschemes",
    );
    return res.issueSecuritySchemes || [];
  }

  async fetchSecurityLevels(schemeIds) {
    const levels = [];
    const schemeIdParams = schemeIds
      .map((id) => `schemeId=${encodeURIComponent(id)}`)
      .join("&");
    let startAt = 0;
    const maxResults = 50;

    while (true) {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/issuesecurityschemes/level?${schemeIdParams}&startAt=${startAt}&maxResults=${maxResults}`,
      );
      const page = res;
      const values = page.values || [];
      levels.push(...values);

      if (startAt + values.length >= (page.total || values.length)) break;
      if (values.length === 0) break;
      startAt += values.length;
    }

    return levels;
  }

  async fetchSecurityLevelMembers(levelIds, schemeIds) {
    const members = [];
    let startAt = 0;
    const maxResults = 50;

    const levelIdParams = levelIds
      .map((id) => `levelId=${encodeURIComponent(id)}`)
      .join("&");
    const schemeIdParams = schemeIds
      .map((id) => `schemeId=${encodeURIComponent(id)}`)
      .join("&");

    while (true) {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/issuesecurityschemes/level/member?${levelIdParams}&${schemeIdParams}&startAt=${startAt}&maxResults=${maxResults}&expand=group`,
      );
      const page = res;
      const values = page.values || [];
      members.push(...values);

      if (startAt + values.length >= (page.total || values.length)) break;
      if (values.length === 0) break;
      startAt += values.length;
    }

    return members;
  }

  async addMemberToSecurityLevel(schemeId, levelId, memberType, parameter) {
    const body = {
      members: [
        {
          type: memberType,
          parameter: parameter,
        },
      ],
    };
    return this.makeRequest(
      "PUT",
      `/rest/api/3/issuesecurityschemes/${encodeURIComponent(schemeId)}/level/${encodeURIComponent(levelId)}/member`,
      body,
    );
  }

  async fetchProjectSchemeAssociations() {
    const associations = [];
    let startAt = 0;
    const maxResults = 50;

    while (true) {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/issuesecurityschemes/project?startAt=${startAt}&maxResults=${maxResults}`,
      );
      const values = res.values || [];
      associations.push(...values);

      if (startAt + values.length >= (res.total || values.length)) break;
      if (values.length === 0) break;
      startAt += values.length;
    }

    return associations;
  }

  async createSecurityLevel(schemeId, name, description, members = []) {
    const levelDef = {
      name,
      description: description || "",
      isDefault: false,
    };
    if (members.length > 0) {
      levelDef.members = members; // [{ type: "group", parameter: "..." }, { type: "projectRole", parameter: "..." }]
    }
    return this.makeRequest(
      "PUT",
      `/rest/api/3/issuesecurityschemes/${encodeURIComponent(schemeId)}/level`,
      { levels: [levelDef] },
    );
  }

  /**
   * Find members of a level by name across all Cloud schemes.
   * Returns deduplicated array of { type, parameter } ready for the creation API.
   *
   * Note: the GET members API returns holder.type in camelCase (e.g. "projectRole")
   * but the creation API expects lowercase (e.g. "projectrole"). We translate here.
   */
  async findLevelMembersByName(levelName, excludeSchemeId = null) {
    const schemes = await this.fetchAllSecuritySchemes();
    const schemeIds = schemes.map((s) => s.id);
    if (schemeIds.length === 0) return [];

    const allLevels = await this.fetchSecurityLevels(schemeIds);
    // Find a level with this name in a scheme that was properly migrated (has members)
    const candidates = allLevels.filter(
      (l) => l.name === levelName && String(l.issueSecuritySchemeId) !== String(excludeSchemeId),
    );

    // GET API type -> creation API type mapping
    const typeMap = {
      group: "group",
      projectRole: "projectrole",
      applicationRole: "applicationRole",
      reporter: "reporter",
      user: "user",
    };

    for (const candidate of candidates) {
      const members = await this.fetchSecurityLevelMembers(
        [candidate.id],
        [candidate.issueSecuritySchemeId],
      );
      if (members.length > 0) {
        const seen = new Set();
        const result = [];
        for (const m of members) {
          const h = m.holder || {};
          const creationType = typeMap[h.type] || h.type.toLowerCase();
          const key = `${creationType}:${h.parameter || ""}`;
          if (!seen.has(key)) {
            seen.add(key);
            result.push({ type: creationType, parameter: h.parameter });
          }
        }
        return result;
      }
    }

    return [];
  }

  /**
   * Create a new issue security scheme with optional levels.
   * POST /rest/api/3/issuesecurityschemes
   * Returns { id: "schemeId" }
   */
  async createSecurityScheme(name, description, levels = []) {
    const body = { name, description: description || "" };
    if (levels.length > 0) {
      body.levels = levels.map((l) => ({
        name: l.name,
        description: l.description || "",
        isDefault: false,
      }));
    }
    const res = await this.makeRequest(
      "POST",
      "/rest/api/3/issuesecurityschemes",
      body,
    );
    return res; // { id: "..." }
  }

  /**
   * Associate a security scheme with a project. This is async — returns a task.
   * PUT /rest/api/3/issuesecurityschemes/project
   * Returns 303 with task progress (handled as redirect or response body).
   */
  async associateSchemeToProject(schemeId, projectId) {
    return this.makeRequest(
      "PUT",
      "/rest/api/3/issuesecurityschemes/project",
      {
        schemeId: String(schemeId),
        projectId: String(projectId),
      },
    );
  }

  /**
   * Poll a task until it completes or fails.
   * GET /rest/api/3/task/{taskId}
   */
  async waitForTask(taskId, maxWaitMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/task/${encodeURIComponent(taskId)}`,
      );
      if (res.status === "COMPLETE" || res.status === "DONE") return res;
      if (res.status === "FAILED" || res.status === "CANCEL_REQUESTED" || res.status === "CANCELLED") {
        throw new Error(`Task ${taskId} failed: ${res.status} - ${JSON.stringify(res.result || res.error || "")}`);
      }
      // Wait 2s between polls
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Task ${taskId} did not complete within ${maxWaitMs / 1000}s`);
  }

  // ─────────────────────────────────────────────────
  //  SEARCH HELPERS
  // ─────────────────────────────────────────────────

  async searchCount(jql) {
    const encoded = encodeURIComponent(jql);
    try {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/search/jql?jql=${encoded}&maxResults=0`,
      );
      return res.total || 0;
    } catch (err) {
      if (err.statusCode === 400) return 0;
      throw err;
    }
  }

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
  //  PROJECT LOOKUP
  // ─────────────────────────────────────────────────

  async getProjectByKey(projectKey) {
    if (this._projectCache.has(projectKey)) {
      return this._projectCache.get(projectKey);
    }

    try {
      const project = await this.makeRequest(
        "GET",
        `/rest/api/3/project/${encodeURIComponent(projectKey)}`,
      );
      const entry = { id: String(project.id), key: project.key, name: project.name };
      this._projectCache.set(projectKey, entry);
      return entry;
    } catch (error) {
      if (error.statusCode === 404) {
        this._projectCache.set(projectKey, null);
        return null;
      }
      throw error;
    }
  }

  // ─────────────────────────────────────────────────
  //  ISSUE SEARCH & UPDATE
  // ─────────────────────────────────────────────────

  async searchIssuesByKeys(issueKeys) {
    const results = new Map();
    if (!issueKeys || issueKeys.length === 0) return results;

    const batchSize = 50;
    const totalBatches = Math.ceil(issueKeys.length / batchSize);

    for (let i = 0; i < issueKeys.length; i += batchSize) {
      const batchNum = Math.floor(i / batchSize) + 1;
      const batch = issueKeys.slice(i, i + batchSize);
      console.log(
        `  [Cloud] Fetching issue batch ${batchNum}/${totalBatches} (${batch.length} issues)`,
      );

      const jql = `key IN (${batch.join(",")})`;
      const encoded = encodeURIComponent(jql);

      let startAt = 0;
      const maxResults = 100;

      while (true) {
        try {
          const response = await this.makeRequest(
            "GET",
            `/rest/api/3/search/jql?jql=${encoded}&startAt=${startAt}&maxResults=${maxResults}&fields=security`,
          );

          const issues = response.issues || [];
          for (const issue of issues) {
            const security = issue.fields?.security;
            results.set(issue.key, {
              securityLevelId: security ? String(security.id) : null,
              securityLevelName: security ? security.name : null,
            });
          }

          const total = response.total || 0;
          if (startAt + issues.length >= total || issues.length === 0) break;
          startAt += issues.length;
        } catch (error) {
          console.error(
            `  [Cloud] Batch search failed: ${error.message}`,
          );
          break;
        }
      }
    }

    return results;
  }

  async updateIssue(issueKey, payload) {
    try {
      await this.makeRequest("PUT", `/rest/api/3/issue/${issueKey}`, payload);
      return { success: true, error: null, isRateLimit: false };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        isRateLimit: error.isRateLimit || false,
      };
    }
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

  getStats() {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      rateLimitCount: this.rateLimitCount,
    };
  }
}

module.exports = CloudJiraClient;
