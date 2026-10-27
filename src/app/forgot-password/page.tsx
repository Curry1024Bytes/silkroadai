/**
 * Forgot-password UI. A visitor who can't log in lands here from the
 * "忘记密码?" link on /login, enters their email, and the page POSTs to
 * /api/auth/forgot-password to trigger the reset email. Visual shell mirrors
 * /login (warm-paper backdrop + brand Card) so the handoff is continuous.
 *
 * The actual token-consuming step lives at /reset-password?token=… (opened
 * from the email). This page only kicks off the email.
 */
import { BrandLogo } from '@/components/brand/BrandLogo';
import { Card } from '@/components/ui/Card';
import { getLocale } from '@/lib/i18n/server';
import { pickMessages } from '@/lib/i18n';
import { authMessages } from '@/lib/i18n/messages/auth';
import { ForgotPasswordForm } from './forgot-password-form';

export async function generateMetadata() {
    const m = pickMessages(authMessages, await getLocale());
    return { title: m.forgot.pageTitle };
}

export default async function ForgotPasswordPage() {
    const m = pickMessages(authMessages, await getLocale());
    return (
        <main className="min-h-screen flex items-center justify-center bg-paper px-4 py-10">
            <Card className="w-full max-w-md p-8">
                <header className="mb-6 flex items-center gap-3">
                    <BrandLogo variant="primary-flat" size={28} />
                    <p className="m-0 text-xs text-minor-ink">Connecting Global Intelligence.</p>
                </header>
                <h2 className="m-0 mb-4 text-base font-semibold text-navy">{m.forgot.heading}</h2>
                <ForgotPasswordForm />
            </Card>
        </main>
    );
}
