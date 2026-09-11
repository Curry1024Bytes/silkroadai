import { describe, expect, it } from 'vitest';
import { generateChannelGroupKey } from '@/lib/channel-group-key';

describe('generateChannelGroupKey', () => {
    it('keeps readable ASCII names and adds a unique suffix within the given tenant keys', () => {
        expect(generateChannelGroupKey('  GPT Pro  ', [])).toBe('gpt-pro');
        expect(generateChannelGroupKey('GPT Pro', ['gpt-pro', 'gpt-pro-2'])).toBe('gpt-pro-3');
    });

    it('generates a stable ASCII key for Chinese names without conflating different names', () => {
        const first = generateChannelGroupKey('CCMax（支持外接）', []);
        const second = generateChannelGroupKey('CCMax（稳定满血）', []);
        expect(first).toMatch(/^ccmax-[a-f0-9]{10}$/);
        expect(second).toMatch(/^ccmax-[a-f0-9]{10}$/);
        expect(first).not.toBe(second);
        expect(generateChannelGroupKey('CCMax（支持外接）', [])).toBe(first);
        expect(generateChannelGroupKey('CCMax（支持外接）', [first])).toBe(`${first}-2`);
        expect(generateChannelGroupKey('图片模型', [])).toMatch(/^tier-[a-f0-9]{10}$/);
    });

    it('keeps long keys and collision suffixes within 50 characters', () => {
        const group = `gpt-${'model-'.repeat(20)}enterprise`;
        const key = generateChannelGroupKey(group, []);
        const collision = generateChannelGroupKey(group, [key]);
        expect(key).toMatch(/^[a-z0-9-]+$/);
        expect(key.length).toBeLessThanOrEqual(50);
        expect(collision).not.toBe(key);
        expect(collision.length).toBeLessThanOrEqual(50);
        expect(generateChannelGroupKey(`${group}-other`, [])).not.toBe(key);
        const exactLimit = 'a'.repeat(50);
        expect(generateChannelGroupKey(exactLimit, [exactLimit])).toBe(`${'a'.repeat(48)}-2`);
    });

    it('does not mutate existing keys, including legacy Chinese identifiers', () => {
        const used = new Set(['图片模型', 'gpt特惠分组', 'ccmax稳定满血']);
        expect(generateChannelGroupKey('图片模型', used)).toMatch(/^[a-z0-9-]{1,50}$/);
        expect([...used]).toEqual(['图片模型', 'gpt特惠分组', 'ccmax稳定满血']);
    });
});
