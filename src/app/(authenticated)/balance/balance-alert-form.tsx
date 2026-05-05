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
    const validRange =
        Number.isFinite(numValue) &&
        Number.isInteger(numValue) &&
        numValue >= 0 &&
        numValue <= 1000;
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
        <article
            data-testid="balance-alert-form"
            style={{
                background: '#fff',
                border: '1px solid #e5e8ee',
                borderRadius: 6,
                padding: 20,
                boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                marginBottom: 24,
            }}
        >
            <h2
                style={{
                    margin: '0 0 4px',
                    fontSize: 16,
                    color: '#0a1535',
                }}
            >
                余额提醒设置
            </h2>
            <p style={{ margin: '0 0 14px', fontSize: 12, color: '#5a6478' }}>
                当余额低于阈值时,我们会向您的注册邮箱发送提醒(24 小时内最多一次)。
                填 0 关闭提醒。
            </p>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <label style={{ fontSize: 13, color: '#1a2540' }}>阈值(CNY)</label>
                <input
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
                    style={{
                        width: 120,
                        padding: '6px 8px',
                        border: '1px solid #e5e8ee',
                        borderRadius: 4,
                        fontSize: 14,
                        fontVariantNumeric: 'tabular-nums',
                    }}
                />
                <button
                    type="button"
                    onClick={handleSave}
                    disabled={!canSave}
                    style={{
                        padding: '6px 14px',
                        background: canSave ? '#0a1535' : '#a8aebc',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 4,
                        fontSize: 13,
                        cursor: canSave ? 'pointer' : 'not-allowed',
                    }}
                >
                    {status === 'saving' ? '保存中…' : '保存'}
                </button>
                {persisted === 0 && (
                    <span
                        style={{
                            fontSize: 12,
                            color: '#7a5d00',
                            background: '#fff8e1',
                            border: '1px solid #f0d785',
                            padding: '3px 8px',
                            borderRadius: 4,
                        }}
                    >
                        已关闭提醒
                    </span>
                )}
                {status === 'saved' && persisted > 0 && (
                    <span style={{ fontSize: 12, color: '#1a8a4a' }}>
                        已保存 ✓ 当前阈值 ¥{persisted}
                    </span>
                )}
                {status === 'error' && errMsg && (
                    <span style={{ fontSize: 12, color: '#c44' }}>{errMsg}</span>
                )}
                {status === 'idle' && !validRange && dirty && (
                    <span style={{ fontSize: 12, color: '#c44' }}>
                        请输入 0–1000 的整数
                    </span>
                )}
            </div>
        </article>
    );
}
