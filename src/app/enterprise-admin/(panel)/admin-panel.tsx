'use client';

/**
 * 运营后台面板(2026-07-20):把 runbook 的手工 curl 全部 UI 化 ——
 * 客户列表/详情 · 开户 · 入账/冲正 · 设密码 · 议价覆盖 · 密钥启停。
 * 全部调用 /api/admin/enterprise/*(superadmin session cookie 鉴权)。
 */
import { useCallback, useEffect, useState } from 'react';
import { copyText } from '@/lib/enterprise/copy-text';
import {
    globalDiscountFormValues,
    toGlobalDiscountPayload,
    type GlobalDiscountFormValues,
} from './global-discount-form';

interface CustomerRow {
    user_id: string;
    email: string;
    name: string | null;
    balance_cny: number;
    spent_cny: number;
    active_keys: number;
    upstream_note: string | null;
    regions?: string[];
    created_at: string;
}

interface Detail {
    user: { id: string; email: string; name: string | null; created_at: string };
    upstream_note: string | null;
    discount: number;
    upstreams: Array<{ region: string; note: string | null; discount: number }>;
    balance_cny: number;
    spent_cny: number;
    keys: Array<{
        id: string;
        name: string;
        key_prefix: string;
        region: string;
        status: string;
        created_at: string;
        last_used_at: string | null;
    }>;
    overrides: Array<{ region: string; variant: string; discount: number }>;
    ledger: Array<{ kind: string; amount_cny: number; balance_after: number; note: string | null; created_at: string }>;
    tasks: Array<{
        id: string;
        model: string;
        resolution: string;
        status: string;
        tokens: number | null;
        cost_cny: number | null;
        fail_reason: string | null;
        billed: boolean;
        created_at: string;
    }>;
}

type GlobalDiscount = {
    region: string;
    variant: string;
    version: number;
    discount: number;
    expires_at: string | null;
    effective_from: string | null;
    schedule_timezone: string;
    schedule_weekdays: number[] | null;
    schedule_windows: Array<{
        start: string;
        end: string;
        discount: number;
        priority?: number;
        enabled?: boolean;
        weekdays?: number[];
        starts_on?: string | null;
        ends_on?: string | null;
        note?: string | null;
    }> | null;
    expired: boolean;
    current_status: {
        active: boolean;
        status: 'active' | 'pending' | 'expired' | 'inactive';
        discount: number | null;
        timezone: string;
        window: { start: string; end: string; discount: number; priority?: number } | null;
        next_transition_at?: string | null;
        next_transition_kind?: 'start' | 'end' | null;
    };
    note: string | null;
};

type CalendarWindow = GlobalDiscountFormValues['scheduleWindows'][number];

const WEEKDAYS = [
    [1, '一'],
    [2, '二'],
    [3, '三'],
    [4, '四'],
    [5, '五'],
    [6, '六'],
    [7, '日'],
] as const;

const fmtTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const fmtCny = (n: number) => `¥${n.toFixed(2)}`;
const KIND_LABEL: Record<string, string> = { recharge: '充值', charge: '消费', adjustment: '调整', migration: '迁移' };
const REGION_LABEL: Record<string, string> = { cn: '国内版', global: '海外版', promax: '海外版proMax', volc: '火山' };
const RULE_STATUS_LABEL: Record<GlobalDiscount['current_status']['status'], string> = {
    active: '当前命中',
    pending: '待生效',
    expired: '已失效',
    inactive: '当前未命中',
};

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
    const [globalDiscounts, setGlobalDiscounts] = useState<GlobalDiscount[]>([]);
    const [editingGlobalDiscount, setEditingGlobalDiscount] = useState<GlobalDiscountFormValues | null>(null);
    const globalScheduleTimezone = 'Asia/Shanghai';
    const [globalScheduleWeekdays, setGlobalScheduleWeekdays] = useState<number[]>([1, 2, 3, 4, 5, 6, 7]);
    const [globalScheduleWindows, setGlobalScheduleWindows] = useState<CalendarWindow[]>([]);

    const loadList = useCallback(async () => {
        const res = await fetch('/api/admin/enterprise/customers');
        if (res.ok) setCustomers(((await res.json()) as { customers: CustomerRow[] }).customers);
    }, []);
    const loadGlobalDiscounts = useCallback(async () => {
        const res = await fetch('/api/admin/enterprise/global-discount');
        if (res.ok) setGlobalDiscounts(((await res.json()) as { discounts: GlobalDiscount[] }).discounts);
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
            const [cRes, gRes] = await Promise.all([
                fetch('/api/admin/enterprise/customers'),
                fetch('/api/admin/enterprise/global-discount'),
            ]);
            if (!alive) return;
            if (cRes.ok) setCustomers(((await cRes.json()) as { customers: CustomerRow[] }).customers);
            if (gRes.ok) setGlobalDiscounts(((await gRes.json()) as { discounts: GlobalDiscount[] }).discounts);
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
            overseas_upstream_key: String(form.get('overseas_upstream_key') || '').trim() || undefined,
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
        const raw = String(form.get('discount') || '').trim();
        const body = {
            user_id: userId,
            region: String(form.get('region') || 'cn'),
            variant: String(form.get('variant')),
            discount: raw === '' ? null : Number(raw),
        };
        if (body.discount !== null && (!Number.isFinite(body.discount) || body.discount < 0.05 || body.discount > 2)) {
            flash('折扣率须为 0.05~2 的数字(留空 = 清除)');
            return;
        }
        const r = await post('/api/admin/enterprise/rate-override', body);
        flash(
            r.ok
                ? body.discount === null
                    ? '议价折扣已清除(回落全局/客户整体折扣)'
                    : `议价折扣已设:${REGION_LABEL[body.region] || body.region} × ${body.variant} → ×${body.discount}`
                : `失败(${r.status})`,
        );
        await refresh();
    }
    async function onDiscount(userId: string, region: string, current: number) {
        const label = REGION_LABEL[region] || region;
        const raw = window.prompt(
            `${label}折扣率 —— 相对【官方挂牌价】(0.05~2):1=官方原价(新户默认),` +
                `0.85=85 折,0.9=九折;要给折扣必须显式设置,单档议价不受影响。当前值:`,
            String(current),
        );
        if (raw === null || raw.trim() === '') return;
        const d = Number(raw);
        const r = await post(`/api/admin/enterprise/customers/${userId}`, { discount: d, region }, 'PATCH');
        flash(r.ok ? `${label}折扣率已设为 ${d}(即时生效)` : `失败(${r.status}):${JSON.stringify(r.j).slice(0, 120)}`);
        await refresh();
    }
    async function onSetUpstreamKey(userId: string, region: string) {
        const label = REGION_LABEL[region] || region;
        const key = window.prompt(`${label}上游 key(设置/替换,立即生效):`);
        if (!key) return;
        const note = window.prompt('备注(上游账户/key 名,可空):') || undefined;
        const r = await post('/api/admin/enterprise/upstream-key', {
            user_id: userId,
            region,
            upstream_key: key.trim(),
            note,
        });
        flash(r.ok ? `${label}上游 key 已保存` : `失败(${r.status}):${JSON.stringify(r.j).slice(0, 120)}`);
        await refresh();
    }
    async function onKeyToggle(keyId: string, to: 'active' | 'disabled') {
        const r = await post(`/api/admin/enterprise/keys/${keyId}`, { status: to }, 'PATCH');
        flash(r.ok ? (to === 'active' ? '密钥已启用' : '密钥已禁用(立即 401)') : `失败(${r.status})`);
        await refresh();
    }
    async function onDeleteAccount(userId: string, email: string) {
        if (
            !window.confirm(
                `确认删除账号 ${email}?\n\n将【禁用全部密钥 + 停用登录 + 从客户列表隐藏】;` +
                    `流水/任务/余额/素材历史保留(审计,可人工恢复)。`,
            )
        )
            return;
        const r = await post(`/api/admin/enterprise/customers/${userId}`, {}, 'DELETE');
        if (r.ok) {
            flash(`账号已删除(软删):${email}`);
            setSelected(null);
            setDetail(null);
            await loadList();
        } else {
            flash(`删除失败(${r.status}):${JSON.stringify(r.j).slice(0, 120)}`);
        }
    }
    async function onSetGlobalDiscount(form: FormData) {
        const staticPercent = Number(form.get('discount_percent'));
        const windows = globalScheduleWindows.map((w) => ({
            ...w,
            discount: Number(w.discountPercent) / 100,
        }));
        const hasSchedule = windows.length > 0;
        const values: GlobalDiscountFormValues = {
            region: String(form.get('region') || 'cn'),
            variant: String(form.get('variant')),
            expectedVersion: editingGlobalDiscount?.expectedVersion ?? 0,
            discountPercent: String(form.get('discount_percent') ?? ''),
            effectiveLocal: String(form.get('effective_from') || '').trim(),
            expiresLocal: String(form.get('expires_at') || '').trim(),
            scheduleTimezone: globalScheduleTimezone,
            scheduleWeekdays: hasSchedule ? globalScheduleWeekdays : [],
            scheduleWindows: globalScheduleWindows,
            note: String(form.get('note') || '').trim(),
        };
        if (!Number.isFinite(staticPercent) || staticPercent < 5 || staticPercent > 200) {
            flash('基础折扣须为 5%~200% 的数字');
            return;
        }
        if (hasSchedule && globalScheduleWeekdays.length === 0) {
            flash('启用时间窗口时至少选择一天');
            return;
        }
        if (
            windows.some((w) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.end))
        ) {
            flash('时间窗口必须使用 HH:mm 格式');
            return;
        }
        if (
            windows.some(
                (w) => w.start === w.end || !Number.isFinite(w.discount) || w.discount < 0.05 || w.discount > 2,
            )
        ) {
            flash('窗口起止不能相同，窗口折扣须为 5%~200%');
            return;
        }
        if (
            windows.some((w) => w.priority.trim() && (!Number.isInteger(Number(w.priority)) || Number(w.priority) < 0))
        ) {
            flash('窗口优先级须为非负整数');
            return;
        }
        let body: ReturnType<typeof toGlobalDiscountPayload>;
        try {
            body = toGlobalDiscountPayload(values);
        } catch (error) {
            flash(error instanceof Error ? error.message : '生效/失效时间无效');
            return;
        }
        const r = await post('/api/admin/enterprise/global-discount', body);
        flash(
            r.ok
                ? `全局折扣已设:${REGION_LABEL[body.region] || body.region} × ${body.variant} → ×${body.discount}`
                : `失败(${r.status}):${JSON.stringify(r.j).slice(0, 120)}`,
        );
        if (r.ok) {
            setEditingGlobalDiscount(null);
            setGlobalScheduleWeekdays([1, 2, 3, 4, 5, 6, 7]);
            setGlobalScheduleWindows([]);
        }
        await loadGlobalDiscounts();
    }

    function onEditGlobalDiscount(rule: GlobalDiscount) {
        try {
            const values = globalDiscountFormValues(rule);
            setEditingGlobalDiscount(values);
            setGlobalScheduleWeekdays(values.scheduleWeekdays);
            setGlobalScheduleWindows(values.scheduleWindows);
        } catch (error) {
            flash(error instanceof Error ? `无法编辑该规则: ${error.message}` : '无法编辑该规则');
        }
    }
    async function onClearGlobalDiscount(region: string, variant: string) {
        if (!window.confirm(`清除全局折扣 ${REGION_LABEL[region] || region} × ${variant}?(回落各客户自己的折扣率)`))
            return;
        const rule = globalDiscounts.find((row) => row.region === region && row.variant === variant);
        if (!rule) {
            flash('规则已变化，请刷新后重试');
            return;
        }
        const r = await post('/api/admin/enterprise/global-discount', {
            region,
            variant,
            discount: null,
            expected_version: rule.version,
        });
        flash(r.ok ? `已清除:${region} × ${variant}` : `失败(${r.status})`);
        await loadGlobalDiscounts();
    }

    function addGlobalWindow() {
        setGlobalScheduleWindows((rows) => [
            ...rows,
            {
                start: '00:00',
                end: '08:00',
                discountPercent: '60',
                priority: '',
                enabled: true,
                weekdays: [...globalScheduleWeekdays],
                startsOn: '',
                endsOn: '',
                note: '',
            },
        ]);
    }

    function updateGlobalWindow(index: number, patch: Partial<CalendarWindow>) {
        setGlobalScheduleWindows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    }

    function removeGlobalWindow(index: number) {
        setGlobalScheduleWindows((rows) => rows.filter((_, i) => i !== index));
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
                        placeholder="国内版上游 key *(token.xinhankr)"
                        className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                    />
                    <input
                        name="overseas_upstream_key"
                        placeholder="海外上游 key(可空;global+proMax 共用一把)"
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
                    开户后记得点客户行 → 「设密码」下发控制台登录密码。国内 key 向 token.xinhankr、海外 key 向
                    ai.artsmcp 按客户单独申请;海外 key 填一把即同时开通 global + proMax 两渠道(详情页可 单独换 key /
                    设折扣)。没填海外 key 的客户后续在详情页「开通」补配。
                </p>
            </section>

            {/* 全局折扣(按 渠道×模型) */}
            <section className="rounded-xl border border-gray-200 bg-white p-5">
                <h2 className="mb-1 text-sm font-semibold text-gray-900">全局折扣(按 渠道 × 模型)</h2>
                <p className="mb-3 text-xs text-gray-400">
                    临时促销(如上游 fast/mini 降价一个月我们跟降)。优先级:客户议价折扣(per-模型)&gt; 全局折扣 &gt;
                    客户整体折扣 —— 即全局折扣<b>覆盖客户整体折扣</b>,但不动客户 per-模型议价,且<b>只影响所选模型</b>。
                    到期时间到点自动失效(回落客户折扣);留空 = 手动清除前长期有效。
                </p>
                {globalDiscounts.length > 0 && (
                    <div className="mb-3 overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-gray-500">
                                    <th className="py-1 pr-3">渠道</th>
                                    <th className="py-1 pr-3">模型</th>
                                    <th className="py-1 pr-3">基础折扣</th>
                                    <th className="py-1 pr-3">日历规则</th>
                                    <th className="py-1 pr-3">生效</th>
                                    <th className="py-1 pr-3">状态</th>
                                    <th className="py-1 pr-3">下次变化</th>
                                    <th className="py-1 pr-3">到期</th>
                                    <th className="py-1 pr-3">备注</th>
                                    <th className="py-1 pr-3"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {globalDiscounts.map((g) => (
                                    <tr key={`${g.region}-${g.variant}`} className="border-t border-gray-100">
                                        <td className="py-1 pr-3">{REGION_LABEL[g.region] || g.region}</td>
                                        <td className="py-1 pr-3 font-mono text-xs">{g.variant}</td>
                                        <td className="py-1 pr-3">
                                            {(g.discount * 100).toFixed(2).replace(/\.00$/, '')}%
                                        </td>
                                        <td className="py-1 pr-3 text-xs text-gray-600">
                                            {g.schedule_windows?.length ? (
                                                <span>
                                                    {g.schedule_timezone} · 周
                                                    {(g.schedule_weekdays ?? [1, 2, 3, 4, 5, 6, 7])
                                                        .map((d) => WEEKDAYS[d - 1]?.[1])
                                                        .join('、')}{' '}
                                                    · {g.schedule_windows.length} 个窗口
                                                </span>
                                            ) : (
                                                <span className="text-gray-400">静态</span>
                                            )}
                                        </td>
                                        <td className="py-1 pr-3 text-xs text-gray-600">
                                            {g.effective_from ? (
                                                fmtTime(g.effective_from)
                                            ) : (
                                                <span className="text-gray-400">立即</span>
                                            )}
                                        </td>
                                        <td
                                            className={`py-1 pr-3 text-xs ${g.current_status.active ? 'font-medium text-green-700' : 'text-gray-500'}`}
                                        >
                                            {RULE_STATUS_LABEL[g.current_status.status]}
                                            {g.current_status.active && g.current_status.discount != null
                                                ? ` · ${(g.current_status.discount * 100).toFixed(2).replace(/\.00$/, '')}%`
                                                : ''}
                                        </td>
                                        <td className="py-1 pr-3 text-xs text-gray-600">
                                            {g.current_status.next_transition_at ? (
                                                <>
                                                    {g.current_status.next_transition_kind === 'end'
                                                        ? '下次结束'
                                                        : '下次生效'}{' '}
                                                    {fmtTime(g.current_status.next_transition_at)}
                                                </>
                                            ) : (
                                                <span className="text-gray-400">—</span>
                                            )}
                                        </td>
                                        <td className="py-1 pr-3 text-xs">
                                            {g.expires_at ? (
                                                <span className={g.expired ? 'text-red-500' : 'text-gray-600'}>
                                                    {fmtTime(g.expires_at)}
                                                    {g.expired ? '(已失效)' : ''}
                                                </span>
                                            ) : (
                                                <span className="text-gray-400">长期</span>
                                            )}
                                        </td>
                                        <td className="py-1 pr-3 text-xs text-gray-500">{g.note || '—'}</td>
                                        <td className="py-1 pr-3">
                                            <button
                                                onClick={() => onEditGlobalDiscount(g)}
                                                className="mr-2 text-xs text-blue-700 hover:underline"
                                            >
                                                编辑
                                            </button>
                                            <button
                                                onClick={() => void onClearGlobalDiscount(g.region, g.variant)}
                                                className="text-xs text-red-500 hover:underline"
                                            >
                                                清除
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                <form
                    key={
                        editingGlobalDiscount
                            ? `${editingGlobalDiscount.region}/${editingGlobalDiscount.variant}`
                            : 'new'
                    }
                    onSubmit={(e) => {
                        e.preventDefault();
                        void onSetGlobalDiscount(new FormData(e.currentTarget));
                    }}
                    className="flex flex-wrap items-center gap-2 text-sm"
                >
                    <select
                        name="region"
                        defaultValue={editingGlobalDiscount?.region ?? 'cn'}
                        className="rounded border border-gray-300 px-2 py-1.5"
                    >
                        <option value="cn">国内版</option>
                        <option value="global">海外版</option>
                        <option value="promax">海外proMax</option>
                        <option value="volc">火山</option>
                    </select>
                    <select
                        name="variant"
                        defaultValue={editingGlobalDiscount?.variant ?? 'fast'}
                        className="rounded border border-gray-300 px-2 py-1.5"
                    >
                        <option value="pro">pro</option>
                        <option value="fast">fast</option>
                        <option value="mini">mini</option>
                        <option value="2.5">2.5</option>
                        <option value="promax">promax</option>
                        <option value="promax-fast">promax-fast</option>
                        <option value="promax-mini">promax-mini</option>
                        <option value="promax-2.5">promax-2.5</option>
                    </select>
                    <input
                        name="discount_percent"
                        defaultValue={editingGlobalDiscount?.discountPercent}
                        type="number"
                        step="0.1"
                        min="5"
                        max="200"
                        placeholder="基础折扣 %"
                        required
                        className="w-28 rounded border border-gray-300 px-2 py-1.5"
                    />
                    <input
                        name="effective_from"
                        type="datetime-local"
                        defaultValue={editingGlobalDiscount?.effectiveLocal}
                        title="生效时间(可空=立即)"
                        className="rounded border border-gray-300 px-2 py-1.5"
                    />
                    <input
                        name="expires_at"
                        type="datetime-local"
                        defaultValue={editingGlobalDiscount?.expiresLocal}
                        title="到期时间(可空=长期)"
                        className="rounded border border-gray-300 px-2 py-1.5"
                    />
                    <input
                        name="note"
                        defaultValue={editingGlobalDiscount?.note}
                        placeholder="备注(如:上游 8 月促销)"
                        className="w-48 rounded border border-gray-300 px-2 py-1.5"
                    />
                    <button className="rounded bg-gray-900 px-3 py-1.5 text-white hover:bg-gray-700">
                        {editingGlobalDiscount ? '保存规则' : '设置 / 更新'}
                    </button>
                    {editingGlobalDiscount && (
                        <button
                            type="button"
                            onClick={() => {
                                setEditingGlobalDiscount(null);
                                setGlobalScheduleWeekdays([1, 2, 3, 4, 5, 6, 7]);
                                setGlobalScheduleWindows([]);
                            }}
                            className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-50"
                        >
                            取消编辑
                        </button>
                    )}
                </form>
                <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50/40 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                            <h3 className="text-xs font-semibold text-gray-700">可选日历促销窗口</h3>
                            <p className="mt-1 text-xs text-gray-500">
                                窗口折扣使用百分比填写，例如 60
                                表示六折；窗口支持跨午夜。填写后，基础折扣仍保留作无窗口时的回退值。
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={addGlobalWindow}
                            className="rounded border border-blue-300 px-2 py-1 text-xs text-blue-700 hover:bg-blue-100"
                        >
                            添加窗口
                        </button>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <label className="text-xs text-gray-600">
                            时区
                            <input
                                value={globalScheduleTimezone}
                                readOnly
                                className="mt-1 w-full rounded border border-gray-300 bg-gray-50 px-2 py-1.5 text-sm"
                            />
                        </label>
                        <div className="text-xs text-gray-600">
                            生效星期
                            <div className="mt-1 flex flex-wrap gap-2">
                                {WEEKDAYS.map(([day, label]) => (
                                    <label
                                        key={day}
                                        className="flex items-center gap-1 rounded border border-gray-200 bg-white px-2 py-1"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={globalScheduleWeekdays.includes(day)}
                                            onChange={(e) =>
                                                setGlobalScheduleWeekdays((days) =>
                                                    e.target.checked
                                                        ? [...days, day].sort()
                                                        : days.filter((d) => d !== day),
                                                )
                                            }
                                        />
                                        周{label}
                                    </label>
                                ))}
                            </div>
                        </div>
                    </div>
                    {globalScheduleWindows.length > 0 && (
                        <div className="mt-3 space-y-2">
                            {globalScheduleWindows.map((window, index) => (
                                <div
                                    key={index}
                                    className="flex flex-wrap items-center gap-2 rounded border border-gray-200 bg-white p-2 text-xs"
                                >
                                    <span className="w-12 text-gray-500">窗口 {index + 1}</span>
                                    <input
                                        value={window.start}
                                        onChange={(e) => updateGlobalWindow(index, { start: e.target.value })}
                                        placeholder="00:00"
                                        className="w-20 rounded border border-gray-300 px-2 py-1.5"
                                    />
                                    <span>至</span>
                                    <input
                                        value={window.end}
                                        onChange={(e) => updateGlobalWindow(index, { end: e.target.value })}
                                        placeholder="08:00"
                                        className="w-20 rounded border border-gray-300 px-2 py-1.5"
                                    />
                                    <input
                                        value={window.discountPercent}
                                        onChange={(e) => updateGlobalWindow(index, { discountPercent: e.target.value })}
                                        type="number"
                                        min="5"
                                        max="200"
                                        step="0.1"
                                        placeholder="折扣 %"
                                        className="w-24 rounded border border-gray-300 px-2 py-1.5"
                                    />
                                    <input
                                        value={window.priority}
                                        onChange={(e) => updateGlobalWindow(index, { priority: e.target.value })}
                                        type="number"
                                        min="0"
                                        step="1"
                                        placeholder="优先级"
                                        className="w-20 rounded border border-gray-300 px-2 py-1.5"
                                    />
                                    <label className="flex items-center gap-1">
                                        <input
                                            type="checkbox"
                                            checked={window.enabled}
                                            onChange={(e) => updateGlobalWindow(index, { enabled: e.target.checked })}
                                        />
                                        启用
                                    </label>
                                    <label className="flex items-center gap-1">
                                        开始日期
                                        <input
                                            type="date"
                                            value={window.startsOn}
                                            onChange={(e) => updateGlobalWindow(index, { startsOn: e.target.value })}
                                            className="rounded border border-gray-300 px-2 py-1.5"
                                        />
                                    </label>
                                    <label className="flex items-center gap-1">
                                        结束日期
                                        <input
                                            type="date"
                                            value={window.endsOn}
                                            onChange={(e) => updateGlobalWindow(index, { endsOn: e.target.value })}
                                            className="rounded border border-gray-300 px-2 py-1.5"
                                        />
                                    </label>
                                    <input
                                        value={window.note}
                                        onChange={(e) => updateGlobalWindow(index, { note: e.target.value })}
                                        placeholder="窗口备注"
                                        className="w-40 rounded border border-gray-300 px-2 py-1.5"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => removeGlobalWindow(index)}
                                        className="text-red-600 hover:underline"
                                    >
                                        删除
                                    </button>
                                    <div className="flex basis-full flex-wrap items-center gap-2 pl-12">
                                        <span className="text-gray-500">适用星期</span>
                                        {WEEKDAYS.map(([day, label]) => (
                                            <label key={day} className="flex items-center gap-1">
                                                <input
                                                    type="checkbox"
                                                    checked={window.weekdays.includes(day)}
                                                    onChange={(e) =>
                                                        updateGlobalWindow(index, {
                                                            weekdays: e.target.checked
                                                                ? [...window.weekdays, day].sort()
                                                                : window.weekdays.filter((value) => value !== day),
                                                        })
                                                    }
                                                />
                                                周{label}
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
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
                                <th className="py-1 pr-4">已开版本</th>
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
                                    <td className="py-2 pr-4">
                                        {(c.regions ?? ['cn']).map((rg) => (
                                            <span
                                                key={rg}
                                                className={`mr-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${rg === 'cn' ? 'bg-gray-100 text-gray-600' : rg === 'global' ? 'bg-indigo-50 text-indigo-700' : rg === 'volc' ? 'bg-orange-50 text-orange-700' : 'bg-purple-50 text-purple-700'}`}
                                            >
                                                {rg === 'cn'
                                                    ? '国内'
                                                    : rg === 'global'
                                                      ? '海外'
                                                      : rg === 'volc'
                                                        ? '火山'
                                                        : 'proMax'}
                                            </span>
                                        ))}
                                    </td>
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
                            {detail.upstreams.map(
                                (u) =>
                                    u.discount !== 1 && (
                                        <span
                                            key={u.region}
                                            className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800"
                                        >
                                            {REGION_LABEL[u.region] || u.region}折扣 ×{u.discount}(官方价
                                            {(u.discount * 10).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}折)
                                        </span>
                                    ),
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
                                onClick={() => void onSetPassword(detail.user.id)}
                                className="rounded-md border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-50"
                            >
                                设密码
                            </button>
                            <button
                                onClick={() => void onDeleteAccount(detail.user.id, detail.user.email)}
                                className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                            >
                                删除账号
                            </button>
                        </div>
                    </div>

                    <div className="rounded-lg border border-gray-200 p-3">
                        <h3 className="mb-2 text-xs font-semibold text-gray-500">版本配置(上游 key / 折扣率)</h3>
                        <div className="flex flex-wrap gap-6">
                            {(['cn', 'global', 'promax', 'volc'] as const).map((rg) => {
                                const row = detail.upstreams.find((u) => u.region === rg);
                                const label = `${REGION_LABEL[rg]}(${rg})`;
                                return (
                                    <div key={rg} className="text-sm">
                                        <span className="font-medium">{label}</span>
                                        {row ? (
                                            <>
                                                <span className="ml-2 text-gray-500">
                                                    折扣 ×{row.discount}(官方价
                                                    {(row.discount * 10)
                                                        .toFixed(2)
                                                        .replace(/0+$/, '')
                                                        .replace(/\.$/, '')}
                                                    折{row.discount === 1 ? ',官方原价' : ''})
                                                    {row.note ? ` · ${row.note}` : ''}
                                                </span>
                                                <button
                                                    onClick={() => void onDiscount(detail.user.id, rg, row.discount)}
                                                    className="ml-2 rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50"
                                                >
                                                    折扣率
                                                </button>
                                                <button
                                                    onClick={() => void onSetUpstreamKey(detail.user.id, rg)}
                                                    className="ml-1 rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50"
                                                >
                                                    换上游key
                                                </button>
                                            </>
                                        ) : (
                                            <button
                                                onClick={() => void onSetUpstreamKey(detail.user.id, rg)}
                                                className="ml-2 rounded border border-indigo-300 px-2 py-0.5 text-xs text-indigo-700 hover:bg-indigo-50"
                                            >
                                                开通{REGION_LABEL[rg]}
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
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
                                                {k.region !== 'cn' && (
                                                    <span className="ml-1 rounded bg-indigo-50 px-1 py-0.5 text-[10px] font-sans text-indigo-700">
                                                        {k.region === 'promax'
                                                            ? '海外proMax'
                                                            : k.region === 'volc'
                                                              ? '火山'
                                                              : '海外'}
                                                    </span>
                                                )}
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

                        {/* 议价折扣(per-模型,优先级最高) */}
                        <div>
                            <h3 className="mb-2 text-xs font-semibold text-gray-500">
                                议价折扣(按 渠道 × 模型;优先级最高,覆盖全局折扣与客户整体折扣;留空提交 = 清除回落)
                            </h3>
                            {detail.overrides.length > 0 && (
                                <ul className="mb-2 space-y-0.5 text-sm text-gray-700">
                                    {detail.overrides.map((o, i) => (
                                        <li key={i}>
                                            {REGION_LABEL[o.region] || o.region} · {o.variant} → 折扣{' '}
                                            <b>×{o.discount}</b>
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
                                <select name="region" className="rounded border border-gray-300 px-2 py-1.5 text-sm">
                                    <option value="cn">国内</option>
                                    <option value="global">海外</option>
                                    <option value="promax">海外proMax</option>
                                    <option value="volc">火山</option>
                                </select>
                                <select name="variant" className="rounded border border-gray-300 px-2 py-1.5 text-sm">
                                    <option value="pro">pro</option>
                                    <option value="fast">fast</option>
                                    <option value="mini">mini</option>
                                    <option value="2.5">2.5</option>
                                    <option value="promax">promax</option>
                                    <option value="promax-fast">promax-fast</option>
                                    <option value="promax-mini">promax-mini</option>
                                    <option value="promax-2.5">promax-2.5</option>
                                </select>
                                <input
                                    name="discount"
                                    type="number"
                                    step="0.01"
                                    min="0.05"
                                    max="2"
                                    placeholder="折扣 0.05~2(空=清除)"
                                    className="w-40 rounded border border-gray-300 px-2 py-1.5 text-sm"
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
                                        <tr key={t.id} className="border-t border-gray-100 align-top">
                                            <td className="py-1 pr-3 text-gray-500">{fmtTime(t.created_at)}</td>
                                            <td className="py-1 pr-3">{t.model}</td>
                                            <td className="py-1 pr-3">{t.resolution}</td>
                                            <td className="py-1 pr-3">
                                                {t.status === 'failed' ? (
                                                    <span className="text-red-600">failed</span>
                                                ) : (
                                                    t.status
                                                )}
                                                {t.status === 'failed' && t.fail_reason && (
                                                    <p className="mt-0.5 max-w-[220px] text-[11px] leading-snug text-red-500">
                                                        {t.fail_reason}
                                                    </p>
                                                )}
                                            </td>
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
