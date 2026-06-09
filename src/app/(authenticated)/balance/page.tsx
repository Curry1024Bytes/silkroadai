/**
 * /balance — merged into the unified /dashboard console (客户控制台三合一).
 *
 * Balance cards, the recharge history table, and the low-balance alert
 * threshold form all live on /dashboard now. This route is kept as a 307
 * redirect (the default for `redirect()` during render) so existing
 * bookmarks / links / docs don't 404.
 */
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function BalancePage(): never {
    redirect('/dashboard');
}
