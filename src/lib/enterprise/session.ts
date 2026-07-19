/**
 * 独立门户 dashboard 会话守门(P2)。
 *
 * 复用主站 JWT cookie 会话(getCurrentUser),再加一道「企业客户」判定:
 * 有 enterprise_upstream_keys 行(一客户一把,P1 开户时建)才算 —— 主站普通客户
 * 的 cookie(即使跨域名带过来)进不了企业 dashboard。
 */
import 'server-only';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import type { User } from '@prisma/client';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';

/** API route 用:NextRequest → 企业客户 User(非企业/未登录 → null)。 */
export async function requireEnterpriseUser(req: NextRequest): Promise<User | null> {
    const user = await getCurrentUser(req);
    if (!user) return null;
    const up = await prisma.enterpriseUpstreamKey.findUnique({
        where: { user_id: user.id },
        select: { id: true },
    });
    return up ? user : null;
}

/** Server component 用:headers() → NextRequest 桥接(同 (authenticated)/layout 模式)。 */
export async function getEnterpriseSessionUser(): Promise<User | null> {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/enterprise', { method: 'GET', headers: { cookie } });
    return requireEnterpriseUser(req);
}
