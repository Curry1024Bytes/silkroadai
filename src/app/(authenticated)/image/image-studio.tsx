'use client';

/**
 * ImageStudio (PR-T2) — client orchestrator for /image.
 *
 * Owns the form state (prompt / model / size / count) and the latest
 * generation result. Composes the design-system-aligned image
 * components. SWR keyed reads:
 *   - /api/portal/balance/quota   (CostPreview)
 *   - /api/portal/image/list      (HistoryGallery)
 *
 * After a successful generate we:
 *   1. Insert the new ImageGeneration row into local "latest" state.
 *   2. mutate the balance SWR cache (forces re-fetch → preview updates).
 *   3. Refresh history via the window-exposed mutate hook (no
 *      prop-drilling).
 */
import { useCallback, useEffect, useState } from 'react';
import { useSWRConfig } from 'swr';
import { ModelSelector } from '@/components/image/ModelSelector';
import { PromptInput } from '@/components/image/PromptInput';
import { SizeSelector, CountSelector } from '@/components/image/SizeCountSelectors';
import { CostPreview, QUOTA_SWR_KEY, useQuotaSnapshot } from '@/components/image/CostPreview';
import { GenerateButton, type GenerateButtonState } from '@/components/image/GenerateButton';
import { ResultDisplay } from '@/components/image/ResultDisplay';
import { ImageEmptyState } from '@/components/image/EmptyState';
import { HistoryGallery } from '@/components/image/HistoryGallery';
import { ImageModal } from '@/components/image/ImageModal';
import { DEFAULT_IMAGE_MODEL_ID, IMAGE_MODEL_OPTIONS, PROMPT_MAX_CHARS } from '@/data/image-models';
import type { ImageGenerationItem } from '@/components/image/types';

interface Props {
    /** Pre-fetched first page of history (server-rendered) so the
     *  empty state vs "you have prior images" decision is rendered
     *  on the first paint without a SWR round-trip. */
    initialLatest: ImageGenerationItem | null;
}

