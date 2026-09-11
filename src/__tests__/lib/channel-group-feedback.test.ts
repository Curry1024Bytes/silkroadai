import { describe, expect, it } from 'vitest';
import { channelGroupFailureText } from '@/lib/admin/channel-group-feedback';

describe('channelGroupFailureText', () => {
    it('shows the exact field and reason for invalid manual keys', () => {
        expect(
            channelGroupFailureText(
                { error: 'invalid_input', issues: { key: ['只能使用小写字母、数字和连字符'] } },
                'zh',
                '保存失败',
            ),
        ).toBe('档次 key：只能使用小写字母、数字和连字符');
    });

    it('includes multiple field errors and uses English field labels for English UI', () => {
        expect(
            channelGroupFailureText(
                { error: 'invalid_input', issues: { display_name: ['Required'], newapi_channel_ids: ['Invalid ID'] } },
                'en',
                'Failed',
            ),
        ).toBe('Display name: Required; Channel IDs: Invalid ID');
    });

    it('retains fallback messages when no field detail is supplied', () => {
        expect(channelGroupFailureText({ error: 'invalid_input', issues: {} }, 'zh', '保存失败')).toBe(
            '请检查必填项和渠道 ID 的格式。',
        );
        expect(channelGroupFailureText({ error: 'active_tier_requires_channels' }, 'zh', '保存失败')).toBe(
            '请先登记至少一个渠道，再启用档次。',
        );
    });
});
