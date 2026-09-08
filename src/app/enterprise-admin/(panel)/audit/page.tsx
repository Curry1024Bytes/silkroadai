/**
 * 运营后台 · 管理员操作审计(2026-09-04):admin_audit_logs 全量明细。
 * superadmin-only(次级管理员导航不显示 + 这里二次守门)——「谁在什么时候对哪个客户
 * 做了什么」,params 已脱敏(密码/上游 key 不落库)。筛选 + 分页 + CSV 导出。
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { resolveEnterpriseAdminFromCookies } from '@/lib/enterprise/admin-auth';
import { bjTimeStr, parseDay } from '@/lib/enterprise/query';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · 操作审计' };

const PAGE_SIZE = 50;

const ACTION_LABEL: Record<string, string> = {
    credit: '入账/冲正',
    onboard: '开户',
    customer_discount: '客户折扣',
    customer_delete: '删除账号',
    key_status: '密钥启停',
    set_password: '设置密码',
    upstream_key_set: '上游 key',
    rate_override: '议价折扣',
    global_discount: '全局折扣',
    admin_grant: '授予管理员',
    admin_revoke: '撤销管理员',
};

function prettyParams(s: string | null): string | null {
    if (!s) return null;
    try {
        return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
        return s;
    }
}

export default async function EnterpriseAdminAuditPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | undefined>>;
}) {
    const admin = await resolveEnterpriseAdminFromCookies();
    if (!admin || admin.level !== 'super') redirect('/enterprise-admin');

    const sp = await searchParams;
    const page = Math.max(1, Math.min(10_000, Number(sp.page) || 1));
    const from = parseDay(sp.from);
    const to = parseDay(sp.to, true);
    const adminFilter = sp.admin && /^[0-9a-f-]{36}$/i.test(sp.admin) ? sp.admin : undefined;
    const actionFilter = sp.action?.trim().slice(0, 64) || undefined;

    const where = {
        ...(from || to ? { created_at: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        ...(adminFilter ? { admin_user_id: adminFilter } : {}),
        ...(actionFilter ? { action: { contains: actionFilter } } : {}),
    };

    // 管理员下拉:出现过的操作者(去重)+ 当前次级管理员名单
    const [distinctAdmins, secondaryRows] = await Promise.all([
        prisma.adminAuditLog.findMany({
            where: { admin_user_id: { not: null } },
            select: { admin_user_id: true, admin_email: true },
            distinct: ['admin_user_id'],
        }),
        prisma.enterpriseAdmin.findMany({ select: { user_id: true } }),
    ]);
    const secondarySet = new Set(secondaryRows.map((r) => r.user_id));

    const [total, logs] = await Promise.all([
        prisma.adminAuditLog.count({ where }),
        prisma.adminAuditLog.findMany({
            where,
            orderBy: { created_at: 'desc' },
            skip: (page - 1) * PAGE_SIZE,
            take: PAGE_SIZE,
        }),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const filterEntries = Object.entries({ from: sp.from, to: sp.to, admin: adminFilter, action: actionFilter }).filter(
        ([, v]) => v,
    ) as Array<[string, string]>;
    const qs = (p: number) => {
        const params = new URLSearchParams(filterEntries);
        params.set('page', String(p));
        return `?${params.toString()}`;
    };
    const exportHref = `/api/admin/enterprise/audit/export?${new URLSearchParams(filterEntries).toString()}`;

    return (
        <section className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-gray-900">
                    管理员操作审计(共 {total.toLocaleString('en-US')} 条)
                </h2>
                <Link href="/enterprise-admin/admins" className="text-xs text-blue-600 hover:underline">
                    管理员管理 →
                </Link>
            </div>
            <form method="get" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
                <input
                    type="date"
                    name="from"
                    defaultValue={sp.from}
                    className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                />
                <span className="text-gray-400">—</span>
                <input
                    type="date"
                    name="to"
                    defaultValue={sp.to}
                    className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                />
                <select
                    name="admin"
                    defaultValue={adminFilter ?? ''}
                    className="max-w-[220px] rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                >
                    <option value="">全部管理员</option>
                    {distinctAdmins.map((a) => (
                        <option key={a.admin_user_id!} value={a.admin_user_id!}>
                            {a.admin_email ?? a.admin_user_id}
                            {secondarySet.has(a.admin_user_id!) ? '(次级)' : ''}
                        </option>
                    ))}
                </select>
                <input
                    type="text"
                    name="action"
                    defaultValue={actionFilter}
                    placeholder="操作类型(credit / onboard …)"
                    className="w-56 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                />
                <button
                    type="submit"
                    className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700"
                >
                    查询
                </button>
                {filterEntries.length > 0 && (
                    <a href="?" className="text-xs text-blue-600 hover:underline">
                        清除
                    </a>
                )}
                <a
                    href={exportHref}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                >
                    导出 CSV
                </a>
            </form>
            {logs.length === 0 ? (
                <p className="text-sm text-gray-500">
                    还没有操作记录。管理员每次成功的写操作(入账/开户/改折扣/启停密钥…)都会记在这里。
                </p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="text-xs text-gray-500">
                            <tr>
                                <th className="py-1 pr-4">时间(北京)</th>
                                <th className="py-1 pr-4">管理员</th>
                                <th className="py-1 pr-4">等级</th>
                                <th className="py-1 pr-4">操作</th>
                                <th className="py-1 pr-4">目标</th>
                                <th className="py-1 pr-4">IP</th>
                                <th className="py-1">参数</th>
                            </tr>
                        </thead>
                        <tbody>
                            {logs.map((l) => (
                                <tr key={l.id} className="border-t border-gray-100 align-top">
                                    <td className="py-2 pr-4 whitespace-nowrap text-gray-600">
                                        {bjTimeStr(l.created_at)}
                                    </td>
                                    <td className="py-2 pr-4 text-xs">
                                        {l.admin_email ?? (l.level === 'break_glass' ? 'break-glass token' : '—')}
                                    </td>
                                    <td className="py-2 pr-4">
                                        {l.level === 'secondary' ? (
                                            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700">
                                                次级
                                            </span>
                                        ) : l.level === 'break_glass' ? (
                                            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                                                token
                                            </span>
                                        ) : (
                                            <span className="text-xs text-gray-500">超管</span>
                                        )}
                                    </td>
                                    <td className="py-2 pr-4">{ACTION_LABEL[l.action] ?? l.action}</td>
                                    <td className="py-2 pr-4 font-mono text-xs text-gray-600">{l.target ?? '—'}</td>
                                    <td className="py-2 pr-4 font-mono text-xs text-gray-500">{l.client_ip ?? '—'}</td>
                                    <td className="py-2">
                                        {l.params ? (
                                            <details>
                                                <summary className="cursor-pointer text-xs text-blue-600">查看</summary>
                                                <pre className="mt-1 max-h-60 max-w-md overflow-auto rounded-md bg-gray-50 p-2 text-xs leading-relaxed text-gray-800">
                                                    {prettyParams(l.params)}
                                                </pre>
                                            </details>
                                        ) : (
                                            <span className="text-xs text-gray-400">—</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {totalPages > 1 && (
                <div className="mt-3 flex items-center gap-3 text-sm">
                    {page > 1 ? (
                        <a href={qs(page - 1)} className="text-blue-600 hover:underline">
                            ← 上一页
                        </a>
                    ) : (
                        <span className="text-gray-300">← 上一页</span>
                    )}
                    <span className="text-gray-500">
                        {page} / {totalPages}
                    </span>
                    {page < totalPages ? (
                        <a href={qs(page + 1)} className="text-blue-600 hover:underline">
                            下一页 →
                        </a>
                    ) : (
                        <span className="text-gray-300">下一页 →</span>
                    )}
                </div>
            )}
            <p className="mt-3 text-xs text-gray-400">
                记录每个成功的写操作(超管与次级都记);敏感字段(密码 / 上游 key)不落库。永久保留。
            </p>
        </section>
    );
}
