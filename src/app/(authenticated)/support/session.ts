import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';

/** headers() → NextRequest 桥接,复用 getCurrentUser(同 /keys /settings/storage 写法)。 */
export async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/support', { method: 'GET', headers: { cookie } });
    return getCurrentUser(req);
}

export function formatDateTime(d: Date | string | number, intl: string): string {
    return new Date(d).toLocaleString(intl, { timeZone: 'Asia/Shanghai', hour12: false });
}
