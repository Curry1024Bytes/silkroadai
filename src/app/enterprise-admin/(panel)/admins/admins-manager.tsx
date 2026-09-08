'use client';

/**
 * 次级管理员管理 client 岛:列表 + 授予表单 + 撤销。
 * 授予支持两种:已有账号(只填邮箱)/ 新账号(邮箱 + 初始密码,建纯登录账号,
 * 不 provision new-api、不给客户调用面)。变更后整页刷新取最新列表。
 */
import { useState } from 'react';

interface AdminRow {
    user_id: string;
    email: string;
    user_status: string;
    last_login_at: string | null;
    note: string;
    created_at: string;
}

function bj(iso: string | null): string {
    if (!iso) return '—';
    return new Date(new Date(iso).getTime() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
}

export function AdminsManager({ initialAdmins }: { initialAdmins: AdminRow[] }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

    async function grant(e: React.FormEvent) {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setMsg(null);
        try {
            const res = await fetch('/api/admin/enterprise/admins', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email,
                    ...(password ? { password } : {}),
                    ...(note ? { note } : {}),
                }),
            });
            const j = (await res.json().catch(() => ({}))) as {
                ok?: boolean;
                account_created?: boolean;
                error?: string;
                detail?: string;
            };
            if (res.ok && j.ok) {
                setMsg({
                    kind: 'ok',
                    text: j.account_created ? `已授予 ${email}(新账号已创建,把邮箱+密码交给对方)` : `已授予 ${email}`,
                });
                setTimeout(() => window.location.reload(), 900);
                return;
            }
            setMsg({ kind: 'err', text: j.detail ?? j.error ?? `失败(HTTP ${res.status})` });
        } catch {
            setMsg({ kind: 'err', text: '网络错误,请重试' });
        } finally {
            setBusy(false);
        }
    }

    async function revoke(row: AdminRow) {
        if (!window.confirm(`撤销 ${row.email} 的次级管理员权限?其登录账号保留,仅失去后台访问。`)) return;
        setBusy(true);
        setMsg(null);
        try {
            const res = await fetch(`/api/admin/enterprise/admins/${row.user_id}`, { method: 'DELETE' });
            if (res.ok) {
                setMsg({ kind: 'ok', text: `已撤销 ${row.email}` });
                setTimeout(() => window.location.reload(), 700);
                return;
            }
            setMsg({ kind: 'err', text: `撤销失败(HTTP ${res.status})` });
        } catch {
            setMsg({ kind: 'err', text: '网络错误,请重试' });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="space-y-5">
            <section className="rounded-xl border border-gray-200 bg-white p-5">
                <h2 className="mb-3 text-sm font-semibold text-gray-900">次级管理员({initialAdmins.length})</h2>
                {initialAdmins.length === 0 ? (
                    <p className="text-sm text-gray-500">还没有次级管理员。用下方表单授予。</p>
                ) : (
                    <table className="w-full text-left text-sm">
                        <thead className="text-xs text-gray-500">
                            <tr>
                                <th className="py-1 pr-4">邮箱</th>
                                <th className="py-1 pr-4">账号状态</th>
                                <th className="py-1 pr-4">最近登录(北京)</th>
                                <th className="py-1 pr-4">备注</th>
                                <th className="py-1 pr-4">授予时间</th>
                                <th className="py-1">操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            {initialAdmins.map((a) => (
                                <tr key={a.user_id} className="border-t border-gray-100">
                                    <td className="py-2 pr-4">{a.email}</td>
                                    <td className="py-2 pr-4">
                                        {a.user_status === 'active' ? (
                                            <span className="text-green-700">正常</span>
                                        ) : (
                                            <span className="text-red-600">{a.user_status}</span>
                                        )}
                                    </td>
                                    <td className="py-2 pr-4 text-xs text-gray-600">{bj(a.last_login_at)}</td>
                                    <td className="py-2 pr-4 text-xs text-gray-600">{a.note || '—'}</td>
                                    <td className="py-2 pr-4 text-xs text-gray-600">{bj(a.created_at)}</td>
                                    <td className="py-2">
                                        <button
                                            onClick={() => revoke(a)}
                                            disabled={busy}
                                            className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
                                        >
                                            撤销
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>

            <section className="rounded-xl border border-gray-200 bg-white p-5">
                <h2 className="mb-1 text-sm font-semibold text-gray-900">授予次级管理员</h2>
                <p className="mb-3 text-xs text-gray-500">
                    已有 portal 账号:只填邮箱。没有账号:邮箱 + 初始密码一并创建(纯登录账号,不开任何客户调用面)。
                    次级管理员可用后台全部日常操作,但看不到操作审计与本页;其每个写操作都会进「操作审计」。
                </p>
                <form onSubmit={grant} className="flex flex-wrap items-center gap-2 text-sm">
                    <input
                        type="email"
                        required
                        placeholder="邮箱"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-56 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                    />
                    <input
                        type="text"
                        placeholder="初始密码(新账号必填,≥8 位)"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-56 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                    />
                    <input
                        type="text"
                        placeholder="备注(可选)"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        className="w-40 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                    />
                    <button
                        type="submit"
                        disabled={busy}
                        className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50"
                    >
                        {busy ? '处理中…' : '授予'}
                    </button>
                </form>
                {msg && (
                    <p className={`mt-2 text-sm ${msg.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>
                        {msg.text}
                    </p>
                )}
            </section>
        </div>
    );
}
