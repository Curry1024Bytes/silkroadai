'use client';

import { useSearchParams } from 'next/navigation';
import { useState, useEffect, useCallback, Suspense } from 'react';
import PayPageLayout from '@/components/PayPageLayout';
import NewApiSyncDialog from '@/components/admin/NewApiSyncDialog';
import PaginationBar from '@/components/PaginationBar';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { resolveLocale, type Locale } from '@/lib/locale';

// ── Types ──

type Modality = 'chat' | 'image' | 'embedding';

interface UpstreamEntry {
    channel_id: number;
    upstream_model: string;
}

interface CatalogModel {
    id: string;
    tenant_id: string | null;
    slug: string;
    display_name: string;
    vendor: string;
    modality: Modality;
    context_window: number | null;
    enabled: boolean;
    sort_order: number;
    upstream_map: Record<string, UpstreamEntry>;
    created_at: string;
    updated_at: string;
}

interface RoutingLabels {
    tiers: Record<string, Record<string, { display_name: string }>>;
    channels: Record<string, { name: string | null }>;
}

interface ModelsResponse {
    models: CatalogModel[];
    total: number;
    page: number;
    page_size: number;
    total_pages: number;
    labels?: RoutingLabels;
}

interface ModelPublishChange {
    slug: string;
}

interface ModelPublishPreview {
    preview_token: string;
    channels: Array<{ id: number; name: string | null; changes: ModelPublishChange[] }>;
    blocked: Array<{ code: string }> | null;
}

interface ModelFormData {
    slug: string;
    display_name: string;
    vendor: string;
    modality: Modality;
    context_window: string;
    sort_order: string;
    enabled: boolean;
    upstream_map: string;
}

const MODALITIES: Modality[] = ['chat', 'image', 'embedding'];

const DEFAULT_UPSTREAM_MAP = '{}';

// ── i18n ──

