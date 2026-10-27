'use client';

/**
 * CodesClient — invite-code CRUD UI (PR-U2).
 *
 * Lists active + inactive codes (inactive grayed out), provides:
 *   - + 创建新邀请码 modal (code input + optional label)
 *   - 复制 button per row → 复制 https://silkroadai.io/register?invite=CODE
 *   - 删除 button per active row → soft-delete via DELETE /codes/[id]
 *
 * MAX_CODES_PER_RESELLER mirrors the server-side cap (10 active) so the
 * "+ 创建" button greys out without a roundtrip. Server enforces the
 * same limit on the API side.
 */
import { useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormError } from '@/components/ui/FormError';
import { useLocale, useMessages } from '@/lib/i18n/client';
import { intlLocale, type Locale } from '@/lib/i18n';
import { resellerMessages } from '@/lib/i18n/messages/reseller';

const MAX_CODES = 10;
const COPIED_TOAST_MS = 1_500;

export interface CodeRow {
    id: string;
    code: string;
    label: string | null;
    is_active: boolean;
    attributed_user_count: number;
    total_attributed_gmv_cny: number;
    created_at: string;
}

/** Landing URL surfaced by the "复制落地链接" button. fix/invite-landing:
 *  point at /register directly so customers skip the homepage detour.
 *  Server-side /register page does an unconditional redirect to
 *  /portal/register preserving ?invite=, so the real URL the customer
 *  ends up on is /portal/register?invite=X. We still expose the short
 *  /register URL because resellers paste this into chat / 朋友圈 / X and
 *  short URLs are easier to trust. */
function landingUrl(code: string): string {
    if (typeof window === 'undefined') return `/register?invite=${encodeURIComponent(code)}`;
    return `${window.location.origin}/register?invite=${encodeURIComponent(code)}`;
}