export function ImageStudio({ initialLatest }: Props) {
    const [prompt, setPrompt] = useState('');
    const [modelId, setModelId] = useState(DEFAULT_IMAGE_MODEL_ID);
    const [size, setSize] = useState('1024x1024');
    const [count, setCount] = useState(1);

    const [latest, setLatest] = useState<ImageGenerationItem | null>(initialLatest);
    const [genState, setGenState] = useState<GenerateButtonState>('idle');
    const [genError, setGenError] = useState<string | undefined>(undefined);

    const [modalItem, setModalItem] = useState<ImageGenerationItem | null>(null);
    const [modalIndex, setModalIndex] = useState(0);

    const { mutate } = useSWRConfig();
    const { data: quota } = useQuotaSnapshot();
    const model = IMAGE_MODEL_OPTIONS.find((m) => m.id === modelId) ?? IMAGE_MODEL_OPTIONS[0];

    const costUsd = model.pricePerImageUsd * count;
    const costCny = Math.round(costUsd * 7 * 100) / 100;
    const remainCny = quota?.remain_cny;
    const balanceShortfall = typeof remainCny === 'number' && remainCny < costCny;

    const overPromptLimit = prompt.length > PROMPT_MAX_CHARS;
    const promptEmpty = prompt.trim().length === 0;
    const generateDisabled = genState === 'loading' || promptEmpty || overPromptLimit || balanceShortfall;

    const onPickSample = useCallback((s: string) => setPrompt(s), []);

    const refreshHistory = useCallback(() => {
        const w = window as unknown as Record<string, () => Promise<unknown>>;
        const fn = w.__pr_t2_history_mutate__;
        if (typeof fn === 'function') {
            void fn();
        }
    }, []);

    async function handleGenerate() {
        if (generateDisabled) return;
        setGenState('loading');
        setGenError(undefined);

        try {
            const r = await fetch('/api/portal/image/generate', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: prompt.trim(), model: modelId, size, count }),
            });

            if (!r.ok) {
                const payload = await r.json().catch(() => ({}));
                if (r.status === 429) {
                    const retrySec = payload?.retry_after_ms ? Math.ceil(payload.retry_after_ms / 1000) : 60;
                    throw new Error(`触发频率限制,请 ${retrySec} 秒后重试`);
                }
                if (r.status === 402 || payload?.error === 'insufficient_user_quota') {
                    throw new Error('余额不足,请前往 /pay 充值');
                }
                throw new Error(payload?.message || payload?.error || `生成失败 (HTTP ${r.status})`);
            }

            const json = (await r.json()) as {
                id: string;
                image_urls: string[];
                cost_usd: number;
                created_at: string;
                expires_at: string | null;
            };

            const newItem: ImageGenerationItem = {
                id: json.id,
                prompt: prompt.trim(),
                model_name: modelId,
                size,
                count,
                image_urls: json.image_urls,
                cost_usd: json.cost_usd,
                is_favorite: false,
                created_at: json.created_at,
                expires_at: json.expires_at,
            };
            setLatest(newItem);
            setGenState('idle');
            // Force balance + history to refresh so the next preview +
            // the gallery reflect the new state.
            void mutate(QUOTA_SWR_KEY);
            refreshHistory();
        } catch (err) {
            setGenState('error');
            setGenError(err instanceof Error ? err.message : '生成失败');
        }
    }

    async function handleToggleFavorite(id: string, next: boolean) {
        const r = await fetch(`/api/portal/image/${encodeURIComponent(id)}/favorite`, {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_favorite: next }),
        });
        if (!r.ok) throw new Error(`favorite ${r.status}`);
        // Update latest if id matches.
        setLatest((prev) => (prev && prev.id === id ? { ...prev, is_favorite: next } : prev));
        // Update modal item if open.
        setModalItem((prev) => (prev && prev.id === id ? { ...prev, is_favorite: next } : prev));
        refreshHistory();
    }

    async function handleDelete(id: string) {
        const r = await fetch(`/api/portal/image/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            credentials: 'same-origin',
        });
        if (!r.ok) throw new Error(`delete ${r.status}`);
        setLatest((prev) => (prev && prev.id === id ? null : prev));
        refreshHistory();
    }

    function openModal(item: ImageGenerationItem, index: number) {
        setModalItem(item);
        setModalIndex(index);
    }

    return (
        <div className="flex flex-col gap-6">
            {/* Top row: model selector + size + count */}
            <div className="flex flex-wrap items-end gap-4">
                <div className="flex-1 min-w-[260px]">
                    <span className="block text-xs text-muted-ink mb-1.5">模型</span>
                    <ModelSelector value={modelId} onChange={setModelId} disabled={genState === 'loading'} />
                </div>
                <div>
                    <span className="block text-xs text-muted-ink mb-1.5">尺寸</span>
                    <SizeSelector value={size} onChange={setSize} disabled={genState === 'loading'} />
                </div>
                <div>
                    <span className="block text-xs text-muted-ink mb-1.5">数量</span>
                    <CountSelector value={count} onChange={setCount} disabled={genState === 'loading'} />
                </div>
            </div>

            {/* Result display OR empty state */}
            {latest ? (
                <ResultDisplay
                    item={latest}
                    onOpenModal={openModal}
                    onToggleFavorite={handleToggleFavorite}
                    onDelete={handleDelete}
                />
            ) : (
                <ImageEmptyState onPickSample={onPickSample} />
            )}

            {/* Prompt + cost + generate */}
            <div className="flex flex-col gap-3">
                <PromptInput value={prompt} onChange={setPrompt} disabled={genState === 'loading'} />
                <div className="flex items-end justify-between gap-3 flex-wrap">
                    <CostPreview pricePerImageUsd={model.pricePerImageUsd} count={count} />
                    <GenerateButton
                        state={genState}
                        disabled={generateDisabled}
                        onClick={handleGenerate}
                        errorMessage={genError}
                        // PR-T2 504 fix — gpt-image-2 sub2api/Codex
                        // queue parks requests at 30-60s. Surface the
                        // expected wait so the customer doesn't bail.
                        slowModelHint={
                            modelId === 'gpt-image-2' ? 'GPT image-2 生成时间约 30-60 秒,请耐心等待' : undefined
                        }
                    />
                </div>
            </div>

            {/* History */}
            <HistoryGallery suppressIds={latest ? [latest.id] : []} onOpen={openModal} />

            {/* Modal viewer */}
            <ImageModal
                item={modalItem}
                initialIndex={modalIndex}
                onClose={() => setModalItem(null)}
                onToggleFavorite={handleToggleFavorite}
                onDelete={handleDelete}
            />
        </div>
    );
}
