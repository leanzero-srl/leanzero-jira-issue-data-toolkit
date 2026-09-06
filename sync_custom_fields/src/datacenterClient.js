// Extends the proven mend_comments DC client (retrying makeRequest, getUser,
// REST v2) with the custom-field read methods this script needs: the global
// field catalog and an issue's full field payload + rendered (HTML) bodies.
const Base = require("../../mend_comments/src/datacenterClient");

class DatacenterClient extends Base {
  /**
   * Global custom-field catalog (REST v2). Same shape as Cloud's /field:
   *   [{ id, name, custom, schema:{ type, custom, items, customId } }, ...]
   */
  async getFields() {
    const res = await this.makeRequest("GET", "/rest/api/2/field");
    return Array.isArray(res) ? res : [];
  }

  /**
   * Full field payload of a DC issue plus rendered (HTML) field bodies and the
   * id->displayName map. `renderedFields` carries the wiki-rendered HTML for
   * rich-text fields, which the textarea->ADF handler prefers over raw storage.
   * Returns { key, fields, renderedFields, names } or null on 404.
   */
  async getIssueFields(issueKey, fields = "*all") {
    try {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=${fields}&expand=renderedFields,names`,
      );
      return {
        key: res.key || issueKey,
        fields: res.fields || {},
        renderedFields: res.renderedFields || {},
        names: res.names || {},
      };
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }
  }

  /**
   * Batch-fetch DC status + resolution for a list of issue keys (REST v2 search,
   * `key in (...)` paged at 80). Returns Map<key, { status, resolution }>.
   */
  async getIssueStatuses(keys) {
    const out = new Map();
    for (let i = 0; i < keys.length; i += 80) {
      const batch = keys.slice(i, i + 80);
      const jql = encodeURIComponent(`key in (${batch.join(",")})`);
      const res = await this.makeRequest(
        "GET",
        `/rest/api/2/search?jql=${jql}&fields=status,resolution&maxResults=100`,
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
}

module.exports = DatacenterClient;
