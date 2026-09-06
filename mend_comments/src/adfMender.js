/**
 * The heart of the script: take one Cloud comment + its DC counterpart, and
 * compute a mended ADF body. Mutations are surgical:
 *   1) Each `mention` node in the Cloud ADF that looks unresolved (see
 *      adfWalker.isUnknownMention) gets paired with a DC mention slot in
 *      document order. The DC username is resolved to a Cloud accountId via
 *      DC user email → Cloud /user/search?query=email → exact email match.
 *      If resolved, the mention node is rewritten with the proper accountId.
 *      If unresolvable, the mention node is replaced with plain text
 *      "@<displayName-or-username>" — and the reason is recorded in the audit.
 *   2) ; runs of length >= 2 are normalized against DC plaintext at the
 *      anchor location (see semicolonNormalizer).
 *
 * Pairing strategy (to avoid index drift when some DC mentions migrated OK):
 *   - Walk DC mentions in document order.
 *   - For each DC mention, compute expectedAccountId (or null if unresolvable).
 *   - If a non-unknown Cloud mention already exists with that accountId,
 *     consider the DC slot "already handled" and skip it.
 *   - Otherwise consume the next unconsumed @unknown Cloud node.
 *   - If counts still mismatch after this pass → skip the comment with reason
 *     `unpaired_mention_count` (caller decides what to do).
 */

const crypto = require("crypto");
const {
  cloneAdf,
  findMentionNodes,
  isUnknownMention,
  replaceNodeAtPath,
  buildMentionNode,
  buildPlainMentionText,
} = require("./adfWalker");
const { extractDcMentions, flattenDcWiki } = require("./mentionExtractor");
const { normalizeSemicolons } = require("./semicolonNormalizer");

/**
 * Canonical hash of a Cloud comment body (ADF). Used to detect drift between
 * PLAN and APPLY: if someone edits the comment in between, we refuse to write.
 */
