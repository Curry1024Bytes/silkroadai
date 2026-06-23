'use client';

import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';

export function ForgotPasswordForm() {
    const [email, setEmail] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sent, setSent] = useState(false);
    // Synchronous guard against the React 19 + double-click race where two
    // onSubmit invocations both observe submitting=false before the first
    // state update commits. Mirrors reset-password-form (W4-2 D7).
    const fired = useRef(false);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        if (fired.current) return;
        setError(null);
        fired.current = true;
        setSubmitting(true);
        try {
            const r = await fetch('/api/auth/forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
            });
            if (r.ok) {
                // The endpoint returns 200 for ANY email (anti-enumeration:
                // it won't reveal whether an address is registered). Keep the
                // success copy neutral — never confirm the account exists.
                setSent(true);
            } else {
                const data = await r.json().catch(() => ({}));
                setError(data?.error === 'invalid_input' ? '请检查邮箱格式' : `提交失败 (${r.status}),请稍后重试`);
                fired.current = false;
                setSubmitting(false);
            }
        } catch {
            setError('网络错误,请稍后重试');
            fired.current = false;
            setSubmitting(false);
        }
    }

    if (sent) {
        return (
            <div>
                <div className="text-sm leading-relaxed rounded-lg px-4 py-3 bg-status-success-bg border border-status-success-border text-status-success-text">
                    如果 <strong>{email}</strong> 已注册,我们已向该邮箱发送密码重置链接,请查收(链接 1 小时内有效)。
                    <br />
                    几分钟内没收到的话,请检查邮箱的<strong>「垃圾箱 / 订阅邮件」</strong>分类。
                </div>
                <p className="m-0 mt-6 text-center text-sm text-minor-ink">
                    <a href="/login" className="text-muted-ink font-medium hover:text-brand-accent transition-colors">
                        ← 返回登录
                    </a>
                </p>
            </div>
        );
    }

    return (
        <div>
            <p className="m-0 mb-4 text-sm leading-relaxed text-minor-ink">
                输入你的注册邮箱,我们会给你发送一封密码重置邮件,点击邮件里的链接即可设置新密码。
            </p>
            <form onSubmit={handleSubmit} className="space-y-3.5">
                <div>
                    <Label htmlFor="forgot-email">邮箱</Label>
                    <Input
                        id="forgot-email"
                        type="email"
                        autoComplete="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        error={!!error}
                    />
                </div>
                <FormError>{error}</FormError>
                <Button type="submit" block loading={submitting} disabled={submitting || !email}>
                    {submitting ? '发送中…' : '发送重置邮件'}
                </Button>
            </form>
            <p className="m-0 mt-6 text-center text-sm text-minor-ink">
                想起密码了?{' '}
                <a href="/login" className="text-muted-ink font-medium hover:text-brand-accent transition-colors">
                    返回登录 →
                </a>
            </p>
        </div>
    );
}
