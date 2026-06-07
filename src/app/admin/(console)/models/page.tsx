'use client';

import { useSearchParams } from 'next/navigation';
import { useState, useEffect, useCallback, Suspense } from 'react';
import PayPageLayout from '@/components/PayPageLayout';
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

// ── 「从 new-api 导入」预览/结果(对应 /api/admin/models/import 响应;P2.6 档次感知)──

interface ImportChannelMenuItem {
    id: number;
    name: string | null;
    type: number | null;
    model_count: number;
    selected: boolean;
    tier: string; // 该渠道会喂哪个档(pool / official)
}

interface ImportCreatedRow {
    slug: string;
    display_name: string;
    vendor: string;
    modality: string;
    tier: string;
    input_cny_per_1m: number | null;
    output_cny_per_1m: number | null;
    ratio_defaulted: boolean;
}

interface ImportFlaggedRow {
    slug: string;
    display_name: string;
    vendor: string;
    modality: string;
    tier: string;
    reason: string;
}

interface ImportPreview {
    dryRun: boolean;
    selectedChannelIds: number[];
    officialRegistered: boolean; // false → 未登记官方渠道,全部进 pool 档
    channels: ImportChannelMenuItem[];
    channelErrors: { channel_id: number; error: string }[];
    created: ImportCreatedRow[];
    skipped: { slug: string; tier: string; reason: string }[];
    flagged: ImportFlaggedRow[];
    summary: { created: number; skipped: number; flagged: number };
}

const MODALITIES: Modality[] = ['chat', 'image', 'embedding'];

const DEFAULT_UPSTREAM_MAP = '{\n  "default": {\n    "channel_id": 3,\n    "upstream_model": "gpt-5.4"\n  }\n}';

// 旗舰渠道默认集(与 import 端点的 DEFAULT_FLAGSHIP_CHANNEL_IDS 一致):
// Claude(2)/ ChatGPT(3)/ Gemini 图片(17)。Gemini 文本渠道 id 未固定,operator 在渠道菜单勾选。
const DEFAULT_IMPORT_CHANNEL_IDS = [2, 3, 17];

// ── i18n ──

