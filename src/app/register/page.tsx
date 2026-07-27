/**
 * /register — short-URL alias for /portal/register (fix/invite-landing).
 *
 * Reseller landing links go out as `llmroute.club/register?invite=X` so
 * the URL the customer sees is short + memorable. Server-side redirect
 * to /portal/register preserves the query string and keeps the
 * implementation single-sourced.
 *
 * For logged-in users, the downstream /portal/register page itself
 * checks the session and redirects to /dashboard — we don't need a
 * second check here. (Brief Change 4: confirm not break — confirmed.)
 */
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';
export const metadata = { title: '注册 — LLmRoute' };

export default async function RegisterAliasPage({ searchParams }: { searchParams: Promise<{ invite?: string }> }) {
    const sp = await searchParams;
    const qs = sp.invite ? `?invite=${encodeURIComponent(sp.invite)}` : '';
    redirect(`/portal/register${qs}`);
}
