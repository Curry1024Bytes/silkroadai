'use client';

import { useEffect, useMemo, useState } from 'react';

export interface KeyRow {
    id: string;
    key_alias: string;
    masked_key: string;
    /** ISO timestamp string. */
    created_at: string;
}

/** Mirror of the server-side mask helper. Used when we receive a freshly
 *  created sk-xxx and want to flip back to the obscured form. */
function maskKey(value: string): string {
    if (value.length <= 12) return '*'.repeat(Math.max(8, value.length));
    return `${value.slice(0, 7)}****${value.slice(-4)}`;
}

/** Brief: max 5 keys per user. Constant lives client-side too so the UI can
 *  disable the "create" button without a roundtrip; server enforces the
 *  same limit (POST /api/portal/keys returns 400 if exceeded). */
const MAX_TOKENS_PER_USER = 5;

/** How long to expose a freshly-revealed sk- before re-masking it. Defends
 *  against shoulder-surfing / forgotten browser tab scenarios. */
const REVEAL_AUTOHIDE_MS = 10_000;
const COPIED_TOAST_MS = 2_000;

/** State of the per-row "displayed key" — either the real sk- (showing) or
 *  null (showing the masked form). */
type RevealMap = Record<string, string | undefined>;
type CopiedMap = Record<string, boolean>;

interface CreateState {
    open: boolean;
    alias: string;
    submitting: boolean;
    error: string | null;
}

const tableHeaderStyle: React.CSSProperties = {
    textAlign: 'left',
    padding: '8px 12px',
    fontSize: 12,
    color: '#5a6478',
    background: '#f5f7fa',
    borderBottom: '1px solid #e5e8ee',
};
const tableCellStyle: React.CSSProperties = {
    padding: '10px 12px',
    fontSize: 13,
    borderBottom: '1px solid #e5e8ee',
    color: '#1a2540',
};

