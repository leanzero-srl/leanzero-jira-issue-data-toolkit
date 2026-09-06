const https = require("https");
const http = require("http");
const fs = require("fs");
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
   * Return the DC issue's attachment list. Each item carries the absolute
   * `content` URL needed for the binary download.
   *   { key, attachments: [{ id, filename, mimeType, size, created,
   *                          author: {name, displayName}, content }] }
   * or, on 404/403:
   *   { key, error }
   */
  async getIssueAttachments(issueKey) {
    const path = `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=attachment`;
    let res;
    try {
      res = await this.makeRequest("GET", path);
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 403) {
        return {
          key: issueKey,
          error: `DC issue not accessible (HTTP ${error.statusCode})`,
        };
      }
      return { key: issueKey, error: error.message };
    }

    const raw = res.fields?.attachment || [];
    const attachments = raw.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType || null,
      size: typeof a.size === "number" ? a.size : null,
      created: a.created || null,
      author: a.author
        ? { name: a.author.name || null, displayName: a.author.displayName || null }
        : null,
      content: a.content, // absolute URL — must be parsed before download
    }));

    return { key: res.key || issueKey, attachments };
  }

  /**
   * Download an absolute attachment URL into destPath. Reuses Basic auth.
   * Follows 302/303/307 redirects up to maxRedirects hops (signed-URL pattern).
   * Applies the same 429 / 5xx / timeout retry policy as makeRequest.
   *
   * Returns { bytesWritten, mimeType }.
   */
  downloadAttachmentToFile(downloadUrl, destPath, retryState = null) {
    const state = retryState || {
      rateLimitAttempts: 0,
      serverErrorAttempts: 0,
      redirects: 0,
    };
    const maxRateLimitRetries = 5;
    const maxServerRetries = 5;
    const maxRedirects = 5;

    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(downloadUrl);
      } catch (e) {
        reject(new Error(`Invalid attachment URL: ${downloadUrl}`));
        return;
      }
      const proto = parsed.protocol === "https:" ? https : http;
      const port =
        parsed.port || (parsed.protocol === "https:" ? 443 : 80);

      const options = {
        hostname: parsed.hostname,
        port,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          Authorization: this.authHeader,
          Accept: "*/*",
        },
        timeout: 120000, // attachments can be slow
      };

      const retry = (newState) =>
        this.downloadAttachmentToFile(downloadUrl, destPath, newState)
          .then(resolve)
          .catch(reject);

      const req = proto.request(options, (res) => {
        // Follow redirects (Jira often hands a signed location)
        if (
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location
        ) {
          res.resume();
          if (state.redirects >= maxRedirects) {
            reject(
              new Error(
                `Too many redirects (>${maxRedirects}) for ${downloadUrl}`,
              ),
            );
            return;
          }
          const next = new URL(res.headers.location, downloadUrl).toString();
          this.downloadAttachmentToFile(next, destPath, {
            ...state,
            redirects: state.redirects + 1,
          })
            .then(resolve)
            .catch(reject);
          return;
        }

        if (res.statusCode === 429) {
          res.resume();
          if (state.rateLimitAttempts >= maxRateLimitRetries) {
            const err = new Error(
              `DC attachment download 429 after ${maxRateLimitRetries} retries: ${downloadUrl}`,
            );
            err.statusCode = 429;
            err.isRateLimit = true;
            reject(err);
            return;
          }
          const retryAfter = res.headers["retry-after"];
          const delay = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : Math.min(5000 * Math.pow(2, state.rateLimitAttempts), 120000);
          console.log(
            `  [DC dl] 429, retrying in ${delay / 1000}s (attempt ${state.rateLimitAttempts + 1}/${maxRateLimitRetries})`,
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
          res.resume();
          const delay = Math.min(
            1000 * Math.pow(2, state.serverErrorAttempts),
            30000,
          );
          console.log(
            `  [DC dl] ${res.statusCode}, retrying in ${delay / 1000}s`,
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
          res.resume();
          const err = new Error(
            `DC attachment download ${res.statusCode} for ${downloadUrl}`,
          );
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }

        // 2xx — stream to disk
        const out = fs.createWriteStream(destPath);
        let bytesWritten = 0;
        const mimeType = res.headers["content-type"] || null;

        res.on("data", (chunk) => {
          bytesWritten += chunk.length;
        });
        res.pipe(out);
        out.on("finish", () => {
          this.requestCount++;
          resolve({ bytesWritten, mimeType });
        });
        out.on("error", (err) => {
          this.errorCount++;
          try {
            fs.unlinkSync(destPath);
          } catch {
            /* ignore */
          }
          reject(err);
        });
      });

      req.on("error", (err) => {
        this.errorCount++;
        if (state.serverErrorAttempts < maxServerRetries) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          console.log(
            `  [DC dl] Connection error: ${err.message}, retrying in ${delay / 1000}s`,
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
          console.log(`  [DC dl] timeout, retrying in ${delay / 1000}s`);
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
        reject(
          new Error(`DC attachment download timeout: ${downloadUrl}`),
        );
      });

      req.end();
    });
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
