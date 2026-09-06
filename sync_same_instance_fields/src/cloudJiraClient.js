/**
 * Same-instance Cloud client — extends the shared sync_issue_links base client
 * with the read methods needed for field sync: global field catalog, editmeta,
 * per-issue field reads, and single-field reads.
 */
const Base = require("./baseCloudJiraClient");

class CloudJiraClient extends Base {
  /**
   * Global custom-field catalog. Returns the raw /field array:
   *   [{ id, name, custom, schema:{ type, custom, items, customId } }, ...]
   */
  async getFields() {
    const res = await this.makeRequest("GET", "/rest/api/3/field");
    return Array.isArray(res) ? res : [];
  }

  /**
   * Edit metadata for an issue — the authoritative set of fields that are
   * writable on this issue's edit screen for its project+issuetype. Each entry:
   *   { required, schema:{type,custom,items}, name, operations:[...], allowedValues? }
   * Returns the `fields` object ({} on 404).
   */
  async getEditMeta(issueKey) {
    try {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/editmeta`,
      );
      return res?.fields || {};
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }
  }

  /**
   * Full field payload of an issue plus the id->displayName map.
   * Returns { key, fields, names } or null on 404.
   */
  async getIssueFields(issueKey, fields = "*all") {
    try {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${fields}&expand=names`,
      );
      return { key: res.key || issueKey, fields: res.fields || {}, names: res.names || {} };
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }
  }

  /** Fetch a single custom field's current value (used by recheck-before-apply). */
  async getIssueFieldValue(issueKey, fieldId) {
    const res = await this.makeRequest(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(fieldId)}`,
    );
    return res?.fields ? res.fields[fieldId] : undefined;
  }
}

module.exports = CloudJiraClient;
