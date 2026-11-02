'use client';

import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { useMessages } from '@/lib/i18n/client';
import { authMessages } from '@/lib/i18n/messages/auth';

export function ForgotPasswordForm() {
    const m = useMessages(authMessages).forgotForm;
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
                setError(data?.error === 'invalid_input' ? m.invalidInput : m.failedWithStatus(r.status));
                fired.current = false;
                setSubmitting(false);
            }
        } catch {
            setError(m.networkError);
            fired.current = false;
            setSubmitting(false);
        }
    }

    if (sent) {
        return (
            <div>
                <div className="text-sm leading-relaxed rounded-lg px-4 py-3 bg-status-success-bg border border-status-success-border text-status-success-text">
                    {m.sentBefore}
                    <strong>{email}</strong>
                    {m.sentAfter}
                    <br />
                    {m.spamBefore}
                    <strong>{m.spamFolder}</strong>
                    {m.spamAfter}
                </div>
                <p className="m-0 mt-6 text-center text-sm text-minor-ink">
                    <a href="/login" className="text-muted-ink font-medium hover:text-brand-accent transition-colors">
                        {m.backToLogin}
                    </a>
                </p>
            </div>
        );
    }

    return (
        <div>
            <p className="m-0 mb-4 text-sm leading-relaxed text-minor-ink">{m.intro}</p>
            <form onSubmit={handleSubmit} className="space-y-3.5">
                <div>
                    <Label htmlFor="forgot-email">{m.email}</Label>
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
                    {submitting ? m.submitting : m.submit}
                </Button>
            </form>
            <p className="m-0 mt-6 text-center text-sm text-minor-ink">
                {m.remembered}{' '}
                <a href="/login" className="text-muted-ink font-medium hover:text-brand-accent transition-colors">
                    {m.backToLoginArrow}
                </a>
            </p>
        </div>
    );
}
