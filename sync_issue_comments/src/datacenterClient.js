// Extends ../../mend_comments/src/datacenterClient.js with comment visibility
// + properties support, plus a JSM Service Desk fallback for the public/internal
// flag when the comment property is missing.
//
// The base class is reused as-is (auth, retry, getUser, listProjects); we only
// override the two comment-fetch methods to also pull `?expand=properties` and
// to surface `visibility` (classic role/group) and `sdPublic` (JSM internal/public).

const Base = require("../../mend_comments/src/datacenterClient");

const JSM_PUBLIC_PROP_KEY = "sd.public.comment";

function pickComment(c, rfMap) {
  return {
    id: c.id,
    author: c.author
      ? { name: c.author.name || null, displayName: c.author.displayName || null }
      : null,
    created: c.created || null,
    updated: c.updated || null,
    storage: typeof c.body === "string" ? c.body : null,
    rendered:
      (rfMap && rfMap.get(String(c.id))) ||
      (typeof c.renderedBody === "string" ? c.renderedBody : null),
    visibility: c.visibility || null,
    properties: Array.isArray(c.properties) ? c.properties : null,
    sdPublic: extractSdPublic(c.properties),
  };
}

// JSM stores the customer-visible flag as a comment property:
//   { key: "sd.public.comment", value: { internal: true } }   ← internal
//   { key: "sd.public.comment", value: { internal: false } }  ← public to customer
// Some old/edge tenants invert it under "public:true|false" — we tolerate both.
function extractSdPublic(properties) {
  if (!Array.isArray(properties)) return null;
  for (const p of properties) {
    if (!p || p.key !== JSM_PUBLIC_PROP_KEY) continue;
    const v = p.value || {};
    if (typeof v.internal === "boolean") {
      return { internal: v.internal, source: "property:sd.public.comment.internal" };
    }
    if (typeof v.public === "boolean") {
      return { internal: !v.public, source: "property:sd.public.comment.public" };
    }
  }
  return null;
}

class DatacenterClient extends Base {
  /**
   * Preferred entrypoint for sync_issue_comments. Always uses the paginated
   * /comment endpoint with `expand=renderedBody,properties` because DC's
   * issue-level endpoint does NOT honor `comment.properties` nested expand —
   * relying on it would silently strip the JSM `sd.public.comment` property
   * from every comment.
   *
   * Returns the same per-comment shape as the methods below
   * (id, author, created, updated, storage, rendered, visibility, properties,
   *  sdPublic).
   */
  async getCommentsWithVisibility(issueKey) {
    return this.getCommentsPaginated(issueKey);
  }

  /**
   * Same shape as the base method but also asks for `properties` and surfaces
   * `visibility`, `properties[]`, and a derived `sdPublic = {internal, source}`.
   *
   * NOTE: DC's issue-level `?expand=...,comment.properties` is inconsistent
   * across DC versions; properties may not actually come back here. Use
   * `getCommentsWithVisibility(issueKey)` when you need visibility data —
   * it always hits the per-comment endpoint which DOES support properties.
   */
  async getIssueWithRenderedBodies(issueKey) {
    const path =
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}` +
      `?fields=description,comment&expand=renderedFields,names,comment.properties`;
    const res = await this.makeRequest("GET", path);

    const fields = res?.fields || {};
    const rf = res?.renderedFields || {};

    const description = {
      storage: typeof fields.description === "string" ? fields.description : null,
      rendered: typeof rf.description === "string" ? rf.description : null,
    };

    const storageComments = Array.isArray(fields.comment?.comments)
      ? fields.comment.comments
      : [];
    const renderedComments = Array.isArray(rf.comment?.comments)
      ? rf.comment.comments
      : Array.isArray(rf.comment)
      ? rf.comment
      : [];
    const renderedById = new Map();
    for (const rc of renderedComments) {
      if (rc && rc.id) renderedById.set(String(rc.id), rc.body);
    }

    const comments = storageComments.map((c) => pickComment(c, renderedById));

    return {
      key: res?.key || issueKey,
      description,
      commentTotal:
        typeof fields.comment?.total === "number"
          ? fields.comment.total
          : storageComments.length,
      comments,
    };
  }

  /**
   * Fallback paginated comment fetch. Surfaces the same fields as the inline
   * variant. Requests `?expand=renderedBody,properties`.
   */
  async getCommentsPaginated(issueKey) {
    const out = [];
    let startAt = 0;
    const maxResults = 100;
    while (true) {
      const path =
        `/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment` +
        `?startAt=${startAt}&maxResults=${maxResults}` +
        `&expand=renderedBody,properties&orderBy=created`;
      const res = await this.makeRequest("GET", path);
      const batch = Array.isArray(res?.comments) ? res.comments : [];
      for (const c of batch) {
        out.push(pickComment(c, null));
      }
      const total = typeof res?.total === "number" ? res.total : null;
      if (batch.length < maxResults) break;
      if (total !== null && startAt + batch.length >= total) break;
      startAt += batch.length;
      if (startAt > 100000) break;
    }
    out.sort((a, b) => {
      const ta = a.created ? Date.parse(a.created) : 0;
      const tb = b.created ? Date.parse(b.created) : 0;
      return ta - tb;
    });
    return out;
  }

  /**
   * Per-comment property fetch — used when the issue-level expand did not
   * return properties (some DC versions only expose them via this endpoint).
   * Returns the parsed property value or null on 404.
   */
  async getCommentProperty(commentId, propertyKey) {
    const path =
      `/rest/api/2/comment/${encodeURIComponent(commentId)}` +
      `/properties/${encodeURIComponent(propertyKey)}`;
    try {
      const res = await this.makeRequest("GET", path);
      return res ? res.value : null;
    } catch (e) {
      if (e.statusCode === 404) return null;
      throw e;
    }
  }

  /**
   * JSM Service Desk fallback for the customer-visible flag.
   * GET /rest/servicedeskapi/request/{key}/comment?expand=renderedBody&start=0&limit=100
   * Each entry has { id, public:boolean, body, author, created, ... }.
   * Returns a Map<commentId(string), {internal:boolean, source:"servicedesk"}>.
   * Returns an empty Map (NOT null) on any failure so callers can treat the
   * outcome uniformly as "no extra info" rather than branching on errors.
   */
  async getServiceDeskCommentPublicFlags(issueKey) {
    const out = new Map();
    let start = 0;
    const limit = 100;
    while (true) {
      const path =
        `/rest/servicedeskapi/request/${encodeURIComponent(issueKey)}/comment` +
        `?start=${start}&limit=${limit}`;
      let res;
      try {
        res = await this.makeRequest("GET", path);
      } catch (e) {
        // Non-JSM issue or no permission — skip silently.
        if (e.statusCode === 404 || e.statusCode === 403) return out;
        throw e;
      }
      const values = Array.isArray(res?.values) ? res.values : [];
      for (const v of values) {
        if (v && v.id != null && typeof v.public === "boolean") {
          out.set(String(v.id), { internal: !v.public, source: "servicedesk" });
        }
      }
      if (res?.isLastPage === true || values.length < limit) break;
      start += values.length || limit;
      if (start > 100000) break;
    }
    return out;
  }
}

module.exports = DatacenterClient;
module.exports.JSM_PUBLIC_PROP_KEY = JSM_PUBLIC_PROP_KEY;
