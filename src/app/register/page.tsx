/**
 * /register — short-URL alias for /portal/register (fix/invite-landing).
 *
 * Reseller landing links go out as `silkroadai.io/register?invite=X` so
 * the URL the customer sees is short + memorable. Server-side redirect
 * to /portal/register preserves the query string and keeps the
 * implementation single-sourced.
 *
 * For logged-in users, the downstream /portal/register page itself
 * checks the session and redirects to /dashboard — we don't need a
 * second check here. (Brief Change 4: confirm not break — confirmed.)
 */
import { redirect } from 'next/navigation';
import { getLocale } from '@/lib/i18n/server';
import { pickMessages } from '@/lib/i18n';
import { authMessages } from '@/lib/i18n/messages/auth';

export const dynamic = 'force-dynamic';
export async function generateMetadata() {
    const m = pickMessages(authMessages, await getLocale());
    return { title: m.register.pageTitle };
}

export default async function RegisterAliasPage({ searchParams }: { searchParams: Promise<{ invite?: string }> }) {
    const sp = await searchParams;
    const qs = sp.invite ? `?invite=${encodeURIComponent(sp.invite)}` : '';
    redirect(`/portal/register${qs}`);
}
