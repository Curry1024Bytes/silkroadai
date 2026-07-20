'use client';

export function AdminLogoutButton() {
    async function onLogout() {
        try {
            await fetch('/api/auth/logout', { method: 'POST' });
        } catch {
            // 失败也回登录页
        }
        window.location.href = '/enterprise-admin/login';
    }
    return (
        <button onClick={onLogout} className="rounded border border-gray-600 px-2 py-1 text-xs hover:bg-gray-800">
            退出
        </button>
    );
}
