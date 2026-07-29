'use client';

/**
 * AK/SK 凭据管理 island(2026-07-28,火山 SignerV4 签名鉴权用)。
 * 数据源 /api/enterprise/aksk;生成时 SK 明文只展示一次 + 复制;禁用软删。
 */
import { useState } from 'react';
import { copyText } from '@/lib/enterprise/copy-text';

export interface AkSkRow {
    id: string;
    access_key: string;
    name: string;
    status: string;
    created_at: string;
    last_used_at: string | null;
}

function fmtTime(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

export function AkSkManager({ initialItems }: { initialItems: AkSkRow[] }) {
    const [items, setItems] = useState(initialItems);
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fresh, setFresh] = useState<{ ak: string; sk: string } | null>(null);
    const [copied, setCopied] = useState<'ak' | 'sk' | null>(null);

    async function onCreate(e: React.FormEvent) {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch('/api/enterprise/aksk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim() || 'default' }),
            });
            const j = (await res.json()) as { access_key?: string; secret_key?: string; row?: AkSkRow; error?: string };
            if (!res.ok || !j.access_key || !j.secret_key || !j.row) {
                setError('创建失败,请稍后重试');
                return;
            }
            setItems((l) => [...l, j.row!]);
            setFresh({ ak: j.access_key, sk: j.secret_key });
            setCopied(null);
            setName('');
        } catch {
            setError('网络错误,请稍后重试');
        } finally {
            setBusy(false);
        }
    }

    async function onDisable(id: string) {
        if (!window.confirm('确认禁用该 AK/SK?禁用后用它签名的调用会立即 401。')) return;
        try {
            const res = await fetch(`/api/enterprise/aksk/${id}`, { method: 'DELETE' });
            if (res.ok) setItems((l) => l.map((a) => (a.id === id ? { ...a, status: 'disabled' } : a)));
        } catch {
            // 失败保持原状
        }
    }

    async function onCopy(which: 'ak' | 'sk') {
        if (!fresh) return;
        if (await copyText(which === 'ak' ? fresh.ak : fresh.sk)) setCopied(which);
    }

    return (
        <div className="space-y-4">
            {fresh && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
                    <p className="text-sm font-medium text-amber-900">
                        新 AK/SK 已创建 —— Secret Key 只显示这一次,请立即保存:
                    </p>
                    <div className="mt-2 space-y-1.5">
                        <div className="flex items-center gap-2">
                            <span className="w-24 shrink-0 text-xs text-amber-800">Access Key</span>
                            <code className="break-all rounded bg-white px-2 py-1 text-xs">{fresh.ak}</code>
                            <button
                                onClick={() => onCopy('ak')}
                                className="shrink-0 rounded border border-amber-400 px-2 py-1 text-xs hover:bg-amber-100"
                            >
                                {copied === 'ak' ? '已复制' : '复制'}
                            </button>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="w-24 shrink-0 text-xs text-amber-800">Secret Key</span>
                            <code className="break-all rounded bg-white px-2 py-1 text-xs">{fresh.sk}</code>
                            <button
                                onClick={() => onCopy('sk')}
                                className="shrink-0 rounded border border-amber-400 px-2 py-1 text-xs hover:bg-amber-100"
                            >
                                {copied === 'sk' ? '已复制' : '复制'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <section className="rounded-xl border border-gray-200 bg-white p-5">
                <h2 className="mb-1 text-sm font-semibold text-gray-900">AK/SK 凭据(火山签名)</h2>
                <p className="mb-3 text-xs text-gray-400">
                    火山引擎 SignerV4(AK/SK)签名鉴权,兼容火山官方 SDK / 素材库脚本。与 sk-ent 密钥并存,任选其一即可。
                </p>
                {items.length === 0 ? (
                    <p className="text-sm text-gray-500">暂无 AK/SK。</p>
                ) : (
                    <table className="w-full text-left text-sm">
                        <thead className="text-xs text-gray-500">
                            <tr>
                                <th className="py-1 pr-4">名称</th>
                                <th className="py-1 pr-4">Access Key</th>
                                <th className="py-1 pr-4">状态</th>
                                <th className="py-1 pr-4">创建时间</th>
                                <th className="py-1 pr-4">最近使用</th>
                                <th className="py-1"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {items.map((a) => (
                                <tr key={a.id} className="border-t border-gray-100">
                                    <td className="py-2 pr-4">{a.name}</td>
                                    <td className="py-2 pr-4 font-mono text-xs text-gray-500">{a.access_key}</td>
                                    <td className="py-2 pr-4">
                                        {a.status === 'active' ? (
                                            <span className="text-green-700">启用</span>
                                        ) : (
                                            <span className="text-gray-400">已禁用</span>
                                        )}
                                    </td>
                                    <td className="py-2 pr-4 text-gray-600">{fmtTime(a.created_at)}</td>
                                    <td className="py-2 pr-4 text-gray-600">{fmtTime(a.last_used_at)}</td>
                                    <td className="py-2 text-right">
                                        {a.status === 'active' && (
                                            <button
                                                onClick={() => onDisable(a.id)}
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
                <form onSubmit={onCreate} className="mt-4 flex items-center gap-2">
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="AK/SK 名称(如 prod-signer)"
                        maxLength={50}
                        className="w-64 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    />
                    <button
                        type="submit"
                        disabled={busy}
                        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                        {busy ? '生成中…' : '生成 AK/SK'}
                    </button>
                </form>
                {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
            </section>
        </div>
    );
}
