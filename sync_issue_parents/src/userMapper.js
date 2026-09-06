const fs = require("fs");
const path = require("path");

/**
 * Resolves DC users → Cloud accountIds via /rest/api/3/user/search.
 *
 * Persistence: write-through JSON cache keyed by DC username. Reused across
 * --resume runs by pointing the same `cacheFilePath` at it. Failure outcomes
 * (no_match / ambiguous_N / lookup_error) are also cached to avoid hammering
 * /user/search for the same unresolved usernames on every run — wipe the
 * relevant entries by hand if you fix the underlying user and want a re-lookup.
 *
 * Endpoint behavior (from Atlassian OpenAPI spec):
 *   GET /rest/api/3/user/search?query=<str>&maxResults=50
 *   `query` matches displayName + emailAddress (prefix). Response is User[].
 *   Email/displayName may be null per the user's privacy settings.
 *   Writes to Cloud require accountId — name/key are deprecated.
 */
class UserMapper {
  constructor(cloudClient, options = {}) {
    this.cloudClient = cloudClient;
    this.cacheFilePath = options.cacheFilePath || null;
    this.log = options.log || console.log;

    this.cache = {};
    this.stats = {
      cacheHits: 0,
      lookupCalls: 0,
      resolved: 0,
      noMatch: 0,
      ambiguous: 0,
      errors: 0,
    };

    if (this.cacheFilePath && fs.existsSync(this.cacheFilePath)) {
      try {
        this.cache = JSON.parse(fs.readFileSync(this.cacheFilePath, "utf8"));
        this.log(
          `  [user-map] Loaded ${Object.keys(this.cache).length} cached entries from ${this.cacheFilePath}`,
        );
      } catch (e) {
        this.log(`  [user-map] Failed to load cache (${e.message}) — starting fresh`);
        this.cache = {};
      }
    }
  }

  /**
   * Resolve one DC user → Cloud accountId.
   * @param {{ name: string|null, emailAddress: string|null, displayName: string|null }} dcUser
   * @returns {Promise<{ accountId: string|null, source: string|null, note: string|null,
   *                    candidateCount: number, displayName: string|null, emailAddress: string|null }>}
   */
  async resolve(dcUser) {
    const name = dcUser?.name || null;
    const email = dcUser?.emailAddress || null;
    const displayName = dcUser?.displayName || null;

    if (!name && !email) {
      return {
        accountId: null,
        source: null,
        note: "lookup_error: dc user has neither name nor email",
        candidateCount: 0,
        displayName: null,
        emailAddress: null,
      };
    }

    // Two-segment key avoids collisions between a DC username that literally
    // starts with "email||" and an email-keyed entry. Extremely unlikely in
    // practice but cheap to guard against.
    const cacheKey = name ? `name||${name}` : `email||${email}`;
    if (this.cache[cacheKey]) {
      const cached = this.cache[cacheKey];
      this.stats.cacheHits++;
      // Also mirror the original resolution outcome into the totals so the
      // plan summary reports cumulative numbers, not just first-time lookups.
      if (cached.accountId) this.stats.resolved++;
      else if (cached.note === "no_match") this.stats.noMatch++;
      else if (cached.note && cached.note.startsWith("ambiguous_")) this.stats.ambiguous++;
      else if (cached.note && cached.note.startsWith("lookup_error")) this.stats.errors++;
      return { ...cached, source: "cache" };
    }

    // First pass: search by DC username (Cloud /user/search matches on
    // displayName + emailAddress prefix, so this works when the Cloud
    // displayName starts with the DC username, OR when the email's
    // local-part starts with the DC username).
    let { result } = await this._searchAndPick(name, dcUser);

    // Fallback: search by email if username search yielded nothing.
    if (!result.accountId && email && email !== name) {
      const fallback = await this._searchAndPick(email, dcUser);
      // Prefer the email result if it actually picks a user. If both searches
      // were ambiguous we keep the ORIGINAL username result — promoting an
      // ambiguous fallback would only confuse the operator about which set of
      // candidates is reported in the note.
      if (fallback.result.accountId) {
        result = fallback.result;
      } else if (result.note === "no_match" && fallback.result.note) {
        result.note = fallback.result.note;
        result.candidateCount = fallback.result.candidateCount;
      }
    }

    // Stamp the dc-user metadata so the cache file is self-explanatory.
    result.displayName = displayName;
    result.emailAddress = email;

    this.cache[cacheKey] = { ...result, lookedUpAt: new Date().toISOString() };

    // Update stats
    if (result.accountId) this.stats.resolved++;
    else if (result.note === "no_match") this.stats.noMatch++;
    else if (result.note && result.note.startsWith("ambiguous_")) this.stats.ambiguous++;
    else if (result.note && result.note.startsWith("lookup_error")) this.stats.errors++;

    return result;
  }

