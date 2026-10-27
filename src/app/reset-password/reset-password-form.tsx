'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useMessages } from '@/lib/i18n/client';
import { authMessages } from '@/lib/i18n/messages/auth';

export function ResetPasswordForm({ token }: { token: string }) {
    const m = useMessages(authMessages).resetForm;
    const [pw1, setPw1] = useState('');
    const [pw2, setPw2] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
    // W4-2 D7 sweep — synchronous guard against the React 19 + double-click
    // race where two onSubmit invocations both observe submitting=false
    // before the first state update commits. Mirrors the firedRef pattern
    // in /verify-email's auto-fire runner (W3 D5).
    const fired = useRef(false);

    async function onSubmit(e: FormEvent) {
        e.preventDefault();
        if (fired.current) return;
        setResult(null);
        if (pw1.length < 8) {
            setResult({ ok: false, msg: m.tooShort });
            return;
        }
        if (pw1 !== pw2) {
            setResult({ ok: false, msg: m.mismatch });
            return;
        }
        fired.current = true;
        setSubmitting(true);
        try {
            const r = await fetch('/api/auth/reset-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, newPassword: pw1 }),
            });
            const data = await r.json().catch(() => ({}));
            if (r.ok) {
                setResult({ ok: true, msg: m.success });
            } else {
                const msg = data?.error === 'invalid_or_expired_token' ? m.invalidToken : m.failed;
                setResult({ ok: false, msg });
                // Allow user to retry on transient/server error (validation
                // errors don't get here — they returned early above without
                // setting fired).
                fired.current = false;
            }
        } catch {
            setResult({ ok: false, msg: m.networkError });
            fired.current = false;
        } finally {
            setSubmitting(false);
        }
    }

    if (result?.ok) {
        return (
            <div>
                <p style={{ color: 'var(--color-status-success-text)' }}>{result.msg}</p>
                <p>
                    <a href="/login" style={{ color: '#0a1535' }}>
                        {m.goLogin}
                    </a>
                </p>
            </div>
        );
    }

    return (
        <form onSubmit={onSubmit}>
            <label style={{ display: 'block', marginBottom: 12 }}>
                <span style={{ fontSize: 13, color: '#5a6478' }}>{m.newPassword}</span>
                <input
                    type="password"
                    value={pw1}
                    onChange={(e) => setPw1(e.target.value)}
                    required
                    minLength={8}
                    maxLength={128}
                    style={{
                        width: '100%',
                        padding: '8px 10px',
                        marginTop: 4,
                        border: '1px solid #d5dae3',
                        borderRadius: 4,
                        fontSize: 14,
                    }}
                />
            </label>
            <label style={{ display: 'block', marginBottom: 16 }}>
                <span style={{ fontSize: 13, color: '#5a6478' }}>{m.repeatPassword}</span>
                <input
                    type="password"
                    value={pw2}
                    onChange={(e) => setPw2(e.target.value)}
                    required
                    minLength={8}
                    maxLength={128}
                    style={{
                        width: '100%',
                        padding: '8px 10px',
                        marginTop: 4,
                        border: '1px solid #d5dae3',
                        borderRadius: 4,
                        fontSize: 14,
                    }}
                />
            </label>
            {result && !result.ok && (
                <p style={{ color: 'var(--color-status-error-text)', fontSize: 13, marginBottom: 12 }}>{result.msg}</p>
            )}
            <button
                type="submit"
                disabled={submitting}
                style={{
                    background: '#0a1535',
                    color: '#fff',
                    padding: '10px 20px',
                    border: 'none',
                    borderRadius: 4,
                    cursor: submitting ? 'wait' : 'pointer',
                    fontSize: 14,
                }}
            >
                {submitting ? m.submitting : m.submit}
            </button>
        </form>
    );
}