function getTexts(locale: Locale) {
    return locale === 'en'
        ? {
              sessionExpired: 'Your session has expired. Please sign in again.',
              title: 'Model Management',
              subtitle: 'Model catalog — Portal manages models; new-api handles channel weights and priority',
              refresh: 'Refresh',
              publish: 'Sync to new-api',
              publishing: 'Syncing...',
              publishPreviewTitle: 'Sync models to new-api',
              publishPreviewHint:
                  'Enabled Portal models will be synced to their registered channels. new-api continues to apply channel weights and priority.',
              publishSummary: (models: number, channels: number) => `Sync ${models} model(s) to ${channels} channel(s)`,
              confirmPublish: 'Confirm sync',
              publishNoChanges: 'The Portal catalog already matches new-api.',
              publishBlocked: 'Sync is blocked by the current model or channel configuration.',
              publishBlockedHint: 'Check the enabled tier, registered channels, and upstream mapping.',
              publishSuccess: 'Model catalog synced to new-api.',
              publishFailed: 'Model catalog sync failed',
              importCatalog: 'Import from new-api',
              loading: 'Loading...',
              newModel: '+ New Model',
              editModel: 'Edit Model',
              noModels: 'No models found',
              noModelsHint: 'Click "+ New Model" to add one to the catalog.',
              noFilteredModels: 'No models match the current filters.',
              noFilteredModelsHint: 'Adjust the filters or click Clear.',
              searchPlaceholder: 'Search name or slug…',
              vendorPlaceholder: 'Vendor…',
              allModalities: 'All types',
              allStatuses: 'All statuses',
              enabledStatus: 'Enabled',
              disabledStatus: 'Disabled',
              search: 'Search',
              clear: 'Clear',
              colName: 'Name',
              colVendor: 'Vendor',
              colModality: 'Type',
              colUpstream: 'Upstream Mapping',
              colSortOrder: 'Sort',
              colEnabled: 'Enabled',
              colActions: 'Actions',
              edit: 'Edit',
              delete: 'Delete',
              deleteConfirm: (slug: string) => `Are you sure you want to delete the model "${slug}"?`,
              fieldSlug: 'Slug',
              fieldSlugHint: 'Unique identifier, cannot be changed after creation.',
              fieldDisplayName: 'Display Name',
              fieldVendor: 'Vendor',
              fieldModality: 'Type',
              fieldContextWindow: 'Context Window',
              fieldContextWindowHint: 'Optional, in tokens.',
              fieldSortOrder: 'Sort Order',
              fieldEnabled: 'Enabled',
              fieldUpstreamMap: 'Upstream Map (JSON)',
              fieldUpstreamMapHint:
                  'JSON object keyed by an enabled Portal tier (e.g. "sale-tier"); each channel_id must be registered only to that tier.',
              cancel: 'Cancel',
              save: 'Save',
              saving: 'Saving...',
              loadFailed: 'Failed to load models',
              saveFailed: 'Failed to save model',
              deleteFailed: 'Failed to delete model',
              invalidJson: 'Upstream Map must be valid JSON',
              none: 'None',
          }
        : {
              sessionExpired: '登录已过期,请重新登录',
              title: '模型管理',
              subtitle: '模型目录 — Portal 管模型，new-api 按渠道权重和优先级路由',
              refresh: '刷新',
              publish: '同步到 new-api',
              publishing: '同步中...',
              publishPreviewTitle: '同步模型到 new-api',
              publishPreviewHint: '启用的 Portal 模型会同步到所属渠道，渠道权重和优先级继续由 new-api 处理。',
              publishSummary: (models: number, channels: number) => `将同步 ${models} 个模型到 ${channels} 个渠道`,
              confirmPublish: '确认同步',
              publishNoChanges: 'Portal 模型目录与 new-api 已一致。',
              publishBlocked: '当前模型或渠道配置有问题，暂不能同步。',
              publishBlockedHint: '请检查启用档次、登记渠道和上游映射。',
              publishSuccess: '模型目录已同步到 new-api。',
              publishFailed: '模型目录同步失败',
              importCatalog: '从 new-api 导入',
              loading: '加载中...',
              newModel: '+ 新建模型',
              editModel: '编辑模型',
              noModels: '暂无模型',
              noModelsHint: '点击「+ 新建模型」添加到模型目录。',
              noFilteredModels: '没有符合当前查询条件的模型。',
              noFilteredModelsHint: '调整查询条件，或点击「清除」。',
              searchPlaceholder: '搜索名称或 Slug…',
              vendorPlaceholder: '厂商…',
              allModalities: '全部类型',
              allStatuses: '全部状态',
              enabledStatus: '启用',
              disabledStatus: '停用',
              search: '查询',
              clear: '清除',
              colName: '名称',
              colVendor: '厂商',
              colModality: '类型',
              colUpstream: '上游映射',
              colSortOrder: '排序',
              colEnabled: '启用',
              colActions: '操作',
              edit: '编辑',
              delete: '删除',
              deleteConfirm: (slug: string) => `确定要删除模型「${slug}」吗？`,
              fieldSlug: 'Slug',
              fieldSlugHint: '唯一标识,创建后不可修改。',
              fieldDisplayName: '显示名称',
              fieldVendor: '厂商',
              fieldModality: '类型',
              fieldContextWindow: '上下文窗口',
              fieldContextWindowHint: '可选,单位 token。',
              fieldSortOrder: '排序',
              fieldEnabled: '启用',
              fieldUpstreamMap: '上游映射(JSON)',
              fieldUpstreamMapHint: '按档次填写上游模型；同步时会写入该档次的全部渠道，由 new-api 按权重和优先级选择。',
              cancel: '取消',
              save: '保存',
              saving: '保存中...',
              loadFailed: '加载模型列表失败',
              saveFailed: '保存模型失败',
              deleteFailed: '删除模型失败',
              invalidJson: '上游映射必须是合法的 JSON',
              none: '无',
          };
}

// ── Helpers ──

/** Human-readable one-line summary of upstream_map with tier/channel labels. */
function summarizeUpstreamMap(
    map: Record<string, UpstreamEntry>,
    tenantId: string | null,
    labels: RoutingLabels,
    locale: Locale,
): string {
    const entries = Object.entries(map ?? {});
    if (entries.length === 0) return '';
    return entries
        .map(([route, entry]) => {
            const tier = labels.tiers[tenantId ?? PLATFORM_TENANT_ID]?.[route];
            const channel = labels.channels[String(entry.channel_id)];
            const tierName = tier?.display_name?.trim() || route;
            const tierText =
                tierName === route ? route : locale === 'en' ? `${tierName} (${route})` : `${tierName}（${route}）`;
            const channelText = channel?.name?.trim()
                ? locale === 'en'
                    ? `${channel.name.trim()} (#${entry.channel_id})`
                    : `${channel.name.trim()}（#${entry.channel_id}）`
                : locale === 'en'
                  ? `Channel #${entry.channel_id}`
                  : `渠道 #${entry.channel_id}`;
            if (locale === 'en') {
                return `Tier: ${tierText} · Channel: ${channelText} · Upstream model: ${entry.upstream_model}`;
            }
            return `档次：${tierText} · 渠道：${channelText} · 上游模型：${entry.upstream_model}`;
        })
        .join('  ·  ');
}

