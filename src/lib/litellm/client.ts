// ============================================
// W2 D6 — LEGACY LITELLM SHIM (compile-only)
// ============================================
//
// W1 used `src/lib/litellm/client.ts` as the upstream backend wrapper.
// W2 D5 archived that real client to `src/lib/litellm.archive/client.ts`
// and replaced the upstream with `src/lib/newapi/client.ts`.
//
// This file exists only to keep ~17 legacy admin/subscription/orders
// route handlers compiling during the B3 transition. Each function
// returns the same null/[]/throw shape as the W1 D5 R3 stubs so callers
// don't crash at module load — they just see "no data" or get an error.
//
// Removal plan:
//   - W3+ will rewrite or delete the legacy routes (orders/*, users/[id],
//     channels/*, subscription*, admin/litellm/*).
//   - When all callers are gone, delete this file.
//
// Find call sites:
//   grep -rn "from '@/lib/litellm/client'" src --include='*.ts' --include='*.tsx'
//
// New code MUST NOT import from here. Use @/lib/newapi/client.

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */

/** @deprecated B3: portal sessions go through src/lib/auth/session.ts now. */
export async function getCurrentUserByToken(_token: string): Promise<any> {
    return null;
}

/** @deprecated B3: use prisma.user.findUnique for portal users. */
export async function getUser(_userId: string | number | null): Promise<any> {
    return null;
}

/** @deprecated B3: subscription model is on hold (R3). */
export async function getUserSubscriptions(_userId: string | number | null): Promise<any[]> {
    return [];
}

/** @deprecated B3: subscription model is on hold (R3). */
export async function listSubscriptions(_args?: any): Promise<any> {
    return { items: [], total: 0, page: 1, page_size: 50 };
}

/** @deprecated B3: group/channel UI shows "no data" until decided. */
export async function getAllGroups(): Promise<any[]> {
    return [];
}

/** @deprecated B3: group/channel UI shows "no data" until decided. */
export async function getGroup(_groupId: string | number | null): Promise<any> {
    return null;
}

/** @deprecated B3: admin user search is now via new-api admin UI. */
export async function searchUsers(_query: string): Promise<any[]> {
    return [];
}

/** @deprecated B3: recharge flow goes through @/lib/newapi/client applyTopup. */
export async function createAndRedeem(..._args: unknown[]): Promise<never> {
    throw new Error('createAndRedeem is deprecated — use new-api applyTopup');
}

/** @deprecated B3: balance lives on new-api side, no separate user balance. */
export async function subtractBalance(..._args: unknown[]): Promise<never> {
    throw new Error('subtractBalance is deprecated — new-api tracks quota per user');
}

/** @deprecated B3: balance lives on new-api side, no separate user balance. */
export async function addBalance(..._args: unknown[]): Promise<never> {
    throw new Error('addBalance is deprecated — use new-api applyTopup');
}

/** @deprecated B3: subscription extension on hold (R3). */
export async function extendSubscription(..._args: unknown[]): Promise<never> {
    throw new Error('extendSubscription is deprecated — subscriptions on hold (R3)');
}

/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