function getTexts(locale: Locale) {
    return locale === 'en'
        ? {
              sessionExpired: 'Your session has expired. Please sign in again.',
              title: 'Model Management',
              subtitle: 'Model catalog — slug / vendor / upstream mapping',
              refresh: 'Refresh',
              loading: 'Loading...',
              newModel: '+ New Model',
              editModel: 'Edit Model',
              noModels: 'No models found',
              noModelsHint: 'Click "+ New Model" to add one to the catalog.',
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
                  'JSON object keyed by route (e.g. "default"), each value { "channel_id": number, "upstream_model": string }.',
              cancel: 'Cancel',
              save: 'Save',
              saving: 'Saving...',
              loadFailed: 'Failed to load models',
              saveFailed: 'Failed to save model',
              deleteFailed: 'Failed to delete model',
              invalidJson: 'Upstream Map must be valid JSON',
              none: 'None',
              // ── P2.5 import from new-api ──
              importBtn: 'Import from new-api',
              importTitle: 'Import models from new-api',
              importIntro:
                  'Reads model lists + current prices from the selected flagship channels and creates catalog entries. Already-existing models are skipped; image models are created without a price (set it on the Pricing page).',
              importChannels: 'Channels to import from',
              importSelectHint:
                  "Defaults to Claude (2) / ChatGPT (3) / Gemini image (17). The Gemini text channel id isn't fixed — tick it below if present.",
              importColModels: 'models',
              importPreviewing: 'Loading preview…',
              importRefresh: 'Re-preview',
              importWillCreate: 'Will create',
              importNeedsPrice: 'Needs manual price',
              importSkippedExists: 'Skipped (price already exists)',
              importColTier: 'Tier',
              importColIn: '¥ in / 1M',
              importColOut: '¥ out / 1M',
              importColReason: 'Note',
              importImageReason: 'Image model — set per-image price on the Pricing page',
              importNoRatioReason: 'No model_ratio in channel — set price manually',
              importRatioDefaulted: 'completion_ratio defaulted to 1 (in = out)',
              importOfficialNotRegistered:
                  'No official channels registered under /admin/channel-groups — everything imports as the pool tier. To capture official prices, register the official channels there first, then re-import.',
              importChannelErrors: 'Some channels could not be read',
              importConfirm: 'Confirm import',
              importImporting: 'Importing…',
              importDone: (s: { created: number; skipped: number; flagged: number }) =>
                  `Import complete — created ${s.created}, skipped ${s.skipped}, needs price ${s.flagged}.`,
              importFailed: 'Import failed',
              importNothing: 'Nothing to import (all already exist, or no channels loaded).',
              importClose: 'Close',
          }
        : {
              sessionExpired: '登录已过期,请重新登录',
              title: '模型管理',
              subtitle: '模型目录 — slug / 厂商 / 上游映射',
              refresh: '刷新',
              loading: '加载中...',
              newModel: '+ 新建模型',
              editModel: '编辑模型',
              noModels: '暂无模型',
              noModelsHint: '点击「+ 新建模型」添加到模型目录。',
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
              fieldUpstreamMapHint:
                  '以路由名为键的 JSON 对象(如 "default"),每个值为 { "channel_id": 数字, "upstream_model": 字符串 }。',
              cancel: '取消',
              save: '保存',
              saving: '保存中...',
              loadFailed: '加载模型列表失败',
              saveFailed: '保存模型失败',
              deleteFailed: '删除模型失败',
              invalidJson: '上游映射必须是合法的 JSON',
              none: '无',
              // ── P2.5 从 new-api 导入 ──
              importBtn: '从 new-api 导入',
              importTitle: '从 new-api 导入模型',
              importIntro:
                  '从选中的旗舰渠道读取模型清单 + 当前价格,自动建好目录条目。已存在的模型会跳过;图片模型只建条目、价格留空(去「定价」页手填)。',
              importChannels: '从哪些渠道导入',
              importSelectHint:
                  '默认 Claude(2)/ ChatGPT(3)/ Gemini 图片(17)。Gemini 文本渠道 id 未固定 —— 若存在,在下方勾选。',
              importColModels: '个模型',
              importPreviewing: '预览中…',
              importRefresh: '重新预览',
              importWillCreate: '将创建',
              importNeedsPrice: '需手填价',
              importSkippedExists: '跳过(价已存在)',
              importColTier: '档次',
              importColIn: '¥ 输入 / 1M',
              importColOut: '¥ 输出 / 1M',
              importColReason: '说明',
              importImageReason: '图片模型 —— 价格需在「定价」页手填',
              importNoRatioReason: '渠道无 model_ratio —— 价格需手填',
              importRatioDefaulted: 'completion_ratio 缺省=1(输入=输出)',
              importOfficialNotRegistered:
                  '未在 /admin/channel-groups 登记 official 渠道,本次全部导入为 pool 档;要区分官方价请先登记官方渠道再导入。',
              importChannelErrors: '部分渠道读取失败',
              importConfirm: '确认导入',
              importImporting: '导入中…',
              importDone: (s: { created: number; skipped: number; flagged: number }) =>
                  `导入完成 —— 新建 ${s.created},跳过 ${s.skipped},需手填价 ${s.flagged}。`,
              importFailed: '导入失败',
              importNothing: '没有可导入的模型(都已存在,或没有渠道加载成功)。',
              importClose: '关闭',
          };
}

// ── Helpers ──

/** Compact one-line summary of upstream_map, e.g. `default → ch3:gpt-5.4`. */
function summarizeUpstreamMap(map: Record<string, UpstreamEntry>): string {
    const entries = Object.entries(map ?? {});
    if (entries.length === 0) return '';
    return entries.map(([route, entry]) => `${route} → ch${entry.channel_id}:${entry.upstream_model}`).join('  ·  ');
}

