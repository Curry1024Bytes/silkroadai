'use client';

/**
 * CostPreview (PR-T2) — show estimated cost vs current balance.
 *
 * SWRs /api/portal/balance/quota with a 30s refresh window. After a
 * successful generate, the studio orchestrator calls `mutate()` on
 * the same key so the preview reflects the new balance immediately.
 *
 * Surfaces:
 *   - "本次约 ¥X.XX (余额 ¥Y.YY)"               normal case
 *   - "本次约 ¥X.XX (余额 ¥Y.YY · 余额不足)"     cost > balance, gold link to /pay
 *   - "本次约 ¥X.XX (余额读取失败)"               quota endpoint 5xx
 */
import Link from 'next/link';
import useSWR from 'swr';
import type { QuotaSnapshotJson } from './types';

const QUOTA_KEY = '/api/portal/balance/quota';

async function fetchJson<T>(url: string): Promise<T> {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`${r.status}`);
    return (await r.json()) as T;
}

interface Props {
    /** Per-image USD price for the currently selected model. */
    pricePerImageUsd: number;
    /** Currently selected count. */
    count: number;
}

export function CostPreview({ pricePerImageUsd, count }: Props) {
    const { data, error } = useSWR<QuotaSnapshotJson>(QUOTA_KEY, fetchJson, {
        refreshInterval: 30_000,
        revalidateOnFocus: true,
    });

    const costUsd = pricePerImageUsd * count;
    const costCny = Math.round(costUsd * 7 * 100) / 100;
    const remainCny = data?.remain_cny;
    const insufficient = typeof remainCny === 'number' && remainCny < costCny;

    return (
        <p className="m-0 text-xs text-minor-ink tabular-nums leading-tight">
            <span>
                本次约 <span className="text-navy font-medium">¥{costCny.toFixed(2)}</span>
            </span>
            {' · '}
            {error ? (
                <span className="text-status-error-text">余额读取失败</span>
            ) : remainCny === undefined ? (
                <span className="text-minor-ink">读取余额中…</span>
            ) : (
                <>
                    <span>余额 ¥{remainCny.toFixed(2)}</span>
                    {insufficient ? (
                        <>
                            <span className="text-status-error-text font-medium">{' · 余额不足'}</span>{' '}
                            <Link
                                href="/pay"
                                className="text-brand-accent font-medium hover:underline whitespace-nowrap"
                            >
                                立即充值 →
                            </Link>
                        </>
                    ) : null}
                </>
            )}
        </p>
    );
}

/** Hook variant for orchestrator to read the same SWR cache (e.g. to
 *  decide whether to disable the generate button). Keeps a single
 *  request in-flight regardless of how many components observe it. */
export function useQuotaSnapshot() {
    return useSWR<QuotaSnapshotJson>(QUOTA_KEY, fetchJson, {
        refreshInterval: 30_000,
        revalidateOnFocus: true,
    });
}

export const QUOTA_SWR_KEY = QUOTA_KEY;
