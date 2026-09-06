/**
 * Minimal DC `renderedBody` HTML → ADF converter.
 *
 * Scope (deliberately small — JSM comments are 90% short prose):
 *   p, h1..h6, ul/ol/li, blockquote, pre, code (inline + block),
 *   strong/b, em/i, a (link), br, plain text.
 *
 * Anything outside this set falls through as inline text; the resulting
 * conversion fidelity is `adf_partial_unknown_nodes` so the audit can flag it.
 *
 * Mention <a> anchors (user-hover / data-username / ViewProfile.jspa) are
 * resolved via a caller-supplied synchronous resolver. Unresolvable mentions
 * render as plain text "@<displayName>", matching mend_comments' rule.
 *
 * Design: a container stack drives block placement. The container at the top
 * of the stack receives new blocks; the active "leaf block" (paragraph /
 * heading / codeBlock) receives inline content.
 */

const MENTION_USER_HOVER_RE = /\bclass=["'][^"']*\buser-hover\b[^"']*["']/i;
const MENTION_REL_RE = /\brel=["']([^"']+)["']/i;
const MENTION_DATA_USERNAME_RE = /\bdata-username=["']([^"']+)["']/i;
const MENTION_VIEW_PROFILE_RE = /\bhref=["'][^"']*\/secure\/ViewProfile\.jspa\?name=([^"'&]+)/i;

function decodeEntities(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

/* ─────────────────────────────────────────────────────────────────────
 *  Tokenizer
 * ────────────────────────────────────────────────────────────────── */

function tokenize(html) {
  const tokens = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      const text = decodeEntities(html.slice(i));
      if (text) tokens.push({ type: "text", text });
      break;
    }
    if (lt > i) {
      const text = decodeEntities(html.slice(i, lt));
      if (text) tokens.push({ type: "text", text });
    }
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === "!") {
      const end = html.indexOf(">", lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) {
      const text = decodeEntities(html.slice(lt));
      if (text) tokens.push({ type: "text", text });
      break;
    }
    const raw = html.slice(lt + 1, gt);
    const isClose = raw.startsWith("/");
    const isSelf = raw.endsWith("/");
    const body = isClose ? raw.slice(1) : (isSelf ? raw.slice(0, -1) : raw);
    const spaceIdx = body.search(/\s/);
    const tag = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase().trim();
    const attrsRaw = spaceIdx === -1 ? "" : body.slice(spaceIdx + 1);
    if (!tag) {
      i = gt + 1;
      continue;
    }
    if (isClose) {
      tokens.push({ type: "close", tag });
    } else if (isSelf || tag === "br" || tag === "hr" || tag === "img") {
      tokens.push({ type: "self", tag, attrs: attrsRaw });
    } else {
      tokens.push({ type: "open", tag, attrs: attrsRaw });
    }
    i = gt + 1;
  }
  return tokens;
}

function parseAttr(attrsRaw, name) {
  if (!attrsRaw) return null;
  const re = new RegExp(`\\b${name}=["']([^"']*)["']`, "i");
  const m = attrsRaw.match(re);
  return m ? m[1] : null;
}

function detectMentionUsername(attrsRaw) {
  if (!attrsRaw) return null;
  if (MENTION_USER_HOVER_RE.test(attrsRaw)) {
    const m = MENTION_REL_RE.exec(attrsRaw);
    if (m && m[1]) return m[1];
  }
  const du = MENTION_DATA_USERNAME_RE.exec(attrsRaw);
  if (du && du[1]) return du[1];
  const vp = MENTION_VIEW_PROFILE_RE.exec(attrsRaw);
  if (vp && vp[1]) return decodeURIComponent(vp[1]);
  return null;
}

/* ─────────────────────────────────────────────────────────────────────
 *  ADF helpers
 * ────────────────────────────────────────────────────────────────── */

function textNode(text, marks) {
  const node = { type: "text", text };
  if (marks && marks.length > 0) node.marks = marks;
  return node;
}

function mergeAdjacentText(nodes) {
  const out = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (
      n && last && n.type === "text" && last.type === "text" &&
      JSON.stringify(n.marks || null) === JSON.stringify(last.marks || null)
    ) {
      last.text += n.text;
    } else {
      out.push(n);
    }
  }
  return out;
}

function emptyDoc() {
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: [] }] };
}

/* ─────────────────────────────────────────────────────────────────────
 *  Converter
 * ────────────────────────────────────────────────────────────────── */

