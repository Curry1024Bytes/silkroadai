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
import { ForgotPasswordForm } from './forgot-password-form';

export const metadata = { title: '找回密码 — LLmRoute' };

export default function ForgotPasswordPage() {
    return (
        <main className="min-h-screen flex items-center justify-center bg-paper px-4 py-10">
            <Card className="w-full max-w-md p-8">
                <header className="mb-6 flex items-center gap-3">
                    <BrandLogo variant="primary-flat" size={28} />
                    <p className="m-0 text-xs text-minor-ink">One route. Every model.</p>
                </header>
                <h2 className="m-0 mb-4 text-base font-semibold text-navy">找回密码</h2>
                <ForgotPasswordForm />
            </Card>
        </main>
    );
}
