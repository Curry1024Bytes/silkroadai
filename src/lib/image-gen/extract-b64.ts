/**
 * Extract base64-encoded images from a Gemini chat-completions response.
 *
 * Gemini-class image SKUs (Nano Banana / 3.1-flash-image / 3-pro-image)
 * are exposed via /v1/chat/completions; the response shape is:
 *
 *   {
 *     "choices": [{
 *       "message": {
 *         "role": "assistant",
 *         "content": "Here is a tiny cat:\n![image](data:image/png;base64,iVBORw0KGgo...)"
 *       }
 *     }]
 *   }
 *
 * The actual image lives inline as a data: URI inside a markdown image
 * link (or, more rarely, inside an HTML `<img src="...">`). One response
 * may contain N inline images if the model decided to return multiples
 * (Google docs say it can; in practice 2.5-flash-image returns 1).
 *
 * This helper extracts ALL base64 payloads from a content string and
 * returns them as Buffers. Used by `/api/portal/image/generate` for the
 * `apiPath: 'chat/completions'` branch.
 *
 * Pure / side-effect-free / testable.
 */

const DATA_URI_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/g;

/** Decoded image with a hint at the original mime type from the data URI. */
export interface DecodedImage {
    buffer: Buffer;
    mime: string;
}

/**
 * Pull every `data:image/...;base64,...` payload from `content`. Returns
 * an empty array if none found (caller should treat as "model refused
 * / safety-filter / empty response" and surface a 502 with a friendly
 * message).
 *
 * Skips obvious garbage (decode failures) so a malformed payload
 * doesn't blow up the whole batch.
 */
export function extractB64Images(content: string): DecodedImage[] {
    const out: DecodedImage[] = [];
    if (typeof content !== 'string' || content.length === 0) return out;

    // Pull the mime back out so we can be honest about jpeg vs png on the
    // R2 upload's Content-Type. Re-use the same regex but in non-`g` mode
    // for the per-match capture; `matchAll` gives us both.
    const matches = content.matchAll(/data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/g);

    for (const m of matches) {
        const mime = m[1];
        const b64 = m[2];
        if (!b64 || b64.length < 16) continue; // guard against tiny garbage matches
        try {
            out.push({ buffer: Buffer.from(b64, 'base64'), mime });
        } catch {
            // Malformed base64; skip but don't fail the whole batch.
        }
    }
    return out;
}

// Re-exported only so a test file can pin the regex shape without
// duplicating the literal. Don't reach for this in route code — use
// `extractB64Images()` instead.
export const _DATA_URI_RE_FOR_TESTS = DATA_URI_RE;
