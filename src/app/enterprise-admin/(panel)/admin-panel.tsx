'use client';

/**
 * 运营后台面板(2026-07-20):把 runbook 的手工 curl 全部 UI 化 ——
 * 客户列表/详情 · 开户 · 入账/冲正 · 设密码 · 议价覆盖 · 密钥启停。
 * 全部调用 /api/admin/enterprise/*(superadmin session cookie 鉴权)。
 */
import { useCallback, useEffect, useState } from 'react';
import { copyText } from '@/lib/enterprise/copy-text';

interface CustomerRow {
    user_id: string;
    email: string;
    name: string | null;
    balance_cny: number;
    spent_cny: number;
    active_keys: number;
    upstream_note: string | null;
    created_at: string;
}

interface Detail {
    user: { id: string; email: string; name: string | null; created_at: string };
    upstream_note: string | null;
    discount: number;
    balance_cny: number;
    spent_cny: number;
    keys: Array<{
        id: string;
        name: string;
        key_prefix: string;
        status: string;
        created_at: string;
        last_used_at: string | null;
    }>;
    overrides: Array<{ variant: string; resolution: string; has_video: boolean; cny_per_m: number }>;
    ledger: Array<{ kind: string; amount_cny: number; balance_after: number; note: string | null; created_at: string }>;
    tasks: Array<{
        id: string;
        model: string;
        resolution: string;
        status: string;
        tokens: number | null;
        cost_cny: number | null;
        billed: boolean;
        created_at: string;
    }>;
}

const fmtTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const fmtCny = (n: number) => `¥${n.toFixed(2)}`;
const KIND_LABEL: Record<string, string> = { recharge: '充值', charge: '消费', adjustment: '调整', migration: '迁移' };

async function post(url: string, body: unknown, method = 'POST') {
    const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, j };
}

