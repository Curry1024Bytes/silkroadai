'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';

/**
 * /portal/register form (W7 D4 + fix/invite-landing).
 *
 * Fields:
 *   email         — required
 *   password      — required, min 8 chars (server enforces; we surface
 *                   the constraint in the label)
 *   confirm       — client-side equality check; never sent to backend
 *   invite_code   — optional, max 64 chars. Empty/whitespace = no code.
 *                   Backend validates: tries Reseller code (PR-U1) first,
 *                   falls back to env INVITE_CODES allow-list (W7 D4).
 *                   Invalid surfaces as `invalid_invite_code` 400 → inline hint.
 *   tos           — required checkbox; client-side gate on submit
 *
 * Prefill (fix/invite-landing):
 *   - Read `?invite=` from URL query
 *   - Fall back to sessionStorage `pendingInviteCode` (set by the root
 *     `/` page bridge when older `/?invite=X` style links land there)
 *   - Show "已自动填入推荐码" muted hint when prefill triggered, so the
 *     user sees the code came from the link, not from them
 *   - Field stays editable — user can clear / change without friction
 *   - On successful registration the sessionStorage key is cleared
 *
 * On 200, /api/auth/register has already set the session cookie + queued
 * the verification email. We hard-nav to /dashboard so any client cache
 * picks up the fresh login state.
 */
const SESSION_STORAGE_KEY = 'pendingInviteCode';

/** Fire-and-forget analytics call. Failures are silent — analytics must
 *  never block the register flow. */
function fireAnalytics(eventType: string, properties: Record<string, unknown> = {}): void {
    void fetch('/api/portal/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: eventType, properties }),
        credentials: 'same-origin',
    }).catch(() => {
        /* best-effort */
    });
}

