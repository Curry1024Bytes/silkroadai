/**
 * 拉取对某客户可见的 active 公告(server-only)。被 `(authenticated)/layout.tsx`
 * 调用 —— 抽成 helper 是为了让 layout 单测能 mock 掉它(layout 测试不连 prisma,
 * 镜像 fetchResellerStatus 的做法)。
 */
import { cache } from 'react';
import { prisma } from '@/lib/db';
import type { AnnouncementItem, AnnouncementLevel } from './types';

/** 单请求最多展示几条 active 公告 —— 防运营忘下线堆积压垮 banner 区。 */
const MAX_ACTIVE = 5;

/**
 * 可见公告 = 平台全局(tenant_id=null) + 该客户所属租户(若有)。按 created_at
 * 倒序(最新在上),take MAX_ACTIVE。Date → ISO 序列化交给 client island,内部
 * 字段(tenant_id)不外泄。React cache():同一请求内多处读取共享一次查询。
 */
export const getActiveAnnouncements = cache(async (tenantId: string | null): Promise<AnnouncementItem[]> => {
    const rows = await prisma.announcement.findMany({
        where: {
            is_active: true,
            OR: [{ tenant_id: null }, ...(tenantId ? [{ tenant_id: tenantId }] : [])],
        },
        orderBy: { created_at: 'desc' },
        take: MAX_ACTIVE,
        select: {
            id: true,
            title: true,
            body: true,
            level: true,
            link_url: true,
            link_label: true,
            created_at: true,
        },
    });
    return rows.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        level: r.level as AnnouncementLevel,
        link_url: r.link_url,
        link_label: r.link_label,
        created_at: r.created_at.toISOString(),
    }));
});
