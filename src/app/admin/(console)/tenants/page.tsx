'use client';

import { useSearchParams } from 'next/navigation';
import { useState, useEffect, useCallback, Suspense } from 'react';
import PayPageLayout from '@/components/PayPageLayout';
import { resolveLocale, type Locale } from '@/lib/locale';

const PLATFORM_TENANT_ID = '00000000-0000-0000-0000-000000000001';

interface Tenant {
    id: string;
    slug: string;
    brand_name: string;
    primary_domain: string | null;
    domains: string[];
    logo_url: string | null;
    primary_color: string | null;
    support_email: string | null;
    support_wechat: string | null;
    signup_enabled: boolean;
    status: string;
    prepaid_balance_cny: string | number;
}

interface FormData {
    slug: string;
    brand_name: string;
    primary_domain: string;
    domains: string; // newline/comma separated in the textarea
    logo_url: string;
    primary_color: string;
    support_email: string;
    support_wechat: string;
    signup_enabled: boolean;
    status: string;
}

const emptyForm: FormData = {
    slug: '',
    brand_name: '',
    primary_domain: '',
    domains: '',
    logo_url: '',
    primary_color: '#1E3A8A',
    support_email: '',
    support_wechat: '',
    signup_enabled: true,
    status: 'active',
};

function getTexts(locale: Locale) {
    return locale === 'en'
        ? {
              sessionExpired: 'Your session has expired (superadmin only).',
              title: 'Tenants',
              subtitle: 'White-label tenants — brand / domains. Superadmin only.',
              refresh: 'Refresh',
              loading: 'Loading...',
              newTenant: '+ New Tenant',
              editTenant: 'Edit Tenant',
              none: 'No tenants',
              colBrand: 'Brand',
              colSlug: 'Slug',
              colDomains: 'Domains',
              colSignup: 'Signup',
              colStatus: 'Status',
              colActions: 'Actions',
              edit: 'Edit',
              platform: 'platform',
              fieldSlug: 'Slug',
              fieldSlugHint: 'lowercase a-z 0-9 -, immutable after creation',
              fieldBrand: 'Brand name',
              fieldPrimaryDomain: 'Primary domain',
              fieldDomains: 'Domains (one per line)',
              fieldDomainsHint: 'Hosts that map to this tenant, e.g. partner.example.com',
              fieldColor: 'Primary color',
              fieldLogo: 'Logo URL',
              fieldSupportEmail: 'Support email',
              fieldSupportWechat: 'Support WeChat',
              fieldSignup: 'Self-serve signup enabled',
              fieldStatus: 'Status',
              statusActive: 'active',
              statusSuspended: 'suspended',
              cancel: 'Cancel',
              save: 'Save',
              saving: 'Saving...',
              loadFailed: 'Failed to load tenants',
              saveFailed: 'Failed to save tenant',
          }
        : {
              sessionExpired: '登录已过期(仅超管可用)。',
              title: '租户管理',
              subtitle: '白标租户 —— 品牌 / 域名。仅超管可用。',
              refresh: '刷新',
              loading: '加载中...',
              newTenant: '+ 新建租户',
              editTenant: '编辑租户',
              none: '暂无租户',
              colBrand: '品牌',
              colSlug: 'Slug',
              colDomains: '域名',
              colSignup: '注册',
              colStatus: '状态',
              colActions: '操作',
              edit: '编辑',
              platform: '平台主体',
              fieldSlug: 'Slug',
              fieldSlugHint: '小写字母/数字/连字符,创建后不可改',
              fieldBrand: '品牌名',
              fieldPrimaryDomain: '主域名',
              fieldDomains: '域名(每行一个)',
              fieldDomainsHint: '映射到该租户的 Host,如 partner.example.com',
              fieldColor: '品牌主色',
              fieldLogo: 'Logo URL',
              fieldSupportEmail: '客服邮箱',
              fieldSupportWechat: '客服微信',
              fieldSignup: '开放自助注册',
              fieldStatus: '状态',
              statusActive: 'active',
              statusSuspended: 'suspended',
              cancel: '取消',
              save: '保存',
              saving: '保存中...',
              loadFailed: '加载租户失败',
              saveFailed: '保存租户失败',
          };
}

