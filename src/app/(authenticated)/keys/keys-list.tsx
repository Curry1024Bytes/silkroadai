'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatCny } from '@/lib/format/number';
// NOTE: this 'use client' island does NOT convert quota→¥ itself. quotaToCny
// reads NEWAPI_QUOTA_PER_USD / USD_TO_CNY_RATE — server-only env that is
// undefined in the browser bundle, so quota-units would fall back to stale
// defaults (500k / 7.2) and over-display ¥ by ~2×. The server passes the
// ready-to-render ¥ (KeyRow.usedCny) instead.
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormError } from '@/components/ui/FormError';
import { Input } from '@/components/ui/Input';
import { intlLocale, type Locale } from '@/lib/i18n';
import { useLocale, useMessages } from '@/lib/i18n/client';
import { commonMessages } from '@/lib/i18n/messages/common';
import { keysMessages, type KeysMessages } from '@/lib/i18n/messages/keys';
import {
    buildQuotaExpiryPayload,
    EXPIRY_PRESETS,
    expiryPresetLabels,
    formatExpiry,
    isExpired,
    toDatetimeLocalValue,
    type ExpiryPreset,
} from '@/lib/keys/quota-expiry';

export interface KeyRow {
    id: string;
    key_alias: string;
    masked_key: string;
    /** ISO timestamp string. */
    created_at: string;
    /** W6 D4: cumulative quota consumed by this key (raw quota units;
     *  caller converts to CNY for display). null = usage fetch failed
     *  or user has no new-api linkage. */
    used_quota: number | null;
    /** ¥ value of `used_quota`, computed server-side (quotaToCny). null when
     *  usage is unavailable. Client must NOT derive this (server-only FX env). */
    usedCny: number | null;
    /** ISO timestamp of the most recent log entry attributable to this
     *  key, or null if it has never been used. */
    last_used_at: string | null;
    /** P3: portal 档次 key('pool' | 'official' | …). */
    tier: string;
    /** 2026-10-22 额度上限 / 到期时间(只读自 new-api;读取失败时 meta_available=false)。 */
    meta_available: boolean;
    /** null = 元数据不可用。 */
    quota_unlimited: boolean | null;
    /** 仅在有额度上限时有值(server 端已换算成 ¥)。 */
    remainCny: number | null;
    /** ISO;null = 永不过期(或元数据不可用,看 meta_available)。 */
    expires_at: string | null;
}

/** P3: a selectable tier (an enabled ChannelGroup), passed from the server page. */
export interface TierOption {
    key: string;
    display_name: string;
    description: string | null;
    is_default: boolean;
    /** new-api 组名(下拉副行展示,与 new-api 分组下拉同款信息)。 */
    newapi_group: string;
    /** 该客户的有效倍率(2026-10-23 起以客户身份读,GroupGroupRatio 专属覆盖生效);不可达 → null,不显示徽章。 */
    ratio: number | null;
    /** 全局挂牌倍率(对照),专属价时与 ratio 不同。 */
    listRatio?: number | null;
    /** 该档对当前客户是专属倍率(GroupGroupRatio 覆盖命中)。 */
    special?: boolean;
}

/** Mirror of the server-side mask helper. Used when we receive a freshly
 *  created sk-xxx and want to flip back to the obscured form. */
function maskKey(value: string): string {
    if (value.length <= 12) return '*'.repeat(Math.max(8, value.length));
    return `${value.slice(0, 7)}****${value.slice(-4)}`;
}

/** How long to expose a freshly-revealed sk- before re-masking it. Defends
 *  against shoulder-surfing / forgotten browser tab scenarios. */
const REVEAL_AUTOHIDE_MS = 10_000;
const COPIED_TOAST_MS = 2_000;

/** Render `last_used_at` as a friendly relative-time string in the current
 *  locale ("从未调用" / "Never used" for the null sentinel). */
function formatLastUsed(iso: string | null, t: KeysMessages['lastUsed']): string {
    if (!iso) return t.never;
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '—';
    const now = Date.now();
    const diffSec = Math.max(0, Math.floor((now - then) / 1000));
    if (diffSec < 60) return t.justNow;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return t.minutesAgo(diffMin);
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return t.hoursAgo(diffHr);
    const diffDay = Math.floor(diffHr / 24);
    return t.daysAgo(diffDay);
}

/** State of the per-row "displayed key" — either the real sk- (showing) or
 *  null (showing the masked form). */
type RevealMap = Record<string, string | undefined>;
type CopiedMap = Record<string, boolean>;

