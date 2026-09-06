/**
 * Depth-first ADF utilities. ADF (Atlassian Document Format) is a JSON tree
 * shaped like:
 *   { type: "doc", version: 1, content: [
 *       { type: "paragraph", content: [
 *           { type: "text", text: "Hello " },
 *           { type: "mention", attrs: { id: "abc", text: "@jdoe" } },
 *           { type: "text", text: "!" }
 *       ]}
 *   ]}
 *
 * Cloud comments are stored in this format. JCMA-migrated comments may have
 * mention nodes where attrs.id was never resolved — the predicate below covers
 * every observed shape ("unknown" sentinel, empty string, absent id, "@unknown"
 * as the text, plain "@").
 */

/**
 * True if the given ADF node is an unresolved/placeholder mention. Defensive —
 * covers every shape encountered in the migrated corpus.
 */
function isUnknownMention(node) {
  if (!node || node.type !== "mention") return false;
  const attrs = node.attrs || {};
  const id = attrs.id;
  const text = attrs.text;
  // Missing or sentinel accountId.
  if (id === undefined || id === null) return true;
  if (typeof id === "string") {
    const t = id.trim().toLowerCase();
    if (t === "" || t === "unknown") return true;
  }
  // Text-side fallback: some JCMA outputs preserve an id-looking value but the
  // display text is literally "@unknown" or just "@".
  if (typeof text === "string") {
    const tt = text.trim().toLowerCase();
    if (tt === "@unknown" || tt === "@") return true;
  }
  return false;
}

/**
 * Walk the ADF tree in document order. Yields every visited node along with
 * the path of (parent, indexInContent) tuples back to the root — enough to
 * mutate the tree in place via replaceNodeAtPath.
 *
 * @returns {Array<{ node, path: Array<{parent, index}> }>}
 */
function walk(adf) {
  const out = [];
  if (!adf || typeof adf !== "object") return out;
  const stack = [{ node: adf, path: [] }];
  while (stack.length) {
    const frame = stack.pop();
    out.push(frame);
    const content = frame.node && Array.isArray(frame.node.content) ? frame.node.content : null;
    if (!content) continue;
    // Push children in reverse so we pop them in document order.
    for (let i = content.length - 1; i >= 0; i--) {
      stack.push({
        node: content[i],
        path: frame.path.concat([{ parent: frame.node, index: i }]),
      });
    }
  }
  return out;
}

function findMentionNodes(adf) {
  return walk(adf).filter((f) => f.node && f.node.type === "mention");
}

function findUnknownMentionNodes(adf) {
  return walk(adf).filter((f) => isUnknownMention(f.node));
}

function findTextNodes(adf) {
  return walk(adf).filter((f) => f.node && f.node.type === "text" && typeof f.node.text === "string");
}

/**
 * Concatenate every text node in document order. mention/emoji/inlineCard
 * nodes are rendered as their visible text (attrs.text || "") so the offsets
 * remain meaningful for human-readable diffs (NOT for byte-exact alignment
 * with DC plaintext — see semicolonNormalizer for the anchoring strategy).
 */
function flattenText(adf) {
  let s = "";
  for (const frame of walk(adf)) {
    const n = frame.node;
    if (!n || typeof n !== "object") continue;
    if (n.type === "text" && typeof n.text === "string") {
      s += n.text;
    } else if (n.type === "mention") {
      s += (n.attrs && n.attrs.text) || "";
    } else if (n.type === "emoji") {
      s += (n.attrs && (n.attrs.text || n.attrs.shortName)) || "";
    } else if (n.type === "hardBreak") {
      s += "\n";
    }
  }
  return s;
}

/**
 * Replace the node at the given path with `newNode`. The path is the same
 * shape produced by walk() — its final element points at (parent, index)
 * where the replacement should land, so the parent's content array is
 * mutated directly.
 */
function replaceNodeAtPath(path, newNode) {
  if (!path || path.length === 0) {
    throw new Error("replaceNodeAtPath: cannot replace the root document node");
  }
  const last = path[path.length - 1];
  if (!last.parent || !Array.isArray(last.parent.content)) {
    throw new Error("replaceNodeAtPath: parent has no content array");
  }
  last.parent.content[last.index] = newNode;
}

/** Splice (delete + optionally insert) at a path location. */
function spliceNodeAtPath(path, deleteCount, insertNodes = []) {
  if (!path || path.length === 0) {
    throw new Error("spliceNodeAtPath: cannot splice the root document node");
  }
  const last = path[path.length - 1];
  if (!last.parent || !Array.isArray(last.parent.content)) {
    throw new Error("spliceNodeAtPath: parent has no content array");
  }
  last.parent.content.splice(last.index, deleteCount, ...insertNodes);
}

/**
 * Deep-clone an ADF tree. JSON.stringify-based clone is fine here — ADF only
 * contains plain objects/arrays/strings/numbers/booleans.
 */
function cloneAdf(adf) {
  return adf == null ? adf : JSON.parse(JSON.stringify(adf));
}

/**
 * Build a fresh ADF mention node with the resolved accountId + displayName.
 * Cloud's wire format wants `attrs.text` to include the leading "@".
 */
function buildMentionNode(accountId, displayName) {
  return {
    type: "mention",
    attrs: {
      id: accountId,
      text: "@" + (displayName || ""),
      userType: "DEFAULT",
    },
  };
}

/** Build a plain-text node holding "@<displayName>" for unresolvable mentions. */
function buildPlainMentionText(displayNameOrUsername) {
  return {
    type: "text",
    text: "@" + (displayNameOrUsername || ""),
  };
}

module.exports = {
  isUnknownMention,
  walk,
  findMentionNodes,
  findUnknownMentionNodes,
  findTextNodes,
  flattenText,
  replaceNodeAtPath,
  spliceNodeAtPath,
  cloneAdf,
  buildMentionNode,
  buildPlainMentionText,
};
