'use client';

/**
 * ImageStudio (PR-T2 + PR-T3) — client orchestrator for /image.
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
 *
 * PR-T3 polish layer: friendly UX for 5 paths
 *   - 429 rate limit       → RateLimitToast w/ countdown
 *   - 402 balance shortfall → BalanceShortfallModal w/ /pay CTA
 *   - 400 content_filter   → ContentFilterModal (NO refund language —
 *                             backend confirms quota_charged=false)
 *   - cost > ¥5            → LargeCostConfirmModal gate before submit
 *   - inline analytics     → POST /api/portal/analytics on key actions
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
import { RateLimitToast } from '@/components/image/RateLimitToast';
import { BalanceShortfallModal } from '@/components/image/BalanceShortfallModal';
import { ContentFilterModal } from '@/components/image/ContentFilterModal';
import { LargeCostConfirmModal } from '@/components/image/LargeCostConfirmModal';
import { DEFAULT_IMAGE_MODEL_ID, IMAGE_MODEL_OPTIONS, PROMPT_MAX_CHARS } from '@/data/image-models';
import type { ImageGenerationItem } from '@/components/image/types';

interface Props {
    /** Pre-fetched first page of history (server-rendered) so the
     *  empty state vs "you have prior images" decision is rendered
     *  on the first paint without a SWR round-trip. */
    initialLatest: ImageGenerationItem | null;
}

/** Cost threshold (CNY) above which we gate generate with a confirm
 *  modal. ¥5 ≈ ~12 Nano Banana / 12 GPT image-2 / 1 Nano Banana Pro
 *  generation; bumps the friction floor to "you must mean to spend
 *  this much". Tune by adjusting this constant. */
const LARGE_COST_THRESHOLD_CNY = 5;

/** Fire-and-forget client analytics record. Failures are swallowed —
 *  instrumentation must never break user-facing UX. */
async function recordEvent(eventType: string, properties: Record<string, unknown> = {}): Promise<void> {
    try {
        await fetch('/api/portal/analytics', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event_type: eventType, properties }),
        });
    } catch {
        // Silent
    }
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

    // PR-T3 UX state.
    const [rateLimitMs, setRateLimitMs] = useState<number | null>(null);
    const [showBalanceModal, setShowBalanceModal] = useState(false);
    const [showContentFilterModal, setShowContentFilterModal] = useState(false);
    const [showCostConfirm, setShowCostConfirm] = useState(false);

    const { mutate } = useSWRConfig();
    const { data: quota } = useQuotaSnapshot();
    const model = IMAGE_MODEL_OPTIONS.find((m) => m.id === modelId) ?? IMAGE_MODEL_OPTIONS[0];

    const costUsd = model.pricePerImageUsd * count;
    const costCny = Math.round(costUsd * 7 * 100) / 100;
    const remainCny = quota?.remain_cny;
    const balanceShortfall = typeof remainCny === 'number' && remainCny < costCny;

    const overPromptLimit = prompt.length > PROMPT_MAX_CHARS;
    const promptEmpty = prompt.trim().length === 0;
    const generateDisabled =
        genState === 'loading' || promptEmpty || overPromptLimit || balanceShortfall || rateLimitMs !== null; // disabled while countdown is running

    const onPickSample = useCallback((s: string) => setPrompt(s), []);

    // Track model selection (debounced via effect — only fires when
    // modelId stabilizes, not on every render).
    useEffect(() => {
        void recordEvent('model_selected', { model: modelId });
    }, [modelId]);

    const refreshHistory = useCallback(() => {
        const w = window as unknown as Record<string, () => Promise<unknown>>;
        const fn = w.__pr_t2_history_mutate__;
        if (typeof fn === 'function') {
            void fn();
        }
    }, []);

    /** The actual generate work. Split out so the cost-confirm modal's
     *  "确认" button can call it directly. */
    async function executeGenerate() {
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

                // 429 rate limit → toast with countdown
                if (r.status === 429) {
                    const retryMs =
                        typeof payload?.retry_after_ms === 'number' && payload.retry_after_ms > 0
                            ? payload.retry_after_ms
                            : 60_000;
                    setRateLimitMs(retryMs);
                    setGenState('idle'); // not in error — just blocked temporarily
                    return;
                }

                // 402 balance shortfall → modal w/ /pay CTA
                if (r.status === 402 || payload?.error === 'insufficient_user_quota') {
                    setShowBalanceModal(true);
                    setGenState('idle');
                    return;
                }

                // 400 content filter → friendly modal, no refund language
                if (r.status === 400 && payload?.error === 'content_filter') {
                    setShowContentFilterModal(true);
                    setGenState('idle');
                    return;
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

    /** Click handler for [生成] — gates the actual call behind the
     *  large-cost confirmation if applicable. */
    function handleGenerate() {
        if (generateDisabled) return;
        if (costCny > LARGE_COST_THRESHOLD_CNY) {
            void recordEvent('cost_confirm_shown', { model: modelId, count, cost_cny: costCny });
            setShowCostConfirm(true);
            return;
        }
        void executeGenerate();
    }

    function handleCostConfirm() {
        setShowCostConfirm(false);
        void executeGenerate();
    }
    function handleCostCancel() {
        setShowCostConfirm(false);
        void recordEvent('cost_confirm_canceled', { model: modelId, count, cost_cny: costCny });
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
        void recordEvent(next ? 'image_favorited' : 'image_unfavorited', { generation_id: id });
    }

    async function handleDelete(id: string) {
        const r = await fetch(`/api/portal/image/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            credentials: 'same-origin',
        });
        if (!r.ok) throw new Error(`delete ${r.status}`);
        setLatest((prev) => (prev && prev.id === id ? null : prev));
        refreshHistory();
        void recordEvent('image_deleted_ui', { generation_id: id });
    }

    function openModal(item: ImageGenerationItem, index: number) {
        setModalItem(item);
        setModalIndex(index);
    }

    return (
        <div className="flex flex-col gap-6">
            {/* Rate-limit toast — only when active. Self-expires via the
             *  RateLimitToast's countdown, which calls onExpire to clear
             *  the state and re-enable the GenerateButton. */}
            {rateLimitMs !== null && (
                <RateLimitToast
                    retryAfterMs={rateLimitMs}
                    onExpire={() => setRateLimitMs(null)}
                    onDismiss={() => setRateLimitMs(null)}
                />
            )}

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

            {/* Modal viewer (PR-T2) */}
            <ImageModal
                item={modalItem}
                initialIndex={modalIndex}
                onClose={() => setModalItem(null)}
                onToggleFavorite={handleToggleFavorite}
                onDelete={handleDelete}
            />

            {/* PR-T3 friendly UX modals */}
            <BalanceShortfallModal
                open={showBalanceModal}
                onClose={() => setShowBalanceModal(false)}
                requiredCny={costCny}
                remainCny={remainCny}
            />
            <ContentFilterModal open={showContentFilterModal} onClose={() => setShowContentFilterModal(false)} />
            <LargeCostConfirmModal
                open={showCostConfirm}
                onCancel={handleCostCancel}
                onConfirm={handleCostConfirm}
                costCny={costCny}
                remainCny={remainCny}
            />
        </div>
    );
}
