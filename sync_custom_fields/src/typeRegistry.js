// =============================================================================
// typeRegistry.js — schema-driven custom-field value handlers.
//
// The registry is keyed by a field's schema CATEGORY, derived from the Cloud
// field's `schema.custom` suffix (and `schema.type`). Each category has a
// handler:
//   { translate(dcValue, dcSchema, ctx) -> Promise<cloudWriteValue>,
//     normalize(value, schema) -> canonical-comparable }
//
// Design notes:
//  - We resolve the handler from the CLOUD (target) field schema. fieldIndex
//    only pairs a DC source whose category is compatible (see typeCompatible),
//    so `translate` can assume the DC value shape matches the category.
//  - `normalize` is applied to BOTH the translated DC write value AND the
//    current Cloud read value. Those have slightly different shapes
//    (e.g. write {value} vs read {self,value,id}), so every normalize extracts
//    the comparable essence (value text / accountId / name / flattened prose).
//  - Unknown / app-managed / computed types map to NO category -> default-skip.
//    This is fail-safe: nothing is written unless explicitly understood.
//  - `translate` throws a coded Error (e.g. "user_unmappable:...") when it
//    cannot safely produce a value; fieldDiffer turns that into a skip+reason.
// =============================================================================

/** Last `:`-segment of schema.custom, e.g. "...types:multiselect" -> "multiselect". */
function suffixOf(schema) {
  const c = schema && schema.custom;
  if (!c || typeof c !== "string") return null;
  return c.split(":").pop();
}

// suffix -> category. Anything not listed here is unsupported -> skip.
const SUFFIX_CATEGORY = {
  select: "option",
  radiobuttons: "option",
  multiselect: "multioption",
  multicheckboxes: "multioption",
  cascadingselect: "cascading",
  float: "number",
  datepicker: "date",
  datetime: "datetime",
  textfield: "text",
  url: "url",
  textarea: "richtext",
  labels: "labels",
  userpicker: "user",
  "multiuserpicker": "multiuser",
  grouppicker: "group",
  multigrouppicker: "multigroup",
  version: "version",
  multiversion: "multiversion",
};

/** Derive the comparable category for a field schema, or null if unsupported. */
function categoryOf(schema) {
  const suffix = suffixOf(schema);
  if (suffix && SUFFIX_CATEGORY[suffix]) return SUFFIX_CATEGORY[suffix];
  return null;
}

// Categories that are interchangeable for source/target pairing. DC and Cloud
// may store "the same" field with slightly different widget types after JCMA.
const COMPAT_FAMILIES = [
  new Set(["text", "url", "richtext"]),       // any plain/rich text widget
  new Set(["option"]),
  new Set(["multioption"]),
  new Set(["cascading"]),
  new Set(["number"]),
  new Set(["date"]),
  new Set(["datetime"]),
  new Set(["labels"]),
  new Set(["user"]),
  new Set(["multiuser"]),
  new Set(["group"]),
  new Set(["multigroup"]),
  new Set(["version"]),
  new Set(["multiversion"]),
];

/** True if a DC source schema can feed a Cloud target schema. */
function typeCompatible(dcSchema, cloudSchema) {
  const a = categoryOf(dcSchema);
  const b = categoryOf(cloudSchema);
  if (!a || !b) return false;
  if (a === b) return true;
  return COMPAT_FAMILIES.some((fam) => fam.has(a) && fam.has(b));
}

// ── helpers ──────────────────────────────────────────────────────────────────

const lc = (s) => String(s == null ? "" : s).trim().toLowerCase();

/** Recursively collect plain text from an ADF doc (for prose comparison). */
function flattenAdf(node) {
  if (!node || typeof node !== "object") return "";
  let out = "";
  if (typeof node.text === "string") out += node.text;
  if (Array.isArray(node.content)) {
    for (const c of node.content) out += flattenAdf(c);
  }
  return out;
}

/**
 * Prose key for comparing rich text across DC/Cloud. Block structure differs
 * wildly after JCMA (Cloud splits lines into separate paragraphs with no
 * separator, DC keeps newlines/<br/>), and htmlToAdf cannot always reproduce
 * lists — so we compare on letters/digits only, ignoring ALL whitespace and
 * case. This prevents needless (and lossy) overwrites of rich-text fields that
 * already carry the same content. Genuine content differences still show.
 */
function proseKey(s) {
  return String(s == null ? "" : s).replace(/\s+/g, "").toLowerCase();
}

