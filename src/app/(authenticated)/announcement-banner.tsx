'use client';

import { useState, useSyncExternalStore } from 'react';
import { type AnnouncementItem, DISMISSED_STORAGE_KEY, LEVEL_META, filterDismissed } from '@/lib/announcements/types';

interface Props {
    items: AnnouncementItem[];
}

/** useSyncExternalStore 的空订阅 —— 仅用它做 SSR-safe 的 isClient gate;localStorage
 *  本身不需订阅(本页 dismiss 走 sessionDismissed 即时生效)。 */
const noopSubscribe = () => () => {};

/** 读 localStorage 里已关闭的公告 id 列表(容错:无 / 坏 JSON → 空数组)。 */
function readDismissed(): string[] {
    try {
        const raw = localStorage.getItem(DISMISSED_STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * 客户控制台顶部运营公告 banner。关闭状态记在浏览器 localStorage(按公告 id),
 * 不建已读表 —— 换设备 / 清缓存会重新出现(产品决策)。
 *
 * SSR + 首帧不渲染(dismissed===null),mount 读 localStorage 后才渲染未读项,
 * 避免「已读公告闪现后又消失」的抖动。代价是公告晚一帧出现,authenticated 页
 * 无 SEO 诉求,可接受。
 */
export function AnnouncementBanner({ items }: Props) {
    // isClient gate(SSR=false → 不渲染,client=true → 渲染):保留「无闪烁」的 mount-gate
    // 效果,又不在 effect 里同步 setState(避免 react-hooks 的 cascading-render error)。
    const isClient = useSyncExternalStore(
        noopSubscribe,
        () => true,
        () => false,
    );
    // 本 session 内新关闭的 id —— 即时叠加在 localStorage 已存之上,不等 storage 事件。
    const [sessionDismissed, setSessionDismissed] = useState<string[]>([]);

    if (!isClient) return null;

    const dismissed = [...readDismissed(), ...sessionDismissed];
    const visible = filterDismissed(items, dismissed);
    if (visible.length === 0) return null;

    function handleDismiss(id: string) {
        try {
            const next = Array.from(new Set([...readDismissed(), id]));
            localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(next));
        } catch {
            // localStorage 不可用(隐私模式 / 配额满)→ 仅本次会话内关闭,不持久化。
        }
        setSessionDismissed((prev) => (prev.includes(id) ? prev : [...prev, id]));
    }

    return (
        <div className="mb-4 flex flex-col gap-2">
            {visible.map((a) => (
                <AnnouncementRow key={a.id} item={a} onDismiss={() => handleDismiss(a.id)} />
            ))}
        </div>
    );
}

export function AnnouncementRow({ item, onDismiss }: { item: AnnouncementItem; onDismiss: () => void }) {
    const meta = LEVEL_META[item.level] ?? LEVEL_META.info;
    // gotcha #20: 服务端 SSR 时 TZ=UTC,显式 Asia/Shanghai 才不串日期。
    const date = new Date(item.created_at).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return (
        <div
            role="status"
            className={[
                'flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm',
                meta.bannerClass,
            ].join(' ')}
        >
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{item.title}</span>
                    <span className="text-xs opacity-60">{date}</span>
                </div>
                {item.body && <p className="m-0 mt-1 whitespace-pre-wrap break-words opacity-90">{item.body}</p>}
                {item.link_url && (
                    <a
                        href={item.link_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-block font-medium underline"
                    >
                        {item.link_label || '查看详情'}
                    </a>
                )}
            </div>
            <button
                type="button"
                onClick={onDismiss}
                aria-label="关闭公告"
                className="shrink-0 rounded p-1 leading-none opacity-50 transition-opacity hover:opacity-100"
            >
                ✕
            </button>
        </div>
    );
}
