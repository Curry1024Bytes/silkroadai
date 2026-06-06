'use client';

import { useEffect, useMemo, useState } from 'react';
// IMPORTANT: import pure quota helpers from the side-effect-free module.
// `@/lib/newapi/client` carries `import 'server-only'` + a runtime
// admin-env check that crashes the browser bundle (W6 D4 → W6 D5 prod
// regression). Anything imported by a 'use client' component MUST come
// from `quota-units` or another client-safe module.
import { quotaToCny } from '@/lib/newapi/quota-units';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormError } from '@/components/ui/FormError';
import { Input } from '@/components/ui/Input';

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
    /** ISO timestamp of the most recent log entry attributable to this
     *  key, or null if it has never been used. */
    last_used_at: string | null;
    /** P3: portal 档次 key('pool' | 'official' | …). */
    tier: string;
}

/** P3: a selectable tier (an enabled ChannelGroup), passed from the server page. */
export interface TierOption {
    key: string;
    display_name: string;
    description: string | null;
    is_default: boolean;
}

/** Mirror of the server-side mask helper. Used when we receive a freshly
 *  created sk-xxx and want to flip back to the obscured form. */
function maskKey(value: string): string {
    if (value.length <= 12) return '*'.repeat(Math.max(8, value.length));
    return `${value.slice(0, 7)}****${value.slice(-4)}`;
}

/** Brief: max 10 keys per user (W6 D4 — bumped from 5). Constant lives
 *  client-side too so the UI can disable the "create" button without a
 *  roundtrip; server enforces the same limit (POST /api/portal/keys
 *  returns 400 if exceeded). */
const MAX_TOKENS_PER_USER = 10;

/** How long to expose a freshly-revealed sk- before re-masking it. Defends
 *  against shoulder-surfing / forgotten browser tab scenarios. */
const REVEAL_AUTOHIDE_MS = 10_000;
const COPIED_TOAST_MS = 2_000;

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
    tier: string;
}

