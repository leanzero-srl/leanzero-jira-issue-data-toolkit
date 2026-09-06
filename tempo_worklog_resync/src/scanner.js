/**
 * Phase 1: Scan issues and count worklogs.
 *
 * Jira has no JQL function for "worklog count > N", so we paginate through
 * every issue matching the user-provided JQL and call GET /worklog?maxResults=1
 * to read total from the response headers without fetching all entries.
 */

class Scanner {
  constructor(client) {
    this.client = client;
  }

  /**
   * @param {string} jql - issue filter
   * @param {number} threshold - flag issues at or above this count (default 7000)
   * @returns {Array<{key, summary, worklogCount}>} sorted descending by count
   */
  async scan(jql, threshold = 7000) {
    console.log(`\nSearching: ${jql}`);
    const issues = await this.client.search(jql, "summary");
    console.log(`Found ${issues.length} issues to check\n`);

    const results = [];
    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      const key = issue.key;
      try {
        const count = await this.client.getWorklogCount(key);
        if (count >= threshold) {
          results.push({ key, summary: issue.fields?.summary || "", worklogCount: count });
        }
      } catch (err) {
        console.log(`  [${i + 1}/${issues.length}] ${key}: error (${err.statusCode || "?"})`);
      }

      if ((i + 1) % 50 === 0 || i + 1 === issues.length) {
        const flagged = results.filter((r) => r.worklogCount >= threshold).length;
        console.log(`  Progress: ${i + 1}/${issues.length} checked, ${flagged} above threshold`);
      }
    }

    results.sort((a, b) => b.worklogCount - a.worklogCount);
    return results;
  }
}

module.exports = Scanner;
