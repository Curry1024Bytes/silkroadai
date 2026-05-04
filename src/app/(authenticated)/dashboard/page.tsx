import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: '概览 — Silk Road AI' };

/** Bridge identical to layout.tsx — server-component access to the
 *  authenticated user. The layout already verified non-null; we re-fetch
 *  here only because the layout cannot pass props down to nested pages. */
async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/dashboard', {
        method: 'GET',
        headers: { cookie },
    });
    return getCurrentUser(req);
}

const cardStyle: React.CSSProperties = {
    background: '#fff',
    border: '1px solid #e5e8ee',
    borderRadius: 6,
    padding: 20,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
};

export default async function DashboardPage() {
    const user = await getSessionUser();
    // Layout has already gated; this branch should never run, but typescript
    // narrows `user` to non-null only after the explicit check.
    if (!user) {
        return null;
    }

    return (
        <section>
            <h1 style={{ margin: '0 0 8px', fontSize: 22, color: '#0a1535' }}>
                欢迎,{user.nickname || user.email.split('@')[0]}
            </h1>
            <p style={{ margin: '0 0 24px', fontSize: 13, color: '#5a6478' }}>
                这是您的客户后台。在这里管理 API Keys、查看余额与用量。
            </p>

            <div
                style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                    gap: 16,
                }}
            >
                <article style={cardStyle}>
                    <h2 style={{ margin: '0 0 8px', fontSize: 14, color: '#0a1535' }}>API Keys</h2>
                    <p style={{ margin: 0, fontSize: 12, color: '#5a6478' }}>
                        管理您的访问密钥(D5 上线)
                    </p>
                </article>
                <article style={cardStyle}>
                    <h2 style={{ margin: '0 0 8px', fontSize: 14, color: '#0a1535' }}>余额</h2>
                    <p style={{ margin: 0, fontSize: 12, color: '#5a6478' }}>
                        实时余额 + 充值流水(D6 上线)
                    </p>
                </article>
                <article style={cardStyle}>
                    <h2 style={{ margin: '0 0 8px', fontSize: 14, color: '#0a1535' }}>用量</h2>
                    <p style={{ margin: 0, fontSize: 12, color: '#5a6478' }}>
                        按模型 / 按日的调用统计(D7 上线)
                    </p>
                </article>
            </div>
        </section>
    );
}