export function KeysList({ initialRows }: { initialRows: KeyRow[] }) {
    const [rows, setRows] = useState<KeyRow[]>(initialRows);
    const [reveal, setReveal] = useState<RevealMap>({});
    const [copied, setCopied] = useState<CopiedMap>({});
    const [busyId, setBusyId] = useState<string | null>(null);
    const [globalError, setGlobalError] = useState<string | null>(null);
    const [create, setCreate] = useState<CreateState>({
        open: false,
        alias: '',
        submitting: false,
        error: null,
    });

    const atLimit = rows.length >= MAX_TOKENS_PER_USER;
    const isOnlyKey = rows.length === 1;

    // Auto-hide revealed keys after REVEAL_AUTOHIDE_MS so a forgotten tab
    // doesn't leave the sk- visible indefinitely.
    useEffect(() => {
        const visibleIds = Object.entries(reveal)
            .filter(([, v]) => typeof v === 'string')
            .map(([k]) => k);
        if (visibleIds.length === 0) return;
        const t = setTimeout(() => {
            setReveal((prev) => {
                const next = { ...prev };
                for (const id of visibleIds) delete next[id];
                return next;
            });
        }, REVEAL_AUTOHIDE_MS);
        return () => clearTimeout(t);
    }, [reveal]);

    async function fetchFullKey(id: string): Promise<string | null> {
        try {
            const r = await fetch(`/api/portal/keys/${encodeURIComponent(id)}/key`, {
                method: 'GET',
                credentials: 'same-origin',
            });
            if (!r.ok) {
                const data = await r.json().catch(() => ({}));
                setGlobalError(typeof data?.error === 'string' ? data.error : `请求失败 (${r.status})`);
                return null;
            }
            const data = (await r.json()) as { key?: string };
            return typeof data.key === 'string' ? data.key : null;
        } catch (err) {
            setGlobalError(err instanceof Error ? err.message : '网络错误');
            return null;
        }
    }

    async function handleReveal(id: string) {
        if (busyId) return;
        setBusyId(id);
        setGlobalError(null);
        const sk = await fetchFullKey(id);
        if (sk) setReveal((prev) => ({ ...prev, [id]: sk }));
        setBusyId(null);
    }

    async function handleCopy(id: string) {
        if (busyId) return;
        setBusyId(id);
        setGlobalError(null);
        const sk = await fetchFullKey(id);
        if (!sk) {
            setBusyId(null);
            return;
        }
        try {
            await navigator.clipboard.writeText(sk);
            setCopied((prev) => ({ ...prev, [id]: true }));
            setTimeout(() => {
                setCopied((prev) => {
                    const next = { ...prev };
                    delete next[id];
                    return next;
                });
            }, COPIED_TOAST_MS);
        } catch {
            setGlobalError('复制失败,浏览器拒绝了 clipboard 权限');
        }
        setBusyId(null);
    }

    async function handleRevoke(id: string) {
        if (busyId) return;
        const warning = isOnlyKey
            ? '这是您唯一的 key,撤销后需重新创建才能调用 API。\n确认撤销?该 key 立即失效'
            : '确认撤销?该 key 立即失效';
        if (!window.confirm(warning)) return;

        setBusyId(id);
        setGlobalError(null);
        try {
            const r = await fetch(`/api/portal/keys/${encodeURIComponent(id)}`, {
                method: 'DELETE',
                credentials: 'same-origin',
            });
            if (!r.ok) {
                const data = await r.json().catch(() => ({}));
                setGlobalError(typeof data?.error === 'string' ? data.error : `撤销失败 (${r.status})`);
            } else {
                setRows((prev) => prev.filter((row) => row.id !== id));
                setReveal((prev) => {
                    const next = { ...prev };
                    delete next[id];
                    return next;
                });
            }
        } catch (err) {
            setGlobalError(err instanceof Error ? err.message : '网络错误');
        }
        setBusyId(null);
    }

    async function handleCreate(e: React.FormEvent) {
        e.preventDefault();
        if (create.submitting) return;
        const alias = create.alias.trim();
        if (!alias) {
            setCreate((prev) => ({ ...prev, error: '请填写 Key 别名' }));
            return;
        }
        setCreate((prev) => ({ ...prev, submitting: true, error: null }));
        try {
            const r = await fetch('/api/portal/keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ alias }),
            });
            if (!r.ok) {
                const data = await r.json().catch(() => ({}));
                setCreate((prev) => ({
                    ...prev,
                    submitting: false,
                    error: typeof data?.error === 'string' ? data.error : `创建失败 (${r.status})`,
                }));
                return;
            }
            const data = (await r.json()) as {
                id: string;
                key_alias: string;
                key: string;
                created_at: string;
            };
            const newRow: KeyRow = {
                id: data.id,
                key_alias: data.key_alias,
                masked_key: maskKey(data.key),
                created_at: data.created_at,
            };
            setRows((prev) => [...prev, newRow]);
            // Auto-reveal the brand-new key so the customer can copy it
            // immediately. The auto-hide timer above re-masks after 10s.
            setReveal((prev) => ({ ...prev, [data.id]: data.key }));
            setCreate({ open: false, alias: '', submitting: false, error: null });
        } catch (err) {
            setCreate((prev) => ({
                ...prev,
                submitting: false,
                error: err instanceof Error ? err.message : '网络错误',
            }));
        }
    }

    const tableHeader = useMemo(
        () => (
            <thead>
                <tr>
                    <th style={tableHeaderStyle}>别名</th>
                    <th style={tableHeaderStyle}>API Key</th>
                    <th style={tableHeaderStyle}>创建时间</th>
                    <th style={{ ...tableHeaderStyle, textAlign: 'right' }}>操作</th>
                </tr>
            </thead>
        ),
        [],
    );

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                <button
                    type="button"
                    onClick={() => setCreate({ open: true, alias: '', submitting: false, error: null })}
                    disabled={atLimit || create.open}
                    title={atLimit ? `已达上限 (${MAX_TOKENS_PER_USER})` : ''}
                    style={{
                        background: atLimit ? '#a8aebc' : '#0a1535',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 4,
                        padding: '8px 16px',
                        fontSize: 13,
                        cursor: atLimit ? 'not-allowed' : 'pointer',
                    }}
                >
                    {atLimit ? `已达上限 (${MAX_TOKENS_PER_USER})` : '+ 创建新 Key'}
                </button>
            </div>

            {create.open && (
                <form
                    onSubmit={handleCreate}
                    style={{
                        background: '#fff',
                        border: '1px solid #e5e8ee',
                        borderRadius: 6,
                        padding: 16,
                        marginBottom: 16,
                        display: 'flex',
                        gap: 8,
                        alignItems: 'flex-start',
                    }}
                >
                    <div style={{ flex: 1 }}>
                        <input
                            type="text"
                            placeholder="为 Key 起个名字(例如 production / 测试 / mobile-app)"
                            value={create.alias}
                            onChange={(e) =>
                                setCreate((prev) => ({ ...prev, alias: e.target.value, error: null }))
                            }
                            maxLength={50}
                            autoFocus
                            style={{
                                width: '100%',
                                padding: '8px 10px',
                                border: '1px solid #e5e8ee',
                                borderRadius: 4,
                                fontSize: 13,
                                boxSizing: 'border-box',
                            }}
                        />
                        {create.error && (
                            <p style={{ margin: '6px 0 0', color: '#c44', fontSize: 12 }}>{create.error}</p>
                        )}
                    </div>
                    <button
                        type="submit"
                        disabled={create.submitting || !create.alias.trim()}
                        style={{
                            background: create.submitting ? '#a8aebc' : '#0a1535',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 4,
                            padding: '8px 14px',
                            fontSize: 13,
                            cursor: create.submitting ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {create.submitting ? '创建中…' : '创建'}
                    </button>
                    <button
                        type="button"
                        onClick={() => setCreate({ open: false, alias: '', submitting: false, error: null })}
                        disabled={create.submitting}
                        style={{
                            background: '#fff',
                            color: '#5a6478',
                            border: '1px solid #e5e8ee',
                            borderRadius: 4,
                            padding: '8px 14px',
                            fontSize: 13,
                            cursor: create.submitting ? 'not-allowed' : 'pointer',
                        }}
                    >
                        取消
                    </button>
                </form>
            )}

            {globalError && (
                <p
                    style={{
                        color: '#c44',
                        background: '#fdecea',
                        border: '1px solid #f0c6c2',
                        padding: '8px 12px',
                        borderRadius: 4,
                        margin: '0 0 12px',
                        fontSize: 13,
                    }}
                >
                    {globalError}
                </p>
            )}

            {rows.length === 0 ? (
                <div
                    style={{
                        background: '#fff',
                        border: '1px dashed #e5e8ee',
                        borderRadius: 6,
                        padding: 32,
                        textAlign: 'center',
                        color: '#8a92a4',
                        fontSize: 13,
                    }}
                >
                    暂无 API Key,点击右上角「+ 创建新 Key」开始。
                </div>
            ) : (
                <table
                    style={{
                        width: '100%',
                        background: '#fff',
                        border: '1px solid #e5e8ee',
                        borderRadius: 6,
                        borderCollapse: 'collapse',
                        overflow: 'hidden',
                    }}
                >
                    {tableHeader}
                    <tbody>
                        {rows.map((row) => {
                            const revealed = reveal[row.id];
                            const showCopied = copied[row.id];
                            const busy = busyId === row.id;
                            return (
                                <tr key={row.id}>
                                    <td style={tableCellStyle}>{row.key_alias}</td>
                                    <td
                                        style={{
                                            ...tableCellStyle,
                                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                                            color: revealed ? '#0a1535' : '#5a6478',
                                        }}
                                    >
                                        {revealed ?? row.masked_key}
                                    </td>
                                    <td style={{ ...tableCellStyle, color: '#5a6478' }}>
                                        {new Date(row.created_at).toLocaleString('zh-CN')}
                                    </td>
                                    <td
                                        style={{
                                            ...tableCellStyle,
                                            textAlign: 'right',
                                            display: 'flex',
                                            gap: 6,
                                            justifyContent: 'flex-end',
                                        }}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => handleReveal(row.id)}
                                            disabled={busy || !!revealed}
                                            style={actionButtonStyle(busy || !!revealed)}
                                        >
                                            {revealed ? '已显示' : '显示'}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => handleCopy(row.id)}
                                            disabled={busy}
                                            style={actionButtonStyle(busy)}
                                        >
                                            {showCopied ? '已复制 ✓' : '复制'}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => handleRevoke(row.id)}
                                            disabled={busy}
                                            style={{
                                                ...actionButtonStyle(busy),
                                                color: '#c44',
                                                borderColor: '#f0c6c2',
                                            }}
                                        >
                                            撤销
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </div>
    );
}

function actionButtonStyle(disabled: boolean): React.CSSProperties {
    return {
        background: '#fff',
        color: '#1a2540',
        border: '1px solid #e5e8ee',
        borderRadius: 4,
        padding: '4px 10px',
        fontSize: 12,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
    };
}
