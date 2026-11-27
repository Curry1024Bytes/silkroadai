'use client';

import { useCallback, useEffect, useState } from 'react';
import { useMessages } from '@/lib/i18n/client';
import { partnerMessages } from '@/lib/i18n/messages/partner';

interface Wallet {
    balance_cny: string;
    pending_cny: string;
    total_earned_cny: string;
}

interface Withdrawal {
    id: string;
    amount_cny: string;
    status: 'pending' | 'paid' | 'rejected';
    admin_note: string | null;
    created_at: string;
    processed_at: string | null;
}

const STATUS_CLS: Record<Withdrawal['status'], string> = {
    pending: 'text-amber-600',
    paid: 'text-emerald-600',
    rejected: 'text-portal-subtle',
};

export default function PartnerWalletPage() {
    const m = useMessages(partnerMessages);
    const [wallet, setWallet] = useState<Wallet | null>(null);
    const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [withdrawAmount, setWithdrawAmount] = useState('');
    const [note, setNote] = useState('');
    const [withdrawing, setWithdrawing] = useState(false);
    const [msg, setMsg] = useState('');

    const fetchWallet = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/partner/wallet');
            const data = await res.json();
            if (!res.ok) {
                setError(data.message || data.error || m.common.loadFailed);
                return;
            }
            setWallet(data.wallet);
            setWithdrawals(data.withdrawals ?? []);
        } catch {
            setError(m.common.loadFailed);
        } finally {
            setLoading(false);
        }
    }, [m.common.loadFailed]);

    useEffect(() => {
        void fetchWallet();
    }, [fetchWallet]);

    const handleWithdraw = async () => {
        const amount = parseFloat(withdrawAmount);
        if (!amount || amount <= 0) {
            setError(m.wallet.invalidAmount);
            return;
        }
        setWithdrawing(true);
        setError('');
        setMsg('');
        try {
            const res = await fetch('/api/partner/wallet/withdraw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount_cny: amount, note: note.trim() || undefined }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.message || data.error || m.common.saveFailed);
                return;
            }
            setWithdrawAmount('');
            setNote('');
            setMsg(m.wallet.requested(amount.toFixed(2)));
            await fetchWallet();
        } catch {
            setError(m.common.saveFailed);
        } finally {
            setWithdrawing(false);
        }
    };

    const fmt = (value: string) =>
        new Date(value).toLocaleString(m.common.timezone === 'Asia/Shanghai' ? 'zh-CN' : 'en-US', {
            timeZone: 'Asia/Shanghai',
        });

    if (loading) return <div className="p-6 text-sm text-portal-muted">{m.common.loading}</div>;

    return (
        <div className="mx-auto max-w-3xl space-y-6 p-6">
            <h1 className="text-2xl font-bold text-portal-ink">{m.wallet.title}</h1>

            {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                    {error}{' '}
                    <button onClick={() => setError('')} className="ml-2 opacity-60 hover:opacity-100">
                        ✕
                    </button>
                </div>
            )}
            {msg && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{msg}</div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="rounded-xl border border-portal-line bg-portal-panel p-5">
                    <p className="text-sm text-portal-muted">{m.wallet.available}</p>
                    <p className="mt-1 text-2xl font-bold text-brand-accent">¥{Number(wallet?.balance_cny ?? 0).toFixed(2)}</p>
                </div>
                <div className="rounded-xl border border-portal-line bg-portal-panel p-5">
                    <p className="text-sm text-portal-muted">{m.wallet.pending}</p>
                    <p className="mt-1 text-2xl font-bold text-amber-500">¥{Number(wallet?.pending_cny ?? 0).toFixed(2)}</p>
                </div>
                <div className="rounded-xl border border-portal-line bg-portal-panel p-5">
                    <p className="text-sm text-portal-muted">{m.wallet.totalEarned}</p>
                    <p className="mt-1 text-2xl font-bold text-portal-ink">¥{Number(wallet?.total_earned_cny ?? 0).toFixed(2)}</p>
                </div>
            </div>

            <div className="rounded-xl border border-portal-line bg-portal-soft p-5">
                <h2 className="mb-3 text-sm font-semibold text-portal-ink">{m.wallet.request}</h2>
                <div className="space-y-2">
                    <div className="flex gap-3">
                        <input
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={withdrawAmount}
                            onChange={(e) => setWithdrawAmount(e.target.value)}
                            placeholder={m.wallet.amountPlaceholder}
                            className="flex-1 rounded-lg border border-portal-line bg-portal-canvas px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-accent/30"
                        />
                        <button
                            onClick={handleWithdraw}
                            disabled={withdrawing || !withdrawAmount}
                            className="rounded-lg bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-brand-accent-strong disabled:opacity-50"
                        >
                            {withdrawing ? m.wallet.requesting : m.wallet.requestButton}
                        </button>
                    </div>
                    <input
                        type="text"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder={m.wallet.notePlaceholder}
                        maxLength={500}
                        className="w-full rounded-lg border border-portal-line bg-portal-canvas px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-accent/30"
                    />
                </div>
                <p className="mt-2 text-xs text-portal-subtle">{m.wallet.note}</p>
            </div>

            <div className="rounded-xl border border-portal-line">
                <h2 className="border-b border-portal-line px-5 py-3 text-sm font-semibold text-portal-ink">
                    {m.wallet.history}
                </h2>
                {withdrawals.length === 0 ? (
                    <p className="px-5 py-6 text-center text-sm text-portal-muted">{m.wallet.emptyHistory}</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-portal-line text-portal-muted">
                                    <th className="px-4 py-2 text-right font-medium">{m.wallet.colAmount}</th>
                                    <th className="px-4 py-2 text-right font-medium">{m.wallet.colStatus}</th>
                                    <th className="px-4 py-2 text-right font-medium">{m.wallet.colTime}</th>
                                    <th className="px-4 py-2 text-right font-medium">{m.wallet.colProcessed}</th>
                                    <th className="px-4 py-2 text-left font-medium">{m.wallet.colNote}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {withdrawals.map((row) => (
                                    <tr key={row.id} className="border-b border-portal-line/50 last:border-0">
                                        <td className="px-4 py-2 text-right font-mono text-portal-ink">
                                            ¥{Number(row.amount_cny).toFixed(2)}
                                        </td>
                                        <td className={`px-4 py-2 text-right text-xs ${STATUS_CLS[row.status]}`}>
                                            {m.wallet.status[row.status]}
                                        </td>
                                        <td className="px-4 py-2 text-right text-xs text-portal-muted">{fmt(row.created_at)}</td>
                                        <td className="px-4 py-2 text-right text-xs text-portal-muted">
                                            {row.processed_at ? fmt(row.processed_at) : '—'}
                                        </td>
                                        <td className="px-4 py-2 text-left text-xs text-portal-muted">{row.admin_note ?? '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}
