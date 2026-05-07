'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';

/**
 * /portal/register form (W7 D4).
 *
 * Fields:
 *   email         — required
 *   password      — required, min 8 chars (server enforces; we surface
 *                   the constraint in the label)
 *   confirm       — client-side equality check; never sent to backend
 *   invite_code   — optional, max 64 chars. Empty/whitespace = no code.
 *                   Backend validates against INVITE_CODES env; invalid
 *                   surfaces as `invalid_invite_code` 400 → inline hint.
 *   tos           — required checkbox; client-side gate on submit
 *
 * On 200, /api/auth/register has already set the session cookie + queued
 * the verification email. We hard-nav to /dashboard so any client cache
 * picks up the fresh login state.
 */
export function RegisterForm() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [inviteCode, setInviteCode] = useState('');
    const [tosAccepted, setTosAccepted] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [inviteError, setInviteError] = useState<string | null>(null);

    const passwordsMatch = password.length === 0 || password === confirm;
    const passwordLongEnough = password.length === 0 || password.length >= 8;
    const formValid =
        email.length > 0 &&
        password.length >= 8 &&
        passwordsMatch &&
        tosAccepted &&
        !submitting;

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
                window.location.href = '/dashboard';
                return;
            }
            const data = await r.json().catch(() => ({}));
            const code = typeof data?.error === 'string' ? data.error : `register_${r.status}`;
            // Targeted invite-code hint so the user can clear that field
            // and resubmit the rest as-is.
            if (code === 'invalid_invite_code') {
                setInviteError(
                    typeof data?.message === 'string'
                        ? data.message
                        : '邀请码无效。可清空后继续注册。',
                );
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
                {!passwordLongEnough ? (
                    <FormError>密码至少 8 位。</FormError>
                ) : null}
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
                        if (inviteError) setInviteError(null);
                    }}
                    placeholder="有码填,无码留空"
                    error={!!inviteError}
                />
                {inviteError ? <FormError>{inviteError}</FormError> : null}
                <p className="m-0 mt-1 text-xs text-minor-ink">
                    有效邀请码可在首充时获得 +30% 积分(默认 +20%)。
                </p>
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
    );
}
