/**
 * Chat UI v1 — listChatModels / collapse helper tests.
 *
 * The collapse helper is the interesting logic (chat+vision filtering,
 * de-dup, vendor grouping). listChatModels itself is a thin wrapper over
 * listAvailableModels + groupModels, so we mock the upstream call to
 * cover the never-throw contract.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockListAvailableModels = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    listAvailableModels: () => mockListAvailableModels(),
}));

import { listChatModels, _collapseChatModelsForTest } from '@/lib/chat/models';
import { groupModels } from '@/lib/models/categorize';

beforeEach(() => vi.clearAllMocks());

describe('collapseChatModels', () => {
    it('keeps chat + vision models, drops image-gen / embedding', () => {
        const { grouped } = groupModels([
            'gpt-5.5', // openai chat
            'claude-opus-4-7', // anthropic → vision (multimodal flagship), still a valid chat target
            'dall-e-3', // openai image-gen → excluded
            'text-embedding-3-large', // openai embedding → excluded
        ]);
        const { flat } = _collapseChatModelsForTest(grouped);
        const ids = flat.map((m) => m.id);
        expect(ids).toContain('gpt-5.5');
        expect(ids).toContain('claude-opus-4-7');
        expect(ids).not.toContain('dall-e-3');
        expect(ids).not.toContain('text-embedding-3-large');
    });

    it('groups by vendor and de-duplicates', () => {
        const { grouped } = groupModels(['gpt-5.5', 'gpt-5.5', 'claude-opus-4-7']);
        const { groups, flat, totalModels } = _collapseChatModelsForTest(grouped);
        // de-dup: gpt-5.5 appears once
        expect(flat.filter((m) => m.id === 'gpt-5.5')).toHaveLength(1);
        expect(totalModels).toBe(flat.length);
        // each group's models all share its vendor
        for (const g of groups) {
            expect(g.models.every((m) => m.vendor === g.vendor)).toBe(true);
        }
    });
});

describe('listChatModels', () => {
    it('returns grouped chat models from the catalog', async () => {
        mockListAvailableModels.mockResolvedValue(['gpt-5.5', 'claude-opus-4-7']);
        const res = await listChatModels();
        expect(res.totalModels).toBeGreaterThanOrEqual(2);
        expect(res.flat.map((m) => m.id)).toEqual(expect.arrayContaining(['gpt-5.5', 'claude-opus-4-7']));
    });

    it('never throws — returns empty list on upstream failure', async () => {
        mockListAvailableModels.mockRejectedValue(new Error('new-api down'));
        const res = await listChatModels();
        expect(res).toEqual({ groups: [], flat: [], totalModels: 0 });
    });
});
