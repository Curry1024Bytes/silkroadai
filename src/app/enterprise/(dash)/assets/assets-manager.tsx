'use client';

/**
 * P3 素材库 island:上传(multipart → /api/enterprise/assets)/ 分组筛选与指派 /
 * 改名 / 删除 / 复制素材 id(生成请求里直接引用)。
 */
import { useMemo, useRef, useState } from 'react';
import { copyText } from '@/lib/enterprise/copy-text';

export interface AssetRow {
    id: string;
    name: string;
    asset_type: string;
    group_id: string | null;
    url: string;
    bytes: number;
    created_at: string;
}
export interface GroupRow {
    id: string;
    name: string;
}

const TYPE_LABEL: Record<string, string> = { image: '图片', video: '视频', audio: '音频' };

function fmtBytes(n: number): string {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
    return `${n}B`;
}

function fmtTime(iso: string): string {
    return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

export function AssetsManager({
    initialAssets,
    initialGroups,
}: {
    initialAssets: AssetRow[];
    initialGroups: GroupRow[];
}) {
    const [assets, setAssets] = useState(initialAssets);
    const [groups, setGroups] = useState(initialGroups);
    const [filterGroup, setFilterGroup] = useState<string>('');
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    const visible = useMemo(
        () => (filterGroup ? assets.filter((a) => a.group_id === filterGroup) : assets),
        [assets, filterGroup],
    );

    async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        setUploading(true);
        setError(null);
        try {
            const form = new FormData();
            form.set('file', file);
            if (filterGroup) form.set('group_id', filterGroup);
            const res = await fetch('/api/enterprise/assets', { method: 'POST', body: form });
            const j = (await res.json()) as AssetRow & { error?: string; detail?: string };
            if (!res.ok) {
                setError(j.detail || j.error || '上传失败');
                return;
            }
            setAssets((list) => [j, ...list]);
        } catch {
            setError('网络错误,请稍后重试');
        } finally {
            setUploading(false);
            if (fileRef.current) fileRef.current.value = '';
        }
    }

    async function onCreateGroup() {
        const name = window.prompt('素材组名称(如「主角参考」):')?.trim();
        if (!name) return;
        const res = await fetch('/api/enterprise/asset-groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        if (res.ok) {
            const g = (await res.json()) as GroupRow;
            setGroups((gs) => [...gs, g]);
        }
    }

    async function onAssign(assetId: string, groupId: string) {
        const res = await fetch(`/api/enterprise/assets/${assetId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ group_id: groupId || null }),
        });
        if (res.ok) {
            setAssets((list) => list.map((a) => (a.id === assetId ? { ...a, group_id: groupId || null } : a)));
        }
    }

    async function onRename(asset: AssetRow) {
        const name = window.prompt('新名称:', asset.name)?.trim();
        if (!name || name === asset.name) return;
        const res = await fetch(`/api/enterprise/assets/${asset.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        if (res.ok) setAssets((list) => list.map((a) => (a.id === asset.id ? { ...a, name } : a)));
    }

    async function onDelete(asset: AssetRow) {
        if (!window.confirm(`确认删除素材「${asset.name}」?正在引用它的生成请求会失效。`)) return;
        const res = await fetch(`/api/enterprise/assets/${asset.id}`, { method: 'DELETE' });
        if (res.ok) setAssets((list) => list.filter((a) => a.id !== asset.id));
    }

    async function onCopyId(id: string) {
        if (!(await copyText(id))) return;
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 1500);
    }

    return (
        <div className="space-y-4">
            <section className="rounded-xl border border-gray-200 bg-white p-5">
                <div className="flex flex-wrap items-center gap-2">
                    <label className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                        {uploading ? '上传中…' : '上传素材'}
                        <input
                            ref={fileRef}
                            type="file"
                            accept="image/*,video/*,audio/*"
                            className="hidden"
                            disabled={uploading}
                            onChange={onUpload}
                        />
                    </label>
                    <select
                        value={filterGroup}
                        onChange={(e) => setFilterGroup(e.target.value)}
                        className="rounded-md border border-gray-300 px-2 py-2 text-sm"
                    >
                        <option value="">全部素材</option>
                        {groups.map((g) => (
                            <option key={g.id} value={g.id}>
                                {g.name}
                            </option>
                        ))}
                    </select>
                    <button
                        onClick={onCreateGroup}
                        className="rounded-md border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50"
                    >
                        + 新建素材组
                    </button>
                </div>
                {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
                <p className="mt-2 text-xs text-gray-400">
                    生成时直接引用:把素材 ID(asset-…)填进 images / first_frame / reference_videos 等字段;素材组
                    ID(group-…)放进 images 数组会按序展开全部成员。也可用 API 管理:
                    <code className="rounded bg-gray-100 px-1">POST /api?Action=CreateAsset&Version=2024-01-01</code>
                </p>
            </section>

            <section className="rounded-xl border border-gray-200 bg-white p-5">
                <h2 className="mb-3 text-sm font-semibold text-gray-900">
                    素材({visible.length}
                    {filterGroup ? ' · 当前组' : ''})
                </h2>
                {visible.length === 0 ? (
                    <p className="text-sm text-gray-500">暂无素材,点「上传素材」开始。</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead className="text-xs text-gray-500">
                                <tr>
                                    <th className="py-1 pr-3">预览</th>
                                    <th className="py-1 pr-3">名称</th>
                                    <th className="py-1 pr-3">素材 ID</th>
                                    <th className="py-1 pr-3">类型</th>
                                    <th className="py-1 pr-3">大小</th>
                                    <th className="py-1 pr-3">素材组</th>
                                    <th className="py-1 pr-3">上传时间</th>
                                    <th className="py-1"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {visible.map((a) => (
                                    <tr key={a.id} className="border-t border-gray-100">
                                        <td className="py-2 pr-3">
                                            {a.asset_type === 'image' ? (
                                                // eslint-disable-next-line @next/next/no-img-element
                                                <img
                                                    src={a.url}
                                                    alt={a.name}
                                                    className="h-10 w-10 rounded object-cover"
                                                />
                                            ) : (
                                                <span className="inline-flex h-10 w-10 items-center justify-center rounded bg-gray-100 text-xs text-gray-500">
                                                    {TYPE_LABEL[a.asset_type] ?? a.asset_type}
                                                </span>
                                            )}
                                        </td>
                                        <td className="max-w-40 truncate py-2 pr-3">{a.name}</td>
                                        <td className="py-2 pr-3">
                                            <button
                                                onClick={() => onCopyId(a.id)}
                                                title="点击复制"
                                                className="rounded bg-gray-50 px-1.5 py-0.5 font-mono text-xs text-gray-600 hover:bg-gray-100"
                                            >
                                                {copiedId === a.id ? '已复制' : a.id}
                                            </button>
                                        </td>
                                        <td className="py-2 pr-3">{TYPE_LABEL[a.asset_type] ?? a.asset_type}</td>
                                        <td className="py-2 pr-3 text-gray-600">{fmtBytes(a.bytes)}</td>
                                        <td className="py-2 pr-3">
                                            <select
                                                value={a.group_id ?? ''}
                                                onChange={(e) => onAssign(a.id, e.target.value)}
                                                className="rounded border border-gray-200 px-1 py-0.5 text-xs"
                                            >
                                                <option value="">未分组</option>
                                                {groups.map((g) => (
                                                    <option key={g.id} value={g.id}>
                                                        {g.name}
                                                    </option>
                                                ))}
                                            </select>
                                        </td>
                                        <td className="py-2 pr-3 text-gray-600">{fmtTime(a.created_at)}</td>
                                        <td className="py-2 text-right whitespace-nowrap">
                                            <button
                                                onClick={() => onRename(a)}
                                                className="mr-1 rounded border border-gray-200 px-2 py-1 text-xs hover:bg-gray-50"
                                            >
                                                改名
                                            </button>
                                            <button
                                                onClick={() => onDelete(a)}
                                                className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                                            >
                                                删除
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </div>
    );
}
