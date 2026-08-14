'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
    { href: '/enterprise', label: '概览' },
    { href: '/enterprise/billing', label: '计费流水' },
    { href: '/enterprise/logs', label: '调用日志' },
    { href: '/enterprise/keys', label: 'API 密钥' },
    { href: '/enterprise/assets', label: '素材库' },
    { href: '/enterprise/storage', label: '自定义存储' },
    { href: '/enterprise/docs', label: '文档' },
];

export function EnterpriseNav() {
    const pathname = usePathname();
    return (
        <nav className="-mb-px flex gap-1 overflow-x-auto">
            {TABS.map((t) => {
                const active = t.href === '/enterprise' ? pathname === '/enterprise' : pathname.startsWith(t.href);
                return (
                    <Link
                        key={t.href}
                        href={t.href}
                        className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${
                            active
                                ? 'border-blue-600 font-medium text-blue-700'
                                : 'border-transparent text-gray-500 hover:text-gray-800'
                        }`}
                    >
                        {t.label}
                    </Link>
                );
            })}
        </nav>
    );
}
