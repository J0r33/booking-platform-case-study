// Excerpt 08 — Error reports that cannot carry a member's personal data
//
// Errors from the browser and from server functions go into an error log. Error messages pick
// up whatever was nearby — an email in a failed query, a card token in a payment error — so
// every report is scrubbed on the server before it is stored, even when the client already
// scrubbed it.
//
// What to notice:
//   * Values are redacted by pattern (emails, UUIDs, Square card/customer tokens, phone
//     numbers, long numbers, URL query strings), and URL queries go first.
//   * Metadata keys that look personal are dropped entirely, not redacted.
//   * One narrow allow-list keeps plain row ids for debugging, and it switches off
//     completely in the most sensitive context rather than one key at a time.
//   * The fingerprint that groups repeats of an error is built from the SCRUBBED message, so
//     grouping never depends on personal data.
//
// Lightly edited from production: a client-specific context flag renamed to
// `sensitiveContext`, and ticket references removed. PERSONAL_KEY_RE, SENSITIVE_KEY_RE,
// OPERATIONAL_ID_KEY_SET and BARE_UUID_RE are defined elsewhere in the module.

const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SQUARE_TOKEN_RE = /\b(?:cnon|cust|ccof|src|card)_[A-Za-z0-9_-]+/g;
const PHONE_RE = /\+?\d[\d\s().-]{8,}\d/g;
const NUMERIC_RE = /\b\d{4,19}\b/g;
const URL_QUERY_RE = /(\bhttps?:\/\/[^\s?]+)\?[^\s]*/g;

export function scrubString(s: string | null | undefined, maxLen = Infinity): string {
  if (!s) return "";
  let out = String(s)
    .replace(URL_QUERY_RE, "$1")
    .replace(EMAIL_RE, "<email>")
    .replace(UUID_RE, "<uuid>")
    .replace(SQUARE_TOKEN_RE, "<token>")
    .replace(PHONE_RE, "<phone>")
    .replace(NUMERIC_RE, "<num>");
  if (out.length > maxLen) out = out.slice(0, maxLen);
  return out;
}

function scrubMetadata(
  meta: Record<string, unknown> | null | undefined,
  sensitiveContext: boolean,
): Record<string, unknown> {
  if (!meta) return sensitiveContext ? { is_sensitive_context: true } : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (PERSONAL_KEY_RE.test(k)) continue;
    if (sensitiveContext && SENSITIVE_KEY_RE.test(k)) continue;
    // The operational-id allow-list, and NEVER in a sensitive context: there the
    // whole allow-list switches off rather than one key at a time, so a future
    // key cannot slip through.
    if (!sensitiveContext && typeof v === "string" && OPERATIONAL_ID_KEY_SET.has(k) && BARE_UUID_RE.test(v.trim())) {
      out[k] = v.trim();
      continue;
    }
    if (typeof v === "string") out[k] = scrubString(v, 500);
    else if (v === null || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else {
      try { out[k] = JSON.parse(scrubString(JSON.stringify(v), 1000)); }
      catch { out[k] = "<unserializable>"; }
    }
  }
  if (sensitiveContext) out.is_sensitive_context = true;
  return out;
}

async function sha1Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function computeFingerprintInput(
  source: string,
  scrubbedMessage: string,
  stack: string | null | undefined,
): string {
  const firstFrame = (
    stack
      ?.split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("Error")) ?? ""
  ).trim();
  return `${source}:${scrubbedMessage.slice(0, 200)}:${firstFrame}`;
}

export async function scrubError(raw: RawError): Promise<ScrubbedError> {
  const sensitiveContext = raw.metadata?.is_sensitive_context === true;
  const message = scrubString(raw.message, 2000);
  const stack = raw.stack ? scrubString(raw.stack, 4000) : null;
  const fpInput = computeFingerprintInput(raw.source, message, stack);
  const fingerprint = (await sha1Hex(fpInput)).slice(0, 16);

  return {
    source: raw.source,
    severity: raw.severity ?? "error",
    message,
    stack,
    route: raw.route ? scrubString(raw.route, 500) : null,
    function_name: raw.functionName ? scrubString(raw.functionName, 100) : null,
    error_code: raw.errorCode ? scrubErrorCode(raw.errorCode) : null,
    user_role: sensitiveContext ? "sensitive_context" : (raw.userRole ?? null),
    user_agent: raw.userAgent ? scrubString(raw.userAgent, 500) : null,
    metadata: scrubMetadata(raw.metadata ?? null, sensitiveContext),
    fingerprint,
  };
}
