/**
 * P6b §0 — nav 收敛: partner admin (role=admin) only sees tenant-scoped views
 * (Dashboard + Orders); platform-level items are superadmin-only.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => '/admin',
}));

import { AdminShell } from '@/app/admin/(console)/admin-shell';

const PLATFORM_LABELS = ['支付配置', '渠道管理', '渠道分组', '模型管理', '定价', '影子计量', '订阅管理', '租户管理'];

describe('AdminShell nav role-filter', () => {
    it('partner admin (role=admin) → Dashboard + Orders + Customers, no platform items', () => {
        const html = renderToString(
            <AdminShell adminEmail="partner@acme.com" adminRole="admin">
                <div>child</div>
            </AdminShell>,
        );
        expect(html).toContain('数据概览');
        expect(html).toContain('订单管理');
        // P6b-2: read-only customers view is visible to partner admins (not superadminOnly).
        expect(html).toContain('客户管理');
        for (const label of PLATFORM_LABELS) expect(html).not.toContain(label);
    });

    it('superadmin → all platform items visible (+ Customers)', () => {
        const html = renderToString(
            <AdminShell adminEmail="ops@silkroadai.io" adminRole="superadmin">
                <div>child</div>
            </AdminShell>,
        );
        expect(html).toContain('数据概览');
        expect(html).toContain('客户管理');
        for (const label of PLATFORM_LABELS) expect(html).toContain(label);
    });
});
