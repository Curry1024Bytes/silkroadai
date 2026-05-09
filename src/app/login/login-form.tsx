'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';

export function LoginForm({ next }: { next: string }) {
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
                window.location.href = next;
                return;
            }
            const data = await r.json().catch(() => ({}));
            // /api/auth/login returns 401 'invalid_credentials' for both
            // wrong-password and unknown-email (timing defense). Don't try
            // to be more specific than the server is willing to be.
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
        <div>
            <form onSubmit={handleSubmit} className="space-y-3.5">
                <div>
                    <Label htmlFor="login-email">邮箱</Label>
                    <Input
                        id="login-email"
                        type="email"
                        autoComplete="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        error={!!error}
                    />
                </div>
                <div>
                    <Label htmlFor="login-password">密码</Label>
                    <Input
                        id="login-password"
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

            <div className="flex items-center gap-3 my-5">
                <hr className="flex-1 border-0 border-t border-brand-border" />
                <span className="text-xs text-minor-ink">或使用第三方登录</span>
                <hr className="flex-1 border-0 border-t border-brand-border" />
            </div>
            <div className="flex flex-col gap-2">
                <Button href="/api/auth/oauth/google/start" variant="secondary" block>
                    使用 Google 登录
                </Button>
                <Button href="/api/auth/oauth/github/start" variant="secondary" block>
                    使用 GitHub 登录
                </Button>
            </div>

            <p className="m-0 mt-6 text-center text-sm text-minor-ink">
                还没账户?{' '}
                <a
                    href="/portal/register"
                    className="text-muted-ink font-medium hover:text-brand-accent transition-colors"
                >
                    创建账户 →
                </a>
            </p>
        </div>
    );
}