/** Inline alias editor state — at most one row in edit mode at a time. */
interface EditState {
    id: string;
    alias: string;
    submitting: boolean;
    error: string | null;
}

interface CreateState {
    open: boolean;
    alias: string;
    submitting: boolean;
    error: string | null;
    /** null = 尚未选档(多档时必选,不预选;单档 / 无档配置时自动定)。 */
    tier: string | null;
    quotaUnlimited: boolean;
    quotaCny: string;
    expiryPreset: ExpiryPreset;
    expiryCustom: string;
}

interface BudgetEditState {
    id: string;
    quotaUnlimited: boolean;
    quotaCny: string;
    expiryPreset: ExpiryPreset;
    expiryCustom: string;
    submitting: boolean;
    error: string | null;
}

function emptyCreate(tier: string | null): CreateState {
    return {
        open: false,
        alias: '',
        submitting: false,
        error: null,
        tier,
        quotaUnlimited: true,
        quotaCny: '',
        expiryPreset: 'never',
        expiryCustom: '',
    };
}

type BudgetFields = Pick<CreateState, 'quotaUnlimited' | 'quotaCny' | 'expiryPreset' | 'expiryCustom'>;

/** 额度上限 + 到期时间输入组(创建表单与行内调整共用)。 */
export function QuotaExpiryFields(props: {
    value: BudgetFields;
    onChange: (patch: Partial<BudgetFields>) => void;
    disabled?: boolean;
    idPrefix: string;
}) {
    const { value, onChange, disabled, idPrefix } = props;
    const t = useMessages(keysMessages).fields;
    const presetLabels = expiryPresetLabels(useLocale());
    return (
        <div className="grid gap-3 sm:grid-cols-2">
            <div>
                <p className="m-0 mb-1 text-xs font-medium text-muted-ink">{t.quotaCap}</p>
                <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                        type="checkbox"
                        id={`${idPrefix}-unlimited`}
                        checked={value.quotaUnlimited}
                        disabled={disabled}
                        onChange={(e) => onChange({ quotaUnlimited: e.target.checked })}
                    />
                    {t.unlimited}
                </label>
                {!value.quotaUnlimited && (
                    <div className="mt-1.5 flex items-center gap-1.5">
                        <span className="text-sm text-muted-ink">¥</span>
                        <Input
                            type="text"
                            inputMode="decimal"
                            placeholder={t.quotaPlaceholder}
                            value={value.quotaCny}
                            disabled={disabled}
                            onChange={(e) => onChange({ quotaCny: e.target.value })}
                            aria-label={t.quotaAria}
                            block={false}
                            className="w-32 text-sm"
                        />
                    </div>
                )}
                <p className="m-0 mt-1 text-xs text-minor-ink">{t.quotaHint}</p>
            </div>
            <div>
                <p className="m-0 mb-1 text-xs font-medium text-muted-ink">{t.expiry}</p>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t.expiry}>
                    {EXPIRY_PRESETS.map((preset) => {
                        const active = value.expiryPreset === preset;
                        return (
                            <button
                                key={preset}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                disabled={disabled}
                                onClick={() => onChange({ expiryPreset: preset })}
                                className={[
                                    'cursor-pointer rounded-full border px-2.5 py-0.5 text-xs transition-colors duration-150 ease-brand',
                                    active
                                        ? 'border-navy bg-navy text-paper'
                                        : 'border-brand-border bg-surface text-muted-ink hover:text-navy',
                                    'disabled:cursor-not-allowed disabled:opacity-50',
                                ].join(' ')}
                            >
                                {presetLabels[preset]}
                            </button>
                        );
                    })}
                </div>
                {value.expiryPreset === 'custom' && (
                    <Input
                        type="datetime-local"
                        value={value.expiryCustom}
                        disabled={disabled}
                        onChange={(e) => onChange({ expiryCustom: e.target.value })}
                        aria-label={t.customExpiryAria}
                        block={false}
                        className="mt-1.5 text-sm"
                    />
                )}
                <p className="m-0 mt-1 text-xs text-minor-ink">{t.expiryHint}</p>
            </div>
        </div>
    );
}

