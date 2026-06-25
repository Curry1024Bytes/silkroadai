/**
 * Public /models page — full catalog of models available through
 * https://ai.silkroadai.io, grouped VENDOR-first (OpenAI / Anthropic /
 * Google / 字节跳动 / …) so each vendor appears exactly once, with a light
 * capability sub-grouping (对话 / 视觉 / 图像 / 视频) inside each vendor.
 *
 * Public access (NOT under (authenticated)). Acts as both a marketing
 * surface ("look how many models we have!") and a customer reference
 * ("which name do I pass to /v1/chat/completions?").
 *
 * Server component fetches `listAvailableModels()` (new-api admin
 * `/api/channel/models_enabled`) once per ISR window and classifies via
 * `src/lib/models/categorize.ts` → a flat `ModelEntry[]` handed to the
 * `ModelsBrowser` client component (search + vendor grouping + cards).
 *
 * ISR: revalidate=60 — channels do change occasionally (admin adds /
 * removes models in admin.silkroadai.io UI) but rarely. 60s is faster
 * than legitimate operator turnaround and keeps SSR fast even when
 * new-api is busy.
 */
import Link from 'next/link';
import { BackButton } from '@/components/BackButton';
import { listAvailableModels } from '@/lib/newapi/client';
import { classifyModels } from '@/lib/models/categorize';
import { Logo } from '@/components/brand/Logo';
import { FormError } from '@/components/ui/FormError';
import { ModelsBrowser } from './models-browser';

export const revalidate = 60;
export const metadata = {
    title: '模型清单 — Silk Road AI',
    description:
        'Silk Road AI 当前接入的全部模型,按厂商分组(OpenAI / Anthropic / Google / 字节跳动 等),覆盖对话 / 视觉 / 图像 / 视频,可搜索检索。',
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

    const { entries, totalModels, vendorCount } = classifyModels(rawModels);

    return (
        <main className="min-h-screen bg-paper px-4 py-8">
            <div className="max-w-6xl mx-auto">
                <header className="mb-6 flex flex-col gap-3">
                    {/* W7 D4 PR-R Item D — back-to-landing link, sits
                     *  above the brand row so customers landing on this
                     *  public page from a search result or a shared
                     *  link have an explicit way back. Small + muted
                     *  per the PR-R style spec. */}
                    <BackButton className="inline-flex items-center gap-1 text-xs text-muted-ink hover:text-brand-accent transition-colors duration-150 ease-brand no-underline w-fit cursor-pointer border-0 bg-transparent p-0">
                        <span aria-hidden="true">←</span>
                        <span>返回</span>
                    </BackButton>
                    <div className="flex items-center gap-3">
                        <Logo variant="primary-flat" size={28} />
                        <p className="m-0 text-xs text-minor-ink">Connecting Global Intelligence.</p>
                    </div>
                    <h1 className="m-0 text-3xl font-semibold text-navy">模型清单</h1>
                    <p className="m-0 text-sm text-muted-ink leading-relaxed max-w-3xl">
                        我们当前接入了 <strong className="text-navy">{totalModels}</strong> 个模型,涵盖{' '}
                        <strong className="text-navy">{vendorCount}</strong> 个厂商。所有模型均可在{' '}
                        <code className="bg-surface px-1.5 py-0.5 rounded text-xs border border-brand-border text-navy">
                            https://ai.silkroadai.io
                        </code>{' '}
                        通过 OpenAI / Anthropic 兼容协议调用。
                    </p>
                </header>

                {fetchErr ? (
                    <FormError severity="banner">当前无法获取模型清单,请稍后重试。</FormError>
                ) : (
                    <ModelsBrowser entries={entries} totalModels={totalModels} vendorCount={vendorCount} />
                )}
            </div>
        </main>
    );
}
