import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { Prisma, type Tenant } from '@prisma/client';
import { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID, PLATFORM_TENANT_SLUG } from '@/lib/admin/tenant-scope';

/**
 * P6a — 按请求 Host 头解析租户(白标地基)。
 *
 * ⚠️ 永不抛、永不 500:任何解析失败 / 无匹配域名 / DB 抖动 → 兜底平台主体。
 * 客户侧 header/logo/品牌色/客服联系都从解析出的 Tenant 渲染;平台主体字段已在
 * add_tenant_branding migration 回填为现状值,故平台域渲染不变。
 *
 * 不做鉴权 / 不挡请求 —— 只是"这个域名属于哪个租户"。
 */

/** DB 完全不可用时的最后兜底(平台主体 in-memory 形态,镜像 migration 回填值)。 */
const PLATFORM_FALLBACK: Tenant = {
    id: PLATFORM_TENANT_ID,
    slug: PLATFORM_TENANT_SLUG,
    brand_name: 'Silk Road AI',
    primary_domain: 'silkroadai.io',
    status: 'active',
    prepaid_balance_cny: new Prisma.Decimal(0),
    logo_url: null,
    primary_color: '#1a2540',
    support_email: 'support@silkroadai.io',
    support_wechat: 'Global_Ads',
    domains: ['silkroadai.io', 'www.silkroadai.io', 'ai.silkroadai.io'],
    signup_enabled: true,
    created_at: new Date(0),
    updated_at: new Date(0),
};

/** 平台主体租户(每请求缓存一次)。DB 读失败 → in-memory 兜底,绝不抛。 */
const getPlatformTenant = cache(async (): Promise<Tenant> => {
    try {
        const t = await prisma.tenant.findUnique({ where: { id: PLATFORM_TENANT_ID } });
        return t ?? PLATFORM_FALLBACK;
    } catch {
        return PLATFORM_FALLBACK;
    }
});

/** `example.com:443` / `Example.COM.` → `example.com`。 */
export function normalizeHost(host: string | null | undefined): string {
    if (!host) return '';
    return host
        .split(',')[0] // 多 Host(代理叠加)取第一个
        .split(':')[0] // 剥端口
        .trim()
        .toLowerCase()
        .replace(/\.$/, ''); // 剥 FQDN 尾点
}

/**
 * 按 Host 解析租户。匹配 `Tenant.domains`(数组含)或 `primary_domain`;无匹配 → 平台主体。
 * 每请求按 host 缓存一次 DB。
 */
export const resolveTenantByHost = cache(async (host: string | null): Promise<Tenant> => {
    const h = normalizeHost(host);
    if (!h) return getPlatformTenant();
    try {
        const match = await prisma.tenant.findFirst({
            where: { OR: [{ domains: { has: h } }, { primary_domain: h }] },
        });
        return match ?? (await getPlatformTenant());
    } catch {
        return getPlatformTenant();
    }
});

/** 读当前请求的 Host → 解析租户(server 组件/handler 用)。每请求缓存一次。 */
export const getCurrentTenant = cache(async (): Promise<Tenant> => {
    try {
        const h = await headers();
        return resolveTenantByHost(h.get('host'));
    } catch {
        return getPlatformTenant();
    }
});

/** 客户侧渲染只需要这些品牌字段。 */
export interface TenantBrand {
    brand_name: string;
    logo_url: string | null;
    primary_color: string | null;
    support_email: string | null;
    support_wechat: string | null;
}

export function tenantBrand(t: Tenant): TenantBrand {
    return {
        brand_name: t.brand_name,
        logo_url: t.logo_url,
        primary_color: t.primary_color,
        support_email: t.support_email,
        support_wechat: t.support_wechat,
    };
}
