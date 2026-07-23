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
import { BellRing } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';

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
                setErrMsg(typeof data?.error === 'string' ? data.error : `请求失败 (${r.status})`);
                setStatus('error');
                return;
            }
            const data = (await r.json()) as { threshold: number };
            setPersisted(data.threshold);
            setValue(String(data.threshold));
            setStatus('saved');
        } catch (err) {
            setErrMsg(err instanceof Error ? err.message : '网络错误');
            setStatus('error');
        }
    }

    return (
        <section
            data-testid="balance-alert-form"
            className="overflow-hidden rounded-lg border border-portal-line bg-portal-panel shadow-portal"
        >
            <div className="border-b border-portal-line px-5 py-4 sm:px-6">
                <div className="flex items-center gap-2">
                    <BellRing size={17} className="text-portal-gold" strokeWidth={1.8} aria-hidden="true" />
                    <h2 className="m-0 text-base font-semibold text-portal-ink">余额提醒设置</h2>
                </div>
                <p className="m-0 mt-1 text-xs text-portal-subtle">账户保护</p>
            </div>
            <div className="px-5 py-5 sm:px-6">
                <p className="m-0 mb-5 text-sm leading-relaxed text-portal-muted">
                    当余额低于阈值时,我们会向您的注册邮箱发送提醒(24 小时内最多一次)。填 0 关闭提醒。
                </p>
                <div className="flex items-end gap-2.5 flex-wrap">
                    <div>
                        <Label htmlFor="balance-alert-threshold">阈值(CNY)</Label>
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
                            aria-label="余额提醒阈值"
                            block={false}
                            className="w-32 rounded-md border-portal-line tabular-nums"
                        />
                    </div>
                    <Button
                        type="button"
                        variant="primary"
                        size="md"
                        onClick={handleSave}
                        loading={status === 'saving'}
                        disabled={!canSave}
                        className="rounded-md"
                    >
                        {status === 'saving' ? '保存中…' : '保存'}
                    </Button>
                    {persisted === 0 && (
                        <span
                            className={[
                                'text-xs px-2 py-1 rounded',
                                'bg-status-warning-bg border border-status-warning-border text-status-warning-text',
                            ].join(' ')}
                        >
                            已关闭提醒
                        </span>
                    )}
                    {status === 'saved' && persisted > 0 && (
                        <span className="text-xs text-status-success-text">已保存 ✓ 当前阈值 ¥{persisted}</span>
                    )}
                    {status === 'error' && errMsg && <span className="text-xs text-status-error-text">{errMsg}</span>}
                    {status === 'idle' && !validRange && dirty && (
                        <span className="text-xs text-status-error-text">请输入 0–1000 的整数</span>
                    )}
                </div>
            </div>
        </section>
    );
}