export function RegisterForm() {
    // `useSearchParams` returns null in test envs that render this form
    // without a NextRouter context (e.g. auth-handoff-link.test.tsx
    // SSR-renders without next/navigation mocked). Defensive optional
    // chaining keeps production behavior + lets unrelated tests render.
    const searchParams = useSearchParams();
    const queryInvite = searchParams?.get('invite')?.trim() ?? '';

    // Prefill source: URL ?invite= > sessionStorage > empty. Computed once
    // on mount via lazy useState initializer so subsequent re-renders don't
    // re-read sessionStorage (which a user-driven edit would otherwise
    // clobber back).
    const [inviteCode, setInviteCode] = useState<string>(() => {
        if (queryInvite) return queryInvite;
        if (typeof window === 'undefined') return '';
        try {
            return window.sessionStorage.getItem(SESSION_STORAGE_KEY)?.trim() ?? '';
        } catch {
            return '';
        }
    });
    // Track whether the current value came from prefill so we can show
    // the "已自动填入推荐码" hint. Flips off if the user edits the field
    // (transparency — once they touch it, we stop labelling it).
    const [prefilled, setPrefilled] = useState<boolean>(() => {
        if (queryInvite) return true;
        if (typeof window === 'undefined') return false;
        try {
            return !!window.sessionStorage.getItem(SESSION_STORAGE_KEY)?.trim();
        } catch {
            return false;
        }
    });

    // Fire `reseller_invite_link_landed` once when we land with a query
    // invite. Best-effort; failure is silent.
    useEffect(() => {
        if (!queryInvite) return;
        fireAnalytics('reseller_invite_link_landed', { code: queryInvite });
    }, [queryInvite]);

    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [tosAccepted, setTosAccepted] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [inviteError, setInviteError] = useState<string | null>(null);

    const passwordsMatch = password.length === 0 || password === confirm;
    const passwordLongEnough = password.length === 0 || password.length >= 8;
    const formValid = email.length > 0 && password.length >= 8 && passwordsMatch && tosAccepted && !submitting;

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!formValid) return;
        setSubmitting(true);
        setError(null);
        setInviteError(null);
        try {
            const trimmedCode = inviteCode.trim();
            const r = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                    email,
                    password,
                    ...(trimmedCode ? { invite_code: trimmedCode } : {}),
                }),
            });
            if (r.ok) {
                // fix/invite-landing: clear the bridge so a fresh session
                // doesn't re-pickup a stale code on the next register attempt.
                try {
                    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
                } catch {
                    /* sessionStorage may be unavailable (Safari private mode);
                     *  not fatal — the code was already consumed by the
                     *  successful register call. */
                }
                window.location.href = '/dashboard';
                return;
            }
            const data = await r.json().catch(() => ({}));
            const code = typeof data?.error === 'string' ? data.error : `register_${r.status}`;
            // Targeted invite-code hint so the user can clear that field
            // and resubmit the rest as-is.
            if (code === 'invalid_invite_code') {
                setInviteError(typeof data?.message === 'string' ? data.message : '邀请码无效。可清空后继续注册。');
            } else if (code === 'email_already_registered') {
                setError('该邮箱已注册,请直接登录。');
            } else if (code === 'validation_failed') {
                setError('请检查邮箱格式或密码长度(至少 8 位)。');
            } else if (code === 'provisioning_failed') {
                setError('账户开通失败,请稍后重试。');
            } else {
                setError(`注册失败:${code}`);
            }
            setSubmitting(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : '网络错误,请稍后重试');
            setSubmitting(false);
        }
    }

    return (
        <>
            <form onSubmit={handleSubmit} className="space-y-3.5">
                <div>
                    <Label htmlFor="register-email" required>
                        邮箱
                    </Label>
                    <Input
                        id="register-email"
                        type="email"
                        autoComplete="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@example.com"
                    />
                </div>
                <div>
                    <Label htmlFor="register-password" required>
                        密码(至少 8 位)
                    </Label>
                    <Input
                        id="register-password"
                        type="password"
                        autoComplete="new-password"
                        required
                        minLength={8}
                        maxLength={128}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        error={!passwordLongEnough}
                    />
                    {!passwordLongEnough ? <FormError>密码至少 8 位。</FormError> : null}
                </div>
                <div>
                    <Label htmlFor="register-confirm" required>
                        确认密码
                    </Label>
                    <Input
                        id="register-confirm"
                        type="password"
                        autoComplete="new-password"
                        required
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        error={!passwordsMatch}
                    />
                    {!passwordsMatch ? <FormError>两次密码不一致。</FormError> : null}
                </div>
                <div>
                    <Label htmlFor="register-invite">邀请码(可选)</Label>
                    <Input
                        id="register-invite"
                        type="text"
                        autoComplete="off"
                        maxLength={64}
                        value={inviteCode}
                        onChange={(e) => {
                            setInviteCode(e.target.value);
                            // User-driven edit cancels the "已自动填入" badge —
                            // transparency: once they touch it, it's theirs.
                            if (prefilled) setPrefilled(false);
                            if (inviteError) setInviteError(null);
                        }}
                        placeholder="有码填,无码留空"
                        error={!!inviteError}
                    />
                    {inviteError ? <FormError>{inviteError}</FormError> : null}
                    {/* fix/invite-landing: prefill transparency hint. Only
                     *  shown when value was prefilled AND the user hasn't
                     *  edited it. */}
                    {prefilled && !inviteError ? (
                        <p className="m-0 mt-1 text-xs text-emerald-700" data-prefill-source="invite-link">
                            ✓ 已自动填入推荐码,可修改或清空
                        </p>
                    ) : (
                        <p className="m-0 mt-1 text-xs text-minor-ink">
                            有效邀请码可在首充时获得 +30% 积分(默认 +20%)。
                        </p>
                    )}
                </div>

                <label className="flex items-start gap-2 text-sm text-muted-ink pt-1">
                    <input
                        type="checkbox"
                        checked={tosAccepted}
                        onChange={(e) => setTosAccepted(e.target.checked)}
                        required
                        className="mt-0.5 accent-navy"
                    />
                    <span>
                        我已阅读并同意{' '}
                        <a
                            href="/terms"
                            target="_blank"
                            rel="noopener"
                            className="text-navy font-medium hover:text-brand-accent"
                        >
                            服务条款
                        </a>{' '}
                        与{' '}
                        <a
                            href="/privacy"
                            target="_blank"
                            rel="noopener"
                            className="text-navy font-medium hover:text-brand-accent"
                        >
                            隐私政策
                        </a>
                        。
                    </span>
                </label>

                {error ? <FormError severity="banner">{error}</FormError> : null}

                <Button type="submit" block size="lg" loading={submitting} disabled={!formValid}>
                    {submitting ? '注册中…' : '创建账户'}
                </Button>

                <p className="m-0 mt-2 text-center text-xs text-minor-ink">
                    注册后将向您的邮箱发送验证链接,24 小时内有效。
                </p>
            </form>

            <p className="m-0 mt-6 text-center text-sm text-minor-ink">
                已有账户?{' '}
                <a href="/login" className="text-muted-ink font-medium hover:text-brand-accent transition-colors">
                    登录 →
                </a>
            </p>
        </>
    );
}