function hashAdf(adf) {
  if (adf == null) return "null";
  // Re-stringify with sorted keys at each level so cosmetic key ordering
  // changes don't trigger false drift detections.
  const canonical = JSON.stringify(adf, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = v[k];
      return out;
    }
    return v;
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Resolve one DC username → Cloud accountId via the configured resolvers.
 * Returns { accountId, displayName, note }.
 *   note ∈ null | "dc_user_not_found" | "dc_user_no_email" | "cloud_no_email_match"
 *          | "ambiguous_exact_email_N" | "lookup_error: ..."
 */
async function resolveDcUsername({ dcClient, userMapper, username, log }) {
  let dcUser;
  try {
    dcUser = await dcClient.getUser(username);
  } catch (e) {
    if (log) log(`  [resolve] DC lookup failed for "${username}": ${e.message}`);
    return { accountId: null, displayName: null, note: `lookup_error: ${e.message}` };
  }
  if (!dcUser) {
    return { accountId: null, displayName: null, note: "dc_user_not_found" };
  }
  if (!dcUser.emailAddress) {
    return {
      accountId: null,
      displayName: dcUser.displayName || null,
      note: "dc_user_no_email",
    };
  }
  const r = await userMapper.resolveByEmail(dcUser.emailAddress);
  return {
    accountId: r.accountId || null,
    displayName: r.displayName || dcUser.displayName || null,
    note: r.note || (r.accountId ? null : "cloud_no_email_match"),
  };
}

/**
 * Mend one Cloud comment given its DC counterpart.
 *
 * @returns {Promise<{
 *   bodyAfter: object|null,
 *   hashBefore: string,
 *   hashAfter: string|null,
 *   changes: {
 *     mentionsReplaced: Array<{ dcUsername, dcDisplayName, accountId|null, mode: "mention"|"plain"|"skip", note }>,
 *     semicolonsCollapsed: Array<{ before, after, anchorLeft, anchorRight }>,
 *     semicolonsAmbiguous: Array<{ run, anchorLeft, anchorRight }>,
 *   },
 *   skipped: boolean,
 *   skipReason: string|null,
 * }>}
 */
async function mendCommentAdf({ cloudComment, dcComment, dcClient, userMapper, log }) {
  const originalBody = cloudComment && cloudComment.body;
  const hashBefore = hashAdf(originalBody);

  if (!originalBody || originalBody.type !== "doc") {
    return {
      bodyAfter: null,
      hashBefore,
      hashAfter: null,
      changes: { mentionsReplaced: [], semicolonsCollapsed: [], semicolonsAmbiguous: [] },
      skipped: true,
      skipReason: "cloud_body_not_adf",
    };
  }

  const cloneBody = cloneAdf(originalBody);
  const mentionsReplaced = [];

  // ── Mention pairing pass ───────────────────────────────────────────────
  const dcMentions = extractDcMentions(dcComment || {});
  const cloudMentionFrames = findMentionNodes(cloneBody);
  const cloudUnknownFrames = cloudMentionFrames.filter((f) => isUnknownMention(f.node));

  // Pre-resolve every DC mention's expected accountId.
  const dcResolved = [];
  for (const m of dcMentions) {
    const r = await resolveDcUsername({
      dcClient,
      userMapper,
      username: m.username,
      log,
    });
    dcResolved.push({ slot: m, resolved: r });
  }

  // Build a set of accountIds that already appear on NON-unknown Cloud mentions.
  // Those DC slots are considered "already migrated by JCMA" and we skip them.
  const alreadyMigratedIds = new Set();
  for (const frame of cloudMentionFrames) {
    if (isUnknownMention(frame.node)) continue;
    const id = frame.node && frame.node.attrs && frame.node.attrs.id;
    if (typeof id === "string" && id) alreadyMigratedIds.add(id);
  }

  // Walk DC slots in document order; pair each pending one with the next
  // unconsumed unknown Cloud node.
  let unknownCursor = 0;
  const toEdit = []; // { frame, mode, newNode, dcSlot, resolved }
  for (const { slot, resolved } of dcResolved) {
    if (resolved.accountId && alreadyMigratedIds.has(resolved.accountId)) {
      mentionsReplaced.push({
        dcUsername: slot.username,
        dcDisplayName: resolved.displayName || slot.displayName || null,
        accountId: resolved.accountId,
        mode: "skip",
        note: "already_migrated",
      });
      continue;
    }
    if (unknownCursor >= cloudUnknownFrames.length) {
      // More DC slots than Cloud unknowns — record as audit-only.
      mentionsReplaced.push({
        dcUsername: slot.username,
        dcDisplayName: resolved.displayName || slot.displayName || null,
        accountId: resolved.accountId || null,
        mode: "skip",
        note: "no_remaining_unknown_in_cloud",
      });
      continue;
    }
    const frame = cloudUnknownFrames[unknownCursor++];
    if (resolved.accountId) {
      toEdit.push({
        frame,
        mode: "mention",
        newNode: buildMentionNode(
          resolved.accountId,
          resolved.displayName || slot.displayName || slot.username,
        ),
        dcSlot: slot,
        resolved,
      });
      mentionsReplaced.push({
        dcUsername: slot.username,
        dcDisplayName: resolved.displayName || slot.displayName || null,
        accountId: resolved.accountId,
        mode: "mention",
        note: null,
      });
    } else {
      toEdit.push({
        frame,
        mode: "plain",
        newNode: buildPlainMentionText(
          slot.displayName || resolved.displayName || slot.username,
        ),
        dcSlot: slot,
        resolved,
      });
      mentionsReplaced.push({
        dcUsername: slot.username,
        dcDisplayName: resolved.displayName || slot.displayName || null,
        accountId: null,
        mode: "plain",
        note: resolved.note || "unresolved",
      });
    }
  }

  // If there are more @unknown Cloud nodes than DC slots, we can't pair them
  // — bail rather than silently leave them dangling.
  if (unknownCursor < cloudUnknownFrames.length) {
    return {
      bodyAfter: null,
      hashBefore,
      hashAfter: null,
      changes: { mentionsReplaced, semicolonsCollapsed: [], semicolonsAmbiguous: [] },
      skipped: true,
      skipReason: `unpaired_mention_count (dc=${dcMentions.length}, cloud_unknown=${cloudUnknownFrames.length})`,
    };
  }

  // ── Semicolon normalization pass ───────────────────────────────────────
  // Order matters: run this BEFORE applying mention edits. Otherwise a
  // resolved-or-plain mention replacement may inject visible text like
  // "@Alex Carter" into the Cloud flat that does NOT exist in DC plaintext
  // (which uses the username, e.g. "acarter"), causing anchor lookups around
  // `;` runs adjacent to mentions to fail and the run to be marked ambiguous.
  // While mention nodes are still type:"mention", the semicolon normalizer's
  // flat-text builder skips them entirely; DC's flattenDcWiki erases wiki
  // mentions for the same reason. With mentions invisible on both sides the
  // anchors line up.
  const dcPlain = flattenDcWiki((dcComment && dcComment.storage) || "");
  const { changes: semChanges, ambiguous: semAmbiguous } = normalizeSemicolons(
    cloneBody,
    dcPlain,
  );

  // Apply the mention edits AFTER the semicolon pass. The mention frames'
  // (parent, index) coordinates remain valid because the semicolon pass only
  // mutates text-node `.text` strings — it never inserts or removes nodes.
  for (const e of toEdit) {
    replaceNodeAtPath(e.frame.path, e.newNode);
  }

  const totalEdits = toEdit.length + semChanges.length;
  if (totalEdits === 0) {
    return {
      bodyAfter: null,
      hashBefore,
      hashAfter: null,
      changes: {
        mentionsReplaced,
        semicolonsCollapsed: semChanges,
        semicolonsAmbiguous: semAmbiguous,
      },
      skipped: true,
      skipReason: "no_changes_needed",
    };
  }

  const hashAfter = hashAdf(cloneBody);
  return {
    bodyAfter: cloneBody,
    hashBefore,
    hashAfter,
    changes: {
      mentionsReplaced,
      semicolonsCollapsed: semChanges,
      semicolonsAmbiguous: semAmbiguous,
    },
    skipped: false,
    skipReason: null,
  };
}

module.exports = {
  mendCommentAdf,
  hashAdf,
  resolveDcUsername,
};
