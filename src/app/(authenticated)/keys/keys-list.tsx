'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatCny } from '@/lib/format/number';
import { Input } from '@/components/ui/Input';
import { intlLocale, type Locale } from '@/lib/i18n';
import { useLocale, useMessages } from '@/lib/i18n/client';
import { commonMessages } from '@/lib/i18n/messages/common';
import { keysMessages, type KeysMessages } from '@/lib/i18n/messages/keys';
import { provisioningMessages, type ProvisioningQueueStatus } from '@/lib/i18n/messages/provisioning';
import {
    buildQuotaExpiryPayload,
    EXPIRY_PRESETS,
    expiryPresetLabels,
    formatExpiry,
    isExpired,
    toDatetimeLocalValue,
    type ExpiryPreset,
} from '@/lib/keys/quota-expiry';
import { Check, Clipboard, Eye, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
// NOTE: this 'use client' island does NOT convert quota→¥ itself. quotaToCny
// reads NEWAPI_QUOTA_PER_USD / USD_TO_CNY_RATE — server-only env that is
// undefined in the browser bundle, so quota-units would fall back to stale
// defaults (500k / 7.2) and over-display ¥ by ~2×. The server passes the
// ready-to-render ¥ (KeyRow.usedCny) instead.
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';

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
    /** P3: tenant-scoped dynamic ChannelGroup.key. */
    tier: string;
    /** Effective GroupGroupRatio for the signed-in customer, if configured. */
    effective_ratio?: number | null;
    meta_available?: boolean;
    upstream_status?: 1 | 2 | 3 | 4 | null;
    requires_reactivation?: boolean;
    quota_unlimited?: boolean | null;
    remainCny?: number | null;
    expires_at?: string | null;
}

/** P3: a selectable tier (an enabled ChannelGroup), passed from the server page. */
export interface TierOption {
    key: string;
    display_name: string;
    description: string | null;
    is_default: boolean;
    /** new-api group name, shown as the selector's secondary label. */
    newapi_group: string;
    /** Group multiplier; null when new-api cannot be reached. */
    ratio: number | null;
    listRatio?: number | null;
    special?: boolean;
}

export interface KeyProvisioningState {
    status: ProvisioningQueueStatus;
    nextAttemptAt: string | null;
    /** True only when the customer has a usable new-api account linkage. */
    ready: boolean;
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
const ACTION_BUTTON =
    'flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-transparent text-portal-subtle sm:h-8 sm:w-8 ' +
    'transition-colors hover:border-portal-line hover:bg-portal-soft hover:text-portal-ink ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/20 disabled:cursor-not-allowed disabled:opacity-40';

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
    quotaLimitsEnabled?: boolean;
}) {
    const { value, onChange, disabled, idPrefix, quotaLimitsEnabled = false } = props;
    const t = useMessages(keysMessages).fields;
    const presetLabels = expiryPresetLabels(useLocale());
    return (
        <div className="grid gap-3 sm:grid-cols-2">
            {quotaLimitsEnabled && (
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
            )}
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
    const inactive = row.requires_reactivation || (row.upstream_status != null && row.upstream_status !== 1);
    const expired = isExpired(row.expires_at ?? null);
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
                {formatExpiry(row.expires_at ?? null, locale)}
                {expired && badge(t.budget.expired)}
            </div>
            {inactive && <p className="m-0 mt-1 text-xs text-status-error-text">{t.quotaExpiry.keyInactive}</p>}
        </div>
    );
}

function ratioBadgeText(ratio: number | null, special: boolean, t: KeysMessages['tier']): string | null {
    if (ratio == null) return null;
    return special ? t.specialRatio(ratio) : t.ratio(ratio);
}

