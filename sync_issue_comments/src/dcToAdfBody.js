/**
 * Convert a DC comment body to a Cloud ADF document, prepended with an
 * authorship attribution blockquote.
 *
 *   buildAdfForInjection({ dcComment, dcClient, userMapper, log })
 *     → { adf, fidelity, authorshipResolved }
 *
 * Steps:
 *   1. Extract DC mentions from the comment (wiki preferred, rendered HTML
 *      fallback) and pre-resolve each DC username → Cloud accountId via
 *      UserMapper. We do this BEFORE the synchronous HTML→ADF pass so the
 *      converter can call a pre-warmed sync resolver.
 *   2. Resolve the comment author's email → Cloud accountId for the
 *      attribution prefix.
 *   3. Run htmlToAdf on DC `rendered`. If it produces an empty document,
 *      fall back to a plaintext ADF wrapper built from `rendered`/`storage`.
 *   4. Prepend a blockquote node with the attribution line.
 *
 * Returned `fidelity` reflects the BODY conversion only (not the attribution
 * line, which is always trivially ADF). Caller is responsible for attaching
 * `migration.fidelity` as a Cloud comment property when the value is not
 * `adf_full`.
 */

const { extractDcMentions } = require("../../mend_comments/src/mentionExtractor");
const { htmlToAdf, plaintextAdf, emptyDoc } = require("./htmlToAdf");

async function buildAdfForInjection({ dcComment, dcClient, userMapper, log = () => {} }) {
  if (!dcComment) {
    return {
      adf: emptyDoc(),
      fidelity: "plaintext_fallback",
      authorshipResolved: null,
    };
  }

  // ── 1. Pre-resolve mentions in the body
  const mentionSlots = extractDcMentions(dcComment);
  const mentionResolutions = new Map(); // username(lowercase) → { accountId, displayName }
  for (const slot of mentionSlots) {
    const key = (slot.username || "").toLowerCase();
    if (!key || mentionResolutions.has(key)) continue;
    const resolved = await resolveDcUsernameToAccountId(slot.username, dcClient, userMapper, log);
    if (resolved.accountId) {
      mentionResolutions.set(key, {
        accountId: resolved.accountId,
        displayName: resolved.displayName || slot.displayName || slot.username,
      });
    } else {
      mentionResolutions.set(key, null); // memoize "no match" too
    }
  }

  const resolveMention = (username) => {
    const r = mentionResolutions.get((username || "").toLowerCase());
    return r || null;
  };

  // ── 2. Resolve author for attribution
  const authorshipResolved = await resolveAuthorship(dcComment, dcClient, userMapper, log);

  // ── 3. Body conversion
  let body;
  if (typeof dcComment.rendered === "string" && dcComment.rendered.trim()) {
    body = htmlToAdf(dcComment.rendered, { resolveMention });
  } else {
    body = { adf: emptyDoc(), fidelity: "plaintext_fallback", unknownTags: new Set() };
  }

  // Empty conversion result → plaintext fallback
  const adfIsEmpty =
    !body.adf ||
    !Array.isArray(body.adf.content) ||
    body.adf.content.length === 0 ||
    body.adf.content.every((b) =>
      b && b.type === "paragraph" && (!b.content || b.content.length === 0),
    );
  if (adfIsEmpty) {
    const raw = dcComment.rendered || dcComment.storage || "";
    body = { adf: plaintextAdf(raw), fidelity: "plaintext_fallback", unknownTags: new Set() };
  }

  // ── 4. Prepend authorship blockquote
  const attribution = buildAttributionNode(dcComment, authorshipResolved);
  const finalContent = [attribution, ...body.adf.content];
  const adf = { type: "doc", version: 1, content: finalContent };

  return {
    adf,
    fidelity: body.fidelity,
    unknownTags: [...(body.unknownTags || [])],
    authorshipResolved,
  };
}

async function resolveDcUsernameToAccountId(dcUsername, dcClient, userMapper, log) {
  if (!dcUsername) return { accountId: null, displayName: null };
  let dcUser = null;
  try {
    dcUser = await dcClient.getUser(dcUsername);
  } catch (e) {
    log(`  [mention] DC user lookup failed for "${dcUsername}": ${e.message}`);
    return { accountId: null, displayName: null };
  }
  if (!dcUser || !dcUser.emailAddress) {
    return { accountId: null, displayName: dcUser?.displayName || null };
  }
  const r = await userMapper.resolveByEmail(dcUser.emailAddress);
  return {
    accountId: r.accountId || null,
    displayName: r.displayName || dcUser.displayName || null,
  };
}

async function resolveAuthorship(dcComment, dcClient, userMapper, log) {
  const dcUsername = dcComment.author && dcComment.author.name;
  const dcDisplay = (dcComment.author && dcComment.author.displayName) || dcUsername || "unknown";
  if (!dcUsername) {
    return { accountId: null, displayName: dcDisplay };
  }
  const resolved = await resolveDcUsernameToAccountId(dcUsername, dcClient, userMapper, log);
  return {
    accountId: resolved.accountId,
    displayName: resolved.displayName || dcDisplay,
  };
}

function buildAttributionNode(dcComment, authorship) {
  const created = dcComment.created || "";
  const dateText = created ? new Date(created).toISOString() : "unknown date";
  const inline = [{ type: "text", text: "Originally posted by " }];
  if (authorship && authorship.accountId) {
    inline.push({
      type: "mention",
      attrs: {
        id: authorship.accountId,
        text: `@${authorship.displayName || "user"}`,
        userType: "DEFAULT",
      },
    });
  } else {
    inline.push({
      type: "text",
      text: `@${authorship?.displayName || "unknown"}`,
    });
  }
  inline.push({ type: "text", text: ` on ${dateText}` });
  return {
    type: "blockquote",
    content: [{ type: "paragraph", content: inline }],
  };
}

module.exports = {
  buildAdfForInjection,
  // exported for tests
  _buildAttributionNode: buildAttributionNode,
};
