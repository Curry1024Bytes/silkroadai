import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './globals.css';
import { Footer } from '@/components/Footer';

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
  const headerStore = await headers();
  const pathname = headerStore.get('x-pathname') || '';
  const search = headerStore.get('x-search') || '';
  const locale = new URLSearchParams(search).get('lang')?.trim().toLowerCase() === 'en' ? 'en' : 'zh';
  const htmlLang = locale === 'en' ? 'en' : 'zh-CN';

  // W5 D5: body is a column flex so Footer pins to bottom even on short
  // pages. The wrapper div around children takes flex: 1 so its content
  // (which often has its own min-height: 100vh) still fills the viewport.
  return (
    <html lang={htmlLang} data-pathname={pathname}>
      <body
        className="antialiased"
        style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}
      >
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
        <Footer />
      </body>
    </html>
  );
}
