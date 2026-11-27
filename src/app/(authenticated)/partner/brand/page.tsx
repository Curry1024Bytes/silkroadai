'use client';

import { useEffect, useState } from 'react';
import { useMessages } from '@/lib/i18n/client';
import { partnerMessages } from '@/lib/i18n/messages/partner';

interface BrandData {
    brand_name: string;
    logo_url: string | null;
    primary_color: string | null;
    support_email: string | null;
    support_wechat: string | null;
}

export default function PartnerBrandPage() {
    const m = useMessages(partnerMessages);
    const [brand, setBrand] = useState<BrandData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [form, setForm] = useState<BrandData>({ brand_name: '', logo_url: '', primary_color: '', support_email: '', support_wechat: '' });
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        fetch('/api/partner/brand')
            .then((r) => r.json())
            .then((data) => {
                if (data.brand) {
                    setBrand(data.brand);
                    setForm({
                        brand_name: data.brand.brand_name ?? '',
                        logo_url: data.brand.logo_url ?? '',
                        primary_color: data.brand.primary_color ?? '',
                        support_email: data.brand.support_email ?? '',
                        support_wechat: data.brand.support_wechat ?? '',
                    });
                }
            })
            .catch(() => setError(m.common.loadFailed))
            .finally(() => setLoading(false));
    }, [m.common.loadFailed]);

    const handleSave = async () => {
        if (!form.brand_name.trim()) {
            setError(m.brand.emptyBrandName);
            return;
        }
        setSaving(true);
        setError('');
        setSaved(false);
        try {
            const body: Partial<BrandData> = {};
            if (form.brand_name !== brand?.brand_name) body.brand_name = form.brand_name;
            if ((form.logo_url || null) !== brand?.logo_url) body.logo_url = form.logo_url || null;
            if ((form.primary_color || null) !== brand?.primary_color) body.primary_color = form.primary_color || null;
            if ((form.support_email || null) !== brand?.support_email) body.support_email = form.support_email || null;
            if ((form.support_wechat || null) !== brand?.support_wechat) body.support_wechat = form.support_wechat || null;

            if (Object.keys(body).length === 0) {
                setSaved(true);
                return;
            }

            const res = await fetch('/api/partner/brand', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.message || data.error || m.common.saveFailed);
                return;
            }
            setBrand(data.brand);
            setSaved(true);
        } catch {
            setError(m.common.saveFailed);
        } finally {
            setSaving(false);
        }
    };

    if (loading) return <div className="p-6 text-sm text-portal-muted">{m.common.loading}</div>;

    const inputCls = 'w-full rounded-lg border border-portal-line bg-portal-canvas px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-accent/30';
    const labelCls = 'mb-1 block text-sm font-medium text-portal-muted';

    return (
        <div className="mx-auto max-w-xl space-y-6 p-6">
            <div>
                <h1 className="text-2xl font-bold text-portal-ink">{m.brand.title}</h1>
                <p className="mt-1 text-sm text-portal-muted">{m.brand.intro}</p>
            </div>

            {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                    {error}{' '}
                    <button onClick={() => setError('')} className="ml-2 opacity-60">
                        ✕
                    </button>
                </div>
            )}
            {saved && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{m.brand.saved}</div>
            )}

            <div className="space-y-4">
                <div>
                    <label className={labelCls}>{m.brand.brandName}</label>
                    <input type="text" value={form.brand_name} onChange={(e) => { setForm({ ...form, brand_name: e.target.value }); setSaved(false); }} className={inputCls} />
                </div>
                <div>
                    <label className={labelCls}>{m.brand.logoUrl}</label>
                    <input type="text" value={form.logo_url ?? ''} onChange={(e) => { setForm({ ...form, logo_url: e.target.value }); setSaved(false); }} className={inputCls} placeholder="https://..." />
                    {/* eslint-disable-next-line @next/next/no-img-element -- 代理填的是任意外链,不走 Next 图片优化 */}
                    {form.logo_url && <img src={form.logo_url} alt="logo preview" className="mt-2 h-10 object-contain" />}
                </div>
                <div>
                    <label className={labelCls}>{m.brand.primaryColor}</label>
                    <input type="text" value={form.primary_color ?? ''} onChange={(e) => { setForm({ ...form, primary_color: e.target.value }); setSaved(false); }} className={[inputCls, 'font-mono'].join(' ')} placeholder="#1E3A8A" />
                    {form.primary_color && (
                        <div className="mt-2 flex items-center gap-2 text-xs text-portal-muted">
                            <span className="inline-block h-5 w-5 rounded border" style={{ background: form.primary_color }} />
                            {m.brand.preview}
                        </div>
                    )}
                </div>
                <div className="flex gap-3">
                    <div className="flex-1">
                        <label className={labelCls}>{m.brand.supportEmail}</label>
                        <input type="email" value={form.support_email ?? ''} onChange={(e) => { setForm({ ...form, support_email: e.target.value }); setSaved(false); }} className={inputCls} />
                    </div>
                    <div className="flex-1">
                        <label className={labelCls}>{m.brand.supportWechat}</label>
                        <input type="text" value={form.support_wechat ?? ''} onChange={(e) => { setForm({ ...form, support_wechat: e.target.value }); setSaved(false); }} className={inputCls} />
                    </div>
                </div>
            </div>

            <div className="flex justify-end">
                <button
                    onClick={handleSave}
                    disabled={saving}
                    className="rounded-lg bg-brand-accent px-6 py-2 text-sm font-medium text-white hover:bg-brand-accent-strong disabled:opacity-50"
                >
                    {saving ? m.common.saving : m.brand.saveButton}
                </button>
            </div>
        </div>
    );
}
