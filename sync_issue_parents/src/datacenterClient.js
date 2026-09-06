const https = require("https");
const http = require("http");
const { URL } = require("url");

class DatacenterClient {
  constructor(baseUrl, username, password) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const parsed = new URL(this.baseUrl);
    this.protocol = parsed.protocol === "https:" ? https : http;
    this.hostname = parsed.hostname;
    this.port = parsed.port || (parsed.protocol === "https:" ? 443 : 80);
    this.basePath = parsed.pathname.replace(/\/$/, "");
    this.authHeader =
      "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
    this.requestCount = 0;
    this.errorCount = 0;
  }

  makeRequest(method, path, body = null, retryState = null) {
    const state = retryState || {
      rateLimitAttempts: 0,
      serverErrorAttempts: 0,
    };
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

      const req = this.protocol.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          this.requestCount++;

          if (
            res.statusCode === 429 &&
            state.rateLimitAttempts < maxRateLimitRetries
          ) {
            const retryAfter = res.headers["retry-after"];
            const delay = retryAfter
              ? parseInt(retryAfter, 10) * 1000
              : Math.min(5000 * Math.pow(2, state.rateLimitAttempts), 120000);
            console.log(
              `  [DC] Rate limited (429), retrying in ${delay / 1000}s (attempt ${state.rateLimitAttempts + 1}/${maxRateLimitRetries})`,
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
              30000,
            );
            console.log(
              `  [DC] Server error (${res.statusCode}), retrying in ${delay / 1000}s (attempt ${state.serverErrorAttempts + 1}/${maxServerRetries})`,
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
              `DC API ${method} ${path} returned ${res.statusCode}: ${data.substring(0, 500)}`,
            );
            error.statusCode = res.statusCode;
            reject(error);
            return;
          }

          try {
            resolve(JSON.parse(data));
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
          console.log(`  [DC] Request timeout, retrying in ${delay / 1000}s`);
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
      await this.makeRequest("GET", "/rest/api/2/serverInfo");
      return true;
    } catch (error) {
      console.error(`  [DC] Connection test failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Discover the actual custom field ids that store parent-like relations on
   * this DC instance. Field numbering varies by deployment, so we match by the
   * canonical schema "custom" identifiers:
   *   - com.pyxis.greenhopper.jira:gh-epic-link        → Epic Link (Story → Epic)
   *   - com.atlassian.jpo:jpo-custom-field-parent      → Parent Link (Epic → Initiative, Advanced Roadmaps)
   *
   * Returns { epicLinkFieldId, parentLinkFieldId } — values may be null if a
   * field is not installed on the instance.
   */
  async discoverParentFieldIds() {
    const fields = await this.makeRequest("GET", "/rest/api/2/field");
    let epicLinkFieldId = null;
    let parentLinkFieldId = null;
    for (const f of fields) {
      const custom = f.schema?.custom;
      if (custom === "com.pyxis.greenhopper.jira:gh-epic-link") {
        epicLinkFieldId = f.id;
      } else if (custom === "com.atlassian.jpo:jpo-custom-field-parent") {
        parentLinkFieldId = f.id;
      }
    }
    return { epicLinkFieldId, parentLinkFieldId };
  }

  /**
   * Fetch a DC issue and return a normalized parent descriptor.
   *
   * Resolution priority:
   *   1. fields.parent.key          — sub-task parent or generic next-gen parent
   *   2. fields[epicLinkFieldId]    — Epic Link (Story → Epic, classic projects)
   *   3. fields[parentLinkFieldId]  — Parent Link (Epic → Initiative, Advanced Roadmaps)
   *
   * Returns:
   *   { key, issueType, isSubtask, parentKey, parentSource, rawParent, rawEpicLink, rawParentLink }
   * or on 404/403:
   *   { key, error: "..." }
   */
  async getIssueParentInfo(issueKey, opts = {}) {
    const epicLinkFieldId = opts.epicLinkFieldId || null;
    const parentLinkFieldId = opts.parentLinkFieldId || null;

    const fieldList = ["parent", "issuetype"];
    if (epicLinkFieldId) fieldList.push(epicLinkFieldId);
    if (parentLinkFieldId) fieldList.push(parentLinkFieldId);

    const path = `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=${fieldList.join(",")}`;

    let res;
    try {
      res = await this.makeRequest("GET", path);
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 403) {
        return { key: issueKey, error: `DC issue not accessible (HTTP ${error.statusCode})` };
      }
      return { key: issueKey, error: error.message };
    }

    const fields = res.fields || {};
    const rawParent = fields.parent || null;
    const rawEpicLink = epicLinkFieldId ? fields[epicLinkFieldId] || null : null;
    const rawParentLink = parentLinkFieldId ? fields[parentLinkFieldId] || null : null;

    let parentKey = null;
    let parentSource = null;

    if (rawParent && rawParent.key) {
      parentKey = rawParent.key;
      parentSource = "fields.parent";
    } else if (rawEpicLink) {
      // Epic Link is usually a string ("PROJ-123") but defensively support
      // object shapes (e.g. { key: "PROJ-123" }).
      if (typeof rawEpicLink === "string") {
        parentKey = rawEpicLink;
      } else if (rawEpicLink.key) {
        parentKey = rawEpicLink.key;
      }
      if (parentKey) parentSource = epicLinkFieldId;
    } else if (rawParentLink) {
      // Parent Link / JPO shapes seen in the wild: string key, { key }, or { data: { key } }.
      if (typeof rawParentLink === "string") {
        parentKey = rawParentLink;
      } else if (rawParentLink.key) {
        parentKey = rawParentLink.key;
      } else if (rawParentLink.data?.key) {
        parentKey = rawParentLink.data.key;
      }
      if (parentKey) parentSource = parentLinkFieldId;
    }

    return {
      key: res.key || issueKey,
      issueType: fields.issuetype?.name || null,
      isSubtask: !!fields.issuetype?.subtask,
      parentKey,
      parentSource,
      rawParent,
      rawEpicLink,
      rawParentLink,
    };
  }

  /**
   * Fetch a DC issue's reporter. DC returns the Server-style user object:
   *   { name, key, emailAddress, displayName, active, avatarUrls, ... }
   * Returns { key, reporter: { name, key, emailAddress, displayName } | null }
   * or { key, error } on 404/403/other failure.
   */
  async getIssueReporter(issueKey) {
    const path = `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=reporter`;
    let res;
    try {
      res = await this.makeRequest("GET", path);
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 403) {
        return { key: issueKey, error: `DC issue not accessible (HTTP ${error.statusCode})` };
      }
      return { key: issueKey, error: error.message };
    }
    const r = res.fields?.reporter || null;
    if (!r) return { key: res.key || issueKey, reporter: null };
    return {
      key: res.key || issueKey,
      reporter: {
        name: r.name || null,
        key: r.key || null,
        emailAddress: r.emailAddress || null,
        displayName: r.displayName || null,
      },
    };
  }

  /**
   * Fetch a DC issue's assignee. DC returns the Server-style user object:
   *   { name, key, emailAddress, displayName, active, avatarUrls, ... }
   * Returns { key, assignee: { name, key, emailAddress, displayName } | null }
   * or { key, error } on 404/403/other failure. A null assignee means the DC
   * issue was Unassigned (a normal, non-error state).
   */
  async getIssueAssignee(issueKey) {
    const path = `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=assignee`;
    let res;
    try {
      res = await this.makeRequest("GET", path);
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 403) {
        return { key: issueKey, error: `DC issue not accessible (HTTP ${error.statusCode})` };
      }
      return { key: issueKey, error: error.message };
    }
    const a = res.fields?.assignee || null;
    if (!a) return { key: res.key || issueKey, assignee: null };
    return {
      key: res.key || issueKey,
      assignee: {
        name: a.name || null,
        key: a.key || null,
        emailAddress: a.emailAddress || null,
        displayName: a.displayName || null,
      },
    };
  }

  /**
   * Paginated DC JQL search. Calls onPage(issues) for each page; stop by
   * returning false from onPage.
   */
  async searchByJql(jql, fieldsParam, onPage) {
    let startAt = 0;
    const maxResults = 100;
    let total = 0;
    while (true) {
      const path = `/rest/api/2/search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${maxResults}&fields=${fieldsParam}`;
      let res;
      try {
        res = await this.makeRequest("GET", path);
      } catch (e) {
        if (e.statusCode === 400) return total;
        throw e;
      }
      const issues = res.issues || [];
      if (issues.length === 0) break;
      const cont = await onPage(issues);
      total += issues.length;
      if (cont === false) break;
      startAt += issues.length;
      if (startAt >= (res.total || 0)) break;
      if (startAt > 500000) break;
    }
    return total;
  }

  getStats() {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
    };
  }
}

module.exports = DatacenterClient;
