'use client';

import { useId, useState, type FormEvent } from 'react';
import type { Locale } from '@/lib/locale';

export function CustomerAliasEditor({
    customerId,
    alias,
    locale,
    isDark,
    onSaved,
}: {
    customerId: string;
    alias: string | null;
    locale: Locale;
    isDark: boolean;
    onSaved: (alias: string | null) => void;
}) {
    const isEnglish = locale === 'en';
    const label = isEnglish ? 'Admin alias' : '后台别名';
    const inputId = useId();
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    const button = 'rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50';
    const secondary = isDark ? 'border-slate-600 hover:bg-slate-700' : 'border-slate-300 hover:bg-slate-100';

    async function save(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (saving) return;
        const value = draft.trim() || null;
        if (value === alias) {
            setEditing(false);
            return;
        }
        setSaving(true);
        setError('');
        try {
            const response = await fetch('/api/admin/customers/' + encodeURIComponent(customerId), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ admin_alias: value }),
            });
            if (!response.ok) throw new Error();
            const result: { admin_alias: string | null } = await response.json();
            onSaved(result.admin_alias);
            setEditing(false);
        } catch {
            setError(isEnglish ? 'Could not save the alias. Please try again.' : '别名保存失败，请重试。');
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="col-span-full min-w-0">
            {editing ? (
                <form onSubmit={save} className="space-y-2">
                    <label className={'block text-xs ' + muted} htmlFor={inputId}>
                        {label}
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                        <input
                            id={inputId}
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            maxLength={80}
                            disabled={saving}
                            aria-describedby={inputId + '-hint'}
                            className={
                                'w-full max-w-xs rounded-md border px-2.5 py-1.5 text-sm ' +
                                (isDark ? 'border-slate-600 bg-slate-900' : 'border-slate-300 bg-white')
                            }
                        />
                        <button
                            type="submit"
                            disabled={saving}
                            className={button + ' border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-700'}
                        >
                            {saving ? (isEnglish ? 'Saving…' : '保存中…') : isEnglish ? 'Save' : '保存'}
                        </button>
                        <button
                            type="button"
                            disabled={saving}
                            className={button + ' ' + secondary}
                            onClick={() => setEditing(false)}
                        >
                            {isEnglish ? 'Cancel' : '取消'}
                        </button>
                    </div>
                    <p className={'text-xs ' + muted} id={inputId + '-hint'}>
                        {isEnglish
                            ? 'Admin only. Leave blank to remove the alias.'
                            : '仅后台可见，留空保存可清除别名。'}
                    </p>
                    {error && (
                        <p role="alert" className={'text-xs ' + (isDark ? 'text-red-300' : 'text-red-700')}>
                            {error}
                        </p>
                    )}
                </form>
            ) : (
                <>
                    <div className={'text-xs ' + muted}>{label}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                        <span className="min-w-0 break-all text-sm">{alias || '—'}</span>
                        <button
                            type="button"
                            className={button + ' ' + secondary}
                            onClick={() => {
                                setDraft(alias ?? '');
                                setError('');
                                setEditing(true);
                            }}
                        >
                            {isEnglish ? (alias ? 'Edit alias' : 'Add alias') : alias ? '修改别名' : '设置别名'}
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}
