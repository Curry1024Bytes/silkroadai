/**
 * Shared renderer for /terms /privacy /refund (W5 D5).
 *
 * Each public legal page is a thin wrapper that points this component at a
 * specific markdown file under `src/content/legal/`. The markdown content
 * is repo-trusted (we author it, not user-supplied), so we render via
 * `dangerouslySetInnerHTML` after passing through `marked` synchronously.
 *
 * Style baseline matches /login + /reset-password — inline style + brand
 * colors #0e1715 (primary) / #53645f (secondary) / #f3f6f5 (page bg). The
 * article width caps at 720px for comfortable line-length on prose.
 *
 * `marked.use({ async: false })` keeps the conversion synchronous so server
 * components can return JSX directly without an extra await. `gfm: true`
 * enables tables / strikethrough that the legal docs author may use.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import Link from 'next/link';
import { marked } from 'marked';

marked.use({ async: false, gfm: true, breaks: false });

interface LegalDocPageProps {
    /** File name only — file lives under src/content/legal/. */
    file: 'service-terms.md' | 'privacy-policy.md' | 'refund-policy.md';
}

export async function LegalDocPage({ file }: LegalDocPageProps) {
    const raw = await fs.readFile(path.join(process.cwd(), 'src/content/legal', file), 'utf8');
    // marked synchronous mode — no Promise unwrap needed.
    const html = marked.parse(raw) as string;

    return (
        <main
            style={{
                minHeight: '100vh',
                background: '#f3f6f5',
                padding: '24px 16px',
            }}
        >
            <div
                style={{
                    maxWidth: 720,
                    margin: '0 auto',
                    background: '#fff',
                    border: '1px solid #e5e8ee',
                    borderRadius: 8,
                    padding: '24px 28px',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                }}
            >
                <Link
                    href="/"
                    style={{
                        display: 'inline-block',
                        marginBottom: 16,
                        fontSize: 13,
                        color: '#53645f',
                        textDecoration: 'none',
                    }}
                >
                    ← 返回 LLmRoute
                </Link>
                {/* Style the rendered HTML in-place via a wrapper class +
                 *  scoped <style>. dangerouslySetInnerHTML is safe here —
                 *  source markdown is repo-controlled (no user input). */}
                <article className="legal-doc" dangerouslySetInnerHTML={{ __html: html }} />
                <style>{`
                    .legal-doc { color: #1d1d1f; line-height: 1.7; font-size: 14px; }
                    .legal-doc h1 { font-size: 22px; color: #0e1715; margin: 8px 0 16px; }
                    .legal-doc h2 { font-size: 17px; color: #0e1715; margin: 28px 0 12px; padding-top: 4px; border-top: 1px solid #e5e8ee; }
                    .legal-doc h3 { font-size: 15px; color: #0e1715; margin: 20px 0 10px; }
                    .legal-doc h4 { font-size: 14px; color: #0e1715; margin: 16px 0 8px; }
                    .legal-doc p { margin: 8px 0 12px; }
                    .legal-doc ul, .legal-doc ol { padding-left: 22px; margin: 8px 0 12px; }
                    .legal-doc li { margin: 4px 0; }
                    .legal-doc strong { color: #0e1715; }
                    .legal-doc code { background: #f3f6f5; padding: 1px 6px; border-radius: 3px; font-size: 13px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
                    .legal-doc blockquote { border-left: 3px solid #0e1715; padding: 6px 14px; margin: 12px 0; background: #f3f6f5; color: #53645f; font-size: 13px; }
                    .legal-doc a { color: #0e1715; }
                    .legal-doc table { border-collapse: collapse; width: 100%; margin: 12px 0; }
                    .legal-doc th, .legal-doc td { border: 1px solid #e5e8ee; padding: 6px 10px; text-align: left; font-size: 13px; }
                    .legal-doc th { background: #f3f6f5; }
                    .legal-doc hr { border: none; border-top: 1px solid #e5e8ee; margin: 20px 0; }
                `}</style>
            </div>
        </main>
    );
}
