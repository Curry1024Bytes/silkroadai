import type { Locale } from '@/lib/locale';

export interface ChannelGroupFailure {
    error?: string;
    message?: string;
    models?: { id: string; slug: string; channel_id: number }[];
    issues?: Record<string, string[] | undefined>;
}

export function channelGroupFailureText(data: ChannelGroupFailure, locale: Locale, fallback: string): string {
    const en = locale === 'en';
    if (data.error === 'invalid_input' && data.issues) {
        const fields: Record<string, string> = {
            key: en ? 'Tier key' : '档次 key',
            display_name: en ? 'Display name' : '显示名',
            newapi_group: 'new-api group',
            description: en ? 'Description' : '描述',
            tier_level: en ? 'Sort order' : '排序',
            newapi_channel_ids: en ? 'Channel IDs' : '登记渠道 ID',
            enabled: en ? 'Enabled' : '启用',
            is_default: en ? 'Default tier' : '默认档次',
        };
        const details = Object.entries(data.issues).flatMap(([field, issues]) =>
            Array.isArray(issues)
                ? issues
                      .filter((issue) => typeof issue === 'string' && issue.trim())
                      .map((issue) => `${fields[field] ?? field}${en ? ': ' : '：'}${issue}`)
                : [],
        );
        if (details.length) return details.join(en ? '; ' : '；');
    }
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
        tier_key_conflict: en
            ? 'Another tier was just created. Please save again to generate a unique key.'
            : '其他操作刚创建了档次，请再次保存以生成唯一标识。',
    };
    return (
        messages[data.error ?? ''] ||
        data.message ||
        (data.error && !/^[a-z_]+$/.test(data.error) ? data.error : fallback)
    );
}
