/**
 * 客户 OSS 配置的 zod schema(W9 D3 PR-C)。
 * PUT /api/portal/oss 与 POST /api/portal/oss/test-connection 共用。
 * 独立文件(不放 route.ts)— Next.js route 文件只允许 HTTP method 等保留 export。
 */
import { z } from 'zod';
import { OSS_PROVIDERS } from './client';

const httpUrl = z
    .string()
    .url()
    .refine((u) => u.startsWith('http://') || u.startsWith('https://'), 'must be http(s) URL');

export const OssConfigSchema = z
    .object({
        provider: z.enum(OSS_PROVIDERS),
        endpoint: httpUrl.nullish(),
        bucket: z.string().min(1).max(255),
        region: z.string().max(64).nullish(),
        access_key_id: z.string().min(1).max(255),
        secret_access_key: z.string().min(1).max(512),
        public_url_prefix: httpUrl,
        cdn_enabled: z.boolean().optional().default(false),
    })
    .refine((c) => c.provider === 's3' || !!c.endpoint, {
        message: 'endpoint is required for non-AWS providers',
        path: ['endpoint'],
    })
    .refine((c) => c.provider !== 's3' || !!c.region, {
        message: 'region is required for AWS S3',
        path: ['region'],
    });

export type OssConfigInput = z.infer<typeof OssConfigSchema>;