function htmlToAdf(html, { resolveMention = () => null } = {}) {
  if (typeof html !== "string" || !html.trim()) {
    return { adf: emptyDoc(), fidelity: "plaintext_fallback", unknownTags: new Set() };
  }
  const tokens = tokenize(html);
  if (tokens.length === 0) {
    return { adf: emptyDoc(), fidelity: "plaintext_fallback", unknownTags: new Set() };
  }

  const unknownTags = new Set();
  const root = { content: [] };

  // containerStack[top] is the block container currently accepting new
  // top-level blocks. Initial: root. blockquote pushes the blockquote node
  // itself. ul/ol push the list. li pushes the listItem.
  const containerStack = [root];

  // currentLeaf is the active paragraph/heading/codeBlock receiving inline
  // content. null when no leaf is active.
  let currentLeaf = null;

  // Inline mark stack — entries are real marks {type: "..."} or a sentinel
  // {__mention:true, username} for an open mention <a>.
  const markStack = [];
  let currentLinkHref = null;

  const topContainer = () => containerStack[containerStack.length - 1];

  function pushBlock(node) {
    const c = topContainer();
    c.content = c.content || [];
    c.content.push(node);
  }

  function finishLeaf() {
    if (!currentLeaf) return;
    if (Array.isArray(currentLeaf.content)) {
      currentLeaf.content = mergeAdjacentText(currentLeaf.content);
    }
    currentLeaf = null;
  }

  function startLeaf(type, attrs) {
    finishLeaf();
    currentLeaf = attrs ? { type, attrs, content: [] } : { type, content: [] };
    pushBlock(currentLeaf);
  }

  function ensureLeafForInline() {
    if (currentLeaf) return currentLeaf;
    // Auto-wrap orphan inline content in a paragraph attached to the top container.
    startLeaf("paragraph");
    return currentLeaf;
  }

  function appendInline(node) {
    if (!node) return;
    const leaf = ensureLeafForInline();
    leaf.content = leaf.content || [];
    leaf.content.push(node);
  }

  function currentMarks() {
    const real = markStack.filter((m) => !m.__mention);
    return real.length > 0 ? real.map((m) => ({ ...m })) : null;
  }

  function popMark(type) {
    for (let i = markStack.length - 1; i >= 0; i--) {
      if (markStack[i].type === type) {
        markStack.splice(i, 1);
        return;
      }
    }
  }

  function makeMention(username, displayName) {
    const resolved = resolveMention(username, displayName) || null;
    if (resolved && resolved.accountId) {
      return {
        type: "mention",
        attrs: {
          id: resolved.accountId,
          text: `@${resolved.displayName || displayName || username}`,
          userType: "DEFAULT",
        },
      };
    }
    return textNode(`@${displayName || username}`, currentMarks());
  }

  function replaceLastTextWithMention(username) {
    const leaf = currentLeaf;
    if (!leaf || !Array.isArray(leaf.content) || leaf.content.length === 0) {
      appendInline(makeMention(username, null));
      return;
    }
    const last = leaf.content[leaf.content.length - 1];
    if (last && last.type === "text") {
      leaf.content.pop();
      leaf.content.push(makeMention(username, last.text));
    } else {
      leaf.content.push(makeMention(username, null));
    }
  }

  for (const tok of tokens) {
    if (tok.type === "text") {
      let text = tok.text;
      if (!text) continue;
      const inCode = currentLeaf && currentLeaf.type === "codeBlock";
      if (!inCode && !/\S/.test(text) && !currentLeaf) continue;
      const marks = currentMarks();
      if (currentLinkHref) {
        const linkMarks = [...(marks || []), { type: "link", attrs: { href: currentLinkHref } }];
        appendInline(textNode(text, linkMarks));
      } else {
        appendInline(textNode(text, marks));
      }
      continue;
    }

    if (tok.type === "self") {
      if (tok.tag === "br") {
        appendInline({ type: "hardBreak" });
      } else if (tok.tag === "img" || tok.tag === "hr") {
        unknownTags.add(tok.tag);
      }
      continue;
    }

    if (tok.type === "open") {
      const t = tok.tag;

      if (t === "p" || t === "div") {
        startLeaf("paragraph");
        continue;
      }
      if (/^h[1-6]$/.test(t)) {
        startLeaf("heading", { level: parseInt(t.slice(1), 10) });
        continue;
      }
      if (t === "blockquote") {
        finishLeaf();
        const bq = { type: "blockquote", content: [] };
        pushBlock(bq);
        containerStack.push(bq);
        continue;
      }
      if (t === "pre") {
        startLeaf("codeBlock");
        continue;
      }
      if (t === "ul" || t === "ol") {
        finishLeaf();
        const list = { type: t === "ul" ? "bulletList" : "orderedList", content: [] };
        pushBlock(list);
        containerStack.push(list);
        continue;
      }
      if (t === "li") {
        finishLeaf();
        const item = { type: "listItem", content: [] };
        pushBlock(item);
        containerStack.push(item);
        // listItem must contain at least one paragraph for inline content.
        startLeaf("paragraph");
        continue;
      }
      if (t === "strong" || t === "b") { markStack.push({ type: "strong" }); continue; }
      if (t === "em" || t === "i") { markStack.push({ type: "em" }); continue; }
      if (t === "code") {
        if (!currentLeaf || currentLeaf.type !== "codeBlock") {
          markStack.push({ type: "code" });
        }
        continue;
      }
      if (t === "a") {
        const mentionUsername = detectMentionUsername(tok.attrs);
        if (mentionUsername) {
          markStack.push({ __mention: true, username: mentionUsername });
          continue;
        }
        currentLinkHref = parseAttr(tok.attrs, "href") || null;
        continue;
      }
      if (t === "span") continue;
      unknownTags.add(t);
      continue;
    }

    if (tok.type === "close") {
      const t = tok.tag;
      if (t === "p" || t === "div") { finishLeaf(); continue; }
      if (/^h[1-6]$/.test(t)) { finishLeaf(); continue; }
      if (t === "blockquote") {
        finishLeaf();
        if (topContainer().type === "blockquote") containerStack.pop();
        continue;
      }
      if (t === "pre") { finishLeaf(); continue; }
      if (t === "ul" || t === "ol") {
        finishLeaf();
        const top = topContainer();
        if (top && (top.type === "bulletList" || top.type === "orderedList")) {
          containerStack.pop();
        }
        continue;
      }
      if (t === "li") {
        finishLeaf();
        if (topContainer().type === "listItem") containerStack.pop();
        continue;
      }
      if (t === "strong" || t === "b") { popMark("strong"); continue; }
      if (t === "em" || t === "i") { popMark("em"); continue; }
      if (t === "code") {
        if (!currentLeaf || currentLeaf.type !== "codeBlock") popMark("code");
        continue;
      }
      if (t === "a") {
        // If a mention is on the stack, the inner text we just appended IS the
        // mention's display text — replace it with a real mention node.
        let mentionFrame = null;
        for (let i = markStack.length - 1; i >= 0; i--) {
          if (markStack[i].__mention) {
            mentionFrame = markStack.splice(i, 1)[0];
            break;
          }
        }
        if (mentionFrame) {
          replaceLastTextWithMention(mentionFrame.username);
        }
        currentLinkHref = null;
        continue;
      }
      if (t === "span") continue;
      unknownTags.add(t);
      continue;
    }
  }

  finishLeaf();
  // Defensive: pop any unclosed containers.
  while (containerStack.length > 1) containerStack.pop();

  // Walk and clean: merge adjacent text, drop empty wrappers.
  const cleaned = (root.content || []).map(cleanupBlock).filter(Boolean);

  let fidelity = "adf_full";
  if (unknownTags.size > 0) fidelity = "adf_partial_unknown_nodes";
  if (cleaned.length === 0) {
    return { adf: emptyDoc(), fidelity: "plaintext_fallback", unknownTags };
  }
  return {
    adf: { type: "doc", version: 1, content: cleaned },
    fidelity,
    unknownTags,
  };
}

