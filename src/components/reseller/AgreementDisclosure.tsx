'use client';

/**
 * AgreementDisclosure — collapsible reseller agreement summary (PR-U2).
 *
 * Pure presentation. The 7-point agreement text lives in the i18n module
 * (`resellerMessages.<locale>.agreement.points`); the Chinese original is
 * re-exported as RESELLER_AGREEMENT_POINTS so tests + future legal-page
 * renderings keep a single source of truth.
 *
 * Brief Q1=a calibration:
 *   "CC 直接写 inline ~200-300 字中文。这是合作摘要不是正式合同;不需要
 *    本协议受 XX 法管辖等正规法律条款"
 */
import { useState } from 'react';
import { useMessages } from '@/lib/i18n/client';
import { resellerMessages, type AgreementPoint } from '@/lib/i18n/messages/reseller';

/** The agreement points (Chinese, binding text) — exported so tests +
 *  downstream legal pages can reuse the same source of truth. Order
 *  matters: it's the same order the brief listed (佣金 → 三档 → 归因 →
 *  结算周期 → 结算方式 → 禁止 → 终止 → 修订). */
export const RESELLER_AGREEMENT_POINTS: readonly AgreementPoint[] = resellerMessages.zh.agreement.points;

interface Props {
    /** Default expanded state — `false` (collapsed) on the join page since
     *  the checkbox is the primary CTA, `true` for in-context refresher
     *  on settings/about pages. */
    defaultOpen?: boolean;
}

export function AgreementDisclosure({ defaultOpen = false }: Props) {
    const [open, setOpen] = useState(defaultOpen);
    const m = useMessages(resellerMessages).agreement;
    return (
        <div className="border border-brand-border rounded-xl bg-paper-muted/40">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className={[
                    'w-full flex items-center justify-between gap-3 px-4 py-3',
                    'text-sm font-medium text-navy text-left',
                    'hover:bg-paper-muted/60 transition-colors duration-150',
                    'rounded-xl',
                ].join(' ')}
            >
                <span>{m.toggle}</span>
                <span aria-hidden="true" className="text-xs text-muted-ink">
                    {open ? m.collapse : m.expand}
                </span>
            </button>
            {open && (
                <ol className="list-decimal pl-7 pr-4 pb-4 m-0 space-y-2 text-sm text-muted-ink leading-relaxed">
                    {m.points.map((p) => (
                        <li key={p.title}>
                            <span className="font-medium text-navy">{p.title}:</span> {p.body}
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
}
