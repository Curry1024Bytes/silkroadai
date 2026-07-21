/** 运营后台主页:server 拉客户列表 → client 面板(全部操作走 /api/admin/enterprise/*)。 */
import { AdminPanel } from './admin-panel';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · 运营后台' };

export default function EnterpriseAdminPage() {
    return <AdminPanel />;
}
