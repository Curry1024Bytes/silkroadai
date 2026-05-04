'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface NavItem {
    href: string;
    label: string;
}

const NAV: NavItem[] = [
    { href: '/dashboard', label: '概览' },
    { href: '/keys', label: 'API Keys' },
    { href: '/balance', label: '余额' },
    { href: '/usage', label: '用量' },
];

const SIDEBAR_WIDTH = 200;

export function Sidebar() {
    const pathname = usePathname();

    return (
        <nav
            style={{
                width: SIDEBAR_WIDTH,
                minWidth: SIDEBAR_WIDTH,
                background: '#fff',
                borderRight: '1px solid #e5e8ee',
                padding: '16px 0',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
            }}
        >
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {NAV.map((item) => {
                    const active = pathname === item.href;
                    return (
                        <li key={item.href}>
                            <Link
                                href={item.href}
                                style={{
                                    display: 'block',
                                    padding: '10px 20px',
                                    color: active ? '#0a1535' : '#5a6478',
                                    background: active ? '#f0f2f8' : 'transparent',
                                    borderLeft: active ? '3px solid #0a1535' : '3px solid transparent',
                                    fontWeight: active ? 600 : 400,
                                    fontSize: 14,
                                    textDecoration: 'none',
                                }}
                                aria-current={active ? 'page' : undefined}
                            >
                                {item.label}
                            </Link>
                        </li>
                    );
                })}
            </ul>

            <div style={{ padding: '0 16px 16px' }}>
                <Link
                    href="/pay"
                    style={{
                        display: 'block',
                        textAlign: 'center',
                        padding: '10px 0',
                        background: '#0a1535',
                        color: '#fff',
                        borderRadius: 4,
                        fontSize: 14,
                        textDecoration: 'none',
                    }}
                >
                    充值
                </Link>
            </div>
        </nav>
    );
}
