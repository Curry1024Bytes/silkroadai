import type { Metadata } from 'next';
import { LogsViewer } from './logs-viewer';

export const metadata: Metadata = { title: '调用日志 · LLmRoute' };

/**
 * 客户「调用日志」页 —— 全功能日志(日期范围 + Request ID / 令牌 / 模型 / 渠道 搜索 + 分页)。
 * 鉴权由 (authenticated)/layout 统一守门(未登录 → /login);数据经 /api/portal/logs
 * (服务端已折叠重试中间失败 + 脱敏)。
 */
export default function LogsPage() {
    return (
        <section className="space-y-6">
            <div>
                <p className="m-0 mb-1 text-xs font-semibold text-portal-gold">ACTIVITY</p>
                <h1 className="m-0 text-[28px] font-semibold leading-tight text-portal-ink">调用日志</h1>
                <p className="m-0 mt-2 max-w-3xl text-sm leading-relaxed text-portal-muted">
                    按时间、Request ID、密钥、模型或渠道定位每一次调用，失败记录可展开查看详情。
                </p>
            </div>
            <LogsViewer />
        </section>
    );
}
