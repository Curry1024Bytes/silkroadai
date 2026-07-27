'use client';

/**
 * CodesClient — invite-code CRUD UI (PR-U2).
 *
 * Lists active + inactive codes (inactive grayed out), provides:
 *   - + 创建新邀请码 modal (code input + optional label)
 *   - 复制 button per row → 复制 https://llmroute.club/register?invite=CODE
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

function fmtCny(v: number): string {
    return `¥${v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
                setSubmitError('邀请码不能为空');
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
                    throw new Error(body.message || body.error || `服务端错误 (${res.status})`);
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
                setSubmitError(err instanceof Error ? err.message : '创建失败,请稍后重试');
            } finally {
                setSubmitting(false);
            }
        },
        [newCode, newLabel],
    );

    const handleDelete = useCallback(
        async (id: string) => {
            if (!confirm('确认删除该邀请码?\n\n已使用该码注册的客户不受影响,只是该码不能再用于新注册。')) return;
            try {
                const res = await fetch(`/api/portal/reseller/codes/${id}`, {
                    method: 'DELETE',
                    credentials: 'same-origin',
                });
                if (!res.ok) {
                    const body: { error?: string; message?: string } = await res.json().catch(() => ({}));
                    throw new Error(body.message || body.error || `服务端错误 (${res.status})`);
                }
                setRows((prev) => prev.map((r) => (r.id === id ? { ...r, is_active: false } : r)));
                router.refresh();
            } catch (err) {
                alert(err instanceof Error ? err.message : '删除失败');
            }
        },
        [router],
    );

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-col gap-1 flex-1">
                    <p className="text-xs uppercase tracking-wider text-muted-ink m-0">代理后台</p>
                    <CardTitle as="h1">邀请码管理</CardTitle>
                </div>
                <Button onClick={() => setCreating((v) => !v)} disabled={atCap} type="button">
                    {creating ? '取消' : `+ 创建邀请码 (${activeCount}/${MAX_CODES})`}
                </Button>
            </CardHeader>
            <CardContent className="space-y-4">
                {atCap && (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 m-0">
                        已达到最大 {MAX_CODES} 个活跃邀请码上限,请先删除不用的码再创建新码。
                    </p>
                )}

                {creating && (
                    <form
                        onSubmit={handleCreate}
                        className="rounded-xl border border-brand-border bg-paper-muted/40 p-4 space-y-3"
                    >
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <label className="block text-sm">
                                <span className="block text-muted-ink mb-1">
                                    邀请码 (3-20 字符,大写字母 / 数字 / 中划线)
                                </span>
                                <input
                                    type="text"
                                    value={newCode}
                                    onChange={(e) => setNewCode(e.target.value.toUpperCase().slice(0, 20))}
                                    placeholder="FRANK-WX-2026"
                                    className="w-full rounded-lg border border-brand-border bg-surface px-3 py-2 text-sm font-mono"
                                    autoFocus
                                />
                            </label>
                            <label className="block text-sm">
                                <span className="block text-muted-ink mb-1">备注 (可选,只你能看到)</span>
                                <input
                                    type="text"
                                    value={newLabel}
                                    onChange={(e) => setNewLabel(e.target.value.slice(0, 64))}
                                    placeholder="朋友圈 5/24"
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
                                取消
                            </Button>
                            <Button type="submit" disabled={submitting}>
                                {submitting ? '创建中...' : '确认创建'}
                            </Button>
                        </div>
                    </form>
                )}

                {rows.length === 0 ? (
                    <EmptyState
                        title="还没有邀请码"
                        body="创建你的第一个邀请码,然后把落地链接发给朋友 / 社群,他们注册后的所有充值都有你的佣金。"
                        action={
                            <Button onClick={() => setCreating(true)} type="button">
                                + 创建第一个邀请码
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
                                                    已停用
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-xs text-muted-ink mt-1 mb-0">
                                            {r.attributed_user_count} 位客户 · 累计 GMV{' '}
                                            {fmtCny(r.total_attributed_gmv_cny)}
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
                                                {copied === r.code ? '✓ 已复制' : '复制落地链接'}
                                            </Button>
                                        )}
                                        {r.is_active && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                type="button"
                                                onClick={() => handleDelete(r.id)}
                                            >
                                                删除
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
