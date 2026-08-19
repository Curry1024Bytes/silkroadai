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

const mockGetModelGroupMap = vi.fn();
vi.mock('@/lib/chat/model-groups', () => ({
    getModelGroupMap: () => mockGetModelGroupMap(),
}));

const mockListUserTierMultipliers = vi.fn();
vi.mock('@/lib/newapi/user-tier-multiplier', () => ({
    listUserTierMultipliers: (...args: unknown[]) => mockListUserTierMultipliers(...args),
}));

import { listChatModels, _collapseChatModelsForTest } from '@/lib/chat/models';
import { groupModels } from '@/lib/models/categorize';

beforeEach(() => {
    vi.clearAllMocks();
    mockGetModelGroupMap.mockResolvedValue(new Map()); // default: no group augmentation
    mockListUserTierMultipliers.mockResolvedValue([]);
});

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

    it('flags vision models (image-capable) vs plain chat for the upload gate', () => {
        const { grouped } = groupModels([
            'gpt-5.5', // plain chat → vision:false
            'claude-opus-4-7', // multimodal flagship → vision:true
            'gpt-4o', // multimodal → vision:true
        ]);
        const { flat } = _collapseChatModelsForTest(grouped);
        const byId = Object.fromEntries(flat.map((m) => [m.id, m.vision]));
        expect(byId['gpt-5.5']).toBe(false);
        expect(byId['claude-opus-4-7']).toBe(true);
        expect(byId['gpt-4o']).toBe(true);
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

    it('augments models with routing group + price multiplier for the picker badge', async () => {
        mockListAvailableModels.mockResolvedValue(['gpt-5.4', 'claude-fable-5']);
        mockGetModelGroupMap.mockResolvedValue(
            new Map([
                ['gpt-5.4', { group: 'default', ratio: 1, multiplier: 1 }],
                ['claude-fable-5', { group: 'official', ratio: 2.4615, multiplier: 2.4615 }],
            ]),
        );
        const res = await listChatModels();
        const byId = Object.fromEntries(res.flat.map((m) => [m.id, m]));
        expect(byId['gpt-5.4'].group).toBe('default');
        expect(byId['gpt-5.4'].priceMultiplier).toBe(1);
        expect(byId['claude-fable-5'].group).toBe('official');
        expect(byId['claude-fable-5'].priceMultiplier).toBeCloseTo(2.4615, 3);
    });

    it('shows the signed-in customer their effective 0.18 rate while another user keeps the public 0.20 rate', async () => {
        mockListAvailableModels.mockResolvedValue(['gpt-5.4']);
        mockGetModelGroupMap.mockResolvedValue(
            new Map([['gpt-5.4', { group: 'GPT-Pro20x(企业级)', ratio: 0.2, multiplier: 1 }]]),
        );
        mockListUserTierMultipliers.mockResolvedValueOnce([
            { tier_key: 'gpt-pro20x', newapi_billing_group: 'GPT-Pro20x(企业级)', multiplier: 0.18 },
        ]);
        expect((await listChatModels('customer-a')).flat[0].effectiveRatio).toBe(0.18);

        mockListUserTierMultipliers.mockResolvedValueOnce([]);
        expect((await listChatModels('customer-b')).flat[0].effectiveRatio).toBe(0.2);
    });
});
