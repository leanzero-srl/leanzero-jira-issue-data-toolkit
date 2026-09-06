const fs = require("fs");
const crypto = require("crypto");

/**
 * Build an RFC-7578 multipart/form-data envelope with a single `file` part.
 *
 * Returns:
 *   {
 *     boundary,
 *     contentType,        // value for the request Content-Type header
 *     contentLength,      // exact byte count of the full body (preamble+file+closer)
 *     createBodyStream()  // factory: returns a fresh Readable each call (retry-safe)
 *   }
 *
 * The factory is recreatable so the upload client can re-send the body on a
 * 429/5xx retry without buffering the file in memory.
 *
 * Form field name is always `file` — the Jira Cloud add-attachment endpoint
 * (`POST /rest/api/3/issue/{key}/attachments`) expects exactly that.
 */
function buildSingleFileMultipart({ filePath, filename, mimeType }) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  const boundary =
    "----nodeAttachmentBoundary" +
    Date.now().toString(36) +
    crypto.randomBytes(8).toString("hex");

  const safeName = String(filename || "file")
    .replace(/[\r\n]/g, "")
    .replace(/"/g, '\\"');
  const ct = mimeType || "application/octet-stream";

  const preamble = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
      `Content-Type: ${ct}\r\n\r\n`,
    "utf8",
  );
  const closer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

  const contentLength = preamble.length + fileSize + closer.length;
  const contentType = `multipart/form-data; boundary=${boundary}`;

  function createBodyStream() {
    const { PassThrough } = require("stream");
    const out = new PassThrough();
    out.write(preamble);
    const fileStream = fs.createReadStream(filePath);
    fileStream.on("error", (err) => out.destroy(err));
    fileStream.on("end", () => out.end(closer));
    fileStream.pipe(out, { end: false });
    return out;
  }

  return { boundary, contentType, contentLength, createBodyStream };
}

module.exports = { buildSingleFileMultipart };
