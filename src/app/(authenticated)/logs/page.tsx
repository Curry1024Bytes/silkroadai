import type { Metadata } from 'next';
import { LogsViewer } from './logs-viewer';

export const metadata: Metadata = { title: '调用日志 · Silk Road AI' };

/**
 * 客户「调用日志」页 —— 全功能日志(日期范围 + Request ID / 令牌 / 模型 / 渠道 搜索 + 分页)。
 * 鉴权由 (authenticated)/layout 统一守门(未登录 → /login);数据经 /api/portal/logs
 * (服务端已折叠重试中间失败 + 脱敏)。
 */
export default function LogsPage() {
    return (
        <section>
            <div className="mb-5">
                <h1 className="m-0 mb-2 text-2xl font-semibold text-navy">调用日志</h1>
                <p className="m-0 text-sm text-muted-ink">
                    按日期范围,以及 Request ID / 令牌 / 模型 / 渠道 搜索每一次调用;失败的调用可展开查看详情。
                </p>
            </div>
            <LogsViewer />
        </section>
    );
}
