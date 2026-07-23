'use client';

/**
 * 企业密钥管理 island(P2):创建(明文只展示一次 + 复制)/ 禁用。
 * 数据源 = /api/enterprise/keys;操作后本地更新列表,不整页刷新。
 */
import { useState } from 'react';
import { copyText } from '@/lib/enterprise/copy-text';

export interface KeyRow {
    id: string;
    name: string;
    key_prefix: string;
    region: string;
    status: string;
    created_at: string;
    last_used_at: string | null;
}

function fmtTime(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

export function KeysManager({ initialKeys }: { initialKeys: KeyRow[] }) {
    const [keys, setKeys] = useState(initialKeys);
    const [name, setName] = useState('');
    const [region, setRegion] = useState<'cn' | 'global'>('cn');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [freshKey, setFreshKey] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    async function onCreate(e: React.FormEvent) {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch('/api/enterprise/keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim() || 'default', region }),
            });
            const j = (await res.json()) as { key?: string; row?: KeyRow; error?: string };
            if (!res.ok || !j.key || !j.row) {
                setError(j.error === 'key_limit_reached' ? '密钥数量已达上限(10 个)' : '创建失败,请稍后重试');
                return;
            }
            setKeys((k) => [...k, j.row!]);
            setFreshKey(j.key);
            setCopied(false);
            setName('');
        } catch {
            setError('网络错误,请稍后重试');
        } finally {
            setBusy(false);
        }
    }

    async function onDisable(id: string) {
        if (!window.confirm('确认禁用该密钥?禁用后使用该密钥的调用会立即 401。')) return;
        try {
            const res = await fetch(`/api/enterprise/keys/${id}`, { method: 'DELETE' });
            if (res.ok) {
                setKeys((ks) => ks.map((k) => (k.id === id ? { ...k, status: 'disabled' } : k)));
            }
        } catch {
            // 失败保持原状,用户可重试
        }
    }

    async function onCopy() {
        if (!freshKey) return;
        if (await copyText(freshKey)) setCopied(true);
    }

    return (
        <div className="space-y-4">
            {freshKey && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
                    <p className="text-sm font-medium text-amber-900">新密钥已创建 —— 只显示这一次,请立即保存:</p>
                    <div className="mt-2 flex items-center gap-2">
                        <code className="break-all rounded bg-white px-2 py-1 text-xs">{freshKey}</code>
                        <button
                            onClick={onCopy}
                            className="shrink-0 rounded border border-amber-400 px-2 py-1 text-xs hover:bg-amber-100"
                        >
                            {copied ? '已复制' : '复制'}
                        </button>
                    </div>
                </div>
            )}

            <section className="rounded-xl border border-gray-200 bg-white p-5">
                <h2 className="mb-3 text-sm font-semibold text-gray-900">API 密钥</h2>
                {keys.length === 0 ? (
                    <p className="text-sm text-gray-500">暂无密钥。</p>
                ) : (
                    <table className="w-full text-left text-sm">
                        <thead className="text-xs text-gray-500">
                            <tr>
                                <th className="py-1 pr-4">名称</th>
                                <th className="py-1 pr-4">密钥</th>
                                <th className="py-1 pr-4">版本</th>
                                <th className="py-1 pr-4">状态</th>
                                <th className="py-1 pr-4">创建时间</th>
                                <th className="py-1 pr-4">最近使用</th>
                                <th className="py-1"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {keys.map((k) => (
                                <tr key={k.id} className="border-t border-gray-100">
                                    <td className="py-2 pr-4">{k.name}</td>
                                    <td className="py-2 pr-4 font-mono text-xs text-gray-500">{k.key_prefix}…</td>
                                    <td className="py-2 pr-4">
                                        {k.region === 'global' ? (
                                            <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-medium text-indigo-700">
                                                海外版
                                            </span>
                                        ) : (
                                            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                                                国内版
                                            </span>
                                        )}
                                    </td>
                                    <td className="py-2 pr-4">
                                        {k.status === 'active' ? (
                                            <span className="text-green-700">启用</span>
                                        ) : (
                                            <span className="text-gray-400">已禁用</span>
                                        )}
                                    </td>
                                    <td className="py-2 pr-4 text-gray-600">{fmtTime(k.created_at)}</td>
                                    <td className="py-2 pr-4 text-gray-600">{fmtTime(k.last_used_at)}</td>
                                    <td className="py-2 text-right">
                                        {k.status === 'active' && (
                                            <button
                                                onClick={() => onDisable(k.id)}
                                                className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                                            >
                                                禁用
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>

            <section className="rounded-xl border border-gray-200 bg-white p-5">
                <h2 className="mb-3 text-sm font-semibold text-gray-900">创建新密钥</h2>
                <form onSubmit={onCreate} className="flex items-center gap-2">
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="密钥名称(如 prod / staging)"
                        maxLength={50}
                        className="w-64 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    />
                    <select
                        value={region}
                        onChange={(e) => setRegion(e.target.value as 'cn' | 'global')}
                        className="rounded-md border border-gray-300 px-2 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    >
                        <option value="cn">国内版</option>
                        <option value="global">海外版(global)</option>
                    </select>
                    <button
                        type="submit"
                        disabled={busy}
                        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                        {busy ? '创建中…' : '创建'}
                    </button>
                </form>
                {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
                <p className="mt-2 text-xs text-gray-400">
                    密钥明文只在创建时显示一次;服务端仅存哈希,无法找回。海外版密钥调 seedance-2-0-global
                    系模型(参数/价格与国内一致,海外节点出片),国内/海外密钥不互通。
                </p>
            </section>
        </div>
    );
}
