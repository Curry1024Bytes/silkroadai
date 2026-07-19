'use client';

export function LogoutButton() {
    async function onLogout() {
        try {
            await fetch('/api/auth/logout', { method: 'POST' });
        } catch {
            // 清 cookie 失败也照样回登录页(下一次请求会被守门挡住)
        }
        window.location.href = '/enterprise/login';
    }
    return (
        <button onClick={onLogout} className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">
            退出
        </button>
    );
}