function cleanupBlock(block) {
  if (!block || typeof block !== "object") return null;
  if (Array.isArray(block.content)) {
    block.content = mergeAdjacentText(block.content)
      .map((c) => (c && c.type && c.type !== "text" ? cleanupBlock(c) : c))
      .filter(Boolean);
  }
  // Drop list items with no content.
  if (block.type === "listItem" && (!block.content || block.content.length === 0)) {
    return null;
  }
  // Drop lists with no items.
  if ((block.type === "bulletList" || block.type === "orderedList") &&
      (!block.content || block.content.length === 0)) {
    return null;
  }
  // Drop blockquote with no content.
  if (block.type === "blockquote" && (!block.content || block.content.length === 0)) {
    return null;
  }
  // Paragraphs with no content but with type "paragraph" → keep as spacer ONLY if not at start.
  return block;
}

/**
 * Last-resort wrapper used when the renderedBody is unparseable or the
 * converter produced an empty document. Strips tags, collapses whitespace,
 * and emits a single ADF paragraph.
 */
function plaintextAdf(text) {
  const stripped = typeof text === "string"
    ? decodeEntities(text.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim()
    : "";
  if (!stripped) return emptyDoc();
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text: stripped }] }],
  };
}

module.exports = {
  htmlToAdf,
  plaintextAdf,
  emptyDoc,
  _tokenize: tokenize,
};
