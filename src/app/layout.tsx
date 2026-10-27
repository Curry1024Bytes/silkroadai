import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Footer } from '@/components/Footer';
import { htmlLang } from '@/lib/i18n';
import { LocaleProvider } from '@/lib/i18n/client';
import { getLocale } from '@/lib/i18n/server';

/**
 * Inter loaded once at the root layout — applies to every route in the
 * app, both authenticated and public. W7 P3 sweep: previously only the
 * landing page imported it locally, so non-landing routes briefly
 * flashed system-ui before any cached `Inter` showed up (FOUT). Hoisting
 * the import here means Next bakes a `font-display: swap` <link> into
 * every page's <head>, and the @theme `--font-sans` token (which lists
 * Inter first) actually resolves.
 *
 * `display: 'swap'` lets the system fallback render immediately; the
 * woff2 swaps in once it's loaded. `variable: '--font-inter'` exposes
 * a CSS var the body className can hook on to ensure Tailwind's
 * `font-sans` utility resolves to the loaded font (not the fallback
 * stack alone).
 */
const inter = Inter({
    subsets: ['latin'],
    display: 'swap',
    weight: ['400', '500', '600', '700'],
    variable: '--font-inter',
});

export const metadata: Metadata = {
    // W5 D5: was "Sub2API Recharge" (W1 sub2apipay legacy). Pages override
    // their own titles in their `metadata` exports; this is just the fallback.
    title: 'Silk Road AI Portal',
    description: 'Silk Road AI — connecting global intelligence',
};

export default async function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    // Site locale: portal_locale cookie → Accept-Language → zh. Server components
    // call getLocale() themselves; client islands read <LocaleProvider>. See
    // src/lib/i18n/README.md.
    const locale = await getLocale();

    // W5 D5: body is a column flex so Footer pins to bottom even on short
    // pages. The wrapper div around children takes flex: 1 so its content
    // (which often has its own min-height: 100vh) still fills the viewport.
    // <LocaleProvider> deliberately wraps <html> rather than sitting inside
    // <body>: with the client boundary as a direct child of <body>, Next 16 dev
    // reported a hydration mismatch (client expected the flex wrapper where the
    // server DOM had <main>) — wrapping the root element keeps the server/client
    // trees aligned. Verified in-browser 2026-10-27; a context provider emits no
    // DOM so the markup is identical either way.
    return (
        <LocaleProvider locale={locale}>
            <html lang={htmlLang(locale)} className={inter.variable}>
                <body className="antialiased" style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>{children}</div>
                    <Footer locale={locale} />
                </body>
            </html>
        </LocaleProvider>
    );
}
