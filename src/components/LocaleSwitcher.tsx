'use client';

/**
 * 中文 / EN toggle. Writes the `portal_locale` cookie and refreshes the
 * page so every server component and client island re-renders in the new
 * language (root layout re-reads the cookie into `<LocaleProvider>`). URLs
 * never change.
 *
 * Styled with design tokens only so it sits in both the landing header
 * (inline-style chrome) and the Tailwind console header.
 */
import { useState } from 'react';
import { LOCALES, type Locale } from '@/lib/i18n';
import { useLocale, useMessages, writeLocaleCookie } from '@/lib/i18n/client';
import { commonMessages } from '@/lib/i18n/messages/common';

export function LocaleSwitcher({ className }: { className?: string }) {
    const locale = useLocale();
    const m = useMessages(commonMessages);
    const [pending, setPending] = useState(false);

    // Full reload rather than router.refresh(): no App Router context needed
    // (keeps renderToString tests provider-free) and client state such as the
    // vendored plaza's i18next instance re-initialises cleanly.
    function select(next: Locale) {
        if (next === locale || pending) return;
        writeLocaleCookie(next);
        setPending(true);
        window.location.reload();
    }

    return (
        <div
            role="group"
            aria-label={m.locale.switcherLabel}
            data-locale={locale}
            className={[
                'inline-flex items-center rounded-md border border-brand-border bg-surface text-xs font-medium',
                pending ? 'opacity-70' : '',
                className ?? '',
            ].join(' ')}
        >
            {LOCALES.map((code) => {
                const active = code === locale;
                return (
                    <button
                        key={code}
                        type="button"
                        lang={code === 'en' ? 'en' : 'zh-CN'}
                        aria-pressed={active}
                        onClick={() => select(code)}
                        className={[
                            'px-2 py-1 leading-none transition-colors duration-150 ease-brand cursor-pointer border-0 bg-transparent',
                            active ? 'text-navy font-semibold' : 'text-muted-ink hover:text-navy',
                        ].join(' ')}
                    >
                        {m.locale[code]}
                    </button>
                );
            })}
        </div>
    );
}
