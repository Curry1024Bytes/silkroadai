import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Activity, ArrowUpRight, BarChart3, Coins, Database, Wallet } from 'lucide-react';
import Link from 'next/link';
import { FormError } from '@/components/ui/FormError';
import { quotaToCny } from '@/lib/newapi/client';
import { ModelConsumptionChartLazy } from './model-consumption-chart-lazy';
import { CallDetailTable } from './call-detail-table';
import type { BalanceData, UsageData } from './sections';
function MetricCell({
    icon: Icon,
    label,
    value,
    detail,
    className,
}: {
    icon: LucideIcon;
    label: string;
    value: ReactNode;
    detail: ReactNode;
    className?: string;
}) {
    return (
        <article className={['min-w-0 p-5 sm:p-6', className ?? ''].filter(Boolean).join(' ')}>
            <div className="mb-7 flex items-center justify-between gap-3">
                <p className="m-0 text-sm font-medium text-portal-muted">{label}</p>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-accent-soft text-brand-accent">
                    <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
                </span>
            </div>
            <p className="m-0 truncate font-display text-2xl font-semibold text-portal-ink tabular-nums sm:text-[28px]">
                {value}
            </p>
            <p className="m-0 mt-2 text-xs text-portal-subtle tabular-nums">{detail}</p>
        </article>
    );
}

const NO_DATA = <span className="text-base font-medium text-portal-subtle">暂无数据</span>;

