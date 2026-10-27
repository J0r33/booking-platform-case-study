// Excerpt 01 — Verifying a Square webhook before trusting a single byte of it
//
// What to notice:
//   * The raw body is read BEFORE parsing. The signature covers the exact bytes Square sent,
//     so parsing and re-serialising first would break verification.
//   * Every precondition fails closed: no secret -> 500, no header -> 401, undecodable
//     signature -> 401. Nothing falls through to "process it anyway".
//   * The comparison is constant-time, so response timing does not leak how many bytes matched.
//
// Edge function (Deno, Supabase). Lightly edited from production: helpers moved above the
// handler, and the rest of the handler is elided.

// Constant-time byte comparison. Returns false on length mismatch without
// short-circuiting based on contents.
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSha256Bytes(key: string, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(message),
  );
}

async function hmacSha256Base64(key: string, message: string): Promise<string> {
  const bytes = new Uint8Array(await hmacSha256Bytes(key, message));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return textResponse(405, "method not allowed");

  // 1. Read raw body BEFORE any parsing — signature is over raw bytes.
  const rawBody = await req.text();

  // 2. Signature verification.
  const signatureKey = Deno.env.get("SQUARE_WEBHOOK_SIGNATURE_KEY");
  const notificationUrl = Deno.env.get("SQUARE_WEBHOOK_URL");
  if (!signatureKey || !notificationUrl) {
    console.error("square-webhook missing required secret(s)");
    return textResponse(500, "server misconfigured");
  }

  const headerSig = req.headers.get("x-square-hmacsha256-signature");
  if (!headerSig) {
    console.error("square-webhook signature header missing");
    return textResponse(401, "unauthorized");
  }

  let expectedB64: string;
  try {
    expectedB64 = await hmacSha256Base64(signatureKey, notificationUrl + rawBody);
  } catch (e) {
    console.error("square-webhook hmac compute failed");
    await reportEdgeError({
      functionName: "square-webhook",
      error: e,
      severity: "error",
      metadata: { phase: "hmac_compute" },
    });
    return textResponse(500, "signature compute error");
  }

  let receivedBytes: Uint8Array;
  let expectedBytes: Uint8Array;
  try {
    receivedBytes = base64ToBytes(headerSig);
    expectedBytes = base64ToBytes(expectedB64);
  } catch {
    console.error("square-webhook signature decode failed");
    return textResponse(401, "unauthorized");
  }

  if (!timingSafeEqual(receivedBytes, expectedBytes)) {
    console.error("square-webhook signature mismatch");
    return textResponse(401, "unauthorized");
  }

  // ... only now is the body parsed and dispatched by event type ...
});