/** 行内「额度 / 到期」摘要。 */
function BudgetSummary({ row }: { row: KeyRow }) {
    const t = useMessages(keysMessages);
    const locale = useLocale();
    if (!row.meta_available) {
        return <span className="text-minor-ink">{t.budget.metaUnavailable}</span>;
    }
    const expired = isExpired(row.expires_at);
    const exhausted = row.quota_unlimited === false && (row.remainCny ?? 0) <= 0;
    const badge = (text: string) => (
        <span className="ml-1.5 rounded-full bg-status-error-bg px-2 py-0.5 text-[10px] font-medium text-status-error-text">
            {text}
        </span>
    );
    return (
        <div className="text-sm tabular-nums">
            <div>
                {row.quota_unlimited === false ? (
                    <>
                        {t.budget.remaining}
                        {formatCny(row.remainCny ?? 0).exact}
                        {exhausted && badge(t.budget.exhausted)}
                    </>
                ) : (
                    t.fields.unlimited
                )}
            </div>
            <div className="mt-0.5 text-xs text-minor-ink">
                {formatExpiry(row.expires_at, locale)}
                {expired && badge(t.budget.expired)}
            </div>
        </div>
    );
}

/** 倍率徽章文案:0.4 → "0.4x 倍率"(与 new-api 分组下拉同款)。 */
function ratioBadgeText(ratio: number | null, special: boolean | undefined, t: KeysMessages['tier']): string | null {
    if (ratio == null) return null;
    return special ? t.specialRatio(ratio) : t.ratio(ratio);
}

/**
 * 档次下拉(样式参照 new-api 的分组选择):触发钮 + 搜索框 + 选项列表。
 * 每行 = 显示名 + 副行介绍(new-api 组名 · portal 描述)+ 「Nx 倍率」徽章;
 * 必选 —— 多档时无预选,placeholder「选择一个档次」。
 */
