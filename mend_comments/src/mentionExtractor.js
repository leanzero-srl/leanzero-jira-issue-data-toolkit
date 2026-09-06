/**
 * Extract DC mention slots from a DC comment in document order.
 *
 * DC wiki-markup form:  [~username]
 *                       [~accountid:712020:...]      (rare; JCMA-prepared bodies)
 *                       [Some Display|~username]     (alias form)
 *
 * DC rendered HTML form: <a class="user-hover" rel="username"
 *                           data-username="username" ...>Display Name</a>
 *
 * We prefer wiki because it never strips a mention behind a rendered-HTML
 * macro. Rendered HTML is the fallback when wiki yielded nothing (e.g. the
 * body was re-rendered post-edit and storage drifted).
 */

const WIKI_MENTION_RE = /\[(?:([^\]|]+)\|)?~([^\]\r\n]+)\]/g;
const HTML_USER_HOVER_RE =
  /<a\b[^>]*\bclass=["'][^"']*\buser-hover\b[^"']*["'][^>]*?\brel=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const HTML_DATA_USERNAME_RE =
  /<a\b[^>]*\bdata-username=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const HTML_USER_LINK_RE =
  /<a\b[^>]*\bhref=["'][^"']*\/secure\/ViewProfile\.jspa\?name=([^"'&]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;

function decodeHtmlText(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function extractFromWiki(storage) {
  if (typeof storage !== "string" || !storage) return [];
  const slots = [];
  WIKI_MENTION_RE.lastIndex = 0;
  let m;
  while ((m = WIKI_MENTION_RE.exec(storage)) !== null) {
    const alias = m[1] ? m[1].trim() : null;
    const usernameRaw = (m[2] || "").trim();
    if (!usernameRaw) continue;
    slots.push({
      username: usernameRaw,
      displayName: alias,
      source: "wiki",
      position: m.index,
      raw: m[0],
    });
  }
  return slots;
}

function extractFromRendered(rendered) {
  if (typeof rendered !== "string" || !rendered) return [];
  const slots = [];
  const seenByPosition = new Set();
  const collect = (re, kind) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(rendered)) !== null) {
      const username = (m[1] || "").trim();
      const displayName = decodeHtmlText(m[2] || "");
      if (!username) continue;
      const key = `${m.index}::${username}`;
      if (seenByPosition.has(key)) continue;
      seenByPosition.add(key);
      slots.push({
        username,
        displayName: displayName || null,
        source: kind,
        position: m.index,
        raw: m[0],
      });
    }
  };
  collect(HTML_USER_HOVER_RE, "rendered:user-hover");
  collect(HTML_DATA_USERNAME_RE, "rendered:data-username");
  collect(HTML_USER_LINK_RE, "rendered:viewprofile");
  slots.sort((a, b) => a.position - b.position);
  return slots;
}

/**
 * Returns DC mention slots in document order: prefer wiki, fall back to
 * rendered HTML only when wiki yielded nothing.
 *
 * @param {{ storage: string|null, rendered: string|null }} dcComment
 * @returns {Array<{ username, displayName, source, position, raw }>}
 */
function extractDcMentions(dcComment) {
  if (!dcComment) return [];
  const fromWiki = extractFromWiki(dcComment.storage);
  if (fromWiki.length > 0) return fromWiki;
  return extractFromRendered(dcComment.rendered);
}

/**
 * Strip wiki markup leaving plain text — used by the semicolon normalizer to
 * compare DC content character-by-character. This is intentionally lossy: we
 * keep word characters, punctuation, and whitespace; we strip mention markup,
 * link macros, and table syntax that would otherwise scramble offsets.
 */
function flattenDcWiki(storage) {
  if (typeof storage !== "string") return "";
  let s = storage;
  // Mention macros → empty string. The Cloud-side flat text (built by the
  // semicolon normalizer) deliberately ignores `type: "mention"` ADF nodes,
  // so we keep DC symmetric by erasing wiki mentions too. Substituting the
  // display name or username would make anchors like "FYI @Alex Carter ;;;"
  // (Cloud, post mention-edit) fail to align with DC "FYI acarter ;" because
  // the visible name differs from the username.
  s = s.replace(WIKI_MENTION_RE, "");
  // Link macros: [Text|http://...] → Text  ;  [http://...] → http://...
  s = s.replace(/\[([^\]|\r\n]+)\|([^\]\r\n]+)\]/g, "$1");
  s = s.replace(/\[([^\]\r\n]+)\]/g, "$1");
  // {color:...}xxx{color} → xxx  (also {panel}{noformat}{quote}{code})
  s = s.replace(/\{(color|panel|quote|noformat|code)[^}]*\}/g, "");
  s = s.replace(/\{(color|panel|quote|noformat|code)\}/g, "");
  // Bold/italic markup left as-is (it doesn't affect ; runs).
  return s;
}

module.exports = {
  extractDcMentions,
  extractFromWiki,
  extractFromRendered,
  flattenDcWiki,
};