  async _searchAndPick(query, dcUser) {
    this.stats.lookupCalls++;
    let matches = [];
    try {
      matches = await this.cloudClient.searchUsers(query, 50);
    } catch (e) {
      return {
        result: {
          accountId: null,
          source: null,
          note: `lookup_error: ${e.message.substring(0, 200)}`,
          candidateCount: 0,
          displayName: null,
          emailAddress: null,
        },
      };
    }

    // Atlassian users only — exclude "app" service accounts and "customer"
    // (Jira Service Desk portal users) since neither can be issue reporters
    // on a standard board.
    const candidates = matches.filter(
      (m) => (m.accountType || "atlassian") === "atlassian",
    );

    if (candidates.length === 0) {
      return {
        result: {
          accountId: null,
          source: null,
          note: "no_match",
          candidateCount: 0,
          displayName: null,
          emailAddress: null,
        },
      };
    }

    if (candidates.length === 1) {
      const c = candidates[0];
      return {
        result: {
          accountId: c.accountId,
          source: "single-match",
          note: null,
          candidateCount: 1,
          displayName: c.displayName || null,
          emailAddress: c.emailAddress || null,
        },
      };
    }

    // Disambiguate (heuristic lifted from set-read-only-cloud/draft_user_map.js).
    const lowerName = (dcUser?.name || "").toLowerCase();
    const lowerEmail = (dcUser?.emailAddress || "").toLowerCase();

    // 1. Exact email match
    let pick = lowerEmail
      ? candidates.find((m) => (m.emailAddress || "").toLowerCase() === lowerEmail)
      : null;
    let source = pick ? "exact" : null;

    // 2. Email local-part matches DC username
    if (!pick && lowerName) {
      pick = candidates.find(
        (m) => (m.emailAddress || "").toLowerCase().split("@")[0] === lowerName,
      );
      if (pick) source = "email-localpart";
    }

    // 3. displayName contains DC username
    if (!pick && lowerName) {
      pick = candidates.find(
        (m) => (m.displayName || "").toLowerCase().includes(lowerName),
      );
      if (pick) source = "displayname-contains";
    }

    if (pick) {
      return {
        result: {
          accountId: pick.accountId,
          source,
          note: null,
          candidateCount: candidates.length,
          displayName: pick.displayName || null,
          emailAddress: pick.emailAddress || null,
        },
      };
    }

    // Still ambiguous — refuse to guess.
    return {
      result: {
        accountId: null,
        source: null,
        note: `ambiguous_${candidates.length}`,
        candidateCount: candidates.length,
        displayName: null,
        emailAddress: null,
      },
    };
  }

  flushCache() {
    if (!this.cacheFilePath) return;
    try {
      const dir = path.dirname(this.cacheFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this.cacheFilePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2));
      fs.renameSync(tmp, this.cacheFilePath);
    } catch (e) {
      this.log(`  [user-map] WARN: failed to write cache: ${e.message}`);
    }
  }

  getStats() {
    return { ...this.stats, cacheSize: Object.keys(this.cache).length };
  }
}

module.exports = UserMapper;