function fmtCny(v: number, locale: Locale): string {
    return `¥${v.toLocaleString(intlLocale(locale), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fireAnalytics(eventType: string, properties: Record<string, unknown>): void {
    void fetch('/api/portal/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: eventType, properties }),
        credentials: 'same-origin',
    }).catch(() => {
        /* best-effort */
    });
}

export function CodesClient({ initialRows }: { initialRows: CodeRow[] }) {
    const router = useRouter();
    const locale = useLocale();
    const all = useMessages(resellerMessages);
    const m = all.codes;
    const [rows, setRows] = useState<CodeRow[]>(initialRows);
    const [creating, setCreating] = useState(false);
    const [newCode, setNewCode] = useState('');
    const [newLabel, setNewLabel] = useState('');
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);

    const activeCount = useMemo(() => rows.filter((r) => r.is_active).length, [rows]);
    const atCap = activeCount >= MAX_CODES;

    const handleCopy = useCallback(async (code: string) => {
        const url = landingUrl(code);
        try {
            await navigator.clipboard.writeText(url);
            setCopied(code);
            setTimeout(() => setCopied(null), COPIED_TOAST_MS);
        } catch {
            // Most browsers in production work; if user revoked clipboard,
            // we leave the URL visible in the row for manual copy.
        }
    }, []);

    const handleCreate = useCallback(
        async (e: React.FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            setSubmitError(null);
            const trimmed = newCode.trim();
            if (!trimmed) {
                setSubmitError(m.emptyCode);
                return;
            }
            setSubmitting(true);
            try {
                const res = await fetch('/api/portal/reseller/codes', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: trimmed, label: newLabel.trim() || undefined }),
                    credentials: 'same-origin',
                });
                const body: {
                    id?: string;
                    code?: string;
                    label?: string | null;
                    is_active?: boolean;
                    created_at?: string;
                    error?: string;
                    message?: string;
                } = await res.json().catch(() => ({}));
                if (!res.ok) {
                    throw new Error(body.message || body.error || all.common.serverError(res.status));
                }
                if (body.id && body.code) {
                    fireAnalytics('reseller_code_created', { code: body.code, has_label: !!newLabel.trim() });
                    setRows((prev) => [
                        ...prev,
                        {
                            id: body.id!,
                            code: body.code!,
                            label: body.label ?? null,
                            is_active: body.is_active ?? true,
                            attributed_user_count: 0,
                            total_attributed_gmv_cny: 0,
                            created_at: body.created_at ?? new Date().toISOString(),
                        },
                    ]);
                    setNewCode('');
                    setNewLabel('');
                    setCreating(false);
                }
            } catch (err) {
                setSubmitError(err instanceof Error ? err.message : m.createFailed);
            } finally {
                setSubmitting(false);
            }
        },
        [newCode, newLabel, m, all],
    );

    const handleDelete = useCallback(
        async (id: string) => {
            if (!confirm(m.deleteConfirm)) return;
            try {
                const res = await fetch(`/api/portal/reseller/codes/${id}`, {
                    method: 'DELETE',
                    credentials: 'same-origin',
                });
                if (!res.ok) {
                    const body: { error?: string; message?: string } = await res.json().catch(() => ({}));
                    throw new Error(body.message || body.error || all.common.serverError(res.status));
                }
                setRows((prev) => prev.map((r) => (r.id === id ? { ...r, is_active: false } : r)));
                router.refresh();
            } catch (err) {
                alert(err instanceof Error ? err.message : m.deleteFailed);
            }
        },
        [router, m, all],
    );

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-col gap-1 flex-1">
                    <p className="text-xs uppercase tracking-wider text-muted-ink m-0">{all.common.consoleKicker}</p>
                    <CardTitle as="h1">{m.title}</CardTitle>
                </div>
                <Button onClick={() => setCreating((v) => !v)} disabled={atCap} type="button">
                    {creating ? m.cancel : m.create(activeCount, MAX_CODES)}
                </Button>
            </CardHeader>
            <CardContent className="space-y-4">
                {atCap && (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 m-0">
                        {m.capWarning(MAX_CODES)}
                    </p>
                )}

                {creating && (
                    <form
                        onSubmit={handleCreate}
                        className="rounded-xl border border-brand-border bg-paper-muted/40 p-4 space-y-3"
                    >
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <label className="block text-sm">
                                <span className="block text-muted-ink mb-1">{m.codeLabel}</span>
                                <input
                                    type="text"
                                    value={newCode}
                                    onChange={(e) => setNewCode(e.target.value.toUpperCase().slice(0, 20))}
                                    placeholder={m.codePlaceholder}
                                    className="w-full rounded-lg border border-brand-border bg-surface px-3 py-2 text-sm font-mono"
                                    autoFocus
                                />
                            </label>
                            <label className="block text-sm">
                                <span className="block text-muted-ink mb-1">{m.labelLabel}</span>
                                <input
                                    type="text"
                                    value={newLabel}
                                    onChange={(e) => setNewLabel(e.target.value.slice(0, 64))}
                                    placeholder={m.labelPlaceholder}
                                    className="w-full rounded-lg border border-brand-border bg-surface px-3 py-2 text-sm"
                                />
                            </label>
                        </div>
                        {submitError && <FormError>{submitError}</FormError>}
                        <div className="flex gap-2 justify-end">
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={() => {
                                    setCreating(false);
                                    setSubmitError(null);
                                }}
                            >
                                {m.cancel}
                            </Button>
                            <Button type="submit" disabled={submitting}>
                                {submitting ? m.creating : m.confirmCreate}
                            </Button>
                        </div>
                    </form>
                )}

                {rows.length === 0 ? (
                    <EmptyState
                        title={m.emptyTitle}
                        body={m.emptyBody}
                        action={
                            <Button onClick={() => setCreating(true)} type="button">
                                {m.createFirst}
                            </Button>
                        }
                    />
                ) : (
                    <ul className="space-y-2 m-0 p-0 list-none">
                        {rows.map((r) => (
                            <li
                                key={r.id}
                                className={[
                                    'rounded-xl border bg-surface px-4 py-3',
                                    r.is_active ? 'border-brand-border' : 'border-brand-border/40 opacity-60',
                                ].join(' ')}
                            >
                                <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <code className="font-mono text-base text-navy">{r.code}</code>
                                            {r.label && <span className="text-xs text-muted-ink">· {r.label}</span>}
                                            {!r.is_active && (
                                                <span className="text-xs px-2 py-0.5 rounded-full bg-paper-muted text-muted-ink">
                                                    {m.inactive}
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-xs text-muted-ink mt-1 mb-0">
                                            {m.rowStats(
                                                r.attributed_user_count,
                                                fmtCny(r.total_attributed_gmv_cny, locale),
                                            )}
                                        </p>
                                    </div>
                                    <div className="flex gap-2 flex-wrap">
                                        {r.is_active && (
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                type="button"
                                                onClick={() => handleCopy(r.code)}
                                            >
                                                {copied === r.code ? m.copied : m.copy}
                                            </Button>
                                        )}
                                        {r.is_active && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                type="button"
                                                onClick={() => handleDelete(r.id)}
                                            >
                                                {m.delete}
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}
