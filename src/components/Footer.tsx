/**
 * Global footer (W5 D5).
 *
 * Renders at the bottom of every page via the root layout. Inline-styled
 * to match /login + /pay color baseline (#0a1535 primary, #5a6478
 * secondary). Slim — ~60-80px tall — so it never competes with primary
 * page content.
 *
 * Server component: pure markup, no interactivity. Picks up the current
 * year at render time.
 */
import Link from 'next/link';
import { Logo } from '@/components/brand/Logo';

const linkStyle: React.CSSProperties = {
    color: '#5a6478',
    textDecoration: 'none',
    fontSize: 12,
};

export function Footer() {
    const year = new Date().getFullYear();
    return (
        <footer
            style={{
                background: '#fff',
                borderTop: '1px solid #e5e8ee',
                padding: '14px 24px',
                fontSize: 12,
                color: '#5a6478',
                display: 'flex',
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: 16,
                justifyContent: 'space-between',
                alignItems: 'center',
            }}
        >
            <nav style={{ display: 'flex', gap: 16 }}>
                <Link href="/models" style={linkStyle}>
                    模型清单
                </Link>
                <Link href="/terms" style={linkStyle}>
                    服务条款
                </Link>
                <Link href="/privacy" style={linkStyle}>
                    隐私政策
                </Link>
                <Link href="/refund" style={linkStyle}>
                    退款政策
                </Link>
            </nav>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <span>
                    客服:微信 <code style={{ fontSize: 12 }}>Global_Ads</code>
                </span>
                <span>
                    <a
                        href="mailto:support@silkroadai.io"
                        style={{ ...linkStyle, color: '#0a1535' }}
                    >
                        support@silkroadai.io
                    </a>
                </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* Footer is on a white background → primary-flat (avoids
                 *  gradient aliasing at this small render size). Brief:
                 *  footer size=20. linkHome=true (the default) so the
                 *  logo doubles as a "back home" affordance. */}
                <Logo variant="primary-flat" size={20} />
                <span>© {year}</span>
            </div>
        </footer>
    );
}
