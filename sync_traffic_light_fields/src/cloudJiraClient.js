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
    this.screenFixCount = 0;

    // Cache: "projectId:issueTypeId" -> { screenId, tabId }
    this._screenCache = new Map();
    // Cache: "projectKey" -> projectId
    this._projectIdCache = new Map();
    // Cache: screenId -> already-added field IDs (to avoid duplicate adds)
    this._screenFieldsAdded = new Map();
  }

  /**
   * Make an HTTPS request to the Cloud Jira REST API.
   * Uses separate counters for rate limit vs server error/network retries.
   */
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

          // Rate limit handling with exponential backoff
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

          // Server errors with retry
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

          // 204 No Content (successful update with no body)
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
   * Test connection to Cloud Jira
   */
  async testConnection() {
    try {
      await this.makeRequest("GET", "/rest/api/3/serverInfo");
      return true;
    } catch (error) {
      console.error(`  [Cloud Jira] Connection test failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Fetch all custom fields from Cloud Jira (paginated)
   */
  async fetchCustomFields() {
    const allFields = [];
    let startAt = 0;
    const maxResults = 100;

    while (true) {
      const response = await this.makeRequest(
        "GET",
        `/rest/api/3/field/search?type=custom&startAt=${startAt}&maxResults=${maxResults}&expand=key`,
      );

      const values = response.values || [];
      allFields.push(...values);

      if (response.isLast || values.length === 0) break;
      startAt += values.length;
    }

    return allFields;
  }

  /**
   * Batch-fetch field values for multiple issues using JQL key IN (...).
   *
   * @param {string[]} issueKeys - Array of issue keys
   * @param {string[]} fieldIds - field IDs to retrieve
   * @returns {Map<string, object>} - Map of issueKey -> fields object
   */
  async searchIssuesByKeys(issueKeys, fieldIds) {
    const results = new Map();
    if (!issueKeys || issueKeys.length === 0) return results;

    const fields = fieldIds.join(",");
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
            `/rest/api/3/search/jql?jql=${encoded}&startAt=${startAt}&maxResults=${maxResults}&fields=${fields}`,
          );

          const issues = response.issues || [];
          for (const issue of issues) {
            results.set(issue.key, issue.fields || {});
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

  /**
   * Update an issue's custom fields
   * @returns {{success: boolean, error: string|null, isRateLimit: boolean}}
   */
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

  /**
   * Update multiple issues concurrently with a semaphore.
   * @param {{issueKey: string, payload: object}[]} updates - Array of updates
   * @param {number} concurrency - Max parallel requests
   * @returns {Map<string, {success: boolean, error: string|null}>}
   */
  async updateIssuesBatch(updates, concurrency = 10) {
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
  //  SCREEN AUTO-FIX: Add field to correct screen
  // ─────────────────────────────────────────────────

  /**
   * Check if an error is a "field not on screen" error.
   * Returns the field ID if it is, null otherwise.
   */
  parseScreenError(errorMessage) {
    if (!errorMessage) return null;
    const match = errorMessage.match(/Field '(customfield_\d+)' cannot be set\. It is not on the appropriate screen/);
    return match ? match[1] : null;
  }

  /**
   * Add a field to the edit screen for a given issue's project+type.
   * Caches screen lookups so repeated calls for the same project+type are fast.
   *
   * @param {string} issueKey - e.g. "P1-653"
   * @param {string} fieldId - e.g. "customfield_11649"
   * @returns {{ success: boolean, error: string|null }}
   */
  async addFieldToScreen(issueKey, fieldId) {
    try {
      // Step 1: Get project ID and issue type ID from the issue
      const issue = await this.makeRequest("GET", `/rest/api/3/issue/${issueKey}?fields=project,issuetype`);
      const projectId = issue.fields?.project?.id;
      const issueTypeId = issue.fields?.issuetype?.id;

      if (!projectId || !issueTypeId) {
        return { success: false, error: `Could not get project/issue type for ${issueKey}` };
      }

      // Step 2: Resolve edit + view screen IDs + tab IDs (cached)
      const cacheKey = `${projectId}:${issueTypeId}`;
      let screenInfos = this._screenCache.get(cacheKey);

      if (!screenInfos) {
        screenInfos = await this._resolveEditScreen(projectId, issueTypeId);
        if (!screenInfos) {
          return { success: false, error: `Could not resolve screens for project ${projectId}, issueType ${issueTypeId}` };
        }
        this._screenCache.set(cacheKey, screenInfos);
      }

      // Step 3+4: Add field to each screen (edit + view)
      let anyAdded = false;
      let lastError = null;
      for (const screenInfo of screenInfos) {
        const screenFieldKey = `${screenInfo.screenId}:${fieldId}`;
        if (this._screenFieldsAdded.has(screenFieldKey)) {
          anyAdded = true;
          continue; // Already added in this run
        }

        try {
          await this.makeRequest(
            "POST",
            `/rest/api/3/screens/${screenInfo.screenId}/tabs/${screenInfo.tabId}/fields`,
            { fieldId },
          );
          this._screenFieldsAdded.set(screenFieldKey, true);
          this.screenFixCount++;
          console.log(`  [Screen Fix] Added ${fieldId} to screen ${screenInfo.screenId} tab ${screenInfo.tabId}`);
          anyAdded = true;
        } catch (addError) {
          // Field might already be on the screen (400 with "already")
          if (addError.statusCode === 400 && addError.message.includes("already")) {
            this._screenFieldsAdded.set(screenFieldKey, true);
            anyAdded = true;
          } else {
            lastError = addError.message;
          }
        }
      }

      if (anyAdded) {
        return { success: true, error: null };
      }
      return { success: false, error: `Failed to add field to any screen: ${lastError}` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Resolve the edit screen ID and first tab ID for a project + issue type.
   * Walks: project → issueTypeScreenScheme → screenScheme → edit screen → tab
   */
  async _resolveEditScreen(projectId, issueTypeId) {
    // 1. Get issue type screen scheme for this project
    const itssResponse = await this.makeRequest(
      "GET",
      `/rest/api/3/issuetypescreenscheme/project?projectId=${projectId}`,
    );

    const itssValues = itssResponse.values || [];
    if (itssValues.length === 0) return null;

    const issueTypeScreenSchemeId = itssValues[0].issueTypeScreenScheme?.id;
    if (!issueTypeScreenSchemeId) return null;

    // 2. Get mappings: issue type → screen scheme
    const mappingResponse = await this.makeRequest(
      "GET",
      `/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${issueTypeScreenSchemeId}&maxResults=200`,
    );

    const mappings = mappingResponse.values || [];

    // Find mapping for this issue type, fall back to "default"
    let screenSchemeId = null;
    for (const m of mappings) {
      if (m.issueTypeId === issueTypeId) {
        screenSchemeId = m.screenSchemeId;
        break;
      }
    }
    if (!screenSchemeId) {
      for (const m of mappings) {
        if (m.issueTypeId === "default") {
          screenSchemeId = m.screenSchemeId;
          break;
        }
      }
    }
    if (!screenSchemeId) return null;

    // 3. Get screen scheme → edit screen ID
    const ssResponse = await this.makeRequest(
      "GET",
      `/rest/api/3/screenscheme?id=${screenSchemeId}`,
    );

    const ssValues = ssResponse.values || [];
    if (ssValues.length === 0) return null;

    const screens = ssValues[0].screens || {};

    // Collect edit and view screen IDs (deduplicated)
    const seen = new Set();
    const screenIds = [];
    for (const sid of [screens.edit, screens.view, screens.default]) {
      if (sid && !seen.has(String(sid))) {
        seen.add(String(sid));
        screenIds.push(sid);
      }
    }
    if (screenIds.length === 0) return null;

    // 4. Get tabs for each screen (use first tab)
    const result = [];
    for (const sid of screenIds) {
      const tabsResponse = await this.makeRequest(
        "GET",
        `/rest/api/3/screens/${sid}/tabs`,
      );
      const tabs = Array.isArray(tabsResponse) ? tabsResponse : [];
      if (tabs.length > 0) {
        result.push({ screenId: Number(sid), tabId: tabs[0].id });
      }
    }

    return result.length > 0 ? result : null;
  }

  getStats() {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      rateLimitCount: this.rateLimitCount,
      screenFixCount: this.screenFixCount,
    };
  }
}

module.exports = CloudJiraClient;
