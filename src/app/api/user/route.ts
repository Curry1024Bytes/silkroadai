import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { getKeyInfo } from '@/lib/litellm/client';
import { resolveLocale } from '@/lib/locale';

export async function GET(request: NextRequest) {
    const locale = resolveLocale(request.nextUrl.searchParams.get('lang'));

    const user = await getCurrentUser(request);
    if (!user) {
        return NextResponse.json(
            { error: locale === 'en' ? 'Unauthorized' : '未授权' },
            { status: 401 },
        );
    }

    const keys = await prisma.liteLLMKey.findMany({
        where: { user_id: user.id, status: 'active' },
        orderBy: { created_at: 'asc' },
    });

    // Pull live spend from LiteLLM in parallel; fall back to cached_spend on error
    // so the portal stays usable if LiteLLM is briefly down.
    const live = await Promise.all(
        keys.map(async (k) => {
            try {
                const info = await getKeyInfo(k.litellm_key);
                return { id: k.id, spend: Number(info.info.spend ?? k.cached_spend) };
            } catch (err) {
                console.warn(`[user/route] getKeyInfo failed for key ${k.id}:`, err);
                return { id: k.id, spend: Number(k.cached_spend) };
            }
        }),
    );
    const spendById = new Map(live.map((x) => [x.id, x.spend]));

    const keysOut = keys.map((k) => {
        const spend = spendById.get(k.id) ?? Number(k.cached_spend);
        const maxBudget = Number(k.max_budget);
        return {
            id: k.id,
            key_alias: k.key_alias,
            max_budget: maxBudget,
            spend,
            balance: Math.max(0, maxBudget - spend),
            status: k.status,
            models: k.models,
        };
    });

    const total_balance = keysOut.reduce((sum, k) => sum + k.balance, 0);

    return NextResponse.json({
        portal_user: {
            id: user.id,
            email: user.email,
            nickname: user.nickname,
            avatar_url: user.avatar_url,
            email_verified: user.email_verified,
            locale: user.locale,
            status: user.status,
            created_at: user.created_at,
        },
        keys: keysOut,
        total_balance,
    });
}