/**
 * Coerce any DC text/rich value to a Cloud ADF doc. Prefers rendered HTML, but
 * falls back to plaintext when htmlToAdf yields an empty doc (e.g. numbered
 * lists). Records which path won in ctx._adfSource so the caller can flag
 * fidelity accurately.
 */
function toAdf(dcValue, ctx) {
  // Already ADF (DC field was itself rich-text on a v3-ish read) — pass through.
  if (dcValue && typeof dcValue === "object" && dcValue.type === "doc") {
    if (ctx) ctx._adfSource = "adf";
    return dcValue;
  }
  const html = ctx && ctx.renderedHtml;
  if (html && typeof html === "string" && html.trim()) {
    try {
      const doc = ctx.htmlToAdf(html, {});
      if (flattenAdf(doc).trim()) {
        if (ctx) ctx._adfSource = "html";
        return doc;
      }
    } catch {
      /* fall through to plaintext */
    }
  }
  if (ctx) ctx._adfSource = "plaintext";
  const text = typeof dcValue === "string" ? dcValue : String(dcValue == null ? "" : dcValue);
  return ctx.plaintextAdf(text);
}

/** Map an option value through a per-field optionMap remap (case-insensitive). */
function remapOption(value, ctx) {
  const map = ctx && ctx.optionMap;
  if (!map) return value;
  const hit = Object.keys(map).find((k) => lc(k) === lc(value));
  return hit ? map[hit] : value;
}

async function resolveAccountId(dcUser, ctx) {
  const email = dcUser && dcUser.emailAddress;
  if (!email) {
    const name = (dcUser && (dcUser.displayName || dcUser.name)) || "unknown";
    throw new Error(`user_unmappable:no_email:${name}`);
  }
  const res = await ctx.userMapper.resolveByEmail(email);
  if (!res || !res.accountId) {
    throw new Error(`user_unmappable:${email}:${(res && res.note) || "no_match"}`);
  }
  return res.accountId;
}

// ── handlers ─────────────────────────────────────────────────────────────────