const emptyForm: ModelFormData = {
    slug: '',
    display_name: '',
    vendor: '',
    modality: 'chat',
    context_window: '',
    sort_order: '0',
    enabled: true,
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
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    // Edit / create modal state
    const [editModalOpen, setEditModalOpen] = useState(false);
    const [editingModel, setEditingModel] = useState<CatalogModel | null>(null);
    const [form, setForm] = useState<ModelFormData>(emptyForm);
    const [saving, setSaving] = useState(false);

    // ── P2.5 import-from-new-api modal state ──
    const [importModalOpen, setImportModalOpen] = useState(false);
    const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
    const [importChannelIds, setImportChannelIds] = useState<number[]>(DEFAULT_IMPORT_CHANNEL_IDS);
    const [importLoading, setImportLoading] = useState(false); // running a dry-run preview
    const [importing, setImporting] = useState(false); // running the real import
    const [importDoneResult, setImportDoneResult] = useState<ImportPreview | null>(null);
    const [importError, setImportError] = useState('');

    // ── Fetch models ──

    const fetchModels = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await fetch('/api/admin/models');
            if (!res.ok) {
                if (res.status === 401) {
                    setError(t.sessionExpired);
                    return;
                }
                const data = await res.json().catch(() => ({}));
                setError(data.error || t.loadFailed);
                return;
            }
            const data = await res.json();
            setModels(data.models ?? []);
        } catch {
            setError(t.loadFailed);
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        fetchModels();
    }, [fetchModels]);

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
                setError(data.error || t.saveFailed);
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
                setError(data.error || t.deleteFailed);
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
                setError(data.error || t.saveFailed);
                return;
            }
            setModels((prev) => prev.map((m) => (m.id === model.id ? { ...m, enabled: !m.enabled } : m)));
        } catch {
            setError(t.saveFailed);
        }
    };

    // ── P2.5 import-from-new-api handlers ──

    // Dry-run preview: never writes. Returns the channel menu + what would be imported.
    const runImportPreview = useCallback(async (channelIds: number[]) => {
        setImportLoading(true);
        setImportError('');
        setImportDoneResult(null);
        try {
            const res = await fetch('/api/admin/models/import?dryRun=true', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel_ids: channelIds }),
            });
            if (!res.ok) {
                if (res.status === 401) {
                    setImportError(t.sessionExpired);
                    return;
                }
                const data = await res.json().catch(() => ({}));
                setImportError(data.error || t.importFailed);
                return;
            }
            const data = (await res.json()) as ImportPreview;
            setImportPreview(data);
            setImportChannelIds(data.selectedChannelIds);
        } catch {
            setImportError(t.importFailed);
        } finally {
            setImportLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const openImportModal = () => {
        setImportModalOpen(true);
        setImportPreview(null);
        setImportDoneResult(null);
        setImportError('');
        setImportChannelIds(DEFAULT_IMPORT_CHANNEL_IDS);
        runImportPreview(DEFAULT_IMPORT_CHANNEL_IDS);
    };

    const closeImportModal = () => setImportModalOpen(false);

    const toggleImportChannel = (id: number) => {
        setImportChannelIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].sort((a, b) => a - b),
        );
    };

    // Real import: writes inside a transaction, then refreshes the table behind the modal.
    const confirmImport = async () => {
        setImporting(true);
        setImportError('');
        try {
            const res = await fetch('/api/admin/models/import?dryRun=false', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel_ids: importChannelIds }),
            });
            if (!res.ok) {
                if (res.status === 401) {
                    setImportError(t.sessionExpired);
                    return;
                }
                const data = await res.json().catch(() => ({}));
                setImportError(data.error || t.importFailed);
                return;
            }
            const data = (await res.json()) as ImportPreview;
            setImportPreview(data);
            setImportDoneResult(data);
            fetchModels();
        } catch {
            setImportError(t.importFailed);
        } finally {
            setImporting(false);
        }
    };

    const flaggedReasonText = (reason: string) =>
        reason === 'image_model_manual_price' ? t.importImageReason : t.importNoRatioReason;
    const fmtPrice = (n: number | null) => (n == null ? '—' : `¥${n.toFixed(2)}`);

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

            {/* Action buttons */}
            <div className="mb-4 flex flex-wrap gap-2 justify-end">
                <button type="button" onClick={openImportModal} className={btnBase}>
                    {t.importBtn}
                </button>
                <button
                    type="button"
                    onClick={openCreateModal}
                    className="inline-flex items-center rounded-lg border border-emerald-500 bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-600"
                >
                    {t.newModel}
                </button>
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
                        <p className="text-base font-medium">{t.noModels}</p>
                        <p className="mt-1 text-sm opacity-70">{t.noModelsHint}</p>
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
                                const upstreamSummary = summarizeUpstreamMap(model.upstream_map);
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

            {/* ── P2.5 Import-from-new-api Modal ── */}
            {importModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div
                        className={[
                            'relative w-full max-w-2xl overflow-y-auto rounded-2xl border p-6 shadow-2xl',
                            isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-white',
                        ].join(' ')}
                        style={{ maxHeight: '90vh' }}
                    >
                        <h2 className={`mb-2 text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                            {t.importTitle}
                        </h2>
                        <p className={`mb-4 text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                            {t.importIntro}
                        </p>

                        {importError && (
                            <div
                                className={`mb-4 rounded-lg border p-3 text-sm ${isDark ? 'border-red-800 bg-red-950/50 text-red-400' : 'border-red-200 bg-red-50 text-red-600'}`}
                            >
                                {importError}
                            </div>
                        )}

                        {importDoneResult && (
                            <div
                                className={`mb-4 rounded-lg border p-3 text-sm ${isDark ? 'border-emerald-800 bg-emerald-950/40 text-emerald-300' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}
                            >
                                {t.importDone(importDoneResult.summary)}
                            </div>
                        )}

                        {/* channel menu */}
                        <div className="mb-4">
                            <label className={labelCls}>{t.importChannels}</label>
                            <p className={`mb-2 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                {t.importSelectHint}
                            </p>
                            <div className="flex flex-col gap-1.5">
                                {(importPreview?.channels.length ?? 0) === 0 && !importLoading ? (
                                    <span className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                        {t.none}
                                    </span>
                                ) : (
                                    importPreview?.channels.map((ch) => (
                                        <label
                                            key={ch.id}
                                            className={`flex items-center gap-2 text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={importChannelIds.includes(ch.id)}
                                                onChange={() => toggleImportChannel(ch.id)}
                                                disabled={importLoading || importing || !!importDoneResult}
                                                className="h-4 w-4 rounded border-slate-400 accent-emerald-500"
                                            />
                                            <span className="font-mono text-xs">#{ch.id}</span>
                                            <span>{ch.name ?? '—'}</span>
                                            <span
                                                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                                    ch.tier === 'official'
                                                        ? isDark
                                                            ? 'bg-indigo-500/20 text-indigo-300'
                                                            : 'bg-indigo-50 text-indigo-600'
                                                        : isDark
                                                          ? 'bg-slate-700 text-slate-300'
                                                          : 'bg-slate-100 text-slate-600'
                                                }`}
                                            >
                                                {ch.tier}
                                            </span>
                                            <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                                · {ch.model_count} {t.importColModels}
                                            </span>
                                        </label>
                                    ))
                                )}
                            </div>
                            {!importDoneResult && (
                                <button
                                    type="button"
                                    onClick={() => runImportPreview(importChannelIds)}
                                    disabled={importLoading || importing}
                                    className={[btnBase, 'mt-3 disabled:opacity-50'].join(' ')}
                                >
                                    {importLoading ? t.importPreviewing : t.importRefresh}
                                </button>
                            )}
                        </div>

                        {/* channel load errors */}
                        {importPreview && importPreview.channelErrors.length > 0 && (
                            <div
                                className={`mb-4 rounded-lg border p-3 text-xs ${isDark ? 'border-amber-800 bg-amber-950/40 text-amber-300' : 'border-amber-200 bg-amber-50 text-amber-700'}`}
                            >
                                <div className="font-medium">{t.importChannelErrors}</div>
                                <ul className="mt-1 list-disc pl-4">
                                    {importPreview.channelErrors.map((e) => (
                                        <li key={e.channel_id}>
                                            #{e.channel_id}: {e.error}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {/* preview body */}
                        {importLoading ? (
                            <div className={`py-8 text-center text-sm ${isDark ? 'text-slate-400' : 'text-gray-500'}`}>
                                {t.importPreviewing}
                            </div>
                        ) : importPreview ? (
                            <div className="space-y-4">
                                {!importPreview.officialRegistered && (
                                    <div
                                        className={`rounded-lg border p-3 text-xs ${isDark ? 'border-amber-700 bg-amber-950/40 text-amber-300' : 'border-amber-300 bg-amber-50 text-amber-800'}`}
                                    >
                                        ⚠️ {t.importOfficialNotRegistered}
                                    </div>
                                )}
                                <div className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                                    <span className="text-emerald-500">
                                        {t.importWillCreate} {importPreview.summary.created}
                                    </span>
                                    {'  ·  '}
                                    <span className="text-amber-500">
                                        {t.importNeedsPrice} {importPreview.summary.flagged}
                                    </span>
                                    {'  ·  '}
                                    <span className={isDark ? 'text-slate-500' : 'text-slate-400'}>
                                        {t.importSkippedExists} {importPreview.summary.skipped}
                                    </span>
                                </div>

                                {importPreview.created.length +
                                    importPreview.flagged.length +
                                    importPreview.skipped.length ===
                                0 ? (
                                    <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                        {t.importNothing}
                                    </p>
                                ) : null}

                                {/* created */}
                                {importPreview.created.length > 0 && (
                                    <div>
                                        <div
                                            className={`mb-1 text-xs font-semibold uppercase ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
                                        >
                                            {t.importWillCreate}
                                        </div>
                                        <div
                                            className={[
                                                'overflow-x-auto rounded-lg border',
                                                isDark ? 'border-slate-700' : 'border-slate-200',
                                            ].join(' ')}
                                        >
                                            <table className="w-full text-xs">
                                                <thead>
                                                    <tr className={isDark ? 'text-slate-400' : 'text-slate-500'}>
                                                        <th className="px-3 py-2 text-left font-medium">{t.colName}</th>
                                                        <th className="px-3 py-2 text-left font-medium">
                                                            {t.colVendor}
                                                        </th>
                                                        <th className="px-3 py-2 text-left font-medium">
                                                            {t.importColTier}
                                                        </th>
                                                        <th className="px-3 py-2 text-right font-medium">
                                                            {t.importColIn}
                                                        </th>
                                                        <th className="px-3 py-2 text-right font-medium">
                                                            {t.importColOut}
                                                        </th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {importPreview.created.map((r) => (
                                                        <tr
                                                            key={`${r.slug}-${r.tier}`}
                                                            className={
                                                                isDark
                                                                    ? 'border-t border-slate-700/50'
                                                                    : 'border-t border-slate-100'
                                                            }
                                                        >
                                                            <td className="px-3 py-1.5">
                                                                <span
                                                                    className={
                                                                        isDark ? 'text-slate-200' : 'text-slate-800'
                                                                    }
                                                                >
                                                                    {r.display_name}
                                                                </span>
                                                                <span
                                                                    className={`ml-1 font-mono ${isDark ? 'text-slate-500' : 'text-slate-400'}`}
                                                                >
                                                                    {r.slug}
                                                                </span>
                                                                {r.ratio_defaulted && (
                                                                    <span
                                                                        className="ml-1 text-amber-500"
                                                                        title={t.importRatioDefaulted}
                                                                    >
                                                                        *
                                                                    </span>
                                                                )}
                                                            </td>
                                                            <td
                                                                className={`px-3 py-1.5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}
                                                            >
                                                                {r.vendor}
                                                            </td>
                                                            <td
                                                                className={`px-3 py-1.5 font-mono ${isDark ? 'text-slate-400' : 'text-slate-600'}`}
                                                            >
                                                                {r.tier}
                                                            </td>
                                                            <td
                                                                className={`px-3 py-1.5 text-right font-mono ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
                                                            >
                                                                {fmtPrice(r.input_cny_per_1m)}
                                                            </td>
                                                            <td
                                                                className={`px-3 py-1.5 text-right font-mono ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
                                                            >
                                                                {fmtPrice(r.output_cny_per_1m)}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                        {importPreview.created.some((r) => r.ratio_defaulted) && (
                                            <p className="mt-1 text-xs text-amber-500">* {t.importRatioDefaulted}</p>
                                        )}
                                    </div>
                                )}

                                {/* flagged */}
                                {importPreview.flagged.length > 0 && (
                                    <div>
                                        <div
                                            className={`mb-1 text-xs font-semibold uppercase ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
                                        >
                                            {t.importNeedsPrice}
                                        </div>
                                        <div
                                            className={[
                                                'overflow-x-auto rounded-lg border',
                                                isDark ? 'border-slate-700' : 'border-slate-200',
                                            ].join(' ')}
                                        >
                                            <table className="w-full text-xs">
                                                <thead>
                                                    <tr className={isDark ? 'text-slate-400' : 'text-slate-500'}>
                                                        <th className="px-3 py-2 text-left font-medium">{t.colName}</th>
                                                        <th className="px-3 py-2 text-left font-medium">
                                                            {t.importColTier}
                                                        </th>
                                                        <th className="px-3 py-2 text-left font-medium">
                                                            {t.colModality}
                                                        </th>
                                                        <th className="px-3 py-2 text-left font-medium">
                                                            {t.importColReason}
                                                        </th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {importPreview.flagged.map((r) => (
                                                        <tr
                                                            key={`${r.slug}-${r.tier}`}
                                                            className={
                                                                isDark
                                                                    ? 'border-t border-slate-700/50'
                                                                    : 'border-t border-slate-100'
                                                            }
                                                        >
                                                            <td className="px-3 py-1.5">
                                                                <span
                                                                    className={
                                                                        isDark ? 'text-slate-200' : 'text-slate-800'
                                                                    }
                                                                >
                                                                    {r.display_name}
                                                                </span>
                                                                <span
                                                                    className={`ml-1 font-mono ${isDark ? 'text-slate-500' : 'text-slate-400'}`}
                                                                >
                                                                    {r.slug}
                                                                </span>
                                                            </td>
                                                            <td
                                                                className={`px-3 py-1.5 font-mono ${isDark ? 'text-slate-400' : 'text-slate-600'}`}
                                                            >
                                                                {r.tier}
                                                            </td>
                                                            <td
                                                                className={`px-3 py-1.5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}
                                                            >
                                                                {r.modality}
                                                            </td>
                                                            <td
                                                                className={`px-3 py-1.5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}
                                                            >
                                                                {flaggedReasonText(r.reason)}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                )}

                                {/* skipped */}
                                {importPreview.skipped.length > 0 && (
                                    <div>
                                        <div
                                            className={`mb-1 text-xs font-semibold uppercase ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
                                        >
                                            {t.importSkippedExists}
                                        </div>
                                        <div
                                            className={`font-mono text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}
                                        >
                                            {importPreview.skipped.map((r) => `${r.slug} (${r.tier})`).join(', ')}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : null}

                        {/* footer */}
                        <div className="mt-6 flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={closeImportModal}
                                className={[
                                    'rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                                    isDark ? 'text-slate-400 hover:bg-slate-700' : 'text-slate-600 hover:bg-slate-100',
                                ].join(' ')}
                            >
                                {importDoneResult ? t.importClose : t.cancel}
                            </button>
                            {!importDoneResult && (
                                <button
                                    type="button"
                                    onClick={confirmImport}
                                    disabled={
                                        importing ||
                                        importLoading ||
                                        !importPreview ||
                                        importPreview.created.length + importPreview.flagged.length === 0
                                    }
                                    className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {importing ? t.importImporting : t.importConfirm}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
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
