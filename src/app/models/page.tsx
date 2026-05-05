/**
 * Public /models page (W6 D3) — full catalog of models available through
 * https://ai.silkroadai.io with double grouping by type × vendor.
 *
 * Public access (NOT under (authenticated)). Acts as both a marketing
 * surface ("look how many models we have!") and a customer reference
 * ("which name do I pass to /v1/chat/completions?").
 *
 * Server component fetches `listAvailableModels()` (new-api admin
 * `/api/channel/models_enabled`) once per ISR window and groups via
 * `src/lib/models/categorize.ts`. The grouped structure is passed to the
 * `ModelsBrowser` client component which handles search + filter + cards.
 *
 * ISR: revalidate=60 — channels do change occasionally (admin adds /
 * removes models in admin.silkroadai.io UI) but rarely. 60s is faster
 * than legitimate operator turnaround and keeps SSR fast even when
 * new-api is busy.
 */
import { listAvailableModels } from '@/lib/newapi/client';
import { groupModels } from '@/lib/models/categorize';
import { ModelsBrowser } from './models-browser';

export const revalidate = 60;
export const metadata = {
    title: '模型清单 — Silk Road AI',
    description:
        'Silk Road AI 当前接入的全部模型(对话 / 视觉 / 音频 / 嵌入 / 图像生成),按厂商分组检索。',
};

export default async function ModelsPage() {
    let rawModels: string[] = [];
    let fetchErr: string | null = null;
    try {
        rawModels = await listAvailableModels();
    } catch (err) {
        // Don't crash the page on new-api hiccup — render the chrome with
        // an empty/error state so the URL stays useful for marketing.
        fetchErr = err instanceof Error ? err.message : String(err);
        console.warn('[models] listAvailableModels failed:', err);
    }

    const { grouped, totalModels, vendorCount } = groupModels(rawModels);

    return (
        <main
            style={{
                minHeight: '100vh',
                background: '#f5f7fa',
                padding: '24px 16px',
            }}
        >
            <div
                style={{
                    maxWidth: 1080,
                    margin: '0 auto',
                }}
            >
                <header style={{ marginBottom: 24 }}>
                    <p style={{ margin: '0 0 4px', fontSize: 12, color: '#5a6478' }}>
                        Silk Road AI · Connecting Global Intelligence.
                    </p>
                    <h1 style={{ margin: '0 0 8px', fontSize: 26, color: '#0a1535' }}>
                        模型清单
                    </h1>
                    <p
                        style={{
                            margin: 0,
                            fontSize: 14,
                            color: '#5a6478',
                            lineHeight: 1.6,
                        }}
                    >
                        我们当前接入了 <strong>{totalModels}</strong> 个模型,涵盖{' '}
                        <strong>{vendorCount}</strong> 个厂商。所有模型均可在{' '}
                        <code
                            style={{
                                background: '#fff',
                                padding: '2px 6px',
                                borderRadius: 3,
                                fontSize: 13,
                                border: '1px solid #e5e8ee',
                                color: '#0a1535',
                            }}
                        >
                            https://ai.silkroadai.io
                        </code>{' '}
                        通过 OpenAI / Anthropic 兼容协议调用。
                    </p>
                </header>

                {fetchErr ? (
                    <div
                        role="alert"
                        style={{
                            background: '#fdecea',
                            border: '1px solid #f0c6c2',
                            color: '#c44',
                            padding: '14px 16px',
                            borderRadius: 6,
                            marginBottom: 24,
                            fontSize: 13,
                        }}
                    >
                        当前无法获取模型清单,请稍后重试。
                    </div>
                ) : (
                    <ModelsBrowser
                        grouped={grouped}
                        totalModels={totalModels}
                        vendorCount={vendorCount}
                    />
                )}
            </div>
        </main>
    );
}
