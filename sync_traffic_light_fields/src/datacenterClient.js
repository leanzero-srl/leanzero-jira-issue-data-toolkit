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

  /**
   * Make an HTTP request to the Datacenter Jira API.
   * Uses separate counters for rate limit vs server error/network retries.
   */
  makeRequest(method, path, body = null, retryState = null) {
    const state = retryState || {
      rateLimitAttempts: 0,
      serverErrorAttempts: 0,
    };
    const maxRateLimitRetries = 5;
    const maxServerRetries = 3;

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
              10000,
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

  /**
   * Test connection to Datacenter
   */
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
   * Fetch all custom fields from Datacenter
   */
  async fetchCustomFields() {
    const response = await this.makeRequest(
      "GET",
      "/rest/api/2/customFields?maxResults=2000",
    );

    // Handle both response formats: {values: [...]} or [...]
    const allFields = response.values || response;
    if (!Array.isArray(allFields)) {
      throw new Error("Unexpected custom fields response format");
    }

    return allFields.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type || "",
    }));
  }

  /**
   * Filter custom fields to only CMDB/Asset fields
   */
  filterCmdbFields(allFields) {
    return allFields.filter((field) => /insight|assets|cmdb/i.test(field.type));
  }

  /**
   * Search for all tickets where a given custom field is not empty.
   * Calls onPage(tickets) for each page of results for streaming processing.
   * If onPage returns false, pagination stops immediately.
   *
   * @param {string} fieldId - e.g. "customfield_12345"
   * @param {Function} onPage - async callback receiving array of {key, id, fieldValue}. Return false to stop.
   * @returns {number} total tickets found
   */
  async searchTicketsForField(fieldId, onPage) {
    const fieldNumber = fieldId.replace("customfield_", "");
    const jql = `cf[${fieldNumber}] is not EMPTY`;
    const encodedJql = encodeURIComponent(jql);

    let startAt = 0;
    const maxResults = 100;
    let totalFound = 0;

    while (true) {
      const path = `/rest/api/2/search?jql=${encodedJql}&startAt=${startAt}&maxResults=${maxResults}&fields=${fieldId},key`;

      let response;
      try {
        response = await this.makeRequest("GET", path);
      } catch (error) {
        // Field might be unused or restricted
        if (error.statusCode === 400) {
          return 0;
        }
        throw error;
      }

      const issues = response.issues || [];
      const total = response.total || 0;

      if (issues.length === 0) break;

      // Extract ticket data
      const tickets = [];
      for (const issue of issues) {
        const fieldValue = issue.fields?.[fieldId];
        if (fieldValue != null) {
          tickets.push({
            key: issue.key,
            id: issue.id,
            fieldValue,
          });
        }
      }

      if (tickets.length > 0) {
        const result = await onPage(tickets);
        totalFound += tickets.length;
        // Stop pagination if callback returns false
        if (result === false) break;
      }

      startAt += issues.length;

      if (startAt >= total) break;

      // Safety limit
      if (startAt > 500000) {
        console.log(
          `  [DC] WARNING: Reached pagination safety limit for field ${fieldId}`,
        );
        break;
      }
    }

    return totalFound;
  }

  getStats() {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
    };
  }
}

module.exports = DatacenterClient;
