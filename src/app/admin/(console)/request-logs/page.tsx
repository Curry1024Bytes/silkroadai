/**
 * 数据存储第③步 — 请求日志查看页(superadmin only)。
 *
 * (console)/layout.tsx 是 **admin+** 粗门;本页 + 背后所有 API route 各自再
 * `requireRole('superadmin')` 细门(brief §4)。这里做 server 端 superadmin 守门
 * (非 superadmin → 跳 /admin/login);交互表格 + 原文懒加载在 client island,
 * 数据走 superadmin-gated 的 /api/admin/request-logs*(审计写在那里)。
 *
 * break-glass ADMIN_TOKEN 是给 API/脚本的,不用于进 UI(与 layout 注释一致)——
 * 浏览器导航不带 ADMIN_TOKEN 头,故本页只放 session superadmin 进。
 */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest } from 'next/server';
import { resolveAdmin } from '@/lib/admin/auth';
import { RequestLogsBrowser } from './request-logs-browser';

export const dynamic = 'force-dynamic';

export default async function RequestLogsPage() {
    const h = await headers();
    const req = new NextRequest('http://internal/admin/request-logs', {
        method: 'GET',
        headers: { cookie: h.get('cookie') || '' },
    });
    const admin = await resolveAdmin(req, 'superadmin');
    if (!admin) redirect('/admin/login');
    return <RequestLogsBrowser />;
}
