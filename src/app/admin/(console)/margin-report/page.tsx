import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest } from 'next/server';
import { resolveAdmin } from '@/lib/admin/auth';
import MarginDashboard from './margin-dashboard';

export const dynamic = 'force-dynamic';

export default async function MarginReportPage() {
    const headersList = await headers();
    const request = new NextRequest('http://internal/admin/margin-report', {
        headers: { cookie: headersList.get('cookie') ?? '' },
    });
    if (!(await resolveAdmin(request, 'superadmin'))) redirect('/admin/login');
    return <MarginDashboard />;
}
