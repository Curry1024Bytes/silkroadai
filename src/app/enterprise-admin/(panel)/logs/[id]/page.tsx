/**
 * 运营后台 · 请求日志详情(2026-09-03):单条日志全貌(入参 / 上游响应 / 耗时 / 归属)
 * + 同任务时间线(submit → 关键轮询 → 终态/对账,一条任务的生命周期一屏看完)。
 * upstream_body 含上游中间商域名 —— 该页 superadmin-only(layout 守门),绝不外流(#271)。
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { bjTimeStr } from '@/lib/enterprise/query';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · 日志详情' };

function prettyJson(s: string | null): string | null {
    if (!s) return null;
    try {
        return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
        return s;
    }
}

function Field({ label, value, mono }: { label: string; value: string | number | null | undefined; mono?: boolean }) {
    return (
        <div>
            <dt className="text-xs text-gray-400">{label}</dt>
            <dd className={`text-sm text-gray-800 ${mono ? 'font-mono text-xs break-all' : ''}`}>
                {value == null || value === '' ? '—' : value}
            </dd>
        </div>
    );
}

export default async function EnterpriseAdminLogDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
    const log = await prisma.enterpriseRequestLog.findUnique({ where: { id } });
    if (!log) notFound();

    const [user, timeline] = await Promise.all([
        log.user_id
            ? prisma.user.findUnique({ where: { id: log.user_id }, select: { email: true, nickname: true } })
            : null,
        log.task_id
            ? prisma.enterpriseRequestLog.findMany({
                  where: { task_id: log.task_id },
                  orderBy: { created_at: 'asc' },
                  select: {
                      id: true,
                      created_at: true,
                      kind: true,
                      http_status: true,
                      upstream_status: true,
                      outcome: true,
                      error_code: true,
                      duration_ms: true,
                  },
              })
            : [],
    ]);
    const task = log.task_id
        ? await prisma.seedanceVideoTask.findUnique({
              where: { id: log.task_id },
              select: { status: true, tokens: true, cost_cny: true, billed: true, fail_reason: true },
          })
        : null;

    return (
        <div className="space-y-5">
            <div className="flex items-center justify-between">
                <Link href="/enterprise-admin/logs" className="text-xs text-blue-600 hover:underline">
                    ← 返回请求日志
                </Link>
                <a
                    href={`/api/admin/enterprise/logs/${log.id}?download=1`}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                >
                    下载 JSON
                </a>
            </div>

            <section className="rounded-xl border border-gray-200 bg-white p-5">
                <h2 className="mb-3 text-sm font-semibold text-gray-900">请求概要</h2>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
                    <Field label="时间(北京)" value={bjTimeStr(log.created_at)} />
                    <Field label="类型" value={`${log.kind}${log.format ? ` · ${log.format} 面` : ''}`} />
                    <Field label="客户" value={user ? user.email : log.user_id ? log.user_id : '未鉴权'} />
                    <Field label="渠道" value={log.region} />
                    <Field label="模型" value={log.model} />
                    <Field label="任务 ID" value={log.task_id} mono />
                    <Field label="渠道侧任务 ID" value={log.vendor_task_id} mono />
                    <Field label="客户请求号" value={log.client_request_id} mono />
                    <Field label="素材 Action" value={log.action} />
                    <Field label="素材/组 ID" value={log.resource_id} mono />
                    <Field label="返给客户 HTTP" value={log.http_status} />
                    <Field
                        label="上游 HTTP"
                        value={
                            log.upstream_status != null
                                ? `${log.upstream_status}${log.cache_hit ? '(缓存)' : ''}`
                                : null
                        }
                    />
                    <Field label="总耗时" value={log.duration_ms != null ? `${log.duration_ms}ms` : null} />
                    <Field label="上游耗时" value={log.upstream_ms != null ? `${log.upstream_ms}ms` : null} />
                    <Field label="结果" value={log.outcome} />
                    <Field label="错误码" value={log.error_code} />
                    <Field label="客户 IP" value={log.client_ip} mono />
                    <Field label="User-Agent" value={log.user_agent} mono />
                </dl>
                {log.error_message && (
                    <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{log.error_message}</p>
                )}
            </section>

            {task && (
                <section className="rounded-xl border border-gray-200 bg-white p-5">
                    <h2 className="mb-3 text-sm font-semibold text-gray-900">任务当前状态</h2>
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
                        <Field label="状态" value={task.status} />
                        <Field
                            label="Tokens"
                            value={task.tokens != null ? Number(task.tokens).toLocaleString('en-US') : null}
                        />
                        <Field
                            label="实付"
                            value={
                                task.billed && task.cost_cny != null ? `¥${Number(task.cost_cny).toFixed(4)}` : '未计费'
                            }
                        />
                        <Field label="失败原因" value={task.fail_reason} />
                    </dl>
                </section>
            )}

            {log.request_body && (
                <section className="rounded-xl border border-gray-200 bg-white p-5">
                    <h2 className="mb-3 text-sm font-semibold text-gray-900">客户入参(脱媒 + 截断)</h2>
                    <pre className="max-h-96 overflow-auto rounded-md bg-gray-50 p-3 text-xs leading-relaxed text-gray-800">
                        {prettyJson(log.request_body)}
                    </pre>
                </section>
            )}

            {log.upstream_body && (
                <section className="rounded-xl border border-gray-200 bg-white p-5">
                    <h2 className="mb-3 text-sm font-semibold text-gray-900">上游响应(截断;内部资料,勿外发)</h2>
                    <pre className="max-h-96 overflow-auto rounded-md bg-gray-50 p-3 text-xs leading-relaxed text-gray-800">
                        {prettyJson(log.upstream_body)}
                    </pre>
                </section>
            )}

            {timeline.length > 1 && (
                <section className="rounded-xl border border-gray-200 bg-white p-5">
                    <h2 className="mb-3 text-sm font-semibold text-gray-900">同任务时间线({timeline.length} 条)</h2>
                    <table className="w-full text-left text-sm">
                        <thead className="text-xs text-gray-500">
                            <tr>
                                <th className="py-1 pr-4">时间(北京)</th>
                                <th className="py-1 pr-4">类型</th>
                                <th className="py-1 pr-4">HTTP</th>
                                <th className="py-1 pr-4">上游</th>
                                <th className="py-1 pr-4">结果</th>
                                <th className="py-1 pr-4">耗时</th>
                                <th className="py-1">详情</th>
                            </tr>
                        </thead>
                        <tbody>
                            {timeline.map((t) => (
                                <tr
                                    key={t.id}
                                    className={`border-t border-gray-100 ${t.id === log.id ? 'bg-blue-50/50' : ''}`}
                                >
                                    <td className="py-1.5 pr-4 whitespace-nowrap text-gray-600">
                                        {bjTimeStr(t.created_at)}
                                    </td>
                                    <td className="py-1.5 pr-4">{t.kind}</td>
                                    <td className="py-1.5 pr-4">{t.http_status ?? '—'}</td>
                                    <td className="py-1.5 pr-4">{t.upstream_status ?? '—'}</td>
                                    <td className="py-1.5 pr-4 text-xs">{t.outcome ?? t.error_code ?? '—'}</td>
                                    <td className="py-1.5 pr-4 text-xs text-gray-600">
                                        {t.duration_ms != null ? `${t.duration_ms}ms` : '—'}
                                    </td>
                                    <td className="py-1.5">
                                        {t.id === log.id ? (
                                            <span className="text-xs text-gray-400">当前</span>
                                        ) : (
                                            <Link
                                                href={`/enterprise-admin/logs/${t.id}`}
                                                className="text-xs text-blue-600 hover:underline"
                                            >
                                                查看
                                            </Link>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}
        </div>
    );
}
