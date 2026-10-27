import type { Metadata } from 'next';
import { getLocale } from '@/lib/i18n/server';
import { pickMessages } from '@/lib/i18n';
import { logsMessages } from '@/lib/i18n/messages/logs';
import { LogsViewer } from './logs-viewer';

export async function generateMetadata(): Promise<Metadata> {
    return { title: pickMessages(logsMessages, await getLocale()).pageTitle };
}

/**
 * 客户「调用日志」页 —— 全功能日志(日期范围 + Request ID / 令牌 / 模型 / 渠道 搜索 + 分页)。
 * 鉴权由 (authenticated)/layout 统一守门(未登录 → /login);数据经 /api/portal/logs
 * (服务端已折叠重试中间失败 + 脱敏)。
 */
export default async function LogsPage() {
    const m = pickMessages(logsMessages, await getLocale());
    return (
        <section>
            <div className="mb-5">
                <h1 className="m-0 mb-2 text-2xl font-semibold text-navy">{m.heading}</h1>
                <p className="m-0 text-sm text-muted-ink">{m.subtitle}</p>
            </div>
            <LogsViewer />
        </section>
    );
}