const emptyForm: ModelFormData = {
    slug: '',
    display_name: '',
    vendor: '',
    modality: 'chat',
    context_window: '',
    sort_order: '0',
    enabled: false,
    upstream_map: DEFAULT_UPSTREAM_MAP,
};

// ── Main Content ──

function ModelsContent() {
    const searchParams = useSearchParams();
    const theme = searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    const uiMode = searchParams.get('ui_mode') || 'standalone';
    const locale = resolveLocale(searchParams.get('lang'));
    const isDark = theme === 'dark';
    const isEmbedded = uiMode === 'embedded';
    const t = getTexts(locale);

    const [models, setModels] = useState<CatalogModel[]>([]);
    const [routingLabels, setRoutingLabels] = useState<RoutingLabels>({ tiers: {}, channels: {} });
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [totalPages, setTotalPages] = useState(1);
    const [queryInput, setQueryInput] = useState('');
    const [vendorInput, setVendorInput] = useState('');
    const [modalityInput, setModalityInput] = useState('');
    const [enabledInput, setEnabledInput] = useState('');
    const [query, setQuery] = useState('');
    const [vendor, setVendor] = useState('');
    const [modality, setModality] = useState('');
    const [enabled, setEnabled] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    // Edit / create modal state
    const [editModalOpen, setEditModalOpen] = useState(false);
    const [editingModel, setEditingModel] = useState<CatalogModel | null>(null);
    const [form, setForm] = useState<ModelFormData>(emptyForm);
    const [saving, setSaving] = useState(false);

    const [syncOpen, setSyncOpen] = useState(false);
    const [publishPreview, setPublishPreview] = useState<ModelPublishPreview | null>(null);
    const [publishLoading, setPublishLoading] = useState(false);
    const [publishApplying, setPublishApplying] = useState(false);
    const [publishError, setPublishError] = useState('');
    const [notice, setNotice] = useState('');

    // ── Fetch models ──

    const fetchModels = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
            if (query) params.set('q', query);
            if (vendor) params.set('vendor', vendor);
            if (modality) params.set('modality', modality);
            if (enabled) params.set('enabled', enabled);

            const res = await fetch(`/api/admin/models?${params.toString()}`);
            if (!res.ok) {
                if (res.status === 401) {
                    setError(
                        locale === 'en' ? 'Your session has expired. Please sign in again.' : '登录已过期,请重新登录',
                    );
                    return;
                }
                const data = await res.json().catch(() => ({}));
                setError(data.error || (locale === 'en' ? 'Failed to load models' : '加载模型列表失败'));
                return;
            }
            const data = (await res.json()) as Partial<ModelsResponse>;
            setModels(data.models ?? []);
            setRoutingLabels(data.labels ?? { tiers: {}, channels: {} });
            setTotal(Number(data.total) || 0);
            setTotalPages(Math.max(1, Number(data.total_pages) || 1));
        } catch {
            setError(locale === 'en' ? 'Failed to load models' : '加载模型列表失败');
        } finally {
            setLoading(false);
        }
    }, [enabled, locale, modality, page, pageSize, query, vendor]);

    useEffect(() => {
        fetchModels();
    }, [fetchModels]);

    const submitSearch = (event: React.FormEvent) => {
        event.preventDefault();
        setPage(1);
        setQuery(queryInput.trim());
        setVendor(vendorInput.trim());
        setModality(modalityInput);
        setEnabled(enabledInput);
    };

    const clearSearch = () => {
        setQueryInput('');
        setVendorInput('');
        setModalityInput('');
        setEnabledInput('');
        setPage(1);
        setQuery('');
        setVendor('');
        setModality('');
        setEnabled('');
    };

    const hasFilters = Boolean(query || vendor || modality || enabled);

    // ── Modal handlers ──

    const openCreateModal = () => {
        setEditingModel(null);
        setForm(emptyForm);
        setEditModalOpen(true);
    };

    const openEditModal = (model: CatalogModel) => {
        setEditingModel(model);
        setForm({
            slug: model.slug,
            display_name: model.display_name,
            vendor: model.vendor,
            modality: model.modality,
            context_window: model.context_window != null ? String(model.context_window) : '',
            sort_order: String(model.sort_order),
            enabled: model.enabled,
            upstream_map: JSON.stringify(model.upstream_map ?? {}, null, 2),
        });
        setEditModalOpen(true);
    };

    const closeEditModal = () => {
        setEditModalOpen(false);
        setEditingModel(null);
    };

    const handleSave = async () => {
        if (!form.display_name.trim() || !form.vendor.trim()) return;
        if (!editingModel && !form.slug.trim()) return;

        // Parse upstream_map JSON with a friendly error
        let upstreamMap: unknown;
        try {
            upstreamMap = JSON.parse(form.upstream_map);
        } catch {
            setError(t.invalidJson);
            return;
        }

        setSaving(true);
        setError('');

        const ctx = form.context_window.trim();
        const body: Record<string, unknown> = {
            display_name: form.display_name.trim(),
            vendor: form.vendor.trim(),
            modality: form.modality,
            context_window: ctx === '' ? null : parseInt(ctx, 10),
            sort_order: parseInt(form.sort_order, 10) || 0,
            enabled: form.enabled,
            upstream_map: upstreamMap,
        };
        // slug only on create (not editable on PUT)
        if (!editingModel) {
            body.slug = form.slug.trim();
        }

        try {
            const url = editingModel ? `/api/admin/models/${editingModel.id}` : '/api/admin/models';
            const method = editingModel ? 'PUT' : 'POST';

            const res = await fetch(url, {
                method,
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                if (res.status === 401) {
                    setError(t.sessionExpired);
                    return;
                }
                const data = await res.json().catch(() => ({}));
                setError(data.message || data.error || t.saveFailed);
                return;
            }

            closeEditModal();
            fetchModels();
        } catch {
            setError(t.saveFailed);
        } finally {
            setSaving(false);
        }
    };

    // ── Delete handler ──

    const handleDelete = async (model: CatalogModel) => {
        if (!confirm(t.deleteConfirm(model.slug))) return;
        setError('');
        setNotice('');
        try {
            const res = await fetch(`/api/admin/models/${model.id}`, {
                method: 'DELETE',
                credentials: 'same-origin',
            });
            if (!res.ok) {
                if (res.status === 401) {
                    setError(t.sessionExpired);
                    return;
                }
                const data = await res.json().catch(() => ({}));
                setError(data.message || data.error || t.deleteFailed);
                return;
            }
            fetchModels();
        } catch {
            setError(t.deleteFailed);
        }
    };

    // ── Toggle enabled ──

    const handleToggleEnabled = async (model: CatalogModel) => {
        setError('');
        try {
            const res = await fetch(`/api/admin/models/${model.id}`, {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: !model.enabled }),
            });
            if (!res.ok) {
                if (res.status === 401) {
                    setError(t.sessionExpired);
                    return;
                }
                const data = await res.json().catch(() => ({}));
                setError(data.message || data.error || t.saveFailed);
                return;
            }
            fetchModels();
        } catch {
            setError(t.saveFailed);
        }
    };

    const previewPublish = async () => {
        setPublishLoading(true);
        setError('');
        setPublishError('');
        setNotice('');
        try {
            const res = await fetch('/api/admin/model-publish', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            const data = (await res.json().catch(() => ({}))) as {
                preview?: ModelPublishPreview;
                message?: string;
                error?: string;
            };
            if (!res.ok || !data.preview) {
                setError(data.message || data.error || t.publishFailed);
                return;
            }
            setPublishPreview(data.preview);
        } catch {
            setError(t.publishFailed);
        } finally {
            setPublishLoading(false);
        }
    };

    const applyPublish = async () => {
        if (!publishPreview || publishPreview.blocked || publishPreview.channels.length === 0) return;
        setPublishApplying(true);
        setPublishError('');
        try {
            const res = await fetch('/api/admin/model-publish?dryRun=false', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ preview_token: publishPreview.preview_token }),
            });
            const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
            if (!res.ok) {
                setPublishError(data.message || data.error || t.publishFailed);
                return;
            }
            setPublishPreview(null);
            setError('');
            setNotice(t.publishSuccess);
            await fetchModels();
        } catch {
            setPublishError(t.publishFailed);
        } finally {
            setPublishApplying(false);
        }
    };

    // ── Shared styles ──

    const btnBase = [
        'inline-flex items-center rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
        isDark
            ? 'border-slate-600 text-slate-200 hover:bg-slate-800'
            : 'border-slate-300 text-slate-700 hover:bg-slate-100',
    ].join(' ');

    const inputCls = [
        'w-full rounded-lg border px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/50',
        isDark
            ? 'border-slate-600 bg-slate-700 text-slate-100 placeholder-slate-400'
            : 'border-slate-300 bg-white text-slate-900 placeholder-slate-400',
    ].join(' ');

    const readonlyInputCls = [
        'w-full rounded-lg border px-3 py-2 text-sm cursor-not-allowed',
        isDark ? 'border-slate-700 bg-slate-800 text-slate-400' : 'border-slate-200 bg-slate-100 text-slate-500',
    ].join(' ');

    const labelCls = ['block text-sm font-medium mb-1', isDark ? 'text-slate-300' : 'text-slate-700'].join(' ');

    // ── Render ──

    return (
        <PayPageLayout
            isDark={isDark}
            isEmbedded={isEmbedded}
            maxWidth="full"
            title={t.title}
            subtitle={t.subtitle}
            locale={locale}
            actions={
                <button type="button" onClick={fetchModels} className={btnBase}>
                    {t.refresh}
                </button>
            }
        >
            {/* Error banner */}
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
            {notice && (
                <div
                    className={`mb-4 rounded-lg border p-3 text-sm ${isDark ? 'border-emerald-800 bg-emerald-950/50 text-emerald-300' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}
                >
                    {notice}
                    <button onClick={() => setNotice('')} className="ml-2 opacity-60 hover:opacity-100" type="button">
                        ✕
                    </button>
                </div>
            )}

            {/* Query conditions and action buttons */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <form onSubmit={submitSearch} className="flex flex-wrap items-center gap-2">
                    <input
                        type="text"
                        value={queryInput}
                        onChange={(event) => setQueryInput(event.target.value)}
                        placeholder={t.searchPlaceholder}
                        className={[
                            'rounded-lg border px-3 py-1.5 text-xs',
                            isDark
                                ? 'border-slate-600 bg-slate-800 text-slate-200 placeholder:text-slate-500'
                                : 'border-slate-300 bg-white text-slate-800 placeholder:text-slate-400',
                        ].join(' ')}
                    />
                    <input
                        type="text"
                        value={vendorInput}
                        onChange={(event) => setVendorInput(event.target.value)}
                        placeholder={t.vendorPlaceholder}
                        className={[
                            'w-28 rounded-lg border px-3 py-1.5 text-xs',
                            isDark
                                ? 'border-slate-600 bg-slate-800 text-slate-200 placeholder:text-slate-500'
                                : 'border-slate-300 bg-white text-slate-800 placeholder:text-slate-400',
                        ].join(' ')}
                    />
                    <select
                        value={modalityInput}
                        onChange={(event) => setModalityInput(event.target.value)}
                        className={[
                            'rounded-lg border px-3 py-1.5 text-xs',
                            isDark
                                ? 'border-slate-600 bg-slate-800 text-slate-200'
                                : 'border-slate-300 bg-white text-slate-800',
                        ].join(' ')}
                    >
                        <option value="">{t.allModalities}</option>
                        {MODALITIES.map((item) => (
                            <option key={item} value={item}>
                                {item}
                            </option>
                        ))}
                    </select>
                    <select
                        value={enabledInput}
                        onChange={(event) => setEnabledInput(event.target.value)}
                        className={[
                            'rounded-lg border px-3 py-1.5 text-xs',
                            isDark
                                ? 'border-slate-600 bg-slate-800 text-slate-200'
                                : 'border-slate-300 bg-white text-slate-800',
                        ].join(' ')}
                    >
                        <option value="">{t.allStatuses}</option>
                        <option value="true">{t.enabledStatus}</option>
                        <option value="false">{t.disabledStatus}</option>
                    </select>
                    <button
                        type="submit"
                        className="rounded-lg border border-emerald-500 bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-600"
                    >
                        {t.search}
                    </button>
                    {hasFilters && (
                        <button type="button" onClick={clearSearch} className={btnBase}>
                            {t.clear}
                        </button>
                    )}
                </form>

                <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setSyncOpen(true)} className={btnBase}>
                        {t.importCatalog}
                    </button>
                    <button
                        type="button"
                        onClick={previewPublish}
                        disabled={publishLoading}
                        className="inline-flex items-center rounded-lg border border-indigo-500 bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {publishLoading ? t.publishing : t.publish}
                    </button>
                    <button
                        type="button"
                        onClick={openCreateModal}
                        className="inline-flex items-center rounded-lg border border-emerald-500 bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-600"
                    >
                        {t.newModel}
                    </button>
                </div>
            </div>

            {/* Model table */}
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
                ) : models.length === 0 ? (
                    <div className={`py-12 text-center ${isDark ? 'text-slate-400' : 'text-gray-500'}`}>
                        <p className="text-base font-medium">{hasFilters ? t.noFilteredModels : t.noModels}</p>
                        <p className="mt-1 text-sm opacity-70">
                            {hasFilters ? t.noFilteredModelsHint : t.noModelsHint}
                        </p>
                    </div>
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
                                <th className="px-4 py-3 text-left font-medium">{t.colName}</th>
                                <th className="px-4 py-3 text-left font-medium">{t.colVendor}</th>
                                <th className="px-4 py-3 text-left font-medium">{t.colModality}</th>
                                <th className="px-4 py-3 text-left font-medium">{t.colUpstream}</th>
                                <th className="px-4 py-3 text-center font-medium">{t.colSortOrder}</th>
                                <th className="px-4 py-3 text-center font-medium">{t.colEnabled}</th>
                                <th className="px-4 py-3 text-right font-medium">{t.colActions}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {models.map((model) => {
                                const upstreamSummary = summarizeUpstreamMap(
                                    model.upstream_map,
                                    model.tenant_id,
                                    routingLabels,
                                    locale,
                                );
                                return (
                                    <tr
                                        key={model.id}
                                        className={[
                                            'border-b transition-colors',
                                            isDark
                                                ? 'border-slate-700/50 hover:bg-slate-700/30'
                                                : 'border-slate-100 hover:bg-slate-50',
                                        ].join(' ')}
                                    >
                                        <td
                                            className={`px-4 py-3 font-medium ${isDark ? 'text-slate-100' : 'text-slate-900'}`}
                                        >
                                            <div>{model.display_name}</div>
                                            <div
                                                className={`font-mono text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}
                                            >
                                                {model.slug}
                                            </div>
                                        </td>
                                        <td className={`px-4 py-3 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                            {model.vendor}
                                        </td>
                                        <td className="px-4 py-3">
                                            <span
                                                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${isDark ? 'bg-slate-700 text-slate-300' : 'bg-slate-100 text-slate-600'}`}
                                            >
                                                {model.modality}
                                            </span>
                                        </td>
                                        <td
                                            className={`px-4 py-3 font-mono text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
                                        >
                                            {upstreamSummary || (
                                                <span className={isDark ? 'text-slate-600' : 'text-slate-300'}>
                                                    {t.none}
                                                </span>
                                            )}
                                        </td>
                                        <td
                                            className={`px-4 py-3 text-center ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
                                        >
                                            {model.sort_order}
                                        </td>
                                        <td className="px-4 py-3 text-center">
                                            <button
                                                type="button"
                                                onClick={() => handleToggleEnabled(model)}
                                                className={[
                                                    'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
                                                    model.enabled
                                                        ? 'bg-emerald-500'
                                                        : isDark
                                                          ? 'bg-slate-600'
                                                          : 'bg-slate-300',
                                                ].join(' ')}
                                                aria-pressed={model.enabled}
                                            >
                                                <span
                                                    className={[
                                                        'inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform',
                                                        model.enabled ? 'translate-x-4.5' : 'translate-x-0.5',
                                                    ].join(' ')}
                                                />
                                            </button>
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                            <div className="inline-flex gap-1">
                                                <button
                                                    type="button"
                                                    onClick={() => openEditModal(model)}
                                                    className={[
                                                        'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                                                        isDark
                                                            ? 'text-indigo-400 hover:bg-indigo-500/20'
                                                            : 'text-indigo-600 hover:bg-indigo-50',
                                                    ].join(' ')}
                                                >
                                                    {t.edit}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleDelete(model)}
                                                    className={[
                                                        'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                                                        isDark
                                                            ? 'text-red-400 hover:bg-red-500/20'
                                                            : 'text-red-600 hover:bg-red-50',
                                                    ].join(' ')}
                                                >
                                                    {t.delete}
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>

            {!loading && total > 0 && (
                <PaginationBar
                    page={page}
                    totalPages={totalPages}
                    total={total}
                    pageSize={pageSize}
                    loading={loading}
                    onPageChange={setPage}
                    onPageSizeChange={(size) => {
                        setPageSize(size);
                        setPage(1);
                    }}
                    locale={locale}
                    isDark={isDark}
                />
            )}

            {publishPreview && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
                    <section
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="model-publish-title"
                        className={`w-full max-w-2xl overflow-y-auto rounded-2xl border p-6 shadow-2xl ${isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-white'}`}
                        style={{ maxHeight: '90vh' }}
                    >
                        <h2
                            id="model-publish-title"
                            className={`text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}
                        >
                            {t.publishPreviewTitle}
                        </h2>
                        <p className={`mt-2 text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                            {t.publishPreviewHint}
                        </p>

                        {publishError && (
                            <div
                                role="alert"
                                className={`mt-4 rounded-lg border p-3 text-sm ${isDark ? 'border-red-800 bg-red-950/50 text-red-300' : 'border-red-200 bg-red-50 text-red-700'}`}
                            >
                                {publishError}
                            </div>
                        )}

                        {publishPreview.blocked && publishPreview.blocked.length > 0 ? (
                            <div
                                className={`mt-5 rounded-xl border p-4 ${isDark ? 'border-amber-700 bg-amber-950/30' : 'border-amber-200 bg-amber-50'}`}
                            >
                                <p
                                    className={`mb-2 text-sm font-semibold ${isDark ? 'text-amber-300' : 'text-amber-800'}`}
                                >
                                    {t.publishBlocked}
                                </p>
                                <p className={`text-sm ${isDark ? 'text-amber-200' : 'text-amber-900'}`}>
                                    {t.publishBlockedHint}
                                </p>
                            </div>
                        ) : publishPreview.channels.length === 0 ? (
                            <div
                                className={`mt-5 rounded-xl border p-4 text-sm ${isDark ? 'border-slate-700 bg-slate-900/40 text-slate-300' : 'border-slate-200 bg-slate-50 text-slate-700'}`}
                            >
                                {t.publishNoChanges}
                            </div>
                        ) : (
                            <div
                                className={`mt-5 rounded-xl border p-4 text-sm ${isDark ? 'border-slate-700 bg-slate-900/40 text-slate-200' : 'border-slate-200 bg-slate-50 text-slate-700'}`}
                            >
                                {t.publishSummary(
                                    new Set(
                                        publishPreview.channels.flatMap((channel) =>
                                            channel.changes.map((change) => change.slug),
                                        ),
                                    ).size,
                                    publishPreview.channels.length,
                                )}
                            </div>
                        )}

                        <div className="mt-6 flex flex-wrap justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => setPublishPreview(null)}
                                disabled={publishApplying}
                                className={`rounded-lg px-4 py-2 text-sm font-medium ${isDark ? 'text-slate-300 hover:bg-slate-700' : 'text-slate-600 hover:bg-slate-100'} disabled:opacity-50`}
                            >
                                {t.cancel}
                            </button>
                            <button
                                type="button"
                                onClick={applyPublish}
                                disabled={
                                    publishApplying ||
                                    publishLoading ||
                                    !!publishPreview.blocked ||
                                    publishPreview.channels.length === 0
                                }
                                className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {publishApplying ? t.publishing : t.confirmPublish}
                            </button>
                        </div>
                    </section>
                </div>
            )}

            {/* ── Edit / Create Modal ── */}
            {editModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div
                        className={[
                            'relative w-full max-w-lg overflow-y-auto rounded-2xl border p-6 shadow-2xl',
                            isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-white',
                        ].join(' ')}
                        style={{ maxHeight: '90vh' }}
                    >
                        <h2 className={`mb-5 text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                            {editingModel ? t.editModel : t.newModel}
                        </h2>

                        <div className="space-y-4">
                            {/* Slug */}
                            <div>
                                <label className={labelCls}>{t.fieldSlug}</label>
                                <input
                                    type="text"
                                    value={form.slug}
                                    onChange={(e) => setForm({ ...form, slug: e.target.value })}
                                    className={editingModel ? readonlyInputCls : [inputCls, 'font-mono'].join(' ')}
                                    readOnly={!!editingModel}
                                    placeholder="gpt-5.4"
                                    required={!editingModel}
                                />
                                <p className={`mt-1 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                    {t.fieldSlugHint}
                                </p>
                            </div>

                            {/* Display Name */}
                            <div>
                                <label className={labelCls}>{t.fieldDisplayName}</label>
                                <input
                                    type="text"
                                    value={form.display_name}
                                    onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                                    className={inputCls}
                                    required
                                />
                            </div>

                            {/* Vendor */}
                            <div>
                                <label className={labelCls}>{t.fieldVendor}</label>
                                <input
                                    type="text"
                                    value={form.vendor}
                                    onChange={(e) => setForm({ ...form, vendor: e.target.value })}
                                    className={inputCls}
                                    placeholder="openai"
                                    required
                                />
                            </div>

                            {/* Modality */}
                            <div>
                                <label className={labelCls}>{t.fieldModality}</label>
                                <select
                                    value={form.modality}
                                    onChange={(e) => setForm({ ...form, modality: e.target.value as Modality })}
                                    className={inputCls}
                                >
                                    {MODALITIES.map((m) => (
                                        <option key={m} value={m}>
                                            {m}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {/* Context Window */}
                            <div>
                                <label className={labelCls}>{t.fieldContextWindow}</label>
                                <input
                                    type="number"
                                    min="0"
                                    value={form.context_window}
                                    onChange={(e) => setForm({ ...form, context_window: e.target.value })}
                                    className={inputCls}
                                    placeholder={locale === 'en' ? 'Optional' : '可选'}
                                />
                                <p className={`mt-1 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                    {t.fieldContextWindowHint}
                                </p>
                            </div>

                            {/* Sort Order */}
                            <div>
                                <label className={labelCls}>{t.fieldSortOrder}</label>
                                <input
                                    type="number"
                                    value={form.sort_order}
                                    onChange={(e) => setForm({ ...form, sort_order: e.target.value })}
                                    className={inputCls}
                                />
                            </div>

                            {/* Upstream Map (JSON) */}
                            <div>
                                <label className={labelCls}>{t.fieldUpstreamMap}</label>
                                <textarea
                                    value={form.upstream_map}
                                    onChange={(e) => setForm({ ...form, upstream_map: e.target.value })}
                                    rows={6}
                                    className={[inputCls, 'font-mono text-xs'].join(' ')}
                                    spellCheck={false}
                                />
                                <p className={`mt-1 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                    {t.fieldUpstreamMapHint}
                                </p>
                            </div>

                            {/* Enabled */}
                            <div className="flex items-center gap-3">
                                <button
                                    type="button"
                                    onClick={() => setForm({ ...form, enabled: !form.enabled })}
                                    className={[
                                        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                                        form.enabled ? 'bg-emerald-500' : isDark ? 'bg-slate-600' : 'bg-slate-300',
                                    ].join(' ')}
                                    aria-pressed={form.enabled}
                                >
                                    <span
                                        className={[
                                            'inline-block h-4 w-4 rounded-full bg-white transition-transform',
                                            form.enabled ? 'translate-x-6' : 'translate-x-1',
                                        ].join(' ')}
                                    />
                                </button>
                                <span className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                    {t.fieldEnabled}
                                </span>
                            </div>
                        </div>

                        {/* Actions */}
                        <div className="mt-6 flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={closeEditModal}
                                className={[
                                    'rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                                    isDark ? 'text-slate-400 hover:bg-slate-700' : 'text-slate-600 hover:bg-slate-100',
                                ].join(' ')}
                            >
                                {t.cancel}
                            </button>
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={
                                    saving ||
                                    !form.display_name.trim() ||
                                    !form.vendor.trim() ||
                                    (!editingModel && !form.slug.trim())
                                }
                                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {saving ? t.saving : t.save}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {syncOpen && (
                <NewApiSyncDialog
                    locale={locale}
                    isDark={isDark}
                    onClose={() => setSyncOpen(false)}
                    onComplete={() => void fetchModels()}
                />
            )}
        </PayPageLayout>
    );
}

function ModelsPageFallback() {
    const searchParams = useSearchParams();
    const locale = resolveLocale(searchParams.get('lang'));

    return (
        <div className="flex min-h-screen items-center justify-center">
            <div className="text-slate-500">{locale === 'en' ? 'Loading...' : '加载中...'}</div>
        </div>
    );
}

export default function ModelsPage() {
    return (
        <Suspense fallback={<ModelsPageFallback />}>
            <ModelsContent />
        </Suspense>
    );
}
