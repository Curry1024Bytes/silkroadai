import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { resolveCustomerPricingTokenIdentity } from './identity';

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function readJSON(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    // Ordinary requests need no extra parse or body buffering.
    if (!value.includes('draft_task')) return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}
export function hasCustomerPricingOriginTask(body: unknown): boolean {
    const value = readJSON(body);
    if (!record(value)) return false;
    const metadata = readJSON(value.metadata);
    const contents = [value.content, record(metadata) ? metadata.content : null];
    return contents.some(
        (content) => Array.isArray(content) && content.some((item) => record(item) && item.type === 'draft_task'),
    );
}

/** Match new-api's relay credential precedence, then separate its administrator channel suffix. */
function relayKey(req: NextRequest, path: string): { value: string; hasChannelSuffix: boolean } | null {
    let auth = req.headers.get('authorization') ?? '';
    if (/(?:^|\/)v1\/messages(?:\/|$)/.test(path) || path === '/messages') auth = req.headers.get('x-api-key') || auth;
    if (path.startsWith('/v1beta/'))
        auth = req.headers.get('x-goog-api-key') || req.nextUrl.searchParams.get('key') || auth;
    auth = auth.replace(/^Bearer\s+/i, '').trim();
    if (!auth || auth === 'midjourney-proxy')
        auth = (req.headers.get('mj-api-secret') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!auth) return null;
    const parts = auth.replace(/^sk-/, '').split('-');
    if (!parts[0]) return null;
    // Non-numeric suffixes are rejected by new-api before selecting any channel.
    return { value: parts[0], hasChannelSuffix: parts.length > 1 && /^\d+$/.test(parts[1]) };
}

/**
 * An unfinished publication must not accept new consumption, including ordinary
 * requests. Native pinned-channel paths also bypass AutoGroups in rc.51 and are
 * unsupported even after a publication is verified.
 * This helper never changes models, channels, keys, bodies, or charge amounts.
 */
export async function rejectUnsupportedCustomerPricingRequest(
    req: NextRequest,
    body?: unknown,
    path = req.nextUrl.pathname,
): Promise<NextResponse | null> {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return null;
    const key = relayKey(req, path);
    if (!key) return null;
    const remix = /\/(?:v1\/)?videos\/[^/]+\/remix\/?$/.test(path);
    const unsupported = key.hasChannelSuffix || remix || hasCustomerPricingOriginTask(body);
    try {
        const identity = await resolveCustomerPricingTokenIdentity(key.value);
        if (!identity) return null;
        const bindings = await prisma.customerPricingBinding.findMany({
            where: {
                user_id: identity.userId,
                ...(identity.tierKey ? { tier_key: identity.tierKey } : { public_group: 'default' }),
            },
            select: { status: true },
            take: 2,
        });
        if (!bindings.length) return null;
        if (bindings.length !== 1 || bindings[0].status !== 'active') throw new Error('Unverified pricing binding');
        if (!unsupported) return null;
        return NextResponse.json(
            {
                error: {
                    code: 'customer_pricing_pinned_request_unsupported',
                    type: 'invalid_request_error',
                    message:
                        '当前专属价格暂不支持指定渠道、引用已有草稿任务或 remix；请提交独立任务。普通图片、视频参考 URL 不受影响。',
                },
            },
            { status: 400 },
        );
    } catch {
        return NextResponse.json(
            {
                error: {
                    code: 'customer_pricing_verification_unavailable',
                    type: 'server_error',
                    message: '暂时无法核验此请求的专属计费配置，请稍后重试。',
                },
            },
            { status: 503 },
        );
    }
}
