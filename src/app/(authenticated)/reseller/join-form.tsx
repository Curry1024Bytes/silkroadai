'use client';

/**
 * JoinForm — agreement checkbox + Join CTA (PR-U2).
 *
 * Client-only: handles the checkbox gate locally, fires
 * POST /api/portal/reseller/join on click, then router.refresh() so the
 * server-side fetchResellerStatus picks up the new row and the entry
 * page redirects to /reseller/dashboard.
 *
 * Analytics: fires `reseller_join_clicked` (PR-U2 whitelist) on submit
 * attempt with the agreement_checked flag in properties. Best-effort —
 * a failed analytics insert never blocks the join.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';

function fireAnalytics(eventType: string, properties: Record<string, unknown>): void {
    void fetch('/api/portal/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: eventType, properties }),
        credentials: 'same-origin',
    }).catch(() => {
        // best-effort instrumentation; client-side analytics failure is
        // visible in dev tools but must never break the join flow.
    });
}

export function JoinForm() {
    const router = useRouter();
    const [agreed, setAgreed] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handleSubmit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        fireAnalytics('reseller_join_clicked', { agreement_checked: agreed });
        if (!agreed) {
            setError('请先阅读并勾选同意《Silk Road AI 代理合作协议》');
            return;
        }
        setError(null);
        setSubmitting(true);
        try {
            const res = await fetch('/api/portal/reseller/join', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
                credentials: 'same-origin',
            });
            if (!res.ok) {
                const j: { error?: string; message?: string } = await res.json().catch(() => ({}));
                throw new Error(j.message || j.error || `服务端错误 (${res.status})`);
            }
            // Refresh — server-side gate now sees isReseller=true and
            // redirects to /reseller/dashboard.
            router.refresh();
            router.push('/reseller/dashboard');
        } catch (err) {
            setError(err instanceof Error ? err.message : '加入失败,请稍后重试');
            setSubmitting(false);
        }
    }

    return (
        <form onSubmit={handleSubmit} className="rounded-xl border border-brand-border bg-surface px-5 py-5 space-y-4">
            <label className="flex items-start gap-3 cursor-pointer">
                <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                    className="mt-1 h-4 w-4 cursor-pointer accent-brand-accent"
                    aria-describedby="agreement-hint"
                />
                <span className="text-sm text-ink leading-relaxed select-none">
                    我已阅读并同意上方《Silk Road AI 代理合作协议》摘要
                </span>
            </label>
            <p id="agreement-hint" className="text-xs text-muted-ink m-0">
                勾选后点击下方按钮即可立即激活代理身份,系统会为你自动生成第一个邀请码。
            </p>
            {error && <FormError>{error}</FormError>}
            <Button type="submit" disabled={submitting || !agreed} className="w-full sm:w-auto">
                {submitting ? '加入中...' : '加入代理计划'}
            </Button>
        </form>
    );
}