export async function PortalBalance({ data }: { data: Promise<BalanceData> }) {
    const { bal } = await data;
    return (
        <article className="relative overflow-hidden rounded-lg border border-portal-line bg-portal-panel p-6 shadow-portal lg:col-span-4 lg:min-h-[220px]">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <p className="m-0 text-sm font-medium text-portal-muted">当前余额</p>
                    <div className="mt-4">
                        {bal ? (
                            <p className="m-0 font-display text-[38px] font-semibold leading-none text-portal-ink tabular-nums">
                                ¥{bal.balanceCny.toFixed(2)}
                            </p>
                        ) : (
                            <p className="m-0 text-base font-medium text-portal-subtle">暂无数据</p>
                        )}
                    </div>
                </div>
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-accent-soft text-brand-accent">
                    <Wallet size={20} strokeWidth={1.7} aria-hidden="true" />
                </span>
            </div>

            <div className="mt-8 flex items-end justify-between gap-4 border-t border-portal-line pt-4">
                <div>
                    <p className="m-0 text-xs text-portal-subtle">历史消费</p>
                    <p className="m-0 mt-1 font-display text-lg font-semibold text-portal-ink tabular-nums">
                        {bal ? `¥${bal.spentCny.toFixed(2)}` : '暂无数据'}
                    </p>
                </div>
                <Link
                    href="/pay"
                    className="inline-flex items-center gap-1 text-xs font-semibold text-brand-accent no-underline transition-colors hover:text-brand-accent-strong"
                >
                    账户充值 <ArrowUpRight size={14} aria-hidden="true" />
                </Link>
            </div>
        </article>
    );
}
export async function PortalUsageStats({ data, periodLabel }: { data: Promise<UsageData>; periodLabel: string }) {
    const { agg } = await data;
    const totalTokens = agg?.totalTokens ?? 0;
    return (
        <div className="grid overflow-hidden rounded-lg border border-portal-line bg-portal-panel shadow-portal sm:grid-cols-3 lg:col-span-8">
            <MetricCell
                icon={Coins}
                label="本期消费"
                value={agg ? `¥${quotaToCny(agg.totalUsedQuota).toFixed(2)}` : NO_DATA}
                detail={
                    agg ? (
                        <>
                            {periodLabel}
                            {agg.source === 'fallback' && ' · 数据稍滞后'}
                        </>
                    ) : (
                        '当前周期'
                    )
                }
            />
            <MetricCell
                icon={Activity}
                label="请求次数"
                value={agg ? agg.totalCalls.toLocaleString('en-US') : NO_DATA}
                detail={periodLabel}
                className="border-t border-portal-line sm:border-l sm:border-t-0"
            />
            <MetricCell
                icon={Database}
                label="统计 Tokens"
                value={agg ? totalTokens.toLocaleString('en-US') : NO_DATA}
                detail={`${periodLabel} · 输入+输出`}
                className="border-t border-portal-line sm:border-l sm:border-t-0"
            />
        </div>
    );
}
export async function PortalUsageBody({ data, periodLabel }: { data: Promise<UsageData>; periodLabel: string }) {
    const { agg, usageErr, calls } = await data;
    const byModel = agg ? agg.byModel.slice(0, 5) : [];
    return (
        <>
            {usageErr && (
                <div>
                    <FormError severity="banner">
                        {usageErr === 'account_not_provisioned'
                            ? '账户尚未关联到上游,请联系管理员。'
                            : '当前无法获取用量数据,请稍后重试。'}
                    </FormError>
                </div>
            )}

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.9fr)_minmax(320px,0.8fr)]">
                <section className="min-w-0 rounded-lg border border-portal-line bg-portal-panel p-5 shadow-portal sm:p-6">
                    <div className="mb-5 flex items-start justify-between gap-4">
                        <div>
                            <div className="flex items-center gap-2">
                                <BarChart3
                                    size={18}
                                    className="text-portal-gold"
                                    strokeWidth={1.8}
                                    aria-hidden="true"
                                />
                                <h2 className="m-0 font-display text-base font-semibold text-portal-ink">
                                    模型消耗分布
                                </h2>
                            </div>
                            <p className="m-0 mt-1.5 text-xs text-portal-subtle">
                                按日展示各模型消费趋势 · {periodLabel}
                            </p>
                        </div>
                    </div>
                    <ModelConsumptionChartLazy
                        byDay={agg?.byDay ?? []}
                        models={agg?.chartModels ?? []}
                        cnyPerQuota={quotaToCny(1)}
                    />
                </section>

                <aside className="rounded-lg border border-portal-line bg-portal-panel p-5 shadow-portal sm:p-6">
                    <div className="mb-4 flex items-center justify-between gap-3">
                        <div>
                            <h2 className="m-0 font-display text-base font-semibold text-portal-ink">热门模型</h2>
                            <p className="m-0 mt-1 text-xs text-portal-subtle">按消费金额排序 · {periodLabel}</p>
                        </div>
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-portal-gold-soft text-portal-gold">
                            <Activity size={17} strokeWidth={1.8} aria-hidden="true" />
                        </span>
                    </div>

                    {byModel.length === 0 ? (
                        <div className="flex min-h-[248px] items-center justify-center border-t border-portal-line text-center text-sm text-portal-subtle">
                            暂无模型消费数据
                        </div>
                    ) : (
                        <ol className="m-0 list-none divide-y divide-portal-line p-0">
                            {byModel.map((model, index) => {
                                const pct = agg && agg.totalUsedQuota ? (model.quota / agg.totalUsedQuota) * 100 : 0;
                                return (
                                    <li key={model.model} className="py-4 first:pt-2 last:pb-0">
                                        <div className="flex items-start gap-3">
                                            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded bg-portal-soft text-[11px] font-semibold text-portal-muted">
                                                {index + 1}
                                            </span>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-start justify-between gap-3">
                                                    <p
                                                        className="m-0 truncate font-mono text-xs font-semibold text-portal-ink"
                                                        title={model.model}
                                                    >
                                                        {model.model}
                                                    </p>
                                                    <span className="shrink-0 text-xs font-semibold text-portal-ink tabular-nums">
                                                        ¥{quotaToCny(model.quota).toFixed(2)}
                                                    </span>
                                                </div>
                                                <div className="mt-2 flex items-center gap-3">
                                                    <div className="h-1 flex-1 overflow-hidden rounded-sm bg-portal-line">
                                                        <div
                                                            className="h-full bg-portal-gold"
                                                            style={{ width: `${Math.max(2, pct)}%` }}
                                                        />
                                                    </div>
                                                    <span className="w-10 text-right text-[11px] text-portal-subtle tabular-nums">
                                                        {pct.toFixed(1)}%
                                                    </span>
                                                </div>
                                                <p className="m-0 mt-1.5 text-[11px] text-portal-subtle tabular-nums">
                                                    {model.calls.toLocaleString('en-US')} 次调用
                                                </p>
                                            </div>
                                        </div>
                                    </li>
                                );
                            })}
                        </ol>
                    )}
                </aside>
            </div>

            <section aria-labelledby="recent-calls-title">
                <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                        <div className="flex items-center gap-2">
                            <Activity size={18} className="text-portal-gold" strokeWidth={1.8} aria-hidden="true" />
                            <h2
                                id="recent-calls-title"
                                className="m-0 font-display text-base font-semibold text-portal-ink"
                            >
                                调用明细
                            </h2>
                        </div>
                        <p className="m-0 mt-1.5 text-xs text-portal-subtle">
                            最近调用的模型、密钥、耗时、Token、消费与结果 · {periodLabel}
                        </p>
                    </div>
                    <Link
                        href="/logs"
                        className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-portal-muted no-underline transition-colors hover:text-portal-ink"
                    >
                        查看全部日志 <ArrowUpRight size={14} aria-hidden="true" />
                    </Link>
                </div>
                <CallDetailTable rows={calls} />
            </section>
        </>
    );
}
