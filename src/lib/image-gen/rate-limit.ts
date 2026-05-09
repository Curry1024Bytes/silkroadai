/**
 * In-memory sliding-window rate limiter for image gen (PR-T1 Phase 3).
 *
 * Why in-memory: portal runs as a single Node container today (W6 D2
 * scheduler analysis confirmed); Redis would add infra cost without
 * a multi-instance need. PR-T1 brief explicitly bans new deps beyond
 * @aws-sdk/client-s3, so we use process-local state.
 *
 * Trade-offs accepted (recorded for the day we bump to multi-instance):
 *   - Container restart resets the window — customers in the middle of
 *     a 60s window get a free re-spend. Cap is generous enough (10
 *     calls/min) that this isn't an abuse vector at single-instance
 *     scale.
 *   - Two containers = each enforces 10/min independently → effective
 *     20/min per user. Fix is to swap this module for a Redis-backed
 *     ZADD/ZRANGEBYSCORE primitive — interface stays the same.
 *
 * Sliding window vs fixed bucket: customer hitting "regenerate" rapidly
 * across the minute boundary should not get burst-paid; sliding gives
 * them a steady max-rate. Implementation = trim timestamps older than
 * windowMs, then check size.
 *
 * The store is a `Map<string, number[]>` keyed by `${userId}:${scope}`
 * with values = ms timestamps. We periodically prune empty/stale
 * entries from a setInterval to keep memory bounded under churn.
 */

interface Bucket {
    timestamps: number[];
}

const store = new Map<string, Bucket>();

const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_HITS = 10;
/** Periodic prune cadence — quiet enough not to burn cycles, frequent
 *  enough to bound memory under user churn. */
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

let pruneTimer: ReturnType<typeof setInterval> | null = null;

function ensurePruneTimer(): void {
    if (pruneTimer) return;
    pruneTimer = setInterval(() => {
        const cutoff = Date.now() - DEFAULT_WINDOW_MS;
        for (const [key, bucket] of store.entries()) {
            // Drop buckets whose newest timestamp is older than the
            // window — they can't possibly contribute to a future
            // `check` and re-creating one is cheap.
            if (bucket.timestamps.length === 0 || bucket.timestamps[bucket.timestamps.length - 1] < cutoff) {
                store.delete(key);
            }
        }
    }, PRUNE_INTERVAL_MS);
    // Detach from event loop so it doesn't keep the process alive in
    // tests (`unref` is missing on some platforms; defensive optional).
    pruneTimer.unref?.();
}

export interface RateLimitResult {
    /** True = allowed (the call was admitted + recorded). False = rejected. */
    allowed: boolean;
    /** How many calls remain in this window after this admission. */
    remaining: number;
    /** When the current window's earliest hit ages out — a soft hint
     *  for the caller to surface "retry after N s". */
    retryAfterMs: number;
}

export interface RateLimitOptions {
    windowMs?: number;
    maxHits?: number;
    /** Discriminator so different operations on the same user don't share
     *  buckets (e.g. `image_gen` vs a future `image_describe`). */
    scope?: string;
}

/**
 * Sliding-window check + record. If allowed, the current call's
 * timestamp is appended; if rejected, no mutation.
 *
 * Idempotent in the rejection path; the caller doesn't need to roll
 * anything back. In the allowed path, the timestamp is committed
 * before the actual work runs — a downstream failure won't refund the
 * slot, which is the intended semantic (an attempt counts).
 */
export function rateLimitCheck(userId: string, options: RateLimitOptions = {}): RateLimitResult {
    ensurePruneTimer();
    const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    const maxHits = options.maxHits ?? DEFAULT_MAX_HITS;
    const scope = options.scope ?? 'image_gen';
    const key = `${userId}:${scope}`;
    const now = Date.now();
    const cutoff = now - windowMs;

    const bucket = store.get(key) ?? { timestamps: [] };
    // In-place trim: cheap and keeps allocations down for hot users.
    while (bucket.timestamps.length > 0 && bucket.timestamps[0] < cutoff) {
        bucket.timestamps.shift();
    }

    if (bucket.timestamps.length >= maxHits) {
        // Reject — earliest timestamp tells the caller when capacity frees.
        const oldest = bucket.timestamps[0];
        const retryAfterMs = Math.max(0, oldest + windowMs - now);
        return { allowed: false, remaining: 0, retryAfterMs };
    }

    bucket.timestamps.push(now);
    if (!store.has(key)) store.set(key, bucket);

    return {
        allowed: true,
        remaining: maxHits - bucket.timestamps.length,
        retryAfterMs: 0,
    };
}

/** Test-only: clear buckets so a fresh harness sees deterministic
 *  state. Don't call in prod paths. */
export function _resetRateLimitForTest(): void {
    store.clear();
}
