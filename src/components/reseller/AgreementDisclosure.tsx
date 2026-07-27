'use client';

/**
 * AgreementDisclosure — collapsible reseller agreement summary (PR-U2).
 *
 * Pure presentation. The 7-point agreement text is sourced from a single
 * const (RESELLER_AGREEMENT_POINTS) so it can also be imported by tests
 * + future legal-page renderings without re-typing.
 *
 * Brief Q1=a calibration:
 *   "CC 直接写 inline ~200-300 字中文。这是合作摘要不是正式合同;不需要
 *    本协议受 XX 法管辖等正规法律条款"
 */
import { useState } from 'react';

/** The agreement points — exported so tests + downstream legal pages can
 *  reuse the same source of truth. Order matters: it's the same order
 *  the brief listed (佣金 → 三档 → 归因 → 结算周期 → 结算方式 → 禁止 →
 *  终止 → 修订). */
export const RESELLER_AGREEMENT_POINTS: readonly { title: string; body: string }[] = [
    {
        title: '佣金计算',
        body: '佣金基于推荐客户的有效充值实付金额,扣除退款 / 作弊后的净额。',
    },
    {
        title: '三档费率',
        body: 'Bronze 10%(累计 GMV ≤ ¥1 万)/ Silver 15%(¥1 万 - ¥10 万)/ Gold 20%(> ¥10 万);累计达标后逐档升级,已结算佣金不补差。',
    },
    {
        title: '归因期',
        body: '客户使用代理邀请码注册起 24 个月内,所有充值归属该代理。',
    },
    {
        title: '结算周期',
        body: '客户充值满 14 天进入 confirmed 状态;每月可申请结算,单次满 ¥100 起结。',
    },
    {
        title: '结算方式',
        body: '运营方 7 个工作日内打款,支持银行转账 / 微信 / USDT 三种方式,请提前在后台填写收款信息。',
    },
    {
        title: '禁止行为',
        body: '严禁自买自卖 / 同 IP 多账户 / 虚假流量;一经发现取消代理资格 + 没收未结佣金。',
    },
    {
        title: '终止与修订',
        body: 'LLmRoute 保留终止合作的权利,已发生但未结佣金按规则照付;协议条款可调整,重大变更提前 30 天通知。',
    },
] as const;

interface Props {
    /** Default expanded state — `false` (collapsed) on the join page since
     *  the checkbox is the primary CTA, `true` for in-context refresher
     *  on settings/about pages. */
    defaultOpen?: boolean;
}

export function AgreementDisclosure({ defaultOpen = false }: Props) {
    const [open, setOpen] = useState(defaultOpen);
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
                <span>📜 《LLmRoute 代理合作协议》摘要</span>
                <span aria-hidden="true" className="text-xs text-muted-ink">
                    {open ? '收起 ▲' : '展开 ▼'}
                </span>
            </button>
            {open && (
                <ol className="list-decimal pl-7 pr-4 pb-4 m-0 space-y-2 text-sm text-muted-ink leading-relaxed">
                    {RESELLER_AGREEMENT_POINTS.map((p) => (
                        <li key={p.title}>
                            <span className="font-medium text-navy">{p.title}:</span> {p.body}
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
}
