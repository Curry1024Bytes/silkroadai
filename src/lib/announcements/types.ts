/**
 * 公告(Announcement)的客户端安全类型 + 级别样式 + dismiss 纯逻辑。
 *
 * 这个文件被 client island(announcement-banner.tsx)与 admin 发布页共同引用,
 * 因此**不得** import prisma / zod / 任何 server-only 模块。级别配色单点定义,
 * 避免 banner 与 admin 两处漂移。
 */
export type AnnouncementLevel = 'info' | 'warning' | 'critical';

export const ANNOUNCEMENT_LEVELS: readonly AnnouncementLevel[] = ['info', 'warning', 'critical'] as const;

/** 客户端可见的公告形状(layout 在服务端组装后传给 banner island)。
 *  Date 已序列化成 ISO 字符串;不含 tenant_id 等内部字段。 */
export interface AnnouncementItem {
    id: string;
    title: string;
    body: string;
    level: AnnouncementLevel;
    link_url: string | null;
    link_label: string | null;
    /** ISO 字符串 — 客户端按 Asia/Shanghai 格式化展示。 */
    created_at: string;
}

interface LevelMeta {
    /** 中文级别标签(admin 列表 / 选择器用)。 */
    label: string;
    /** banner 容器配色 class(对齐 globals.css 的 status-* token)。 */
    bannerClass: string;
}

export const LEVEL_META: Record<AnnouncementLevel, LevelMeta> = {
    info: {
        label: '普通',
        bannerClass: 'bg-status-info-bg border-status-info-border text-status-info-text',
    },
    warning: {
        label: '提醒',
        bannerClass: 'bg-status-warning-bg border-status-warning-border text-status-warning-text',
    },
    critical: {
        label: '重要',
        bannerClass: 'bg-status-error-bg border-status-error-border text-status-error-text',
    },
};

/** localStorage key — 存客户已关闭(dismiss)的公告 id 数组(JSON string[])。 */
export const DISMISSED_STORAGE_KEY = 'silkroad_dismissed_announcements';

/**
 * 从全部公告里剔除已关闭的。导出为纯函数以便单测(不依赖 DOM 渲染)。
 * dismissedIds 来自 localStorage,可能含已失效(下线/删除)的 id —— 无害,
 * 不命中即可。
 */
export function filterDismissed(items: AnnouncementItem[], dismissedIds: readonly string[]): AnnouncementItem[] {
    if (dismissedIds.length === 0) return items;
    const set = new Set(dismissedIds);
    return items.filter((a) => !set.has(a.id));
}
