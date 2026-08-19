'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Clipboard, Eye, KeyRound, Plus, Trash2 } from 'lucide-react';
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
    /** P3: portal 档次 key('pool' | 'official' | …). */
    tier: string;
    /** Effective GroupGroupRatio for the signed-in customer, if configured. */
    effective_ratio?: number | null;
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

/** Render `last_used_at` as a friendly Chinese relative-time string.
 *  Returns null sentinel for "never used" so callers can phrase it in
 *  context (e.g. "从未调用"). */
function formatLastUsed(iso: string | null): string {
    if (!iso) return '从未调用';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '—';
    const now = Date.now();
    const diffSec = Math.max(0, Math.floor((now - then) / 1000));
    if (diffSec < 60) return '刚刚';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} 分钟前`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} 小时前`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay} 天前`;
}

/** State of the per-row "displayed key" — either the real sk- (showing) or
 *  null (showing the masked form). */
type RevealMap = Record<string, string | undefined>;
type CopiedMap = Record<string, boolean>;

interface CreateState {
    open: boolean;
    alias: string;
    submitting: boolean;
    error: string | null;
    tier: string | null;
}

function ratioBadgeText(ratio: number | null): string | null {
    return ratio == null ? null : `${ratio}x 倍率`;
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
                        {ratioBadgeText(selected.ratio) && (
                            <span className="shrink-0 rounded border border-status-success-border bg-status-success-bg px-1.5 py-0.5 text-[11px] font-medium text-status-success-text">
                                {ratioBadgeText(selected.ratio)}
                            </span>
                        )}
                    </span>
                ) : (
                    <span className="text-portal-subtle">选择一个档次</span>
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
                            placeholder="搜索…"
                            autoFocus
                            className="w-full rounded-md border border-portal-line bg-portal-soft px-2.5 py-1.5 text-sm text-portal-ink outline-none focus:border-navy"
                        />
                    </div>
                    <ul role="listbox" className="m-0 max-h-64 list-none overflow-y-auto p-1">
                        {filtered.length === 0 && <li className="px-3 py-2 text-sm text-portal-subtle">无匹配档次</li>}
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
                                    {ratioBadgeText(tier.ratio) && (
                                        <span className="shrink-0 rounded border border-status-success-border bg-status-success-bg px-1.5 py-0.5 text-[11px] font-medium text-status-success-text">
                                            {ratioBadgeText(tier.ratio)}
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
    onReveal,
    onCopy,
    onRevoke,
}: {
    row: KeyRow;
    busy: boolean;
    revealed: boolean;
    copied: boolean;
    onReveal: () => void;
    onCopy: () => void;
    onRevoke: () => void;
}) {
    return (
        <span className="inline-flex shrink-0 justify-end gap-1">
            <button
                type="button"
                onClick={onReveal}
                disabled={busy || revealed}
                className={ACTION_BUTTON}
                aria-label={revealed ? `${row.key_alias} 已显示` : `显示 ${row.key_alias}`}
                title={revealed ? '密钥已显示' : '显示密钥'}
            >
                <Eye size={15} strokeWidth={1.8} aria-hidden="true" />
                <span className="sr-only">显示</span>
            </button>
            <button
                type="button"
                onClick={onCopy}
                disabled={busy}
                className={ACTION_BUTTON}
                aria-label={copied ? `${row.key_alias} 已复制` : `复制 ${row.key_alias}`}
                title={copied ? '已复制' : '复制密钥'}
            >
                {copied ? (
                    <Check size={15} className="text-status-success-text" aria-hidden="true" />
                ) : (
                    <Clipboard size={15} strokeWidth={1.8} aria-hidden="true" />
                )}
                <span className="sr-only">复制</span>
            </button>
            <button
                type="button"
                onClick={onRevoke}
                disabled={busy}
                className={`${ACTION_BUTTON} hover:border-status-error-border hover:bg-status-error-bg hover:text-status-error-text`}
                aria-label={`撤销 ${row.key_alias}`}
                title="撤销密钥"
            >
                <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
                <span className="sr-only">撤销</span>
            </button>
        </span>
    );
}

export function KeysList({ initialRows, tiers = [] }: { initialRows: KeyRow[]; tiers?: TierOption[] }) {
    // Multi-tier accounts must deliberately select a group. A single group
    // (and legacy deployments without configured groups) remains automatic.
    const initialTier: string | null = tiers.length > 1 ? null : (tiers[0]?.key ?? 'pool');
    const showTierChoice = tiers.length > 1;
    const tierLabel = (key: string) => tiers.find((t) => t.key === key)?.display_name ?? key;

    const [rows, setRows] = useState<KeyRow[]>(initialRows);
    const [reveal, setReveal] = useState<RevealMap>({});
    const [copied, setCopied] = useState<CopiedMap>({});
    const [busyId, setBusyId] = useState<string | null>(null);
    const [globalError, setGlobalError] = useState<string | null>(null);
    const [create, setCreate] = useState<CreateState>({
        open: false,
        alias: '',
        submitting: false,
        error: null,
        tier: initialTier,
    });

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
                setGlobalError(typeof data?.error === 'string' ? data.error : `请求失败 (${r.status})`);
                return null;
            }
            const data = (await r.json()) as { key?: string };
            return typeof data.key === 'string' ? data.key : null;
        } catch (err) {
            setGlobalError(err instanceof Error ? err.message : '网络错误');
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
            setGlobalError('复制失败,浏览器拒绝了 clipboard 权限');
        }
        setBusyId(null);
    }

    async function handleRevoke(id: string) {
        if (busyId) return;
        const warning = isOnlyKey
            ? '这是您唯一的 key,撤销后需重新创建才能调用 API。\n确认撤销?该 key 立即失效'
            : '确认撤销?该 key 立即失效';
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
                setGlobalError(typeof data?.error === 'string' ? data.error : `撤销失败 (${r.status})`);
            } else {
                setRows((prev) => prev.filter((row) => row.id !== id));
                setReveal((prev) => {
                    const next = { ...prev };
                    delete next[id];
                    return next;
                });
            }
        } catch (err) {
            setGlobalError(err instanceof Error ? err.message : '网络错误');
        }
        setBusyId(null);
    }

    async function handleCreate(e: React.FormEvent) {
        e.preventDefault();
        if (create.submitting) return;
        const alias = create.alias.trim();
        if (!alias || (showTierChoice && !create.tier)) {
            setCreate((prev) => ({ ...prev, error: !alias ? '请填写 Key 别名' : '请选择调用档次' }));
            return;
        }
        const tier = create.tier ?? 'pool';
        setCreate((prev) => ({ ...prev, submitting: true, error: null }));
        try {
            const r = await fetch('/api/portal/keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ alias, tier }),
            });
            if (!r.ok) {
                const data = await r.json().catch(() => ({}));
                setCreate((prev) => ({
                    ...prev,
                    submitting: false,
                    error: typeof data?.error === 'string' ? data.error : `创建失败 (${r.status})`,
                }));
                return;
            }
            const data = (await r.json()) as {
                id: string;
                key_alias: string;
                key: string;
                created_at: string;
                tier?: string;
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
                effective_ratio: tiers.find((option) => option.key === (data.tier ?? tier))?.ratio ?? null,
            };
            setRows((prev) => [...prev, newRow]);
            // Auto-reveal the brand-new key so the customer can copy it
            // immediately. The auto-hide timer above re-masks after 10s.
            // (W7 D4 PR-R Item C — the per-row "如何使用此 Key" panel
            // was removed; the unified bottom 调用示例 panel covers all
            // keys, so there's no per-row panel to auto-expand here.)
            setReveal((prev) => ({ ...prev, [data.id]: data.key }));
            setCreate({ open: false, alias: '', submitting: false, error: null, tier: initialTier });
        } catch (err) {
            setCreate((prev) => ({
                ...prev,
                submitting: false,
                error: err instanceof Error ? err.message : '网络错误',
            }));
        }
    }

    const tableHeader = useMemo(
        () => (
            <thead>
                <tr className="bg-portal-soft text-portal-muted">
                    <th className="border-b border-portal-line px-5 py-2.5 text-left text-xs font-semibold">别名</th>
                    <th className="border-b border-portal-line px-5 py-2.5 text-left text-xs font-semibold">API Key</th>
                    <th className="border-b border-portal-line px-5 py-2.5 text-left text-xs font-semibold">
                        创建时间
                    </th>
                    <th className="border-b border-portal-line px-5 py-2.5 text-right text-xs font-semibold">操作</th>
                </tr>
            </thead>
        ),
        [],
    );

    return (
        <div className="space-y-4">
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
                            <h2 className="m-0 text-sm font-semibold text-portal-ink">访问密钥</h2>
                            <p className="m-0 mt-0.5 text-xs text-portal-subtle tabular-nums">
                                已创建 {rows.length} 个
                            </p>
                        </div>
                    </div>
                    <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        onClick={() =>
                            setCreate({ open: true, alias: '', submitting: false, error: null, tier: initialTier })
                        }
                        disabled={create.open}
                        title="创建新的 API Key"
                        className="rounded-md"
                    >
                        <Plus size={15} strokeWidth={2} aria-hidden="true" />
                        <span>创建新 Key</span>
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
                                    密钥别名
                                </label>
                                <input
                                    id="new-key-alias"
                                    type="text"
                                    placeholder="例如 prod-openai / test-claude / dev-mobile"
                                    value={create.alias}
                                    onChange={(e) =>
                                        setCreate((prev) => ({ ...prev, alias: e.target.value, error: null }))
                                    }
                                    maxLength={50}
                                    autoFocus
                                    aria-invalid={!!create.error}
                                    className="h-10 w-full rounded-md border border-portal-line bg-portal-panel px-3 text-sm text-portal-ink outline-none placeholder:text-portal-subtle focus:border-navy focus:ring-2 focus:ring-navy/10"
                                />
                                <p className="m-0 mt-1.5 text-xs text-portal-subtle">
                                    建议采用{' '}
                                    <code className="font-mono text-[11px] text-portal-muted">env-purpose</code>{' '}
                                    格式，便于区分环境与用途。
                                </p>
                            </div>
                            <div className="flex flex-col-reverse gap-2 sm:flex-row lg:pb-6">
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    onClick={() =>
                                        setCreate({
                                            open: false,
                                            alias: '',
                                            submitting: false,
                                            error: null,
                                            tier: initialTier,
                                        })
                                    }
                                    disabled={create.submitting}
                                    className="rounded-md border-portal-line text-portal-muted"
                                >
                                    取消
                                </Button>
                                <Button
                                    type="submit"
                                    variant="primary"
                                    size="sm"
                                    loading={create.submitting}
                                    disabled={
                                        create.submitting || !create.alias.trim() || (showTierChoice && !create.tier)
                                    }
                                    className="rounded-md"
                                >
                                    {create.submitting ? '创建中…' : '确认创建'}
                                </Button>
                            </div>
                        </div>

                        {showTierChoice && (
                            <fieldset className="mt-4 border-0 p-0">
                                <legend className="mb-2 text-xs font-medium text-portal-muted">调用档次</legend>
                                <TierSelect
                                    tiers={tiers}
                                    value={create.tier}
                                    onChange={(tier) => setCreate((prev) => ({ ...prev, tier, error: null }))}
                                    disabled={create.submitting}
                                />
                                <p className="m-0 mt-2 text-xs text-portal-subtle">
                                    {tiers.find((t) => t.key === create.tier)?.description ??
                                        '请选择档次。档次决定路由与倍率，创建后不可修改。'}
                                </p>
                            </fieldset>
                        )}
                        <FormError>{create.error}</FormError>
                    </form>
                )}

                {rows.length === 0 ? (
                    <div className="flex min-h-[250px] flex-col items-center justify-center px-6 py-10 text-center">
                        <span className="flex h-11 w-11 items-center justify-center rounded-md bg-portal-gold-soft text-portal-gold">
                            <KeyRound size={21} strokeWidth={1.7} aria-hidden="true" />
                        </span>
                        <h3 className="m-0 mt-4 text-base font-semibold text-portal-ink">还没有 API Key</h3>
                        <p className="m-0 mt-1.5 max-w-sm text-sm leading-relaxed text-portal-muted">
                            创建第一个 Key 后，即可通过兼容 OpenAI 与 Anthropic 的接口调用模型。
                        </p>
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
                                                    <h3 className="m-0 max-w-full truncate text-sm font-semibold text-portal-ink">
                                                        {row.key_alias}
                                                    </h3>
                                                    <span className="rounded bg-portal-gold-soft px-2 py-0.5 text-[10px] font-semibold text-portal-gold">
                                                        {tierLabel(row.tier)}
                                                    </span>
                                                    {ratioBadgeText(row.effective_ratio ?? null) && (
                                                        <span className="rounded border border-status-success-border bg-status-success-bg px-2 py-0.5 text-[10px] font-medium text-status-success-text">
                                                            {ratioBadgeText(row.effective_ratio ?? null)}
                                                        </span>
                                                    )}
                                                </div>
                                                <p className="m-0 mt-1 text-[11px] text-portal-subtle">
                                                    创建于{' '}
                                                    {new Date(row.created_at).toLocaleString('zh-CN', {
                                                        timeZone: 'Asia/Shanghai',
                                                    })}
                                                </p>
                                            </div>
                                            <KeyActions
                                                row={row}
                                                busy={busy}
                                                revealed={!!revealed}
                                                copied={!!showCopied}
                                                onReveal={() => handleReveal(row.id)}
                                                onCopy={() => handleCopy(row.id)}
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
                                                    '用量数据暂不可用'
                                                ) : (
                                                    <>
                                                        累计 ¥{(row.usedCny ?? 0).toFixed(2)}
                                                        <span className="mx-1.5">·</span>
                                                        最近调用 {formatLastUsed(row.last_used_at)}
                                                    </>
                                                )}
                                            </p>
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
                                                        <span className="font-medium">{row.key_alias}</span>
                                                        <span className="rounded bg-portal-gold-soft px-2 py-0.5 text-[10px] font-semibold text-portal-gold">
                                                            {tierLabel(row.tier)}
                                                        </span>
                                                        {ratioBadgeText(row.effective_ratio ?? null) && (
                                                            <span className="rounded border border-status-success-border bg-status-success-bg px-2 py-0.5 text-[10px] font-medium text-status-success-text">
                                                                {ratioBadgeText(row.effective_ratio ?? null)}
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
                                                            <span>用量数据暂不可用</span>
                                                        ) : (
                                                            <>
                                                                累计 ¥{(row.usedCny ?? 0).toFixed(2)}
                                                                <span className="mx-1.5">·</span>
                                                                最近调用 {formatLastUsed(row.last_used_at)}
                                                            </>
                                                        )}
                                                    </div>
                                                </td>
                                                <td
                                                    className={`${cell} ${borderClass} whitespace-nowrap text-portal-muted`}
                                                >
                                                    {new Date(row.created_at).toLocaleString('zh-CN', {
                                                        timeZone: 'Asia/Shanghai',
                                                    })}
                                                </td>
                                                <td className={`${cell} ${borderClass} text-right`}>
                                                    <KeyActions
                                                        row={row}
                                                        busy={busy}
                                                        revealed={!!revealed}
                                                        copied={!!showCopied}
                                                        onReveal={() => handleReveal(row.id)}
                                                        onCopy={() => handleCopy(row.id)}
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