export function KeysList({ initialRows, tiers = [] }: { initialRows: KeyRow[]; tiers?: TierOption[] }) {
    // P3: 默认档 = is_default 的 ChannelGroup(pool);label / 单选项从 tiers 派生。
    const defaultTier = tiers.find((t) => t.is_default)?.key ?? tiers[0]?.key ?? 'pool';
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
        tier: defaultTier,
    });

    const atLimit = rows.length >= MAX_TOKENS_PER_USER;
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
        if (!alias) {
            setCreate((prev) => ({ ...prev, error: '请填写 Key 别名' }));
            return;
        }
        setCreate((prev) => ({ ...prev, submitting: true, error: null }));
        try {
            const r = await fetch('/api/portal/keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ alias, tier: create.tier }),
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
                last_used_at: null,
                tier: data.tier ?? create.tier,
            };
            setRows((prev) => [...prev, newRow]);
            // Auto-reveal the brand-new key so the customer can copy it
            // immediately. The auto-hide timer above re-masks after 10s.
            // (W7 D4 PR-R Item C — the per-row "如何使用此 Key" panel
            // was removed; the unified bottom 调用示例 panel covers all
            // keys, so there's no per-row panel to auto-expand here.)
            setReveal((prev) => ({ ...prev, [data.id]: data.key }));
            setCreate({ open: false, alias: '', submitting: false, error: null, tier: defaultTier });
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
                <tr className="bg-paper-muted text-muted-ink">
                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">别名</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                        API Key
                    </th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold border-b border-brand-border">
                        创建时间
                    </th>
                    <th className="text-right px-4 py-2.5 text-xs font-semibold border-b border-brand-border">操作</th>
                </tr>
            </thead>
        ),
        [],
    );

    return (
        <div>
            <div className="flex justify-end mb-3">
                <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={() =>
                        setCreate({ open: true, alias: '', submitting: false, error: null, tier: defaultTier })
                    }
                    disabled={atLimit || create.open}
                    title={atLimit ? `已达上限 (${MAX_TOKENS_PER_USER})` : ''}
                >
                    {atLimit ? `已达上限 (${MAX_TOKENS_PER_USER})` : '+ 创建新 Key'}
                </Button>
            </div>

            {create.open && (
                <Card className="p-4 mb-4">
                    <form onSubmit={handleCreate} className="flex gap-2 items-start">
                        <div className="flex-1">
                            <Input
                                type="text"
                                placeholder="例如 prod-openai / test-claude / dev-mobile"
                                value={create.alias}
                                onChange={(e) => setCreate((prev) => ({ ...prev, alias: e.target.value, error: null }))}
                                maxLength={50}
                                autoFocus
                                error={!!create.error}
                                className="text-sm"
                            />
                            <p className="m-0 mt-1.5 text-xs text-minor-ink">
                                建议格式 <code className="font-mono text-xs">env-purpose</code> —
                                方便区分不同环境与用途。
                            </p>
                            {showTierChoice && (
                                <div className="mt-2.5">
                                    <p className="m-0 mb-1 text-xs font-medium text-muted-ink">档次</p>
                                    <div className="flex flex-wrap gap-3">
                                        {tiers.map((t) => (
                                            <label
                                                key={t.key}
                                                className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-ink"
                                            >
                                                <input
                                                    type="radio"
                                                    name="key-tier"
                                                    value={t.key}
                                                    checked={create.tier === t.key}
                                                    onChange={() => setCreate((prev) => ({ ...prev, tier: t.key }))}
                                                />
                                                <span>{t.display_name}</span>
                                            </label>
                                        ))}
                                    </div>
                                    <p className="m-0 mt-1 text-xs text-minor-ink">
                                        {tiers.find((t) => t.key === create.tier)?.description ??
                                            '官方稳定档更稳、价格更高;低价号池性价比高。档次建后不可改,换档请新建 key。'}
                                    </p>
                                </div>
                            )}
                            <FormError>{create.error}</FormError>
                        </div>
                        <Button
                            type="submit"
                            variant="primary"
                            size="sm"
                            loading={create.submitting}
                            disabled={create.submitting || !create.alias.trim()}
                        >
                            {create.submitting ? '创建中…' : '创建'}
                        </Button>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() =>
                                setCreate({ open: false, alias: '', submitting: false, error: null, tier: defaultTier })
                            }
                            disabled={create.submitting}
                        >
                            取消
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
                        title="还没有 API Key"
                        body={
                            <>
                                创建第一个 key 即可调用 Silk Road AI。点击右上角{' '}
                                <code className="font-mono text-xs">+ 创建新 Key</code> 开始。
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
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span>{row.key_alias}</span>
                                                <span className="rounded-full bg-paper-muted px-2 py-0.5 text-[10px] font-medium text-muted-ink">
                                                    {tierLabel(row.tier)}
                                                </span>
                                            </div>
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
                                                    <span>用量数据暂不可用</span>
                                                ) : (
                                                    <>
                                                        累计 ¥{quotaToCny(row.used_quota).toFixed(2)}
                                                        <span className="mx-1.5">·</span>
                                                        最近调用 {formatLastUsed(row.last_used_at)}
                                                    </>
                                                )}
                                            </div>
                                        </td>
                                        <td className={`${cell} ${borderClass} text-muted-ink`}>
                                            {new Date(row.created_at).toLocaleString('zh-CN', {
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
                                                    {revealed ? '已显示' : '显示'}
                                                </Button>
                                                <Button
                                                    type="button"
                                                    variant="secondary"
                                                    size="sm"
                                                    onClick={() => handleCopy(row.id)}
                                                    disabled={busy}
                                                >
                                                    {showCopied ? '已复制 ✓' : '复制'}
                                                </Button>
                                                <Button
                                                    type="button"
                                                    variant="danger"
                                                    size="sm"
                                                    onClick={() => handleRevoke(row.id)}
                                                    disabled={busy}
                                                >
                                                    撤销
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
