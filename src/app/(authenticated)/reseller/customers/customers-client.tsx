'use client';

/**
 * CustomersClient (PR-U2) — table on desktop, card-stack on mobile.
 *
 * Pure presentation; pagination is URL-driven (?page=N) so the server
 * component re-renders with fresh data on navigation. We don't refetch
 * client-side — keeps the data path simple.
 */
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';

export interface CustomerRow {
    seq_no: string;
    email_masked: string;
    joined_at: string;
    attribution_expires_at: string | null;
    attribution_active: boolean;
    total_recharged_cny: number;
    last_recharge_at: string | null;
    status: 'active' | 'disabled' | 'banned';
    inviter_code: string | null;
}

interface Props {
    rows: CustomerRow[];
    pagination: { page: number; limit: number; total: number; hasMore: boolean };
}

function fmtCny(v: number): string {
    return `¥${v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('zh-CN');
}

export function CustomersClient({ rows, pagination }: Props) {
    if (rows.length === 0) {
        return (
            <Card>
                <CardContent>
                    <EmptyState
                        title="还没有引流客户"
                        body="去 /reseller/codes 生成你的第一个邀请码,把落地链接发给朋友,客户注册后这里会出现。"
                        action={
                            <Link
                                href="/reseller/codes"
                                className="inline-block px-4 py-2 text-sm rounded-lg bg-navy text-paper no-underline hover:bg-navy-strong"
                            >
                                去管理邀请码
                            </Link>
                        }
                    />
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-col gap-1 flex-1">
                    <p className="text-xs uppercase tracking-wider text-muted-ink m-0">代理后台</p>
                    <CardTitle as="h1">客户列表 ({pagination.total})</CardTitle>
                </div>
            </CardHeader>
            <CardContent className="space-y-3">
                {/* Mobile card-stack (default), desktop hides */}
                <ul className="md:hidden space-y-2 list-none m-0 p-0">
                    {rows.map((r) => (
                        <li key={r.seq_no} className="rounded-xl border border-brand-border bg-surface px-4 py-3">
                            <div className="flex items-baseline justify-between">
                                <span className="text-xs font-mono text-muted-ink">{r.seq_no}</span>
                                <StatusChip status={r.status} active={r.attribution_active} />
                            </div>
                            <p className="font-medium text-navy mt-1 mb-0">{r.email_masked}</p>
                            <div className="grid grid-cols-2 gap-2 mt-2 text-xs text-muted-ink">
                                <div>
                                    <p className="text-[10px] uppercase tracking-wider m-0">注册</p>
                                    <p className="m-0">{fmtDate(r.joined_at)}</p>
                                </div>
                                <div>
                                    <p className="text-[10px] uppercase tracking-wider m-0">累计充值</p>
                                    <p className="m-0 text-navy font-medium">{fmtCny(r.total_recharged_cny)}</p>
                                </div>
                                <div>
                                    <p className="text-[10px] uppercase tracking-wider m-0">归因到期</p>
                                    <p className="m-0">{fmtDate(r.attribution_expires_at)}</p>
                                </div>
                                <div>
                                    <p className="text-[10px] uppercase tracking-wider m-0">最近充值</p>
                                    <p className="m-0">{fmtDate(r.last_recharge_at)}</p>
                                </div>
                            </div>
                            {r.inviter_code && (
                                <p className="text-xs text-muted-ink mt-2 mb-0">
                                    使用码 <code className="font-mono">{r.inviter_code}</code>
                                </p>
                            )}
                        </li>
                    ))}
                </ul>

                {/* Desktop table */}
                <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr className="text-left text-xs uppercase tracking-wider text-muted-ink">
                                <th className="font-medium px-3 py-2 border-b border-brand-border">编号</th>
                                <th className="font-medium px-3 py-2 border-b border-brand-border">邮箱</th>
                                <th className="font-medium px-3 py-2 border-b border-brand-border">注册</th>
                                <th className="font-medium px-3 py-2 border-b border-brand-border">归因到期</th>
                                <th className="font-medium px-3 py-2 border-b border-brand-border">累计充值</th>
                                <th className="font-medium px-3 py-2 border-b border-brand-border">最近充值</th>
                                <th className="font-medium px-3 py-2 border-b border-brand-border">码</th>
                                <th className="font-medium px-3 py-2 border-b border-brand-border">状态</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((r) => (
                                <tr key={r.seq_no} className="hover:bg-paper-muted/30">
                                    <td className="px-3 py-2 border-b border-brand-border font-mono text-xs">
                                        {r.seq_no}
                                    </td>
                                    <td className="px-3 py-2 border-b border-brand-border">{r.email_masked}</td>
                                    <td className="px-3 py-2 border-b border-brand-border text-xs text-muted-ink">
                                        {fmtDate(r.joined_at)}
                                    </td>
                                    <td className="px-3 py-2 border-b border-brand-border text-xs text-muted-ink">
                                        {fmtDate(r.attribution_expires_at)}
                                    </td>
                                    <td className="px-3 py-2 border-b border-brand-border font-medium text-navy">
                                        {fmtCny(r.total_recharged_cny)}
                                    </td>
                                    <td className="px-3 py-2 border-b border-brand-border text-xs text-muted-ink">
                                        {fmtDate(r.last_recharge_at)}
                                    </td>
                                    <td className="px-3 py-2 border-b border-brand-border text-xs font-mono">
                                        {r.inviter_code ?? '—'}
                                    </td>
                                    <td className="px-3 py-2 border-b border-brand-border">
                                        <StatusChip status={r.status} active={r.attribution_active} />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {pagination.total > pagination.limit && (
                    <div className="flex items-center justify-between pt-3 border-t border-brand-border">
                        <span className="text-xs text-muted-ink">
                            第 {pagination.page} 页 · 共 {pagination.total} 位客户
                        </span>
                        <div className="flex gap-2">
                            {pagination.page > 1 && (
                                <Link
                                    href={`/reseller/customers?page=${pagination.page - 1}`}
                                    className="px-3 py-1.5 text-sm rounded-lg border border-brand-border hover:bg-paper-muted no-underline text-navy"
                                >
                                    ← 上一页
                                </Link>
                            )}
                            {pagination.hasMore && (
                                <Link
                                    href={`/reseller/customers?page=${pagination.page + 1}`}
                                    className="px-3 py-1.5 text-sm rounded-lg border border-brand-border hover:bg-paper-muted no-underline text-navy"
                                >
                                    下一页 →
                                </Link>
                            )}
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

function StatusChip({ status, active }: { status: 'active' | 'disabled' | 'banned'; active: boolean }) {
    if (status === 'banned') {
        return <span className="text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-800">已封</span>;
    }
    if (status === 'disabled') {
        return <span className="text-xs px-2 py-0.5 rounded-full bg-paper-muted text-muted-ink">停用</span>;
    }
    if (!active) {
        return <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-800">归因已结束</span>;
    }
    return <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800">归因中</span>;
}
