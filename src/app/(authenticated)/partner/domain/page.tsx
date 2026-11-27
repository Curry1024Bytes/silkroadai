'use client';

import { useCallback, useEffect, useState } from 'react';
import { useMessages } from '@/lib/i18n/client';
import { partnerMessages } from '@/lib/i18n/messages/partner';

interface PendingClaim {
    domain: string;
    txt: { host: string; type: string; value: string; ttl: number };
    cname: { host: string; type: string; value: string; ttl: number };
}

interface DomainInfo {
    primary_domain: string | null;
    domains: string[];
    cname_target: string;
    pending: PendingClaim | null;
}

interface VerifyResult {
    verified: boolean;
    txt_ok: boolean;
    cname_ok: boolean;
    txt_records?: string[];
    cname_records?: string[];
}

export default function PartnerDomainPage() {
    const m = useMessages(partnerMessages);
    const [info, setInfo] = useState<DomainInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [newDomain, setNewDomain] = useState('');
    const [saving, setSaving] = useState(false);
    const [verifying, setVerifying] = useState(false);
    const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

    const fetchInfo = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/partner/domain');
            const data = await res.json();
            if (!res.ok) {
                setError(data.message || data.error || m.common.loadFailed);
                return;
            }
            setInfo(data);
        } catch {
            setError(m.common.loadFailed);
        } finally {
            setLoading(false);
        }
    }, [m.common.loadFailed]);

    useEffect(() => {
        void fetchInfo();
    }, [fetchInfo]);

    const handleBind = async () => {
        if (!newDomain.trim()) return;
        setSaving(true);
        setError('');
        setVerifyResult(null);
        try {
            const res = await fetch('/api/partner/domain', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ domain: newDomain.trim() }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.message || data.error || m.common.saveFailed);
                return;
            }
            setNewDomain('');
            await fetchInfo();
        } catch {
            setError(m.common.saveFailed);
        } finally {
            setSaving(false);
        }
    };

    const handleVerify = async () => {
        setVerifying(true);
        setVerifyResult(null);
        setError('');
        try {
            const res = await fetch('/api/partner/domain', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'verify' }),
            });
            const data = await res.json();
            setVerifyResult(data);
            if (data.verified) await fetchInfo();
        } catch {
            setError(m.domain.verifying);
        } finally {
            setVerifying(false);
        }
    };

    if (loading) return <div className="p-6 text-sm text-portal-muted">{m.common.loading}</div>;

    const records = info?.pending ? [info.pending.txt, info.pending.cname] : [];

    return (
        <div className="mx-auto max-w-2xl space-y-6 p-6">
            <div>
                <h1 className="text-2xl font-bold text-portal-ink">{m.domain.title}</h1>
                <p className="mt-1 text-sm text-portal-muted">{m.domain.intro}</p>
            </div>

            {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                    {error}{' '}
                    <button onClick={() => setError('')} className="ml-2 opacity-60">
                        ✕
                    </button>
                </div>
            )}

            <div className="rounded-xl border border-portal-line bg-portal-panel p-5">
                <h2 className="mb-2 text-sm font-semibold text-portal-ink">{m.domain.current}</h2>
                {info?.primary_domain ? (
                    <p className="font-mono text-portal-ink">{info.primary_domain}</p>
                ) : (
                    <p className="text-sm text-portal-muted">{m.domain.none}</p>
                )}
            </div>

            {info?.pending && (
                <div className="space-y-4 rounded-xl border border-portal-line bg-portal-panel p-5">
                    <div>
                        <h2 className="text-sm font-semibold text-portal-ink">{m.domain.pending}</h2>
                        <p className="mt-1 font-mono text-sm text-portal-ink">{info.pending.domain}</p>
                    </div>
                    <div>
                        <h3 className="mb-2 text-xs font-medium text-portal-muted">{m.domain.addRecord}</h3>
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                                <thead>
                                    <tr className="text-left text-portal-muted">
                                        <th className="pb-2 pr-3 font-medium">{m.domain.colHost}</th>
                                        <th className="pb-2 pr-3 font-medium">{m.domain.colType}</th>
                                        <th className="pb-2 pr-3 font-medium">{m.domain.colValue}</th>
                                        <th className="pb-2 pr-3 font-medium">{m.domain.colTtl}</th>
                                        <th className="pb-2 font-medium" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {records.map((record, index) => (
                                        <tr key={record.type} className="font-mono">
                                            <td className="py-1 pr-3 text-portal-ink">{record.host}</td>
                                            <td className="py-1 pr-3 text-portal-ink">{record.type}</td>
                                            <td className="py-1 pr-3 break-all text-portal-ink">{record.value}</td>
                                            <td className="py-1 pr-3 text-portal-ink">{record.ttl}</td>
                                            <td className="py-1 text-[11px] text-portal-subtle">
                                                {index === 0 ? m.domain.txtPurpose : m.domain.cnamePurpose}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                    <div>
                        <h3 className="mb-2 text-xs font-medium text-portal-muted">{m.domain.verify}</h3>
                        <button
                            onClick={handleVerify}
                            disabled={verifying}
                            className="rounded-lg bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-brand-accent-strong disabled:opacity-50"
                        >
                            {verifying ? m.domain.verifying : m.domain.verifyButton}
                        </button>
                    </div>
                    {verifyResult && (
                        <div
                            className={`rounded-lg p-3 text-xs ${verifyResult.verified ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}
                        >
                            <div>{verifyResult.verified ? m.domain.verified : m.domain.txtFailed}</div>
                            {verifyResult.txt_records && verifyResult.txt_records.length > 0 && (
                                <div className="mt-1 break-all font-mono">TXT: {verifyResult.txt_records.join(', ')}</div>
                            )}
                            {verifyResult.cname_records && verifyResult.cname_records.length > 0 && (
                                <div className="mt-1 break-all font-mono">CNAME: {verifyResult.cname_records.join(', ')}</div>
                            )}
                        </div>
                    )}
                </div>
            )}

            <div className="rounded-xl border border-portal-line bg-portal-soft p-5">
                <h2 className="mb-3 text-sm font-semibold text-portal-ink">{m.domain.newDomain}</h2>
                <div className="flex gap-3">
                    <input
                        type="text"
                        value={newDomain}
                        onChange={(e) => setNewDomain(e.target.value)}
                        placeholder={m.domain.domainPlaceholder}
                        className="flex-1 rounded-lg border border-portal-line bg-portal-canvas px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-accent/30"
                    />
                    <button
                        onClick={handleBind}
                        disabled={saving || !newDomain.trim()}
                        className="rounded-lg bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-brand-accent-strong disabled:opacity-50"
                    >
                        {saving ? m.domain.binding : m.domain.bind}
                    </button>
                </div>
                <p className="mt-2 text-xs text-portal-subtle">{m.domain.note}</p>
            </div>
        </div>
    );
}
