// Excerpt 03 — Deterministic idempotency keys for a payment API with a length limit
//
// Square deduplicates payment calls by `idempotency_key`, capped at 45 characters. Keys built
// by joining ids with hyphens grew past that limit, and Square answered with a 400 on the
// money path. The tempting fix — a random key — would silence the 400 and bring back double
// charges, because a retry would no longer match its first attempt.
//
// What to notice:
//   * The key is a pure function of the attempt's parts, so a retry always produces the same
//     key and Square collapses it.
//   * The length limit is ENFORCED in code (it throws), not just documented. The prefix is the
//     only part a future caller picks freely, so it is the only way back over the limit.
//   * The separator is chosen so ("a-b", "c") and ("a", "b-c") cannot hash to the same key.
//
// Unchanged from production apart from this header.

//     <prefix>-<first 16 bytes of SHA-256, hex>   =  prefix + 1 + 32
//
// DETERMINISM IS THE WHOLE POINT AND MUST NOT BE TRADED AWAY. Square's
// idempotency contract, and this repo's retry and dedup behaviour, both depend
// on the same logical attempt producing the same key every time. A random key
// would silence the 400 and reintroduce double charges — the exact defect these
// keys exist to prevent. SHA-256 over the caller's parts is deterministic, so a
// retry of the same attempt still collides in Square as intended.
//
// Truncating to 16 of the 32 digest bytes leaves 128 bits. These keys are not a
// security boundary — they scope a retry to one attempt, and the values fed in
// are already unique (uuids) — so a 128-bit collision domain is far past what
// the job needs, and it buys the headroom that makes the prefix readable.

/** Square's documented maximum for `idempotency_key`, on every endpoint we call. */
export const SQUARE_IDEMPOTENCY_MAX_LENGTH = 45;

/** Hex characters emitted for the truncated digest: 16 bytes → 32 chars. */
const DIGEST_HEX_LENGTH = 32;

/**
 * The longest prefix that still fits: 45 - 1 separator - 32 digest = 12.
 * Enforced rather than documented, because a prefix is the one part of the key
 * a future caller chooses freely and it is the only way back over the limit.
 */
export const SQUARE_IDEMPOTENCY_MAX_PREFIX_LENGTH =
  SQUARE_IDEMPOTENCY_MAX_LENGTH - 1 - DIGEST_HEX_LENGTH;

/**
 * Build a Square `idempotency_key` that is deterministic in `parts` and can
 * never exceed {@link SQUARE_IDEMPOTENCY_MAX_LENGTH}.
 *
 * `prefix` is for humans reading Square's dashboard — it identifies which call
 * site issued the key and never carries meaning the system depends on. `parts`
 * are what make the key unique to one attempt; pass exactly the values that
 * identify the attempt, in a stable order.
 *
 * Throws on a prefix that is too long or empty. That is a programming error
 * reachable only by editing this repo, and it is caught by the unit test rather
 * than at runtime — but it FAILS CLOSED if it ever does fire, because returning
 * an over-length key would hand Square a 400 on a money path, which is the
 * failure this module exists to remove.
 */
export async function squareIdempotencyKey(
  prefix: string,
  ...parts: readonly (string | number | null | undefined)[]
): Promise<string> {
  if (!prefix) {
    throw new Error("squareIdempotencyKey: prefix must not be empty");
  }
  if (prefix.length > SQUARE_IDEMPOTENCY_MAX_PREFIX_LENGTH) {
    throw new Error(
      `squareIdempotencyKey: prefix ${JSON.stringify(prefix)} is ` +
        `${prefix.length} chars; the maximum is ` +
        `${SQUARE_IDEMPOTENCY_MAX_PREFIX_LENGTH} so the key stays within ` +
        `Square's ${SQUARE_IDEMPOTENCY_MAX_LENGTH}-character limit`,
    );
  }

  // ` ` as the separator, so no combination of part values can collide by
  // rearranging where one part ends and the next begins. A hyphen could:
  // ("a-b", "c") and ("a", "b-c") would otherwise hash identically, and uuids
  // and ISO timestamps are full of hyphens.
  const material = parts.map((p) => (p ?? "")).join(" ");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  const hex = [...new Uint8Array(digest)]
    .slice(0, DIGEST_HEX_LENGTH / 2)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `${prefix}-${hex}`;
}
