/**
 * JCMA enforces a 32,767-char cap on the serialized ADF JSON of descriptions
 * and comment bodies. When content from DC overflows this, Cloud stores a
 * body whose `JSON.stringify(body).length === 32767`. Detection is a strict
 * equality test on the serialized length.
 *
 * We also handle legacy/string bodies (very old Cloud sites, or null) so the
 * helper is safe to call on every issue without precondition checks.
 */

const TRUNCATION_LIMIT = 32767;

function adfJsonLength(body) {
  if (body == null) return 0;
  if (typeof body === "string") return body.length;
  return JSON.stringify(body).length;
}

function isTruncated(body) {
  return adfJsonLength(body) === TRUNCATION_LIMIT;
}

/**
 * The actionable signal for DC -> Cloud truncation lives on DC, not Cloud.
 * Any DC body whose length exceeds 32,767 would not fit Cloud's ADF JSON cap
 * and (per the user observation) gets truncated during JCMA migration.
 * For DC `body` is wiki-markup string; for Cloud `body` is ADF JSON.
 * The same helper (adfJsonLength) handles both correctly.
 */
function isOverCap(body) {
  return adfJsonLength(body) > TRUNCATION_LIMIT;
}

module.exports = { adfJsonLength, isTruncated, isOverCap, TRUNCATION_LIMIT };
