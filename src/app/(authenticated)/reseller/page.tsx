/**
 * /reseller — entry page (PR-U2).
 *
 * Server-side gate: when the user already has an active Reseller row,
 * redirect to /reseller/dashboard. Otherwise render the join page
 * (agreement summary + checkbox + CTA → POST /api/portal/reseller/join).
 *
 * Layout handles auth; we just need user.id to compute reseller status.
 */
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { fetchResellerStatus } from '@/lib/reseller/fetch-status';
import { JoinForm } from './join-form';
import { AgreementDisclosure } from '@/components/reseller/AgreementDisclosure';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { getLocale } from '@/lib/i18n/server';
import { pickMessages } from '@/lib/i18n';
import { resellerMessages } from '@/lib/i18n/messages/reseller';

export const dynamic = 'force-dynamic';
export async function generateMetadata() {
    return { title: pickMessages(resellerMessages, await getLocale()).meta.entryTitle };
}

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/reseller', {
        method: 'GET',
        headers: { cookie },
    });
    return getCurrentUser(req);
}

export default async function ResellerEntryPage() {
    const user = await getSessionUser();
    if (!user) return null; // layout gates; defensive narrowing
    const { status } = await fetchResellerStatus(user.id);
    if (status === 'active') redirect('/reseller/dashboard');
    const locale = await getLocale();
    const m = pickMessages(resellerMessages, locale).entry;

    // Suspended / banned — show a status page so sidebar grey-entry clicks
    // land on something explanatory instead of the join form (which would
    // crash on the unique constraint or worse — quietly try to re-join).
    if (status === 'suspended' || status === 'banned') {
        const isBanned = status === 'banned';
        return (
            <div className="space-y-6">
                <Card>
                    <CardHeader>
                        <div className="flex flex-col gap-1">
                            <p className="text-xs uppercase tracking-wider text-muted-ink m-0">{m.statusKicker}</p>
                            <CardTitle as="h1">{isBanned ? m.bannedTitle : m.suspendedTitle}</CardTitle>
                        </div>
                    </CardHeader>
                    <CardContent>
                        <p className="text-sm leading-relaxed text-muted-ink m-0">
                            {isBanned ? m.bannedBody : m.suspendedBody}
                        </p>
                    </CardContent>
                </Card>
            </div>
        );
    }

    // null status → never joined → render join page.
    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <div className="flex flex-col gap-1">
                        <p className="text-xs uppercase tracking-wider text-muted-ink m-0">{m.programKicker}</p>
                        <CardTitle as="h1">{m.joinTitle}</CardTitle>
                    </div>
                </CardHeader>
                <CardContent>
                    <p className="text-sm leading-relaxed text-muted-ink mb-4">
                        {m.introBefore} <strong className="text-navy">{m.introStrong}</strong>
                        {m.introAfter}
                    </p>
                    <ul className="text-sm text-muted-ink space-y-1.5 pl-5 list-disc">
                        {m.bullets.map((b) => (
                            <li key={b}>{b}</li>
                        ))}
                    </ul>
                </CardContent>
            </Card>

            <AgreementDisclosure />

            <JoinForm />
        </div>
    );
}
