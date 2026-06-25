'use client';

/**
 * 「返回」按钮 —— 回到浏览器上一页(从控制台来就回控制台、从落地页来就回落地页),
 * 而不是固定回首页。无历史可回时(直链/新标签页打开)退回 fallbackHref(默认首页)。
 *
 * 用 window.history.back() 而非 next/navigation 的 router.back():前者无需 AppRouter
 * context,server component 直接内嵌 + renderToString 测试都不用 mock;in-app 的历史项
 * 仍会被 Next 的 popstate 拦截做客户端导航,效果等价。
 */
import type { ReactNode } from 'react';

export function BackButton({
    className,
    children,
    fallbackHref = '/',
}: {
    className?: string;
    children: ReactNode;
    fallbackHref?: string;
}) {
    return (
        <button
            type="button"
            className={className}
            onClick={() => {
                if (typeof window !== 'undefined' && window.history.length > 1) window.history.back();
                else window.location.assign(fallbackHref);
            }}
        >
            {children}
        </button>
    );
}