function parseDomains(raw: string): string[] {
    return raw
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function TenantsContent() {
    const searchParams = useSearchParams();
    const theme = searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    const uiMode = searchParams.get('ui_mode') || 'standalone';
    const locale = resolveLocale(searchParams.get('lang'));
    const isDark = theme === 'dark';
    const isEmbedded = uiMode === 'embedded';
    const t = getTexts(locale);

    const [tenants, setTenants] = useState<Tenant[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [modalOpen, setModalOpen] = useState(false);
    const [editing, setEditing] = useState<Tenant | null>(null);
    const [form, setForm] = useState<FormData>(emptyForm);
    const [saving, setSaving] = useState(false);

    const fetchTenants = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await fetch('/api/admin/tenants');
            if (!res.ok) {
                setError(res.status === 401 ? t.sessionExpired : t.loadFailed);
                return;
            }
            const data = await res.json();
            setTenants(data.tenants ?? []);
        } catch {
            setError(t.loadFailed);
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        fetchTenants();
    }, [fetchTenants]);

    const openCreate = () => {
        setEditing(null);
        setForm(emptyForm);
        setModalOpen(true);
    };
    const openEdit = (tn: Tenant) => {
        setEditing(tn);
        setForm({
            slug: tn.slug,
            brand_name: tn.brand_name,
            primary_domain: tn.primary_domain ?? '',
            domains: (tn.domains ?? []).join('\n'),
            logo_url: tn.logo_url ?? '',
            primary_color: tn.primary_color ?? '#1E3A8A',
            support_email: tn.support_email ?? '',
            support_wechat: tn.support_wechat ?? '',
            signup_enabled: tn.signup_enabled,
            status: tn.status,
        });
        setModalOpen(true);
    };

    const handleSave = async () => {
        if (!form.brand_name.trim()) return;
        if (!editing && !form.slug.trim()) return;
        setSaving(true);
        setError('');

        const body: Record<string, unknown> = {
            brand_name: form.brand_name.trim(),
            primary_domain: form.primary_domain.trim() || null,
            domains: parseDomains(form.domains),
            logo_url: form.logo_url.trim() || null,
            primary_color: form.primary_color.trim() || null,
            support_email: form.support_email.trim() || null,
            support_wechat: form.support_wechat.trim() || null,
            signup_enabled: form.signup_enabled,
            status: form.status,
        };
        if (!editing) body.slug = form.slug.trim();

        try {
            const url = editing ? `/api/admin/tenants/${editing.id}` : '/api/admin/tenants';
            const res = await fetch(url, {
                method: editing ? 'PUT' : 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                setError(data.error || t.saveFailed);
                return;
            }
            setModalOpen(false);
            fetchTenants();
        } catch {
            setError(t.saveFailed);
        } finally {
            setSaving(false);
        }
    };

    const btnBase = [
        'inline-flex items-center rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
        isDark
            ? 'border-slate-600 text-slate-200 hover:bg-slate-800'
            : 'border-slate-300 text-slate-700 hover:bg-slate-100',
    ].join(' ');
    const inputCls = [
        'w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50',
        isDark ? 'border-slate-600 bg-slate-700 text-slate-100' : 'border-slate-300 bg-white text-slate-900',
    ].join(' ');
    const readonlyCls = [
        'w-full rounded-lg border px-3 py-2 text-sm cursor-not-allowed',
        isDark ? 'border-slate-700 bg-slate-800 text-slate-400' : 'border-slate-200 bg-slate-100 text-slate-500',
    ].join(' ');
    const labelCls = ['block text-sm font-medium mb-1', isDark ? 'text-slate-300' : 'text-slate-700'].join(' ');

    return (
        <PayPageLayout
            isDark={isDark}
            isEmbedded={isEmbedded}
            maxWidth="full"
            title={t.title}
            subtitle={t.subtitle}
            locale={locale}
            actions={
                <button type="button" onClick={fetchTenants} className={btnBase}>
                    {t.refresh}
                </button>
            }
        >
            {error && (
                <div
                    className={`mb-4 rounded-lg border p-3 text-sm ${isDark ? 'border-red-800 bg-red-950/50 text-red-400' : 'border-red-200 bg-red-50 text-red-600'}`}
                >
                    {error}
                    <button onClick={() => setError('')} className="ml-2 opacity-60 hover:opacity-100">
                        ✕
                    </button>
                </div>
            )}

            <div className="mb-4 flex justify-end">
                <button
                    type="button"
                    onClick={openCreate}
                    className="inline-flex items-center rounded-lg border border-emerald-500 bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600"
                >
                    {t.newTenant}
                </button>
            </div>

            <div
                className={[
                    'overflow-x-auto rounded-xl border',
                    isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-white shadow-sm',
                ].join(' ')}
            >
                {loading ? (
                    <div className={`py-12 text-center ${isDark ? 'text-slate-400' : 'text-gray-500'}`}>
                        {t.loading}
                    </div>
                ) : tenants.length === 0 ? (
                    <div className={`py-12 text-center ${isDark ? 'text-slate-400' : 'text-gray-500'}`}>{t.none}</div>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr
                                className={
                                    isDark
                                        ? 'border-b border-slate-700 text-slate-400'
                                        : 'border-b border-slate-200 text-slate-500'
                                }
                            >
                                <th className="px-4 py-3 text-left font-medium">{t.colBrand}</th>
                                <th className="px-4 py-3 text-left font-medium">{t.colSlug}</th>
                                <th className="px-4 py-3 text-left font-medium">{t.colDomains}</th>
                                <th className="px-4 py-3 text-center font-medium">{t.colSignup}</th>
                                <th className="px-4 py-3 text-center font-medium">{t.colStatus}</th>
                                <th className="px-4 py-3 text-right font-medium">{t.colActions}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {tenants.map((tn) => {
                                const isPlatform = tn.id === PLATFORM_TENANT_ID;
                                return (
                                    <tr
                                        key={tn.id}
                                        className={[
                                            'border-b',
                                            isDark ? 'border-slate-700/50' : 'border-slate-100',
                                        ].join(' ')}
                                    >
                                        <td
                                            className={`px-4 py-3 font-medium ${isDark ? 'text-slate-100' : 'text-slate-900'}`}
                                        >
                                            <span className="inline-flex items-center gap-2">
                                                <span
                                                    className="inline-block h-3 w-3 rounded-full border"
                                                    style={{ background: tn.primary_color ?? '#1E3A8A' }}
                                                />
                                                {tn.brand_name}
                                                {isPlatform && (
                                                    <span
                                                        className={`text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}
                                                    >
                                                        ({t.platform})
                                                    </span>
                                                )}
                                            </span>
                                        </td>
                                        <td
                                            className={`px-4 py-3 font-mono text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
                                        >
                                            {tn.slug}
                                        </td>
                                        <td
                                            className={`px-4 py-3 font-mono text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
                                        >
                                            {(tn.domains ?? []).join(', ') || '—'}
                                        </td>
                                        <td className="px-4 py-3 text-center">{tn.signup_enabled ? '✓' : '✕'}</td>
                                        <td
                                            className={`px-4 py-3 text-center ${tn.status === 'active' ? 'text-emerald-500' : 'text-amber-500'}`}
                                        >
                                            {tn.status}
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                            <button
                                                type="button"
                                                onClick={() => openEdit(tn)}
                                                className={
                                                    isDark
                                                        ? 'text-indigo-400 hover:underline'
                                                        : 'text-indigo-600 hover:underline'
                                                }
                                            >
                                                {t.edit}
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>

            {modalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div
                        className={[
                            'relative w-full max-w-lg overflow-y-auto rounded-2xl border p-6 shadow-2xl',
                            isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-white',
                        ].join(' ')}
                        style={{ maxHeight: '90vh' }}
                    >
                        <h2 className={`mb-5 text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                            {editing ? t.editTenant : t.newTenant}
                        </h2>
                        <div className="space-y-4">
                            <div>
                                <label className={labelCls}>{t.fieldSlug}</label>
                                <input
                                    type="text"
                                    value={form.slug}
                                    onChange={(e) => setForm({ ...form, slug: e.target.value })}
                                    className={editing ? readonlyCls : [inputCls, 'font-mono'].join(' ')}
                                    readOnly={!!editing}
                                    placeholder="partner-acme"
                                />
                                {!editing && (
                                    <p className={`mt-1 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                        {t.fieldSlugHint}
                                    </p>
                                )}
                            </div>
                            <div>
                                <label className={labelCls}>{t.fieldBrand}</label>
                                <input
                                    type="text"
                                    value={form.brand_name}
                                    onChange={(e) => setForm({ ...form, brand_name: e.target.value })}
                                    className={inputCls}
                                />
                            </div>
                            <div>
                                <label className={labelCls}>{t.fieldPrimaryDomain}</label>
                                <input
                                    type="text"
                                    value={form.primary_domain}
                                    onChange={(e) => setForm({ ...form, primary_domain: e.target.value })}
                                    className={[inputCls, 'font-mono'].join(' ')}
                                    placeholder="partner.example.com"
                                />
                            </div>
                            <div>
                                <label className={labelCls}>{t.fieldDomains}</label>
                                <textarea
                                    value={form.domains}
                                    onChange={(e) => setForm({ ...form, domains: e.target.value })}
                                    rows={3}
                                    className={[inputCls, 'font-mono text-xs'].join(' ')}
                                    spellCheck={false}
                                    placeholder={'partner.example.com\nwww.partner.example.com'}
                                />
                                <p className={`mt-1 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                    {t.fieldDomainsHint}
                                </p>
                            </div>
                            <div className="flex gap-3">
                                <div className="flex-1">
                                    <label className={labelCls}>{t.fieldColor}</label>
                                    <input
                                        type="text"
                                        value={form.primary_color}
                                        onChange={(e) => setForm({ ...form, primary_color: e.target.value })}
                                        className={[inputCls, 'font-mono'].join(' ')}
                                        placeholder="#1E3A8A"
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className={labelCls}>{t.fieldStatus}</label>
                                    <select
                                        value={form.status}
                                        onChange={(e) => setForm({ ...form, status: e.target.value })}
                                        className={inputCls}
                                    >
                                        <option value="active">{t.statusActive}</option>
                                        <option value="suspended">{t.statusSuspended}</option>
                                    </select>
                                </div>
                            </div>
                            <div>
                                <label className={labelCls}>{t.fieldLogo}</label>
                                <input
                                    type="text"
                                    value={form.logo_url}
                                    onChange={(e) => setForm({ ...form, logo_url: e.target.value })}
                                    className={inputCls}
                                    placeholder="https://..."
                                />
                            </div>
                            <div className="flex gap-3">
                                <div className="flex-1">
                                    <label className={labelCls}>{t.fieldSupportEmail}</label>
                                    <input
                                        type="text"
                                        value={form.support_email}
                                        onChange={(e) => setForm({ ...form, support_email: e.target.value })}
                                        className={inputCls}
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className={labelCls}>{t.fieldSupportWechat}</label>
                                    <input
                                        type="text"
                                        value={form.support_wechat}
                                        onChange={(e) => setForm({ ...form, support_wechat: e.target.value })}
                                        className={inputCls}
                                    />
                                </div>
                            </div>
                            <div className="flex items-center gap-3">
                                <button
                                    type="button"
                                    onClick={() => setForm({ ...form, signup_enabled: !form.signup_enabled })}
                                    className={[
                                        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                                        form.signup_enabled
                                            ? 'bg-emerald-500'
                                            : isDark
                                              ? 'bg-slate-600'
                                              : 'bg-slate-300',
                                    ].join(' ')}
                                    aria-pressed={form.signup_enabled}
                                >
                                    <span
                                        className={[
                                            'inline-block h-4 w-4 rounded-full bg-white transition-transform',
                                            form.signup_enabled ? 'translate-x-6' : 'translate-x-1',
                                        ].join(' ')}
                                    />
                                </button>
                                <span className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                    {t.fieldSignup}
                                </span>
                            </div>
                        </div>
                        <div className="mt-6 flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => setModalOpen(false)}
                                className={[
                                    'rounded-lg px-4 py-2 text-sm font-medium',
                                    isDark ? 'text-slate-400 hover:bg-slate-700' : 'text-slate-600 hover:bg-slate-100',
                                ].join(' ')}
                            >
                                {t.cancel}
                            </button>
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={saving || !form.brand_name.trim() || (!editing && !form.slug.trim())}
                                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {saving ? t.saving : t.save}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </PayPageLayout>
    );
}

function Fallback() {
    const searchParams = useSearchParams();
    const locale = resolveLocale(searchParams.get('lang'));
    return (
        <div className="flex min-h-screen items-center justify-center">
            <div className="text-slate-500">{locale === 'en' ? 'Loading...' : '加载中...'}</div>
        </div>
    );
}

export default function TenantsPage() {
    return (
        <Suspense fallback={<Fallback />}>
            <TenantsContent />
        </Suspense>
    );
}
