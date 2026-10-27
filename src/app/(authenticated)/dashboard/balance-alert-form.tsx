'use client';

/**
 * W6 D2 — Balance alert threshold settings (client form).
 *
 * Lives next to /balance/page.tsx (server component). Receives the current
 * threshold as a prop from the SSR pass; the form posts to
 * /api/portal/balance-alert-threshold and updates local state on success.
 *
 * Threshold semantics:
 *   - 0 disables alerts entirely (BalanceAlertScheduler WHERE threshold > 0
 *     short-circuits). UI surfaces this as "已关闭提醒".
 *   - 1..1000 (CNY, integer) is the normal range.
 *
 * The server enforces the same range via zod regardless of UI clamping.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { useMessages } from '@/lib/i18n/client';
import { commonMessages } from '@/lib/i18n/messages/common';
import { dashboardMessages } from '@/lib/i18n/messages/dashboard';

interface Props {
    /** Current threshold from the SSR pass. null/undefined defaults to 10. */
    initialThreshold: number;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export function BalanceAlertForm({ initialThreshold }: Props) {
    const [value, setValue] = useState<string>(String(initialThreshold));
    const [persisted, setPersisted] = useState<number>(initialThreshold);
    const [status, setStatus] = useState<SaveStatus>('idle');
    const [errMsg, setErrMsg] = useState<string | null>(null);
    const m = useMessages(dashboardMessages).alert;
    const c = useMessages(commonMessages).auth;

    const numValue = Number(value);
    const dirty = !Number.isNaN(numValue) && numValue !== persisted;
    const validRange = Number.isFinite(numValue) && Number.isInteger(numValue) && numValue >= 0 && numValue <= 1000;
    const canSave = dirty && validRange && status !== 'saving';

    async function handleSave() {
        if (!canSave) return;
        setStatus('saving');
        setErrMsg(null);
        try {
            const r = await fetch('/api/portal/balance-alert-threshold', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ threshold: numValue }),
            });
            if (!r.ok) {
                const data = await r.json().catch(() => ({}));
                setErrMsg(typeof data?.error === 'string' ? data.error : c.requestFailed(r.status));
                setStatus('error');
                return;
            }
            const data = (await r.json()) as { threshold: number };
            setPersisted(data.threshold);
            setValue(String(data.threshold));
            setStatus('saved');
        } catch (err) {
            setErrMsg(err instanceof Error ? err.message : c.networkError);
            setStatus('error');
        }
    }

    return (
        <Card as="article" data-testid="balance-alert-form" className="mb-6">
            <CardHeader>
                <CardTitle as="h2" className="text-base font-semibold text-navy">
                    {m.heading}
                </CardTitle>
            </CardHeader>
            <CardContent>
                <p className="m-0 mb-4 text-xs text-muted-ink">{m.hint}</p>
                <div className="flex items-end gap-2.5 flex-wrap">
                    <div>
                        <Label htmlFor="balance-alert-threshold">{m.thresholdLabel}</Label>
                        <Input
                            id="balance-alert-threshold"
                            type="number"
                            min={0}
                            max={1000}
                            step={1}
                            value={value}
                            onChange={(e) => {
                                setValue(e.target.value);
                                if (status !== 'idle') setStatus('idle');
                            }}
                            aria-label={m.thresholdAria}
                            block={false}
                            className="w-32 tabular-nums"
                        />
                    </div>
                    <Button
                        type="button"
                        variant="primary"
                        size="md"
                        onClick={handleSave}
                        loading={status === 'saving'}
                        disabled={!canSave}
                    >
                        {status === 'saving' ? m.saving : m.save}
                    </Button>
                    {persisted === 0 && (
                        <span
                            className={[
                                'text-xs px-2 py-1 rounded',
                                'bg-status-warning-bg border border-status-warning-border text-status-warning-text',
                            ].join(' ')}
                        >
                            {m.disabled}
                        </span>
                    )}
                    {status === 'saved' && persisted > 0 && (
                        <span className="text-xs text-status-success-text">{m.saved(persisted)}</span>
                    )}
                    {status === 'error' && errMsg && <span className="text-xs text-status-error-text">{errMsg}</span>}
                    {status === 'idle' && !validRange && dirty && (
                        <span className="text-xs text-status-error-text">{m.invalidRange}</span>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