export function TierSelect({
    tiers,
    value,
    onChange,
    disabled,
}: {
    tiers: TierOption[];
    value: string | null;
    onChange: (key: string) => void;
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const rootRef = useRef<HTMLDivElement | null>(null);
    const t = useMessages(keysMessages).tier;

    // 点外面 / Escape 关闭
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const q = query.trim().toLowerCase();
    const filtered = q
        ? tiers.filter((t) =>
              [t.key, t.display_name, t.description ?? '', t.newapi_group].some((s) => s.toLowerCase().includes(q)),
          )
        : tiers;
    const selected = value != null ? tiers.find((t) => t.key === value) : undefined;

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                disabled={disabled}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => {
                    setQuery('');
                    setOpen((v) => !v);
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    open ? 'border-navy' : 'border-brand-border'
                } bg-surface hover:bg-paper-muted disabled:cursor-not-allowed disabled:opacity-60`}
            >
                {selected ? (
                    <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-ink">{selected.display_name}</span>
                        {ratioBadgeText(selected.ratio, selected.special, t) && (
                            <span className="shrink-0 rounded-full border border-status-success-border bg-status-success-bg px-2 py-0.5 text-[11px] font-medium text-status-success-text">
                                {ratioBadgeText(selected.ratio, selected.special, t)}
                            </span>
                        )}
                    </span>
                ) : (
                    <span className="text-minor-ink">{t.pick}</span>
                )}
                <span aria-hidden className="shrink-0 text-[10px] text-minor-ink">
                    {open ? '▲' : '▼'}
                </span>
            </button>
            {open && (
                <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-brand-border bg-surface shadow-card">
                    <div className="border-b border-brand-border p-2">
                        <input
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={t.searchPlaceholder}
                            autoFocus
                            className="w-full rounded-md border border-brand-border bg-paper-muted px-2.5 py-1.5 text-sm text-ink outline-none focus:border-navy"
                        />
                    </div>
                    <ul role="listbox" className="m-0 max-h-64 list-none overflow-y-auto p-1">
                        {filtered.length === 0 && <li className="px-3 py-2 text-sm text-minor-ink">{t.noMatch}</li>}
                        {filtered.map((opt) => (
                            <li key={opt.key} role="option" aria-selected={opt.key === value}>
                                <button
                                    type="button"
                                    onClick={() => {
                                        onChange(opt.key);
                                        setOpen(false);
                                    }}
                                    className={`flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-paper-muted ${
                                        opt.key === value ? 'bg-paper-muted' : ''
                                    }`}
                                >
                                    <span className="min-w-0">
                                        <span className="block truncate text-sm text-ink">{opt.display_name}</span>
                                        <span className="mt-0.5 block truncate text-xs text-minor-ink">
                                            {[opt.newapi_group, opt.description].filter(Boolean).join(' · ')}
                                        </span>
                                    </span>
                                    {ratioBadgeText(opt.ratio, opt.special, t) && (
                                        <span className="shrink-0 rounded-full border border-status-success-border bg-status-success-bg px-2 py-0.5 text-[11px] font-medium text-status-success-text">
                                            {ratioBadgeText(opt.ratio, opt.special, t)}
                                        </span>
                                    )}
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}

export function KeysList({ initialRows, tiers = [] }: { initialRows: KeyRow[]; tiers?: TierOption[] }) {
    // P3: 多档时【必选】不预选(null);单档自动定;无档配置(老部署)回落 'pool'
    // 由 server 端解析默认档。
    const initialTier: string | null = tiers.length > 1 ? null : (tiers[0]?.key ?? 'pool');
    const showTierChoice = tiers.length > 1;
    const tierLabel = (key: string) => tiers.find((t) => t.key === key)?.display_name ?? key;
    const msgs = useMessages(keysMessages);
    const t = msgs.list;
    const c = useMessages(commonMessages).auth;
    const locale: Locale = useLocale();

    const [rows, setRows] = useState<KeyRow[]>(initialRows);
    const [reveal, setReveal] = useState<RevealMap>({});
    const [copied, setCopied] = useState<CopiedMap>({});
    const [busyId, setBusyId] = useState<string | null>(null);
    const [globalError, setGlobalError] = useState<string | null>(null);
    const [edit, setEdit] = useState<EditState | null>(null);
    const [create, setCreate] = useState<CreateState>(() => emptyCreate(initialTier));
    const [budgetEdit, setBudgetEdit] = useState<BudgetEditState | null>(null);

    const isOnlyKey = rows.length === 1;

    // Auto-hide revealed keys after REVEAL_AUTOHIDE_MS so a forgotten tab
    // doesn't leave the sk- visible indefinitely.
    useEffect(() => {
        const visibleIds = Object.entries(reveal)
            .filter(([, v]) => typeof v === 'string')
            .map(([k]) => k);
        if (visibleIds.length === 0) return;
        const t = setTimeout(() => {
            setReveal((prev) => {
                const next = { ...prev };
                for (const id of visibleIds) delete next[id];
                return next;
            });
        }, REVEAL_AUTOHIDE_MS);
        return () => clearTimeout(t);
    }, [reveal]);

    async function fetchFullKey(id: string): Promise<string | null> {
        try {
            const r = await fetch(`/api/portal/keys/${encodeURIComponent(id)}/key`, {
                method: 'GET',
                credentials: 'same-origin',
            });
            if (!r.ok) {
                const data = await r.json().catch(() => ({}));
                setGlobalError(typeof data?.error === 'string' ? data.error : c.requestFailed(r.status));
                return null;
            }
            const data = (await r.json()) as { key?: string };
            return typeof data.key === 'string' ? data.key : null;
        } catch (err) {
            setGlobalError(err instanceof Error ? err.message : c.networkError);
            return null;
        }
    }

    async function handleReveal(id: string) {
        if (busyId) return;
        setBusyId(id);
        setGlobalError(null);
        const sk = await fetchFullKey(id);
        if (sk) setReveal((prev) => ({ ...prev, [id]: sk }));
        setBusyId(null);
    }

    async function handleCopy(id: string) {
        if (busyId) return;
        setBusyId(id);
        setGlobalError(null);
        const sk = await fetchFullKey(id);
        if (!sk) {
            setBusyId(null);
            return;
        }
        try {
            await navigator.clipboard.writeText(sk);
            setCopied((prev) => ({ ...prev, [id]: true }));
            setTimeout(() => {
                setCopied((prev) => {
                    const next = { ...prev };
                    delete next[id];
                    return next;
                });
            }, COPIED_TOAST_MS);
        } catch {
            setGlobalError(t.copyFailed);
        }
        setBusyId(null);
    }

    async function handleRevoke(id: string) {
        if (busyId) return;
        const warning = isOnlyKey ? t.revokeConfirmOnlyKey : t.revokeConfirm;
        if (!window.confirm(warning)) return;

        setBusyId(id);
        setGlobalError(null);
        try {
            const r = await fetch(`/api/portal/keys/${encodeURIComponent(id)}`, {
                method: 'DELETE',
                credentials: 'same-origin',
            });
            if (!r.ok) {
                const data = await r.json().catch(() => ({}));
                setGlobalError(typeof data?.error === 'string' ? data.error : t.revokeFailed(r.status));
            } else {
                setRows((prev) => prev.filter((row) => row.id !== id));
                setReveal((prev) => {
                    const next = { ...prev };
                    delete next[id];
                    return next;
                });
            }
        } catch (err) {
            setGlobalError(err instanceof Error ? err.message : c.networkError);
        }
        setBusyId(null);
    }

    function startEdit(row: KeyRow) {
        if (busyId || edit?.submitting) return;
        setGlobalError(null);
        setEdit({ id: row.id, alias: row.key_alias, submitting: false, error: null });
    }

    function cancelEdit() {
        if (edit?.submitting) return;
        setEdit(null);
    }

    async function submitEdit() {
        if (!edit || edit.submitting) return;
        const alias = edit.alias.trim();
        if (!alias) {
            setEdit((prev) => (prev ? { ...prev, error: t.aliasRequired } : prev));
            return;
        }
        const current = rows.find((r) => r.id === edit.id);
        if (current && current.key_alias === alias) {
            setEdit(null);
            return;
        }
        setEdit((prev) => (prev ? { ...prev, submitting: true, error: null } : prev));
        try {
            const r = await fetch(`/api/portal/keys/${encodeURIComponent(edit.id)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ alias }),
            });
            if (!r.ok) {
                const data = await r.json().catch(() => ({}));
                const msg =
                    r.status === 502
                        ? t.saveFailedUpstream
                        : typeof data?.error === 'string'
                          ? data.error
                          : t.saveFailed(r.status);
                setEdit((prev) => (prev ? { ...prev, submitting: false, error: msg } : prev));
                return;
            }
            const data = (await r.json()) as { key_alias?: string };
            const saved = typeof data.key_alias === 'string' ? data.key_alias : alias;
            setRows((prev) => prev.map((row) => (row.id === edit.id ? { ...row, key_alias: saved } : row)));
            setEdit(null);
        } catch (err) {
            setEdit((prev) =>
                prev
                    ? { ...prev, submitting: false, error: err instanceof Error ? err.message : c.networkError }
                    : prev,
            );
        }
    }

    function startBudgetEdit(row: KeyRow) {
        if (busyId || budgetEdit?.submitting) return;
        setGlobalError(null);
        setBudgetEdit({
            id: row.id,
            quotaUnlimited: row.quota_unlimited !== false,
            quotaCny: row.quota_unlimited === false ? (row.remainCny ?? 0).toFixed(2) : '',
            expiryPreset: row.expires_at ? 'custom' : 'never',
            expiryCustom: row.expires_at ? toDatetimeLocalValue(row.expires_at) : '',
            submitting: false,
            error: null,
        });
    }

    function cancelBudgetEdit() {
        if (budgetEdit?.submitting) return;
        setBudgetEdit(null);
    }

    async function submitBudgetEdit() {
        if (!budgetEdit || budgetEdit.submitting) return;
        const budget = buildQuotaExpiryPayload(budgetEdit, new Date(), locale);
        if (!budget.ok) {
            setBudgetEdit((prev) => (prev ? { ...prev, error: budget.error } : prev));
            return;
        }
        setBudgetEdit((prev) => (prev ? { ...prev, submitting: true, error: null } : prev));
        try {
            const r = await fetch(`/api/portal/keys/${encodeURIComponent(budgetEdit.id)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ quotaCny: budget.quotaCny, expiresAt: budget.expiresAt }),
            });
            if (!r.ok) {
                const data = await r.json().catch(() => ({}));
                const msg =
                    r.status === 502
                        ? t.saveFailedUpstream
                        : typeof data?.error === 'string'
                          ? data.error
                          : t.saveFailed(r.status);
                setBudgetEdit((prev) => (prev ? { ...prev, submitting: false, error: msg } : prev));
                return;
            }
            const data = (await r.json()) as {
                quota_unlimited?: boolean;
                remainCny?: number | null;
                expires_at?: string | null;
            };
            setRows((prev) =>
                prev.map((row) =>
                    row.id === budgetEdit.id
                        ? {
                              ...row,
                              meta_available: true,
                              quota_unlimited: data.quota_unlimited ?? budget.quotaCny == null,
                              remainCny: data.remainCny ?? budget.quotaCny,
                              expires_at: data.expires_at ?? budget.expiresAt,
                          }
                        : row,
                ),
            );
            setBudgetEdit(null);
        } catch (err) {
            setBudgetEdit((prev) =>
                prev
                    ? { ...prev, submitting: false, error: err instanceof Error ? err.message : c.networkError }
                    : prev,
            );
        }
    }

    async function handleCreate(e: React.FormEvent) {
        e.preventDefault();
        if (create.submitting) return;
        const alias = create.alias.trim();
        if (!alias) {
            setCreate((prev) => ({ ...prev, error: t.aliasRequired }));
            return;
        }
        if (showTierChoice && !create.tier) {
            setCreate((prev) => ({ ...prev, error: msgs.tier.required }));
            return;
        }
        const budget = buildQuotaExpiryPayload(create, new Date(), locale);
        if (!budget.ok) {
            setCreate((prev) => ({ ...prev, error: budget.error }));
            return;
        }
        setCreate((prev) => ({ ...prev, submitting: true, error: null }));
        try {
            const r = await fetch('/api/portal/keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                    alias,
                    ...(create.tier ? { tier: create.tier } : {}),
                    quotaCny: budget.quotaCny,
                    expiresAt: budget.expiresAt,
                }),
            });
            if (!r.ok) {
                const data = await r.json().catch(() => ({}));
                setCreate((prev) => ({
                    ...prev,
                    submitting: false,
                    error: typeof data?.error === 'string' ? data.error : t.createFailed(r.status),
                }));
                return;
            }
            const data = (await r.json()) as {
                id: string;
                key_alias: string;
                key: string;
                created_at: string;
                tier?: string;
                quota_unlimited?: boolean;
                remainCny?: number | null;
                expires_at?: string | null;
            };
            const newRow: KeyRow = {
                id: data.id,
                key_alias: data.key_alias,
                masked_key: maskKey(data.key),
                created_at: data.created_at,
                // Brand-new key — no usage yet by definition.
                used_quota: 0,
                usedCny: 0,
                last_used_at: null,
                tier: data.tier ?? create.tier ?? 'pool',
                meta_available: true,
                quota_unlimited: data.quota_unlimited ?? budget.quotaCny == null,
                remainCny: data.remainCny ?? budget.quotaCny,
                expires_at: data.expires_at ?? budget.expiresAt,
            };
            setRows((prev) => [...prev, newRow]);
            // Auto-reveal the brand-new key so the customer can copy it
            // immediately. The auto-hide timer above re-masks after 10s.
            // (W7 D4 PR-R Item C — the per-row "如何使用此 Key" panel
            // was removed; the unified bottom 调用示例 panel covers all
            // keys, so there's no per-row panel to auto-expand here.)
            setReveal((prev) => ({ ...prev, [data.id]: data.key }));
            setCreate(emptyCreate(initialTier));
        } catch (err) {
            setCreate((prev) => ({
                ...prev,
                submitting: false,
                error: err instanceof Error ? err.message : c.networkError,
            }));
        }
    }

    const tableHeader = useMemo(
        () => (
            <thead>
                <tr className="bg-paper-muted text-muted-ink">
                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                        {t.colAlias}
                    </th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                        {t.colKey}
                    </th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                        {t.colQuota}
                    </th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                        {t.colCreated}
                    </th>
                    <th className="text-right px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                        {t.colActions}
                    </th>
                </tr>
            </thead>
        ),
        [t],
    );

    return (
        <div>
            <div className="flex justify-end mb-3">
                <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={() => setCreate({ ...emptyCreate(initialTier), open: true })}
                    disabled={create.open}
                >
                    {t.createNew}
                </Button>
            </div>

            {create.open && (
                <Card className="p-4 mb-4">
                    <form onSubmit={handleCreate} className="flex gap-2 items-start">
                        <div className="flex-1">
                            <Input
                                type="text"
                                placeholder={t.aliasPlaceholder}
                                value={create.alias}
                                onChange={(e) => setCreate((prev) => ({ ...prev, alias: e.target.value, error: null }))}
                                maxLength={50}
                                autoFocus
                                error={!!create.error}
                                className="text-sm"
                            />
                            <p className="m-0 mt-1.5 text-xs text-minor-ink">
                                {t.aliasHintBefore}
                                <code className="font-mono text-xs">env-purpose</code>
                                {t.aliasHintAfter}
                            </p>
                            {showTierChoice && (
                                <div className="mt-2.5 max-w-md">
                                    <p className="m-0 mb-1 text-xs font-medium text-muted-ink">
                                        {msgs.tier.label}
                                        <span className="text-status-error-text">*</span>
                                    </p>
                                    <TierSelect
                                        tiers={tiers}
                                        value={create.tier}
                                        onChange={(key) => setCreate((prev) => ({ ...prev, tier: key, error: null }))}
                                        disabled={create.submitting}
                                    />
                                    <p className="m-0 mt-1 text-xs text-minor-ink">{msgs.tier.hint}</p>
                                </div>
                            )}
                            <div className="mt-3 max-w-2xl">
                                <QuotaExpiryFields
                                    idPrefix="create"
                                    value={create}
                                    disabled={create.submitting}
                                    onChange={(patch) => setCreate((prev) => ({ ...prev, ...patch, error: null }))}
                                />
                            </div>
                            <FormError>{create.error}</FormError>
                        </div>
                        <Button
                            type="submit"
                            variant="primary"
                            size="sm"
                            loading={create.submitting}
                            disabled={create.submitting || !create.alias.trim() || (showTierChoice && !create.tier)}
                        >
                            {create.submitting ? t.creating : t.create}
                        </Button>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => setCreate(emptyCreate(initialTier))}
                            disabled={create.submitting}
                        >
                            {t.cancel}
                        </Button>
                    </form>
                </Card>
            )}

            {globalError ? (
                <div className="mb-3">
                    <FormError severity="banner">{globalError}</FormError>
                </div>
            ) : null}

            {rows.length === 0 ? (
                <Card>
                    <EmptyState
                        title={t.emptyTitle}
                        body={
                            <>
                                {t.emptyBodyBefore}
                                <code className="font-mono text-xs">{t.createNew}</code>
                                {t.emptyBodyAfter}
                            </>
                        }
                    />
                </Card>
            ) : (
                <Card className="overflow-hidden">
                    <table className="w-full border-collapse">
                        {tableHeader}
                        <tbody>
                            {rows.map((row, idx) => {
                                const revealed = reveal[row.id];
                                const showCopied = copied[row.id];
                                const busy = busyId === row.id;
                                const editing = edit?.id === row.id ? edit : null;
                                const budgetEditing = budgetEdit?.id === row.id ? budgetEdit : null;
                                const isLast = idx === rows.length - 1;
                                // W7 D4 PR-R Item C: rows are flat again.
                                // The per-row "如何使用此 Key" panel that
                                // PR-G stitched in was replaced by a single
                                // unified 调用示例 panel below the table
                                // (see <KeysSnippetsPanel /> rendered by
                                // keys/page.tsx). Border treatment matches
                                // the rest of the portal: every row except
                                // the last gets a bottom border.
                                const cell = `px-4 py-3 text-sm text-ink`;
                                const borderClass = isLast ? '' : 'border-b border-brand-border';
                                return (
                                    <tr key={row.id}>
                                        <td className={`${cell} ${borderClass}`}>
                                            {editing ? (
                                                <div>
                                                    <div className="flex items-center gap-1.5">
                                                        <Input
                                                            type="text"
                                                            value={editing.alias}
                                                            onChange={(e) =>
                                                                setEdit((prev) =>
                                                                    prev
                                                                        ? {
                                                                              ...prev,
                                                                              alias: e.target.value,
                                                                              error: null,
                                                                          }
                                                                        : prev,
                                                                )
                                                            }
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter') {
                                                                    e.preventDefault();
                                                                    void submitEdit();
                                                                } else if (e.key === 'Escape') {
                                                                    e.preventDefault();
                                                                    cancelEdit();
                                                                }
                                                            }}
                                                            maxLength={50}
                                                            autoFocus
                                                            disabled={editing.submitting}
                                                            error={!!editing.error}
                                                            aria-label={t.aliasAria}
                                                            block={false}
                                                            className="text-sm w-44"
                                                        />
                                                        <Button
                                                            type="button"
                                                            variant="primary"
                                                            size="sm"
                                                            onClick={() => void submitEdit()}
                                                            loading={editing.submitting}
                                                            disabled={editing.submitting || !editing.alias.trim()}
                                                        >
                                                            {t.save}
                                                        </Button>
                                                        <Button
                                                            type="button"
                                                            variant="secondary"
                                                            size="sm"
                                                            onClick={cancelEdit}
                                                            disabled={editing.submitting}
                                                        >
                                                            {t.cancel}
                                                        </Button>
                                                    </div>
                                                    <FormError>{editing.error}</FormError>
                                                </div>
                                            ) : (
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span>{row.key_alias}</span>
                                                    <span className="rounded-full bg-paper-muted px-2 py-0.5 text-[10px] font-medium text-muted-ink">
                                                        {tierLabel(row.tier)}
                                                    </span>
                                                    <button
                                                        type="button"
                                                        onClick={() => startEdit(row)}
                                                        disabled={busy || !!edit}
                                                        title={t.editAliasTitle}
                                                        aria-label={t.editAliasAria(row.key_alias)}
                                                        className="cursor-pointer rounded px-1 text-xs text-minor-ink hover:text-navy hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                                                    >
                                                        {t.edit}
                                                    </button>
                                                </div>
                                            )}
                                        </td>
                                        <td className={`${cell} ${borderClass}`}>
                                            <div
                                                className={[
                                                    'font-mono',
                                                    revealed ? 'text-navy' : 'text-muted-ink',
                                                ].join(' ')}
                                            >
                                                {revealed ?? row.masked_key}
                                            </div>
                                            {/* W6 D4: per-key usage subline. Grey/small so it never
                                             *  competes with the masked sk-. Renders null state
                                             *  ("从未调用") explicitly so customers see the key exists
                                             *  but isn't being hit. */}
                                            <div className="mt-1 text-xs text-minor-ink tabular-nums">
                                                {row.used_quota === null ? (
                                                    <span>{t.usageUnavailable}</span>
                                                ) : (
                                                    <>
                                                        {t.cumulative}
                                                        {formatCny(row.usedCny ?? 0).exact}
                                                        <span className="mx-1.5">·</span>
                                                        {t.lastUsed}
                                                        {formatLastUsed(row.last_used_at, msgs.lastUsed)}
                                                    </>
                                                )}
                                            </div>
                                        </td>
                                        <td className={`${cell} ${borderClass}`}>
                                            {budgetEditing ? (
                                                <div className="min-w-[22rem]">
                                                    <QuotaExpiryFields
                                                        idPrefix={`edit-${row.id}`}
                                                        value={budgetEditing}
                                                        disabled={budgetEditing.submitting}
                                                        onChange={(patch) =>
                                                            setBudgetEdit((prev) =>
                                                                prev ? { ...prev, ...patch, error: null } : prev,
                                                            )
                                                        }
                                                    />
                                                    <div className="mt-2 flex items-center gap-1.5">
                                                        <Button
                                                            type="button"
                                                            variant="primary"
                                                            size="sm"
                                                            onClick={() => void submitBudgetEdit()}
                                                            loading={budgetEditing.submitting}
                                                            disabled={budgetEditing.submitting}
                                                        >
                                                            {t.save}
                                                        </Button>
                                                        <Button
                                                            type="button"
                                                            variant="secondary"
                                                            size="sm"
                                                            onClick={cancelBudgetEdit}
                                                            disabled={budgetEditing.submitting}
                                                        >
                                                            {t.cancel}
                                                        </Button>
                                                    </div>
                                                    <FormError>{budgetEditing.error}</FormError>
                                                </div>
                                            ) : (
                                                <div className="flex items-start gap-2">
                                                    <BudgetSummary row={row} />
                                                    {row.meta_available && (
                                                        <button
                                                            type="button"
                                                            onClick={() => startBudgetEdit(row)}
                                                            disabled={busy || !!budgetEdit}
                                                            title={t.adjustTitle}
                                                            aria-label={t.adjustAria(row.key_alias)}
                                                            className="cursor-pointer rounded px-1 text-xs text-minor-ink hover:text-navy hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                                                        >
                                                            {t.adjust}
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </td>
                                        <td className={`${cell} ${borderClass} text-muted-ink`}>
                                            {new Date(row.created_at).toLocaleString(intlLocale(locale), {
                                                timeZone: 'Asia/Shanghai',
                                            })}
                                        </td>
                                        <td className={`${cell} ${borderClass} text-right`}>
                                            <span className="inline-flex gap-1.5 justify-end">
                                                <Button
                                                    type="button"
                                                    variant="secondary"
                                                    size="sm"
                                                    onClick={() => handleReveal(row.id)}
                                                    disabled={busy || !!revealed}
                                                >
                                                    {revealed ? t.revealed : t.reveal}
                                                </Button>
                                                <Button
                                                    type="button"
                                                    variant="secondary"
                                                    size="sm"
                                                    onClick={() => handleCopy(row.id)}
                                                    disabled={busy}
                                                >
                                                    {showCopied ? t.copiedCheck : t.copy}
                                                </Button>
                                                <Button
                                                    type="button"
                                                    variant="danger"
                                                    size="sm"
                                                    onClick={() => handleRevoke(row.id)}
                                                    disabled={busy}
                                                >
                                                    {t.revoke}
                                                </Button>
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </Card>
            )}
        </div>
    );
}
