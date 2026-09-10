import type { Locale } from '@/lib/locale';

export interface ChannelGroupFailure {
    error?: string;
    message?: string;
    models?: { id: string; slug: string; channel_id: number }[];
}

export function channelGroupFailureText(data: ChannelGroupFailure, locale: Locale, fallback: string): string {
    const en = locale === 'en';
    const messages: Record<string, string> = {
        tier_in_use_by_enabled_models: en
            ? `${data.models?.length ?? 0} enabled models still use this tier or channel. Use “Replace channel” to migrate them together, or edit their references in Models.`
            : `仍有 ${data.models?.length ?? 0} 个启用模型引用此档次或渠道。换渠道请使用「替换渠道」一起迁移；下架档次请先处理这些模型。`,
        active_tier_requires_channels: en
            ? 'Register at least one channel before enabling this tier.'
            : '请先登记至少一个渠道，再启用档次。',
        default_tier_must_be_enabled: en
            ? 'The default tier must remain enabled.'
            : '默认档次必须保持启用，请先把其他档次设为默认档。',
        active_default_tier_required: en
            ? 'Set another enabled tier as default first.'
            : '请先把另一个启用档次设为默认档。',
        newapi_group_already_assigned: en
            ? 'This new-api group already belongs to another enabled tier.'
            : '这个 new-api 分组已归属其他启用档次，请核对分组。',
        channel_already_assigned: en
            ? 'A selected channel already belongs to another enabled tier.'
            : '所选渠道已登记在其他启用档次，请核对归属。',
        invalid_input: en ? 'Check the required fields and channel IDs.' : '请检查必填项和渠道 ID 的格式。',
    };
    return (
        messages[data.error ?? ''] ||
        data.message ||
        (data.error && !/^[a-z_]+$/.test(data.error) ? data.error : fallback)
    );
}
