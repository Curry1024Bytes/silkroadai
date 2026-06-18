/**
 * 客户自定义 OSS 的 S3 兼容 client(W9 D3 PR-C)。
 *
 * 支持 provider:
 *   - 'r2'          Cloudflare R2(endpoint = https://<account>.r2.cloudflarestorage.com)
 *   - 'aliyun-oss'  阿里云 OSS S3 兼容(endpoint = https://oss-cn-xxx.aliyuncs.com)
 *   - 'tencent-cos' 腾讯云 COS S3 兼容(endpoint = https://cos.<region>.myqcloud.com)
 *   - 's3'          AWS S3(region 必填,endpoint 留空走 AWS 默认)
 *   - 's3-custom'   自建 / 其他 S3 兼容(MinIO 等,forcePathStyle)
 *
 * 与 src/lib/r2/client.ts(平台默认 R2)分开:那边是 env 单例,这边是
 * per-customer 配置、每次按 config 构造(客户数量级小 + 测试连接也走这里,
 * 不做跨请求缓存,避免配置更新后用到旧凭证)。
 *
 * Server-only — 解密后的 secret 只在内存中存活于单次调用。
 */
import 'server-only';
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { decryptSecret } from './encryption';

/** 结构化的 OSS 配置(= prisma UserOssConfig 的子集,解耦生成的 client 类型) */
export interface OssConfigLike {
    provider: string;
    endpoint: string | null;
    bucket: string;
    region: string | null;
    access_key_id: string;
    secret_access_key_encrypted: string;
    public_url_prefix: string;
}

export const OSS_PROVIDERS = ['r2', 'aliyun-oss', 'tencent-cos', 's3', 's3-custom'] as const;
export type OssProvider = (typeof OSS_PROVIDERS)[number];

export function getS3ClientForConfig(config: OssConfigLike): S3Client {
    return new S3Client({
        endpoint: config.endpoint || undefined,
        region: config.region || 'auto',
        credentials: {
            accessKeyId: config.access_key_id,
            secretAccessKey: decryptSecret(config.secret_access_key_encrypted),
        },
        forcePathStyle: config.provider === 's3-custom',
    });
}

/** 上传到客户 bucket,返回客户配置的公网 URL(`${public_url_prefix}/${key}`)。 */
export async function uploadToCustomerOss(
    config: OssConfigLike,
    buffer: Buffer,
    key: string,
    mimeType: string,
): Promise<string> {
    const client = getS3ClientForConfig(config);
    await client.send(
        new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: buffer,
            ContentType: mimeType,
            CacheControl: 'public, max-age=31536000, immutable',
        }),
    );
    return `${config.public_url_prefix.replace(/\/$/, '')}/${key}`;
}

/** 客户 OSS 上某 key 的公网 URL(与 uploadToCustomerOss 同构,供 HEAD 命中后直接拼 URL 不重传)。 */
export function ossPublicUrl(config: OssConfigLike, key: string): string {
    return `${config.public_url_prefix.replace(/\/$/, '')}/${key}`;
}

/** 客户 bucket 里是否已有该 key(HEAD)。用于幂等:重复轮询时不重复下载+上传。任何错误(含 404)→ false。 */
export async function objectExistsInOss(config: OssConfigLike, key: string): Promise<boolean> {
    try {
        await getS3ClientForConfig(config).send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        return true;
    } catch {
        return false;
    }
}

/** 测试连接:put 一个临时对象再删掉。失败返回 {ok:false, message},不 throw。 */
export async function testOssConnection(config: OssConfigLike): Promise<{ ok: boolean; message?: string }> {
    try {
        const client = getS3ClientForConfig(config);
        const testKey = `__silkroadai_test_${Date.now()}.txt`;
        await client.send(
            new PutObjectCommand({
                Bucket: config.bucket,
                Key: testKey,
                Body: 'silkroadai-connection-test',
                ContentType: 'text/plain',
            }),
        );
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: testKey }));
        return { ok: true };
    } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
}
