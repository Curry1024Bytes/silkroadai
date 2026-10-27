/**
 * /settings/storage — customer-owned object storage (OSS) configuration page + form.
 * The form is also mounted by the enterprise portal, which passes its own
 * `defaultModeHint` / `apiBase`; those overrides stay as-is.
 */
import { defineMessages } from '../index';

export const storageMessages = defineMessages(
    {
        heading: '存储设置',
        intro1: 'AI 生图(Gemini 系列)与 AI 视频(Seedance 系列)的输出默认存储在 Silk Road AI 的对象存储,返回',
        intro2: 'URL;gpt-image-2 默认返回 base64,请求传',
        intro3: '时同样走对象存储、返回 URL。你也可以配置自己的对象存储(Cloudflare R2 / 阿里云 OSS / 腾讯云 COS / AWS S3 / 自建 S3 兼容),生成的图片和视频将直接上传到你的 bucket,URL 用你自己的域名。',
        form: {
            cardTitle: '图片 / 视频输出存储',
            defaultMode: '默认存储(推荐)',
            defaultModeHint: 'Silk Road AI 托管,无需配置,URL 为 images.silkroadai.io',
            customMode: '自定义对象存储',
            customModeHint: '图片和视频直接上传到你自己的 bucket,URL 用你的域名,数据归属你',
            currentConfig: '当前配置:',
            prefix: '前缀',
            clear: '清除(回默认)',
            provider: '服务商',
            providers: {
                r2: 'Cloudflare R2',
                aliyun: '阿里云 OSS',
                tencent: '腾讯云 COS',
                s3: 'AWS S3',
                s3Custom: '自建 / 其他 S3 兼容',
            },
            s3EndpointHint: '留空(走 AWS 默认,需填 region)',
            optional: '(可选)',
            akStoredPlaceholder: (masked: string) => `已存(${masked}),修改需重填`,
            skStoredPlaceholder: '已加密存储,修改需重填',
            publicPrefix: '公网访问前缀',
            publicPrefixHint: 'bucket 绑定的公开访问域名 / CDN。返回给你的图片 URL = 前缀 + /gen/<uuid>.png',
            testing: '测试中…',
            testConnection: '测试连接',
            saving: '保存中…',
            saveConfig: '保存配置',
            testOk: '✅ 连接成功,可以保存',
            testFail: '❌ 连接失败:',
            saved: '已保存,立即生效',
            saveFailed: '保存失败:',
            security1: '凭证使用 AES-256-GCM 加密存储,不会回显。建议使用',
            security2: '仅对该 bucket 有读写权限的子账号',
            security3: '(最小权限),不要用主账号 AK。上传失败时自动回退到平台默认存储(响应头',
            security4: '标记),不影响生图。',
        },
    },
    {
        heading: 'Storage',
        intro1: 'By default, images (Gemini models) and videos (Seedance models) are stored in Silk Road AI object storage and returned as',
        intro2: 'URLs; gpt-image-2 returns base64 by default, and requests with',
        intro3: 'also go through object storage and return a URL. You can also configure your own object storage (Cloudflare R2 / Alibaba Cloud OSS / Tencent Cloud COS / AWS S3 / self-hosted S3-compatible): generated images and videos are uploaded straight to your bucket and served from your own domain.',
        form: {
            cardTitle: 'Image / video output storage',
            defaultMode: 'Default storage (recommended)',
            defaultModeHint: 'Hosted by Silk Road AI, no setup needed; URLs are served from images.silkroadai.io',
            customMode: 'Custom object storage',
            customModeHint:
                'Images and videos are uploaded straight to your own bucket and served from your domain — the data is yours',
            currentConfig: 'Current config: ',
            prefix: 'prefix',
            clear: 'Clear (back to default)',
            provider: 'Provider',
            providers: {
                r2: 'Cloudflare R2',
                aliyun: 'Alibaba Cloud OSS',
                tencent: 'Tencent Cloud COS',
                s3: 'AWS S3',
                s3Custom: 'Self-hosted / other S3-compatible',
            },
            s3EndpointHint: 'Leave blank (AWS default; region required)',
            optional: ' (optional)',
            akStoredPlaceholder: (masked: string) => `Saved (${masked}); re-enter to change`,
            skStoredPlaceholder: 'Stored encrypted; re-enter to change',
            publicPrefix: 'Public URL prefix',
            publicPrefixHint:
                'The public domain / CDN bound to the bucket. Image URLs returned to you = prefix + /gen/<uuid>.png',
            testing: 'Testing…',
            testConnection: 'Test connection',
            saving: 'Saving…',
            saveConfig: 'Save config',
            testOk: '✅ Connection OK — ready to save',
            testFail: '❌ Connection failed: ',
            saved: 'Saved — effective immediately',
            saveFailed: 'Save failed: ',
            security1: 'Credentials are stored with AES-256-GCM encryption and never echoed back. Use ',
            security2: 'a sub-account with read/write access to this bucket only',
            security3:
                ' (least privilege) rather than your root access key. If an upload fails we fall back to platform storage automatically (marked by the',
            security4: 'response header) so generation never fails.',
        },
    },
);

export type StorageMessages = (typeof storageMessages)['zh'];
