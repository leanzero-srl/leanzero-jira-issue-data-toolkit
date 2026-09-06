// Extends the proven sync_issue_links Cloud client (retrying makeRequest,
// searchIssues, updateIssue -> PUT /issue/{key}?notifyUsers=false, searchUsers,
// notification-scheme methods) with the custom-field read methods this script
// needs: the global field catalog, per-issue editmeta, and the full field
// payload of an issue.
const Base = require("../../sync_issue_links/src/cloudJiraClient");

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

  /** Token owner — used by notify-test. */
  async getCurrentUser() {
    return this.makeRequest("GET", "/rest/api/3/myself");
  }

  /**
   * Available transitions FROM the issue's current status, with their target
   * status and (expanded) screen fields. Returns the transitions array.
   */
  async getTransitions(issueKey) {
    const res = await this.makeRequest(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions?expand=transitions.fields`,
    );
    return (res && res.transitions) || [];
  }

  /**
   * Perform a transition. `fields` (optional) are applied on the transition
   * screen (e.g. resolution). notifyUsers=false suppresses the actor email;
   * the NotificationMuter still handles watcher "Issue Updated" emails.
   * Mirrors updateIssue()'s result envelope.
   */
  async transitionIssue(issueKey, transitionId, fields = null) {
    const payload = { transition: { id: String(transitionId) } };
    if (fields && Object.keys(fields).length) payload.fields = fields;
    try {
      await this.makeRequest(
        "POST",
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions?notifyUsers=false`,
        payload,
      );
      return { success: true, error: null, isRateLimit: false };
    } catch (error) {
      return { success: false, error: error.message, statusCode: error.statusCode || null, isRateLimit: error.isRateLimit || false };
    }
  }

  /**
   * Batch-fetch Cloud status + resolution for a list of issue keys
   * (`key in (...)` paged at 80). Returns Map<key, { status, resolution }>.
   */
  async getIssueStatuses(keys) {
    const out = new Map();
    for (let i = 0; i < keys.length; i += 80) {
      const batch = keys.slice(i, i + 80);
      const jql = encodeURIComponent(`key in (${batch.join(",")})`);
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/search/jql?jql=${jql}&fields=status,resolution&maxResults=100`,
      );
      for (const it of (res && res.issues) || []) {
        out.set(it.key, {
          status: it.fields?.status?.name || null,
          resolution: it.fields?.resolution?.name || null,
        });
      }
    }
    return out;
  }

  /** Current status name (+ resolution) of an issue. null on 404. */
  async getStatus(issueKey) {
    try {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=status,resolution`,
      );
      return {
        status: res.fields?.status?.name || null,
        resolution: res.fields?.resolution?.name || null,
      };
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }
  }
}

module.exports = CloudJiraClient;
