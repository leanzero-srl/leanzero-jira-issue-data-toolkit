// Extends ../../mend_comments/src/cloudJiraClient.js with:
//   - addCommentV3WithProps: POST /rest/api/3/issue/{key}/comment with body + properties[] + visibility
//   - findCommentByProperty:  scan existing Cloud comments for a property value (for idempotency)
//   - getCommentsWithProperties: GET /rest/api/3/issue/{key}/comment?expand=properties
//   - verifyAddCommentsPermission: check ADD_COMMENTS (the right permission for our POSTs;
//     mend_comments only needed EDIT_ISSUES because it edits existing comments)

const Base = require("../../mend_comments/src/cloudJiraClient");

const MIGRATION_TAG_KEY = "migration.dc_comment_id";
const JSM_PUBLIC_PROP_KEY = "sd.public.comment";
const FIDELITY_PROP_KEY = "migration.fidelity";
// When a DC comment is too large for Cloud's 32,767-char ADF body cap it is
// split into multiple sequential Cloud comments (B → B1, B2, B3). Every part
// carries the SAME migration.dc_comment_id plus these two part markers so a
// re-run can tell a fully-applied split from a partially-applied one.
const PART_INDEX_PROP_KEY = "migration.part_index"; // 1-based
const PART_TOTAL_PROP_KEY = "migration.part_total";

class CloudJiraClient extends Base {
  /**
   * POST a brand-new Cloud comment with optional properties and visibility.
   *
   * Cloud REST API v3 accepts a `properties: [{key, value}, ...]` array on the
   * POST body. We use it to attach:
   *   - sd.public.comment (JSM internal/public flag)
   *   - migration.dc_comment_id (our idempotency tag)
   *   - migration.fidelity (when the body had to fall back to plaintext)
   *
   * `visibility` is an optional classic Jira role/group restriction:
   *   { type: "role" | "group", value: "<name>" }     // legacy form
   *   { type: "role" | "group", identifier: "<id>" }  // newer form
   * Passed through untouched when DC reported one.
   *
   * NOTE: POST /comment does NOT honor `notifyUsers` per the Atlassian OpenAPI
   * spec — the caller must rely on NotificationMuter to suppress emails.
   */
  async addCommentV3WithProps(issueKey, adfBody, { properties = [], visibility = null } = {}) {
    const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`;
    const payload = { body: adfBody };
    if (Array.isArray(properties) && properties.length > 0) {
      payload.properties = properties;
    }
    if (visibility && typeof visibility === "object") {
      payload.visibility = visibility;
    }
    return this.makeRequest("POST", path, payload);
  }

  /**
   * Fetch every comment on an issue WITH their properties inlined.
   * GET /rest/api/3/issue/{key}/comment?expand=properties
   * Returns the same shape as getComments() plus a `properties: [...]` array
   * on each entry.
   */
  async getCommentsWithProperties(issueKey) {
    const out = [];
    let startAt = 0;
    const maxResults = 100;
    while (true) {
      const path =
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment` +
        `?startAt=${startAt}&maxResults=${maxResults}&orderBy=created&expand=properties`;
      const res = await this.makeRequest("GET", path);
      const batch = res?.comments || [];
      out.push(...batch);
      const total = typeof res?.total === "number" ? res.total : null;
      if (batch.length < maxResults) break;
      if (total !== null && startAt + batch.length >= total) break;
      startAt += batch.length;
      if (startAt > 100000) break;
    }
    out.sort((a, b) => {
      const ta = a.created ? Date.parse(a.created) : 0;
      const tb = b.created ? Date.parse(b.created) : 0;
      if (ta !== tb) return ta - tb;
      // Same-millisecond tie (fast sequential POSTs, e.g. split comment parts):
      // fall back to the monotonic Cloud comment id so insertion order — and
      // thus the B1, B2, B3 chain — is preserved.
      const ia = Number(a.id);
      const ib = Number(b.id);
      if (Number.isFinite(ia) && Number.isFinite(ib)) return ia - ib;
      return 0;
    });
    return out;
  }

  /**
   * PUT a single comment property. Body of the request IS the value itself
   * (per the Atlassian REST v3 spec for /rest/api/3/comment/{id}/properties/{key}).
   * Returns null on success (204).
   *
   * Required because POST /comment with inline `properties: [...]` is rejected
   * by JSM's property validator on this tenant ("not a valid JSON" for the
   * sd.public.comment shape). The two-step POST-then-PUT-property path works.
   */
  async setCommentProperty(commentId, key, value) {
    const path =
      `/rest/api/3/comment/${encodeURIComponent(commentId)}` +
      `/properties/${encodeURIComponent(key)}`;
    return this.makeRequest("PUT", path, value);
  }

  /**
   * Cloud-side preflight: does the token have ADD_COMMENTS on this project?
   * Cached per project. POST /comment requires ADD_COMMENTS (not EDIT_ISSUES,
   * which is what mend_comments preflights for its PUT path).
   */
  async verifyAddCommentsPermission(projectKey) {
    const path =
      `/rest/api/3/mypermissions?projectKey=${encodeURIComponent(projectKey)}` +
      `&permissions=ADD_COMMENTS`;
    try {
      const res = await this.makeRequest("GET", path);
      const perms = res?.permissions || {};
      return !!(perms.ADD_COMMENTS && perms.ADD_COMMENTS.havePermission);
    } catch {
      return false;
    }
  }

  /**
   * Returns the set of DC comment ids that are already represented in Cloud
   * via the `migration.dc_comment_id` property tag. Pulled in one batch
   * with `?expand=properties`. Returns a Set<string>.
   */
  static collectMigrationTags(cloudCommentsWithProps) {
    const tagged = new Set();
    if (!Array.isArray(cloudCommentsWithProps)) return tagged;
    for (const c of cloudCommentsWithProps) {
      const props = Array.isArray(c.properties) ? c.properties : [];
      for (const p of props) {
        if (p && p.key === MIGRATION_TAG_KEY && p.value != null) {
          tagged.add(String(p.value));
          break;
        }
      }
    }
    return tagged;
  }
}

module.exports = CloudJiraClient;
module.exports.MIGRATION_TAG_KEY = MIGRATION_TAG_KEY;
module.exports.JSM_PUBLIC_PROP_KEY = JSM_PUBLIC_PROP_KEY;
module.exports.FIDELITY_PROP_KEY = FIDELITY_PROP_KEY;
module.exports.PART_INDEX_PROP_KEY = PART_INDEX_PROP_KEY;
module.exports.PART_TOTAL_PROP_KEY = PART_TOTAL_PROP_KEY;
