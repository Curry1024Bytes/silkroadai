'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';

/**
 * Admin login form. Reuses the customer `POST /api/auth/login` (same
 * silkroad_session cookie) — admin and customer share one login per design
 * §3.2. On success we hard-nav to /admin; the role check happens server-side
 * (the /admin layout + the login page itself bounce non-admins back here with
 * a notice). No OAuth / register affordances — admins are provisioned via
 * scripts/grant-admin.ts, not self-signup.
 */
export function AdminLoginForm() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (submitting) return;
        setSubmitting(true);
        setError(null);
        try {
            const r = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ email, password }),
            });
            if (r.ok) {
                window.location.href = '/admin';
                return;
            }
            const data = await r.json().catch(() => ({}));
            setError(
                typeof data?.error === 'string'
                    ? data.error === 'invalid_credentials'
                        ? '邮箱或密码错误'
                        : data.error === 'invalid_input'
                          ? '请检查邮箱格式或密码长度'
                          : `登录失败:${data.error}`
                    : `登录失败 (${r.status})`,
            );
            setSubmitting(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : '网络错误,请稍后重试');
            setSubmitting(false);
        }
    }

    return (
        <form onSubmit={handleSubmit} className="space-y-3.5">
            <div>
                <Label htmlFor="admin-email">邮箱</Label>
                <Input
                    id="admin-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    error={!!error}
                />
            </div>
            <div>
                <Label htmlFor="admin-password">密码</Label>
                <Input
                    id="admin-password"
                    type="password"
                    autoComplete="current-password"
                    required
                    minLength={1}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    error={!!error}
                />
            </div>
            <FormError>{error}</FormError>
            <Button type="submit" block loading={submitting} disabled={submitting || !email || !password}>
                {submitting ? '登录中…' : '登录'}
            </Button>
        </form>
    );
}
