/**
 * Register-handler hooks for reseller attribution (PR-U1).
 *
 * Polymorphic invite resolution + 防控 rules in a single helper so the
 * register route stays slim.
 *
 * Resolution priority (operator calibration to design choice #3):
 *   1. Try ResellerInviteCode lookup (uppercase + is_active=true) — if hit,
 *      return reseller-attribution payload AND the original env-invite_code
 *      field stays null (the two systems are orthogonal; a customer either
 *      goes through a reseller or uses an env-allow-list code, not both).
 *   2. Fall back to the env allow-list (`isValidInviteCode`) — if hit,
 *      return the env-bonus payload (User.invite_code = raw string).
 *   3. Neither hit + code non-empty → "invalid_invite_code" error.
 *      Empty code → no attribution, no error.
 *
 * 防控 rules (executed only when the code resolves to a reseller code):
 *   #1 self-invite: reseller's owning user email == registering email →
 *      reject (return self-invite reason + record analytics event).
 *      Defense-in-depth — at register time the new user doesn't yet
 *      exist as a reseller, but operators could share their own code
 *      with their alt email; reject to stop accidental self-attribution.
 *   #2 IP throttle: ≥3 users registered from same IP in last 24h all
 *      using SAME reseller code → flag analytics event for ops review.
 *      Does NOT block registration (brief: "不阻塞但记 audit"). Threshold
 *      is "count BEFORE this insert ≥ 2" so the 3rd registration trips it.
 */
import 'server-only';
import { prisma } from '@/lib/db';
import { isValidInviteCode } from '@/lib/invite/code';
import { normalizeForLookup } from '@/lib/reseller/code';
import { computeAttributionExpiry } from '@/lib/reseller/attribution';
import { record as recordAnalytics } from '@/lib/analytics/recorder';

const IP_THROTTLE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const IP_THROTTLE_COUNT_THRESHOLD = 2; // count BEFORE current → 3rd trips it

export type ResolveOutcome =
    | { kind: 'none' /* user typed nothing */ }
    | {
          kind: 'reseller';
          inviter_code_id: string;
          inviter_reseller_id: string;
          attribution_expires_at: Date;
      }
    | { kind: 'env_invite_code'; invite_code: string /* the typed-in raw string */ }
    | { kind: 'self_invite_rejected'; resellerUserId: string }
    | { kind: 'invalid' /* neither reseller code nor env-valid */ };

export interface ResolveInput {
    /** Raw code from the form (trimmed, may be empty/undefined). */
    typedCode: string | undefined;
    /** Registering email (lowercase) — for self-invite check. */
    registeringEmail: string;
    /** Now() for the attribution_expires_at calc + cron determinism in tests. */
    now: Date;
}

/**
 * Resolve a typed invite code into one of:
 *   - 'none'                  — empty input, no attribution
 *   - 'reseller'              — code maps to a ResellerInviteCode (active)
 *   - 'env_invite_code'       — code maps to env INVITE_CODES allow-list
 *   - 'self_invite_rejected'  — code maps to a Reseller whose owning user
 *                                email == registering email (防控 #1)
 *   - 'invalid'               — code present but doesn't match either
 *
 * Caller's responsibility:
 *   - kind=='reseller' → set User.inviter_code_id / inviter_reseller_id /
 *     attribution_expires_at and DO NOT set User.invite_code.
 *   - kind=='env_invite_code' → set User.invite_code = invite_code (as-typed).
 *   - kind=='self_invite_rejected' / 'invalid' → return 400 to client.
 */
export async function resolveInviteCode(input: ResolveInput): Promise<ResolveOutcome> {
    const normalized = normalizeForLookup(input.typedCode);
    if (!normalized) return { kind: 'none' };

    // Path A: try ResellerInviteCode (uppercase column, unique).
    const resellerCode = await prisma.resellerInviteCode.findUnique({
        where: { code: normalized },
        select: {
            id: true,
            reseller_id: true,
            is_active: true,
            reseller: {
                select: {
                    status: true,
                    user: { select: { email: true } },
                },
            },
        },
    });
    if (resellerCode && resellerCode.is_active && resellerCode.reseller.status === 'active') {
        // 防控 #1: self-invite — code's owning user's email matches
        // registering email (case-insensitive, both already lowercased).
        if (resellerCode.reseller.user.email.toLowerCase() === input.registeringEmail.toLowerCase()) {
            return { kind: 'self_invite_rejected', resellerUserId: resellerCode.reseller_id };
        }
        return {
            kind: 'reseller',
            inviter_code_id: resellerCode.id,
            inviter_reseller_id: resellerCode.reseller_id,
            attribution_expires_at: computeAttributionExpiry(input.now),
        };
    }

    // Path B: env allow-list (W7 D4). Case-insensitive — isValidInviteCode
    // lowercases internally so we pass the typed-as-is to preserve casing
    // for the User.invite_code value (analytics may care about casing).
    if (input.typedCode && isValidInviteCode(input.typedCode)) {
        return { kind: 'env_invite_code', invite_code: input.typedCode.trim() };
    }

    // Neither matched.
    return { kind: 'invalid' };
}

/**
 * 防控 #2 IP throttle check. Called AFTER `prisma.user.create()` so the
 * just-inserted row is included in the count (so threshold semantics are
 * "the 3rd in the window trips").
 *
 * Effect: NEVER blocks the register flow. Records an analytics event
 * with the relevant identifiers so ops can review. Returns boolean for
 * the test harness to assert on.
 */
export async function checkIpThrottleAndFlag(args: {
    signup_ip: string | null;
    inviter_code_id: string | null;
    inviter_reseller_id: string | null;
    new_user_id: string;
    now: Date;
}): Promise<{ flagged: boolean; count?: number }> {
    if (!args.signup_ip || !args.inviter_code_id) {
        // No IP captured (dev / curl) or non-reseller path → skip.
        return { flagged: false };
    }
    const since = new Date(args.now.getTime() - IP_THROTTLE_WINDOW_MS);
    // Count all users in the 24h window with same IP AND same inviter code.
    // Includes the just-inserted row → threshold check ">=" the operator
    // value (3) trips.
    const count = await prisma.user.count({
        where: {
            signup_ip: args.signup_ip,
            inviter_code_id: args.inviter_code_id,
            created_at: { gte: since },
        },
    });
    if (count > IP_THROTTLE_COUNT_THRESHOLD) {
        await recordAnalytics({
            userId: args.new_user_id,
            eventType: 'reseller_signup_ip_throttle_flagged',
            properties: {
                signup_ip: args.signup_ip,
                inviter_code_id: args.inviter_code_id,
                inviter_reseller_id: args.inviter_reseller_id,
                count_in_window: count,
                window_hours: 24,
            },
        });
        return { flagged: true, count };
    }
    return { flagged: false, count };
}
