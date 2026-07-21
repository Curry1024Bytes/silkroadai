'use client';

/**
 * 企业门户登录表单(P2)—— 复用主站 POST /api/auth/login(email+password → httpOnly cookie)。
 * 企业客户密码由 admin 开户/set-password 下发;无注册、无 OAuth、无找回(联系商务)。
 */
import { useState } from 'react';

export function EnterpriseLoginForm() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function onSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            });
            if (res.ok) {
                window.location.href = '/enterprise';
                return;
            }
            setError(res.status === 401 ? '邮箱或密码错误' : '登录失败,请稍后重试');
        } catch {
            setError('网络错误,请稍后重试');
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={onSubmit} className="space-y-4">
            <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                    邮箱
                </label>
                <input
                    id="email"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
            </div>
            <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                    密码
                </label>
                <input
                    id="password"
                    type="password"
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
                type="submit"
                disabled={busy}
                className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
                {busy ? '登录中…' : '登录'}
            </button>
            <p className="text-xs text-gray-500">账号与密码由商务开通下发;如遗忘请联系对接人重置。</p>
        </form>
    );
}