/** Searchable group selector. Multiple groups intentionally start unselected. */
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

    const normalizedQuery = query.trim().toLowerCase();
    const filtered = normalizedQuery
        ? tiers.filter((tier) =>
              [tier.key, tier.display_name, tier.description ?? '', tier.newapi_group].some((value) =>
                  value.toLowerCase().includes(normalizedQuery),
              ),
          )
        : tiers;
    const selected = value == null ? undefined : tiers.find((tier) => tier.key === value);

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                disabled={disabled}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => {
                    setQuery('');
                    setOpen((current) => !current);
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                    open ? 'border-navy' : 'border-portal-line'
                } bg-portal-panel hover:bg-portal-soft disabled:cursor-not-allowed disabled:opacity-60`}
            >
                {selected ? (
                    <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-portal-ink">{selected.display_name}</span>
                        {ratioBadgeText(selected.ratio, !!selected.special, t) && (
                            <span className="shrink-0 rounded border border-status-success-border bg-status-success-bg px-1.5 py-0.5 text-[11px] font-medium text-status-success-text">
                                {ratioBadgeText(selected.ratio, !!selected.special, t)}
                            </span>
                        )}
                    </span>
                ) : (
                    <span className="text-portal-subtle">{t.pick}</span>
                )}
                <span aria-hidden className="shrink-0 text-[10px] text-portal-subtle">
                    {open ? '▲' : '▼'}
                </span>
            </button>
            {open && (
                <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-portal-line bg-portal-panel shadow-portal">
                    <div className="border-b border-portal-line p-2">
                        <input
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={t.searchPlaceholder}
                            autoFocus
                            className="w-full rounded-md border border-portal-line bg-portal-soft px-2.5 py-1.5 text-sm text-portal-ink outline-none focus:border-navy"
                        />
                    </div>
                    <ul role="listbox" className="m-0 max-h-64 list-none overflow-y-auto p-1">
                        {filtered.length === 0 && <li className="px-3 py-2 text-sm text-portal-subtle">{t.noMatch}</li>}
                        {filtered.map((tier) => (
                            <li key={tier.key} role="option" aria-selected={tier.key === value}>
                                <button
                                    type="button"
                                    onClick={() => {
                                        onChange(tier.key);
                                        setOpen(false);
                                    }}
                                    className={`flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-portal-soft ${
                                        tier.key === value ? 'bg-portal-soft' : ''
                                    }`}
                                >
                                    <span className="min-w-0">
                                        <span className="block truncate text-sm text-portal-ink">
                                            {tier.display_name}
                                        </span>
                                        <span className="mt-0.5 block truncate text-xs text-portal-subtle">
                                            {[tier.newapi_group, tier.description].filter(Boolean).join(' · ')}
                                        </span>
                                    </span>
                                    {ratioBadgeText(tier.ratio, !!tier.special, t) && (
                                        <span className="shrink-0 rounded border border-status-success-border bg-status-success-bg px-1.5 py-0.5 text-[11px] font-medium text-status-success-text">
                                            {ratioBadgeText(tier.ratio, !!tier.special, t)}
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

function KeyActions({
    row,
    busy,
    revealed,
    copied,
    editing,
    actionsDisabled,
    onReveal,
    onCopy,
    onEdit,
    onRevoke,
}: {
    row: KeyRow;
    busy: boolean;
    revealed: boolean;
    copied: boolean;
    editing: boolean;
    actionsDisabled?: boolean;
    onReveal: () => void;
    onCopy: () => void;
    onEdit: () => void;
    onRevoke: () => void;
}) {
    const t = useMessages(keysMessages).actions;
    return (
        <span className="inline-flex shrink-0 justify-end gap-1">
            <button
                type="button"
                onClick={onReveal}
                disabled={actionsDisabled || busy || revealed}
                className={ACTION_BUTTON}
                aria-label={revealed ? t.revealedAria(row.key_alias) : t.revealAria(row.key_alias)}
                title={revealed ? t.revealedTitle : t.revealTitle}
            >
                <Eye size={15} strokeWidth={1.8} aria-hidden="true" />
                <span className="sr-only">{t.reveal}</span>
            </button>
            <button
                type="button"
                onClick={onCopy}
                disabled={actionsDisabled || busy}
                className={ACTION_BUTTON}
                aria-label={copied ? t.copiedAria(row.key_alias) : t.copyAria(row.key_alias)}
                title={copied ? t.copiedTitle : t.copyTitle}
            >
                {copied ? (
                    <Check size={15} className="text-status-success-text" aria-hidden="true" />
                ) : (
                    <Clipboard size={15} strokeWidth={1.8} aria-hidden="true" />
                )}
                <span className="sr-only">{t.copy}</span>
            </button>
            <button
                type="button"
                onClick={onEdit}
                disabled={actionsDisabled || busy || editing}
                className={ACTION_BUTTON}
                aria-label={t.editAliasAria(row.key_alias)}
                title={t.editAliasTitle}
            >
                <Pencil size={15} strokeWidth={1.8} aria-hidden="true" />
                <span className="sr-only">{t.edit}</span>
            </button>
            <button
                type="button"
                onClick={onRevoke}
                disabled={actionsDisabled || busy}
                className={`${ACTION_BUTTON} hover:border-status-error-border hover:bg-status-error-bg hover:text-status-error-text`}
                aria-label={t.revokeAria(row.key_alias)}
                title={t.revokeTitle}
            >
                <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
                <span className="sr-only">{t.revoke}</span>
            </button>
        </span>
    );
}

function AliasEditor({
    edit,
    onChange,
    onSave,
    onCancel,
}: {
    edit: EditState;
    onChange: (alias: string) => void;
    onSave: () => void;
    onCancel: () => void;
}) {
    const t = useMessages(keysMessages).list;
    return (
        <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
                <input
                    type="text"
                    aria-label={t.aliasAria}
                    value={edit.alias}
                    maxLength={50}
                    disabled={edit.submitting}
                    onChange={(event) => onChange(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            onSave();
                        } else if (event.key === 'Escape') {
                            event.preventDefault();
                            onCancel();
                        }
                    }}
                    className="w-40 min-w-0 rounded-md border border-portal-line bg-portal-panel px-2 py-1 text-sm text-portal-ink outline-none focus:border-navy disabled:opacity-60"
                />
                <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={onSave}
                    disabled={edit.submitting || !edit.alias.trim()}
                    loading={edit.submitting}
                >
                    {t.save}
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={edit.submitting}>
                    {t.cancel}
                </Button>
            </div>
            <FormError>{edit.error}</FormError>
        </div>
    );
}

export function KeysList({
    initialRows,
    tiers = [],
    quotaLimitsEnabled = false,
    provisioning = { status: null, nextAttemptAt: null, ready: true },
}: {
    initialRows: KeyRow[];
    tiers?: TierOption[];
    quotaLimitsEnabled?: boolean;
    provisioning?: KeyProvisioningState;
}) {
    // Multi-tier accounts must deliberately select a group. Missing topology
    // is an operator error; never invent a legacy `pool` tier in the browser.
    const initialTier: string | null = tiers.length === 1 ? tiers[0].key : null;
    const showTierChoice = tiers.length > 1;
    const tierLabel = (key: string) => tiers.find((t) => t.key === key)?.display_name ?? key;
    const m = useMessages(keysMessages);
    const t = m.list;
    const c = useMessages(commonMessages).auth;
    const provisioningCopy = useMessages(provisioningMessages);
    const locale: Locale = useLocale();
    const router = useRouter();
    const actionsDisabled = !provisioning.ready;

    const provisioningBody = (() => {
        switch (provisioning.status) {
            case 'queued':
                return provisioningCopy.queued;
            case 'running':
                return provisioningCopy.running;
            case 'retry_wait': {
                const time = provisioning.nextAttemptAt ? new Date(provisioning.nextAttemptAt) : null;
                if (!time || Number.isNaN(time.getTime())) {
                    return `${provisioningCopy.retryWait} ${provisioningCopy.retrySoon}`;
                }
                return `${provisioningCopy.retryWait} ${provisioningCopy.retryAt(
                    time.toLocaleString(intlLocale(locale), { timeZone: 'Asia/Shanghai' }),
                )}`;
            }
            case 'failed':
                return provisioningCopy.failed;
            case 'completed':
                return provisioningCopy.completedMissingLink;
            default:
                return provisioningCopy.unknown;
        }
    })();

    const [rows, setRows] = useState<KeyRow[]>(initialRows);
    const [reveal, setReveal] = useState<RevealMap>({});
    const [copied, setCopied] = useState<CopiedMap>({});
    const [busyId, setBusyId] = useState<string | null>(null);
    const [globalError, setGlobalError] = useState<string | null>(null);
    const [edit, setEdit] = useState<EditState | null>(null);
    const [create, setCreate] = useState<CreateState>(() => emptyCreate(initialTier));
    const [budgetEdit, setBudgetEdit] = useState<BudgetEditState | null>(null);

    const isOnlyKey = rows.length === 1;

    useEffect(() => {
        if (provisioning.ready || provisioning.status === null || provisioning.status === 'failed') return;
        const timer = window.setInterval(() => router.refresh(), 5_000);
        return () => window.clearInterval(timer);
    }, [provisioning.ready, provisioning.status, router]);

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
        if (actionsDisabled) return null;
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
        if (actionsDisabled || busyId) return;
        setBusyId(id);
        setGlobalError(null);
        const sk = await fetchFullKey(id);
        if (sk) setReveal((prev) => ({ ...prev, [id]: sk }));
        setBusyId(null);
    }

    async function handleCopy(id: string) {
        if (actionsDisabled || busyId) return;
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
        if (actionsDisabled || busyId) return;
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
        if (actionsDisabled || busyId || edit) return;
        setGlobalError(null);
        setEdit({ id: row.id, alias: row.key_alias, submitting: false, error: null });
    }

    function cancelEdit() {
        if (!edit?.submitting) setEdit(null);
    }

    async function submitEdit() {
        if (actionsDisabled || !edit || edit.submitting || busyId) return;
        const alias = edit.alias.trim();
        if (!alias) {
            setEdit((current) => current && { ...current, error: t.aliasRequired });
            return;
        }
        const current = rows.find((row) => row.id === edit.id);
        if (current?.key_alias === alias) {
            setEdit(null);
            return;
        }
        const id = edit.id;
        setEdit((current) => current && { ...current, submitting: true, error: null });
        try {
            const response = await fetch(`/api/portal/keys/${encodeURIComponent(id)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ alias }),
            });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                const error =
                    response.status === 502
                        ? t.aliasSaveFailedUpstream
                        : typeof data?.error === 'string'
                          ? data.error
                          : t.saveFailed(response.status);
                setEdit((current) => current && { ...current, submitting: false, error });
                return;
            }
            const data = (await response.json()) as { key_alias?: string };
            const savedAlias = typeof data.key_alias === 'string' ? data.key_alias : alias;
            setRows((current) => current.map((row) => (row.id === id ? { ...row, key_alias: savedAlias } : row)));
            setEdit(null);
        } catch (error) {
            setEdit(
                (current) =>
                    current && {
                        ...current,
                        submitting: false,
                        error: error instanceof Error ? error.message : c.networkError,
                    },
            );
        }
    }

    function startBudgetEdit(row: KeyRow) {
        if (actionsDisabled || busyId || budgetEdit?.submitting) return;
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
        if (actionsDisabled || !budgetEdit || budgetEdit.submitting) return;
        const budget = buildQuotaExpiryPayload(
            { ...budgetEdit, quotaUnlimited: !quotaLimitsEnabled || budgetEdit.quotaUnlimited },
            new Date(),
            locale,
        );
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
                body: JSON.stringify({
                    ...(quotaLimitsEnabled ? { quotaCny: budget.quotaCny } : {}),
                    expiresAt: budget.expiresAt,
                }),
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
                requires_reactivation?: boolean;
            };
            setRows((prev) =>
                prev.map((row) =>
                    row.id === budgetEdit.id
                        ? {
                              ...row,
                              meta_available: true,
                              requires_reactivation:
                                  data.requires_reactivation ??
                                  row.requires_reactivation ??
                                  (row.upstream_status != null && row.upstream_status !== 1),
                              quota_unlimited:
                                  data.quota_unlimited ??
                                  (quotaLimitsEnabled ? budget.quotaCny == null : row.quota_unlimited),
                              remainCny: data.remainCny ?? (quotaLimitsEnabled ? budget.quotaCny : row.remainCny),
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
        if (actionsDisabled || create.submitting) return;
        const alias = create.alias.trim();
        if (!alias || !create.tier) {
            setCreate((prev) => ({ ...prev, error: !alias ? t.aliasRequired : m.tier.required }));
            return;
        }
        const tier = create.tier;
        const budget = buildQuotaExpiryPayload(
            { ...create, quotaUnlimited: !quotaLimitsEnabled || create.quotaUnlimited },
            new Date(),
            locale,
        );
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
                    tier,
                    ...(quotaLimitsEnabled ? { quotaCny: budget.quotaCny } : {}),
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
                tier: data.tier ?? tier,
                meta_available: true,
                upstream_status: 1,
                requires_reactivation: false,
                quota_unlimited: data.quota_unlimited ?? budget.quotaCny === null,
                remainCny: data.remainCny ?? budget.quotaCny,
                expires_at: data.expires_at ?? budget.expiresAt,
                effective_ratio: tiers.find((option) => option.key === (data.tier ?? tier))?.ratio ?? null,
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
                <tr className="bg-portal-soft text-portal-muted">
                    <th className="border-b border-portal-line px-5 py-2.5 text-left text-xs font-semibold">
                        {t.colAlias}
                    </th>
                    <th className="border-b border-portal-line px-5 py-2.5 text-left text-xs font-semibold">
                        {t.colKey}
                    </th>
                    <th className="border-b border-portal-line px-5 py-2.5 text-left text-xs font-semibold">
                        {t.colQuota}
                    </th>
                    <th className="border-b border-portal-line px-5 py-2.5 text-left text-xs font-semibold">
                        {t.colCreated}
                    </th>
                    <th className="border-b border-portal-line px-5 py-2.5 text-right text-xs font-semibold">
                        {t.colActions}
                    </th>
                </tr>
            </thead>
        ),
        [t],
    );

    return (
        <div className="space-y-4">
            {actionsDisabled && (
                <section
                    role="status"
                    aria-live="polite"
                    className="rounded-lg border border-status-warning-border bg-status-warning-bg px-4 py-3 text-sm text-status-warning-text"
                >
                    <h2 className="m-0 text-sm font-semibold">{provisioningCopy.heading}</h2>
                    <p className="m-0 mt-1 leading-relaxed">{provisioningBody}</p>
                </section>
            )}
            {globalError ? (
                <div>
                    <FormError severity="banner">{globalError}</FormError>
                </div>
            ) : null}

            <section
                className={[
                    'rounded-lg border border-portal-line bg-portal-panel shadow-portal',
                    // The tier menu is an absolute overlay. Let it escape the
                    // card while the create form is open, otherwise the card's
                    // overflow clipping cuts off the options at its bottom edge.
                    create.open ? 'relative z-20 overflow-visible' : 'overflow-hidden',
                ].join(' ')}
            >
                <div className="flex flex-col gap-3 border-b border-portal-line px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                    <div className="flex min-w-0 items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-portal-gold-soft text-portal-gold">
                            <KeyRound size={18} strokeWidth={1.8} aria-hidden="true" />
                        </span>
                        <div className="min-w-0">
                            <h2 className="m-0 text-sm font-semibold text-portal-ink">{t.sectionTitle}</h2>
                            <p className="m-0 mt-0.5 text-xs text-portal-subtle tabular-nums">
                                {t.keyCount(rows.length)}
                            </p>
                        </div>
                    </div>
                    <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        onClick={() => setCreate({ ...emptyCreate(initialTier), open: true })}
                        disabled={actionsDisabled || create.open || tiers.length === 0}
                        title={tiers.length === 0 ? t.noTiersTitle : t.createTitle}
                        className="rounded-md"
                    >
                        <Plus size={15} strokeWidth={2} aria-hidden="true" />
                        <span>{t.createNew}</span>
                    </Button>
                </div>

                {create.open && (
                    <form onSubmit={handleCreate} className="border-b border-portal-line bg-portal-soft p-4 sm:p-5">
                        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                            <div className="min-w-0">
                                <label
                                    htmlFor="new-key-alias"
                                    className="mb-1.5 block text-xs font-medium text-portal-muted"
                                >
                                    {t.aliasLabel}
                                </label>
                                <input
                                    id="new-key-alias"
                                    type="text"
                                    placeholder={t.aliasPlaceholder}
                                    value={create.alias}
                                    onChange={(e) =>
                                        setCreate((prev) => ({ ...prev, alias: e.target.value, error: null }))
                                    }
                                    maxLength={50}
                                    autoFocus
                                    aria-invalid={!!create.error}
                                    disabled={actionsDisabled || create.submitting}
                                    className="h-10 w-full rounded-md border border-portal-line bg-portal-panel px-3 text-sm text-portal-ink outline-none placeholder:text-portal-subtle focus:border-navy focus:ring-2 focus:ring-navy/10 disabled:opacity-60"
                                />
                                <p className="m-0 mt-1.5 text-xs text-portal-subtle">
                                    {t.aliasHintBefore}
                                    <code className="font-mono text-[11px] text-portal-muted">env-purpose</code>
                                    {t.aliasHintAfter}
                                </p>
                            </div>
                            <div className="flex flex-col-reverse gap-2 sm:flex-row lg:pb-6">
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => setCreate(emptyCreate(initialTier))}
                                    disabled={actionsDisabled || create.submitting}
                                    className="rounded-md border-portal-line text-portal-muted"
                                >
                                    {t.cancel}
                                </Button>
                                <Button
                                    type="submit"
                                    variant="primary"
                                    size="sm"
                                    loading={create.submitting}
                                    disabled={
                                        actionsDisabled || create.submitting || !create.alias.trim() || !create.tier
                                    }
                                    className="rounded-md"
                                >
                                    {create.submitting ? t.creating : t.create}
                                </Button>
                            </div>
                        </div>

                        {showTierChoice && (
                            <fieldset className="mt-4 border-0 p-0">
                                <legend className="mb-2 text-xs font-medium text-portal-muted">{m.tier.legend}</legend>
                                <TierSelect
                                    tiers={tiers}
                                    value={create.tier}
                                    onChange={(tier) => setCreate((prev) => ({ ...prev, tier, error: null }))}
                                    disabled={actionsDisabled || create.submitting}
                                />
                                <p className="m-0 mt-2 text-xs text-portal-subtle">
                                    {tiers.find((t) => t.key === create.tier)?.description ?? m.tier.hint}
                                </p>
                            </fieldset>
                        )}
                        <div className="mt-4">
                            <QuotaExpiryFields
                                idPrefix="create"
                                value={create}
                                quotaLimitsEnabled={quotaLimitsEnabled}
                                disabled={actionsDisabled || create.submitting}
                                onChange={(patch) => setCreate((prev) => ({ ...prev, ...patch, error: null }))}
                            />
                        </div>
                        <FormError>{create.error}</FormError>
                    </form>
                )}

                {budgetEdit && (
                    <div
                        className="border-b border-portal-line bg-portal-soft p-4 sm:p-5"
                        aria-label={t.budgetPanelAria}
                    >
                        <QuotaExpiryFields
                            idPrefix={`edit-${budgetEdit.id}`}
                            value={budgetEdit}
                            quotaLimitsEnabled={quotaLimitsEnabled}
                            disabled={actionsDisabled || budgetEdit.submitting}
                            onChange={(patch) =>
                                setBudgetEdit((prev) => (prev ? { ...prev, ...patch, error: null } : prev))
                            }
                        />
                        <div className="mt-3 flex gap-2">
                            <Button
                                type="button"
                                size="sm"
                                onClick={() => void submitBudgetEdit()}
                                disabled={actionsDisabled || budgetEdit.submitting}
                            >
                                {t.save}
                            </Button>
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={cancelBudgetEdit}
                                disabled={actionsDisabled || budgetEdit.submitting}
                            >
                                {t.cancel}
                            </Button>
                        </div>
                        <FormError>{budgetEdit.error}</FormError>
                    </div>
                )}
                {rows.length === 0 ? (
                    <div className="flex min-h-[250px] flex-col items-center justify-center px-6 py-10 text-center">
                        <span className="flex h-11 w-11 items-center justify-center rounded-md bg-portal-gold-soft text-portal-gold">
                            <KeyRound size={21} strokeWidth={1.7} aria-hidden="true" />
                        </span>
                        <h3 className="m-0 mt-4 text-base font-semibold text-portal-ink">{t.emptyTitle}</h3>
                        <p className="m-0 mt-1.5 max-w-sm text-sm leading-relaxed text-portal-muted">{t.emptyBody}</p>
                    </div>
                ) : (
                    <>
                        <div className="divide-y divide-portal-line sm:hidden">
                            {rows.map((row) => {
                                const revealed = reveal[row.id];
                                const showCopied = copied[row.id];
                                const busy = busyId === row.id;
                                return (
                                    <article key={row.id} className="p-4">
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0 pt-1">
                                                <div className="flex min-w-0 flex-wrap items-center gap-2">
                                                    {edit?.id === row.id ? (
                                                        <AliasEditor
                                                            edit={edit}
                                                            onChange={(alias) =>
                                                                setEdit(
                                                                    (current) =>
                                                                        current && { ...current, alias, error: null },
                                                                )
                                                            }
                                                            onSave={() => void submitEdit()}
                                                            onCancel={cancelEdit}
                                                        />
                                                    ) : (
                                                        <h3 className="m-0 max-w-full truncate text-sm font-semibold text-portal-ink">
                                                            {row.key_alias}
                                                        </h3>
                                                    )}
                                                    <span className="rounded bg-portal-gold-soft px-2 py-0.5 text-[10px] font-semibold text-portal-gold">
                                                        {tierLabel(row.tier)}
                                                    </span>
                                                    {ratioBadgeText(row.effective_ratio ?? null, false, m.tier) && (
                                                        <span className="rounded border border-status-success-border bg-status-success-bg px-2 py-0.5 text-[10px] font-medium text-status-success-text">
                                                            {ratioBadgeText(row.effective_ratio ?? null, false, m.tier)}
                                                        </span>
                                                    )}
                                                </div>
                                                <p className="m-0 mt-1 text-[11px] text-portal-subtle">
                                                    {t.createdAtPrefix}
                                                    {new Date(row.created_at).toLocaleString(intlLocale(locale), {
                                                        timeZone: 'Asia/Shanghai',
                                                    })}
                                                </p>
                                            </div>
                                            <KeyActions
                                                row={row}
                                                busy={busy}
                                                revealed={!!revealed}
                                                copied={!!showCopied}
                                                editing={!!edit}
                                                actionsDisabled={actionsDisabled}
                                                onReveal={() => handleReveal(row.id)}
                                                onCopy={() => handleCopy(row.id)}
                                                onEdit={() => startEdit(row)}
                                                onRevoke={() => handleRevoke(row.id)}
                                            />
                                        </div>
                                        <div className="mt-3 border-t border-portal-line pt-3">
                                            <p
                                                className={[
                                                    'm-0 break-all font-mono text-xs',
                                                    revealed ? 'font-semibold text-portal-ink' : 'text-portal-muted',
                                                ].join(' ')}
                                            >
                                                {revealed ?? row.masked_key}
                                            </p>
                                            <p className="m-0 mt-1.5 text-xs text-portal-subtle tabular-nums">
                                                {row.used_quota === null ? (
                                                    t.usageUnavailable
                                                ) : (
                                                    <>
                                                        {t.cumulative}¥{(row.usedCny ?? 0).toFixed(2)}
                                                        <span className="mx-1.5">·</span>
                                                        {t.lastUsed}
                                                        {formatLastUsed(row.last_used_at, m.lastUsed)}
                                                    </>
                                                )}
                                            </p>
                                        </div>
                                        <div className="mt-2 flex items-start gap-2">
                                            <BudgetSummary row={row} />
                                            {row.meta_available && (
                                                <button
                                                    type="button"
                                                    onClick={() => startBudgetEdit(row)}
                                                    disabled={actionsDisabled || busy || !!budgetEdit}
                                                    aria-label={t.adjustAria(row.key_alias)}
                                                    className="text-xs text-portal-muted hover:underline"
                                                >
                                                    {t.adjust}
                                                </button>
                                            )}
                                        </div>
                                    </article>
                                );
                            })}
                        </div>

                        <div className="hidden max-w-full overflow-x-auto overscroll-x-contain sm:block">
                            <table className="w-full min-w-[860px] border-collapse">
                                {tableHeader}
                                <tbody>
                                    {rows.map((row, idx) => {
                                        const revealed = reveal[row.id];
                                        const showCopied = copied[row.id];
                                        const busy = busyId === row.id;
                                        const isLast = idx === rows.length - 1;
                                        // W7 D4 PR-R Item C: rows are flat again.
                                        // The per-row "如何使用此 Key" panel that
                                        // PR-G stitched in was replaced by a single
                                        // unified 调用示例 panel below the table
                                        // (see <KeysSnippetsPanel /> rendered by
                                        // keys/page.tsx). Border treatment matches
                                        // the rest of the portal: every row except
                                        // the last gets a bottom border.
                                        const cell = `px-5 py-3.5 text-sm text-portal-ink`;
                                        const borderClass = isLast ? '' : 'border-b border-portal-line';
                                        return (
                                            <tr key={row.id} className="transition-colors hover:bg-portal-soft/70">
                                                <td className={`${cell} ${borderClass}`}>
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        {edit?.id === row.id ? (
                                                            <AliasEditor
                                                                edit={edit}
                                                                onChange={(alias) =>
                                                                    setEdit(
                                                                        (current) =>
                                                                            current && {
                                                                                ...current,
                                                                                alias,
                                                                                error: null,
                                                                            },
                                                                    )
                                                                }
                                                                onSave={() => void submitEdit()}
                                                                onCancel={cancelEdit}
                                                            />
                                                        ) : (
                                                            <span className="font-medium">{row.key_alias}</span>
                                                        )}
                                                        <span className="rounded bg-portal-gold-soft px-2 py-0.5 text-[10px] font-semibold text-portal-gold">
                                                            {tierLabel(row.tier)}
                                                        </span>
                                                        {ratioBadgeText(row.effective_ratio ?? null, false, m.tier) && (
                                                            <span className="rounded border border-status-success-border bg-status-success-bg px-2 py-0.5 text-[10px] font-medium text-status-success-text">
                                                                {ratioBadgeText(
                                                                    row.effective_ratio ?? null,
                                                                    false,
                                                                    m.tier,
                                                                )}
                                                            </span>
                                                        )}
                                                    </div>
                                                </td>
                                                <td className={`${cell} ${borderClass}`}>
                                                    <div
                                                        className={[
                                                            'font-mono text-xs',
                                                            revealed
                                                                ? 'font-semibold text-portal-ink'
                                                                : 'text-portal-muted',
                                                        ].join(' ')}
                                                    >
                                                        {revealed ?? row.masked_key}
                                                    </div>
                                                    {/* W6 D4: per-key usage subline. Grey/small so it never
                                                     *  competes with the masked sk-. Renders null state
                                                     *  ("从未调用") explicitly so customers see the key exists
                                                     *  but isn't being hit. */}
                                                    <div className="mt-1.5 text-xs text-portal-subtle tabular-nums">
                                                        {row.used_quota === null ? (
                                                            <span>{t.usageUnavailable}</span>
                                                        ) : (
                                                            <>
                                                                {t.cumulative}¥{(row.usedCny ?? 0).toFixed(2)}
                                                                <span className="mx-1.5">·</span>
                                                                {t.lastUsed}
                                                                {formatLastUsed(row.last_used_at, m.lastUsed)}
                                                            </>
                                                        )}
                                                    </div>
                                                </td>
                                                <td className={`${cell} ${borderClass}`}>
                                                    <div className="mt-2 flex items-start gap-2">
                                                        <BudgetSummary row={row} />
                                                        {row.meta_available && (
                                                            <button
                                                                type="button"
                                                                onClick={() => startBudgetEdit(row)}
                                                                disabled={actionsDisabled || busy || !!budgetEdit}
                                                                aria-label={t.adjustAria(row.key_alias)}
                                                                className="text-xs text-portal-muted hover:underline"
                                                            >
                                                                {t.adjust}
                                                            </button>
                                                        )}
                                                    </div>
                                                </td>
                                                <td
                                                    className={`${cell} ${borderClass} whitespace-nowrap text-portal-muted`}
                                                >
                                                    {new Date(row.created_at).toLocaleString(intlLocale(locale), {
                                                        timeZone: 'Asia/Shanghai',
                                                    })}
                                                </td>
                                                <td className={`${cell} ${borderClass} text-right`}>
                                                    <KeyActions
                                                        row={row}
                                                        busy={busy}
                                                        revealed={!!revealed}
                                                        copied={!!showCopied}
                                                        editing={!!edit}
                                                        actionsDisabled={actionsDisabled}
                                                        onReveal={() => handleReveal(row.id)}
                                                        onCopy={() => handleCopy(row.id)}
                                                        onEdit={() => startEdit(row)}
                                                        onRevoke={() => handleRevoke(row.id)}
                                                    />
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
            </section>
        </div>
    );
}