export function AdminPanel() {
    const [customers, setCustomers] = useState<CustomerRow[]>([]);
    const [selected, setSelected] = useState<string | null>(null);
    const [detail, setDetail] = useState<Detail | null>(null);
    const [msg, setMsg] = useState<string | null>(null);
    const [freshKey, setFreshKey] = useState<string | null>(null);

    const loadList = useCallback(async () => {
        const res = await fetch('/api/admin/enterprise/customers');
        if (res.ok) setCustomers(((await res.json()) as { customers: CustomerRow[] }).customers);
    }, []);
    const loadDetail = useCallback(async (id: string) => {
        setSelected(id);
        setDetail(null);
        const res = await fetch(`/api/admin/enterprise/customers/${id}`);
        if (res.ok) setDetail((await res.json()) as Detail);
    }, []);
    useEffect(() => {
        let alive = true;
        void (async () => {
            const res = await fetch('/api/admin/enterprise/customers');
            if (!alive || !res.ok) return;
            setCustomers(((await res.json()) as { customers: CustomerRow[] }).customers);
        })();
        return () => {
            alive = false;
        };
    }, []);

    function flash(text: string) {
        setMsg(text);
        setTimeout(() => setMsg(null), 5000);
    }
    async function refresh() {
        await loadList();
        if (selected) await loadDetail(selected);
    }

    // ── 操作 ──
    async function onOnboard(form: FormData) {
        const body = {
            email: String(form.get('email') || '').trim(),
            name: String(form.get('name') || '').trim() || undefined,
            upstream_key: String(form.get('upstream_key') || '').trim(),
            credit_cny: Number(form.get('credit_cny')) || undefined,
            note: String(form.get('note') || '').trim() || undefined,
        };
        const r = await post('/api/admin/enterprise/onboard', body);
        if (r.ok) {
            setFreshKey(String(r.j.key));
            flash(`开户成功:${body.email}`);
            await refresh();
        } else {
            flash(`开户失败(${r.status}):${JSON.stringify(r.j).slice(0, 120)}`);
        }
    }
    async function onCredit(userId: string) {
        const amt = window.prompt('入账金额 ¥(负数=冲正):');
        if (!amt) return;
        const note = window.prompt('备注(打款流水号/原因,必填):');
        if (!note) return;
        const r = await post('/api/admin/enterprise/credit', { user_id: userId, amount_cny: Number(amt), note });
        flash(r.ok ? `入账成功,余额 ¥${r.j.balance_after}` : `失败(${r.status}):${JSON.stringify(r.j).slice(0, 120)}`);
        await refresh();
    }
    async function onSetPassword(userId: string) {
        const pw = window.prompt('新密码(至少 8 位,会踢掉客户已登录会话):');
        if (!pw) return;
        const r = await post('/api/admin/enterprise/set-password', { user_id: userId, password: pw });
        flash(r.ok ? '密码已设置' : `失败(${r.status}):${JSON.stringify(r.j).slice(0, 120)}`);
    }
    async function onOverride(userId: string, form: FormData) {
        const raw = String(form.get('cny_per_m') || '').trim();
        const body = {
            user_id: userId,
            variant: String(form.get('variant')),
            resolution: String(form.get('resolution')),
            has_video: String(form.get('has_video')) === 'true',
            cny_per_m: raw === '' ? null : Number(raw),
        };
        const r = await post('/api/admin/enterprise/rate-override', body);
        flash(
            r.ok
                ? body.cny_per_m === null
                    ? '覆盖已清除(回落挂牌)'
                    : `议价已设:¥${body.cny_per_m}/1M`
                : `失败(${r.status})`,
        );
        await refresh();
    }
    async function onDiscount(userId: string, current: number) {
        const raw = window.prompt('客户级整体折扣率(0.05~2;1=无折扣,0.9=全线九折;单档议价不受影响):', String(current));
        if (raw === null || raw.trim() === '') return;
        const d = Number(raw);
        const r = await post(`/api/admin/enterprise/customers/${userId}`, { discount: d }, 'PATCH');
        flash(r.ok ? `折扣率已设为 ${d}(即时生效)` : `失败(${r.status}):${JSON.stringify(r.j).slice(0, 120)}`);
        await refresh();
    }
    async function onKeyToggle(keyId: string, to: 'active' | 'disabled') {
        const r = await post(`/api/admin/enterprise/keys/${keyId}`, { status: to }, 'PATCH');
        flash(r.ok ? (to === 'active' ? '密钥已启用' : '密钥已禁用(立即 401)') : `失败(${r.status})`);
        await refresh();
    }

    return (
        <div className="space-y-5">
            {msg && <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">{msg}</div>}
            {freshKey && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
                    <p className="text-sm font-medium text-amber-900">
                        新客户 API 密钥 —— 只显示这一次,立即复制发给客户:
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                        <code className="break-all rounded bg-white px-2 py-1 text-xs">{freshKey}</code>
                        <button
                            onClick={() => {
                                void copyText(freshKey).then((ok) => flash(ok ? '已复制' : '复制失败,请手动选中'));
                            }}
                            className="shrink-0 rounded border border-amber-400 px-2 py-1 text-xs hover:bg-amber-100"
                        >
                            复制
                        </button>
                        <button
                            onClick={() => setFreshKey(null)}
                            className="shrink-0 rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100"
                        >
                            已保存,关闭
                        </button>
                    </div>
                </div>
            )}

            {/* 开户 */}
            <section className="rounded-xl border border-gray-200 bg-white p-5">
                <h2 className="mb-3 text-sm font-semibold text-gray-900">开客户账号</h2>
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        void onOnboard(new FormData(e.currentTarget));
                    }}
                    className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
                >
                    <input
                        name="email"
                        type="email"
                        required
                        placeholder="客户邮箱 *"
                        className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                    />
                    <input
                        name="name"
                        placeholder="客户名称"
                        className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                    />
                    <input
                        name="upstream_key"
                        required
                        placeholder="该客户上游 key *"
                        className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                    />
                    <input
                        name="credit_cny"
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="首笔入账 ¥(可空)"
                        className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                    />
                    <input
                        name="note"
                        placeholder="入账备注(流水号)"
                        className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                    />
                    <button
                        type="submit"
                        className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
                    >
                        开户
                    </button>
                </form>
                <p className="mt-2 text-xs text-gray-400">
                    开户后记得点客户行 → 「设密码」下发控制台登录密码。上游 key 建议向 token.xinhankr 按客户单独申请。
                </p>
            </section>

            {/* 客户列表 */}
            <section className="rounded-xl border border-gray-200 bg-white p-5">
                <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-gray-900">企业客户({customers.length})</h2>
                    <button
                        onClick={() => void refresh()}
                        className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
                    >
                        刷新
                    </button>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="text-xs text-gray-500">
                            <tr>
                                <th className="py-1 pr-4">邮箱</th>
                                <th className="py-1 pr-4">名称</th>
                                <th className="py-1 pr-4">余额</th>
                                <th className="py-1 pr-4">累计消费</th>
                                <th className="py-1 pr-4">启用密钥</th>
                                <th className="py-1 pr-4">上游备注</th>
                                <th className="py-1">开户时间</th>
                            </tr>
                        </thead>
                        <tbody>
                            {customers.map((c) => (
                                <tr
                                    key={c.user_id}
                                    onClick={() => void loadDetail(c.user_id)}
                                    className={`cursor-pointer border-t border-gray-100 hover:bg-blue-50 ${selected === c.user_id ? 'bg-blue-50' : ''}`}
                                >
                                    <td className="py-2 pr-4">{c.email}</td>
                                    <td className="py-2 pr-4">{c.name ?? '—'}</td>
                                    <td className="py-2 pr-4 font-medium">{fmtCny(c.balance_cny)}</td>
                                    <td className="py-2 pr-4 text-gray-600">{fmtCny(c.spent_cny)}</td>
                                    <td className="py-2 pr-4">{c.active_keys}</td>
                                    <td className="py-2 pr-4 text-gray-500">{c.upstream_note ?? '—'}</td>
                                    <td className="py-2 text-gray-600">{fmtTime(c.created_at)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {customers.length === 0 && <p className="py-3 text-sm text-gray-500">暂无客户,用上方表单开户。</p>}
                </div>
            </section>

            {/* 客户详情 */}
            {selected && detail && (
                <section className="rounded-xl border border-gray-200 bg-white p-5">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <h2 className="text-sm font-semibold text-gray-900">
                            {detail.user.email}
                            {detail.user.name ? `(${detail.user.name})` : ''} — 余额 {fmtCny(detail.balance_cny)} ·
                            累计消费 {fmtCny(detail.spent_cny)}
                            {detail.discount !== 1 && (
                                <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
                                    折扣 ×{detail.discount}
                                </span>
                            )}
                        </h2>
                        <div className="flex gap-2">
                            <button
                                onClick={() => void onCredit(detail.user.id)}
                                className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
                            >
                                入账 / 冲正
                            </button>
                            <button
                                onClick={() => void onDiscount(detail.user.id, detail.discount)}
                                className="rounded-md border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-50"
                            >
                                折扣率
                            </button>
                            <button
                                onClick={() => void onSetPassword(detail.user.id)}
                                className="rounded-md border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-50"
                            >
                                设密码
                            </button>
                        </div>
                    </div>

                    <div className="grid gap-5 lg:grid-cols-2">
                        {/* 密钥 */}
                        <div>
                            <h3 className="mb-2 text-xs font-semibold text-gray-500">API 密钥</h3>
                            <table className="w-full text-left text-sm">
                                <tbody>
                                    {detail.keys.map((k) => (
                                        <tr key={k.id} className="border-t border-gray-100">
                                            <td className="py-1.5 pr-3">{k.name}</td>
                                            <td className="py-1.5 pr-3 font-mono text-xs text-gray-500">
                                                {k.key_prefix}…
                                            </td>
                                            <td className="py-1.5 pr-3">
                                                {k.status === 'active' ? (
                                                    <span className="text-green-700">启用</span>
                                                ) : (
                                                    <span className="text-gray-400">禁用</span>
                                                )}
                                            </td>
                                            <td className="py-1.5 text-right">
                                                <button
                                                    onClick={() =>
                                                        void onKeyToggle(
                                                            k.id,
                                                            k.status === 'active' ? 'disabled' : 'active',
                                                        )
                                                    }
                                                    className={`rounded border px-2 py-0.5 text-xs ${k.status === 'active' ? 'border-red-200 text-red-600 hover:bg-red-50' : 'border-green-200 text-green-700 hover:bg-green-50'}`}
                                                >
                                                    {k.status === 'active' ? '禁用' : '启用'}
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {/* 议价 */}
                        <div>
                            <h3 className="mb-2 text-xs font-semibold text-gray-500">
                                议价覆盖(¥/1M token;留空提交 = 清除回落挂牌)
                            </h3>
                            {detail.overrides.length > 0 && (
                                <ul className="mb-2 space-y-0.5 text-sm text-gray-700">
                                    {detail.overrides.map((o, i) => (
                                        <li key={i}>
                                            {o.variant} · {o.resolution} · {o.has_video ? '含视频' : '无视频'} →{' '}
                                            <b>¥{o.cny_per_m}</b>/1M
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <form
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    void onOverride(detail.user.id, new FormData(e.currentTarget));
                                }}
                                className="flex flex-wrap items-center gap-2"
                            >
                                <select name="variant" className="rounded border border-gray-300 px-2 py-1.5 text-sm">
                                    <option value="pro">pro</option>
                                    <option value="fast">fast</option>
                                    <option value="mini">mini</option>
                                </select>
                                <select
                                    name="resolution"
                                    className="rounded border border-gray-300 px-2 py-1.5 text-sm"
                                >
                                    <option value="720p">720p</option>
                                    <option value="1080p">1080p</option>
                                    <option value="4k">4k</option>
                                </select>
                                <select name="has_video" className="rounded border border-gray-300 px-2 py-1.5 text-sm">
                                    <option value="false">无视频</option>
                                    <option value="true">含视频</option>
                                </select>
                                <input
                                    name="cny_per_m"
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    placeholder="¥/1M(空=清除)"
                                    className="w-32 rounded border border-gray-300 px-2 py-1.5 text-sm"
                                />
                                <button
                                    type="submit"
                                    className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700"
                                >
                                    保存
                                </button>
                            </form>
                        </div>

                        {/* 流水 */}
                        <div>
                            <h3 className="mb-2 text-xs font-semibold text-gray-500">最近流水</h3>
                            <table className="w-full text-left text-xs">
                                <tbody>
                                    {detail.ledger.map((l, i) => (
                                        <tr key={i} className="border-t border-gray-100">
                                            <td className="py-1 pr-3 text-gray-500">{fmtTime(l.created_at)}</td>
                                            <td className="py-1 pr-3">{KIND_LABEL[l.kind] ?? l.kind}</td>
                                            <td className={`py-1 pr-3 ${l.amount_cny < 0 ? '' : 'text-green-700'}`}>
                                                {l.amount_cny < 0
                                                    ? `¥${l.amount_cny.toFixed(4)}`
                                                    : `+¥${l.amount_cny.toFixed(2)}`}
                                            </td>
                                            <td className="py-1 pr-3 text-gray-500">余 {fmtCny(l.balance_after)}</td>
                                            <td className="py-1 text-gray-400">{l.note ?? ''}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {/* 任务 */}
                        <div>
                            <h3 className="mb-2 text-xs font-semibold text-gray-500">最近任务</h3>
                            <table className="w-full text-left text-xs">
                                <tbody>
                                    {detail.tasks.map((t) => (
                                        <tr key={t.id} className="border-t border-gray-100">
                                            <td className="py-1 pr-3 text-gray-500">{fmtTime(t.created_at)}</td>
                                            <td className="py-1 pr-3">{t.model}</td>
                                            <td className="py-1 pr-3">{t.resolution}</td>
                                            <td className="py-1 pr-3">{t.status}</td>
                                            <td className="py-1 pr-3">
                                                {t.tokens != null ? t.tokens.toLocaleString('en-US') : '—'}
                                            </td>
                                            <td className="py-1">
                                                {t.billed && t.cost_cny != null ? `¥${t.cost_cny.toFixed(4)}` : '—'}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </section>
            )}
        </div>
    );
}