const HANDLERS = {
  option: {
    async translate(dc, _s, ctx) {
      const v = dc && (dc.value != null ? dc.value : dc);
      return { value: String(remapOption(v, ctx)) };
    },
    normalize(v) {
      if (v == null) return null;
      return lc(v.value != null ? v.value : v);
    },
  },

  multioption: {
    async translate(dc, _s, ctx) {
      const arr = Array.isArray(dc) ? dc : [dc];
      return arr
        .filter((o) => o != null)
        .map((o) => ({ value: String(remapOption(o.value != null ? o.value : o, ctx)) }));
    },
    normalize(v) {
      if (!Array.isArray(v)) return v == null ? null : [lc(v.value != null ? v.value : v)];
      return v.map((o) => lc(o && o.value != null ? o.value : o)).sort();
    },
  },

  cascading: {
    async translate(dc, _s, ctx) {
      if (!dc || typeof dc !== "object") return null;
      const out = { value: String(remapOption(dc.value, ctx)) };
      if (dc.child && dc.child.value != null) {
        out.child = { value: String(dc.child.value) };
      }
      return out;
    },
    normalize(v) {
      if (!v || typeof v !== "object") return null;
      const parent = lc(v.value);
      const child = v.child && v.child.value != null ? lc(v.child.value) : "";
      return parent + "/" + child;
    },
  },

  number: {
    async translate(dc) {
      const n = Number(typeof dc === "string" ? dc.trim() : dc);
      return Number.isFinite(n) ? n : null;
    },
    normalize(v) {
      if (v == null || v === "") return null;
      const n = Number(typeof v === "string" ? v.trim() : v);
      return Number.isFinite(n) ? String(n) : null;
    },
  },

  date: {
    async translate(dc) {
      // DC date is "YYYY-MM-DD"; pass the date part straight through.
      return typeof dc === "string" ? dc.substring(0, 10) : dc;
    },
    normalize(v) {
      if (!v) return null;
      return String(v).substring(0, 10);
    },
  },

  datetime: {
    async translate(dc) {
      // DC datetime is ISO-8601 ("2024-01-18T16:43:58.708+0000"); Cloud accepts it.
      return dc;
    },
    normalize(v) {
      if (!v) return null;
      const ms = Date.parse(v);
      if (Number.isNaN(ms)) return String(v);
      return String(Math.floor(ms / 60000)); // minute granularity
    },
  },

  text: {
    async translate(dc) {
      return typeof dc === "string" ? dc : String(dc == null ? "" : dc);
    },
    normalize(v) {
      if (v == null) return null;
      // A Cloud value here is plain string; tolerate an ADF read just in case.
      if (typeof v === "object" && v.type === "doc") return flattenAdf(v).trim();
      return String(v).trim();
    },
  },

  url: {
    async translate(dc) {
      return typeof dc === "string" ? dc.trim() : dc;
    },
    normalize(v) {
      return v == null ? null : String(v).trim();
    },
  },

  richtext: {
    async translate(dc, _s, ctx) {
      return toAdf(dc, ctx);
    },
    normalize(v) {
      if (v == null) return null;
      const text = typeof v === "object" && v.type === "doc" ? flattenAdf(v) : String(v);
      const key = proseKey(text);
      return key === "" ? null : key;
    },
  },

  labels: {
    async translate(dc) {
      if (!Array.isArray(dc)) return dc == null ? [] : [String(dc)];
      return dc.map((s) => String(s));
    },
    normalize(v) {
      if (!Array.isArray(v)) return v == null ? [] : [String(v)];
      return v.map((s) => String(s)).sort();
    },
  },

  user: {
    async translate(dc, _s, ctx) {
      const accountId = await resolveAccountId(dc, ctx);
      return { accountId };
    },
    normalize(v) {
      if (!v) return null;
      return v.accountId || null;
    },
  },

  multiuser: {
    async translate(dc, _s, ctx) {
      const arr = Array.isArray(dc) ? dc : [dc];
      const out = [];
      for (const u of arr) {
        if (u == null) continue;
        out.push({ accountId: await resolveAccountId(u, ctx) });
      }
      return out;
    },
    normalize(v) {
      if (!Array.isArray(v)) return v && v.accountId ? [v.accountId] : null;
      return v.map((u) => (u && u.accountId) || "").filter(Boolean).sort();
    },
  },

  group: {
    async translate(dc) {
      const name = dc && (dc.name != null ? dc.name : dc);
      return { name: String(name) };
    },
    normalize(v) {
      if (!v) return null;
      return lc(v.name != null ? v.name : v);
    },
  },

  multigroup: {
    async translate(dc) {
      const arr = Array.isArray(dc) ? dc : [dc];
      return arr.filter((g) => g != null).map((g) => ({ name: String(g.name != null ? g.name : g) }));
    },
    normalize(v) {
      if (!Array.isArray(v)) return v == null ? null : [lc(v.name != null ? v.name : v)];
      return v.map((g) => lc(g && g.name != null ? g.name : g)).sort();
    },
  },

  version: {
    async translate(dc) {
      const name = dc && (dc.name != null ? dc.name : dc);
      return { name: String(name) };
    },
    normalize(v) {
      if (!v) return null;
      return lc(v.name != null ? v.name : v);
    },
  },

  multiversion: {
    async translate(dc) {
      const arr = Array.isArray(dc) ? dc : [dc];
      return arr.filter((x) => x != null).map((x) => ({ name: String(x.name != null ? x.name : x) }));
    },
    normalize(v) {
      if (!Array.isArray(v)) return v == null ? null : [lc(v.name != null ? v.name : v)];
      return v.map((x) => lc(x && x.name != null ? x.name : x)).sort();
    },
  },
};

const DEFAULT_SKIP = { syncable: false, category: null };

/**
 * Resolve a Cloud field schema to its handler.
 * Returns { syncable, category, translate?, normalize? }.
 */
function resolve(cloudSchema) {
  const category = categoryOf(cloudSchema);
  if (!category || !HANDLERS[category]) {
    return { ...DEFAULT_SKIP, suffix: suffixOf(cloudSchema), type: cloudSchema && cloudSchema.type };
  }
  const h = HANDLERS[category];
  return { syncable: true, category, translate: h.translate, normalize: h.normalize };
}

/** Normalize a value using a known category handler (used by apply recheck). */
function normalizeByCategory(category, value) {
  const h = HANDLERS[category];
  if (!h) return value == null ? null : value;
  return h.normalize(value);
}

/** equalNorm — structural equality of two normalized values. */
function equalNorm(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether a raw field value carries data (not empty). */
function hasData(v) {
  if (v == null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") {
    if (v.type === "doc") return flattenAdf(v).trim() !== "";
    return Object.keys(v).length > 0;
  }
  return true; // numbers, booleans
}

module.exports = {
  resolve,
  categoryOf,
  suffixOf,
  typeCompatible,
  normalizeByCategory,
  equalNorm,
  hasData,
  flattenAdf,
  SUFFIX_CATEGORY,
};
