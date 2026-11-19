import 'server-only';

import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db';

export interface CustomerPricingTokenIdentity {
    tokenId: number | null;
    userId: string;
    tierKey: string | null;
    source: 'customer_key' | 'system_hash' | 'legacy_system';
}

/** Canonical wire and stored representations share one hash. Never log the input value. */
export function customerPricingKeyHash(tokenValue: string): string {
    const value = tokenValue.trim().replace(/^sk-/, '');
    if (!value || /\s/.test(value)) throw new Error('Invalid customer pricing token value');
    return createHash('sha256').update(value).digest('hex');
}

export async function registerCustomerPricingTokenIdentity(args: {
    tokenId: number;
    tokenValue: string;
    userId: string;
    tierKey: string;
}): Promise<void> {
    if (!Number.isSafeInteger(args.tokenId) || args.tokenId <= 0 || !args.userId || !args.tierKey.trim())
        throw new Error('Invalid customer pricing token identity');
    const keyHash = customerPricingKeyHash(args.tokenValue);
    const existing = await prisma.customerPricingTokenIdentity.findUnique({
        where: { token_id: args.tokenId },
        select: { user_id: true },
    });
    if (existing && existing.user_id !== args.userId) throw new Error('Customer pricing token ownership changed');
    await prisma.customerPricingTokenIdentity.upsert({
        where: { token_id: args.tokenId },
        create: { token_id: args.tokenId, key_hash: keyHash, user_id: args.userId, tier_key: args.tierKey },
        update: { key_hash: keyHash, tier_key: args.tierKey },
    });
}

/** Credential ownership is resolved only from server-held records, never client metadata or IDs. */
export async function resolveCustomerPricingTokenIdentity(
    tokenValue: string,
): Promise<CustomerPricingTokenIdentity | null> {
    const bare = tokenValue.trim().replace(/^sk-/, '');
    if (!bare) return null;
    const candidates = [...new Set([bare, `sk-${bare}`])];
    const keys = await prisma.newApiToken.findMany({
        where: { newapi_token_value: { in: candidates } },
        select: { user_id: true, tier: true, newapi_token_id: true },
        take: 2,
    });
    if (keys.length > 1) throw new Error('Ambiguous customer pricing key ownership');
    if (keys.length)
        return {
            tokenId: keys[0].newapi_token_id,
            userId: keys[0].user_id,
            tierKey: keys[0].tier,
            source: 'customer_key',
        };
    const indexed = await prisma.customerPricingTokenIdentity.findUnique({
        where: { key_hash: customerPricingKeyHash(bare) },
        select: { token_id: true, user_id: true, tier_key: true },
    });
    if (indexed)
        return { tokenId: indexed.token_id, userId: indexed.user_id, tierKey: indexed.tier_key, source: 'system_hash' };
    const legacy = await prisma.user.findMany({
        where: { newapi_system_token_value: { in: candidates } },
        select: { id: true, newapi_system_token_id: true },
        take: 2,
    });
    if (legacy.length > 1) throw new Error('Ambiguous system pricing key ownership');
    if (!legacy.length) return null;
    const id = Number(legacy[0].newapi_system_token_id);
    return {
        tokenId: Number.isSafeInteger(id) && id > 0 ? id : null,
        userId: legacy[0].id,
        tierKey: null,
        source: 'legacy_system',
    };
}

/** Internal services know the public group; map it to the owner's exact Portal tier before indexing. */
export async function registerCustomerPricingSystemToken(args: {
    tokenId: number;
    tokenValue: string;
    userId: string;
    publicGroup: string;
}): Promise<void> {
    const bindings = await prisma.customerPricingBinding.findMany({
        where: { user_id: args.userId, public_group: args.publicGroup },
        select: { tier_key: true, status: true },
        take: 2,
    });
    if (bindings.length === 0) return;
    if (bindings.length !== 1 || bindings[0].status !== 'active')
        throw new Error('System token customer pricing binding is not active');
    await registerCustomerPricingTokenIdentity({ ...args, tierKey: bindings[0].tier_key });
}
