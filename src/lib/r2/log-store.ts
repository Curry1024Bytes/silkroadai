/**
 * 私有 R2 log bucket helper(数据存储 Phase 1 第①步)。
 *
 * 请求日志大体(请求体 / 响应体 / 输入图原始字节)存这里;PG `request_logs`
 * 行(prisma RequestLog)只存元数据 + 键引用,id = request_id 即键里的同名段。
 *
 * ⚠️ 安全边界 — 与 `client.ts` 完全分离:client.ts 的 `silkroadai-image-gen`
 * 是 **public-read** bucket(靠不可猜 key);请求日志是全量客户内容
 * (prompt / 对话 / 输入图),【绝不能】落公开读 bucket。本模块只认独立 env
 * `R2_LOG_BUCKET_NAME`(operator 在 Cloudflare 建 private bucket、不绑公开
 * 域名);env 未配置时 fail-closed —— 所有 I/O helper 抛
 * `LogStoreNotConfiguredError`,绝不回落 / 复用 `R2_BUCKET_NAME`。调用方
 * (第②步捕获层)先 `isLogStoreConfigured()` 探,再决定捕不捕。
 *
 * 账号与凭证沿用现有 R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
 * (operator 2026-06-13 拍板)。若现有 scoped API token 只授了 image bucket,
 * 对新 bucket 会 403 —— 那时 operator 开新凭证,这里再加 R2_LOG_* override。
 *
 * ── R2 键约定(定案 2026-06-13;单一事实源,第②步捕获 + admin 页直接引用)──
 *   reqlog/{yyyy}/{mm}/{dd}/{request_id}.in.json      请求体(原始 JSON)
 *   reqlog/{yyyy}/{mm}/{dd}/{request_id}.out.json     响应体(非流式原样;流式为重组后的完整体)
 *   reqlog/{yyyy}/{mm}/{dd}/{request_id}.in.{i}.{ext} 第 i 张(0-based)输入图原始字节
 * 日期取 UTC(与 PG created_at 同源),按日分前缀便于未来按期清理/分析。
 * 输出图【不】进 reqlog/ —— 已在 gen/、image-gen/ 或客户 OSS,RequestLog
 * 只存引用(output_image_refs),不复制字节。
 *
 * Server-only(`import 'server-only'`)+ env 懒读,镜像 client.ts:module
 * load 不读任何 env,vitest / typecheck / dev boot 在 env 未配时不炸。
 */
import 'server-only';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/** 所有请求日志对象的统一键前缀(列举 / lifecycle rule 按这个前缀圈)。 */
export const REQLOG_PREFIX = 'reqlog';

/** env 未配置时所有 I/O helper 抛这个。调用方据此跳过捕获(fail-closed),
 *  绝不静默改写到别的 bucket。 */
export class LogStoreNotConfiguredError extends Error {
    constructor() {
        super(
            'R2 log store not configured: need R2_LOG_BUCKET_NAME ' +
                '(+ shared R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)',
        );
        this.name = 'LogStoreNotConfiguredError';
    }
}

interface LogStoreEnvSnapshot {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
}

/** 调用时(非 import 时)读 env;不全则抛 LogStoreNotConfiguredError。 */
function readEnv(): LogStoreEnvSnapshot {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_LOG_BUCKET_NAME;
    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
        throw new LogStoreNotConfiguredError();
    }
    return { accountId, accessKeyId, secretAccessKey, bucket };
}

/** 第②步捕获层的总开关探针:env 不全 → false(此时任何 put/get/delete 都会抛)。 */
export function isLogStoreConfigured(): boolean {
    try {
        readEnv();
        return true;
    } catch {
        return false;
    }
}

// Lazy-singleton S3 client,与 client.ts 同模式(env 变更时按签名重建,
// 测试 harness 改 env 后不吃旧缓存)。与 client.ts 各持各的实例。
let _client: S3Client | null = null;
let _envSig: string | null = null;

function client(): S3Client {
    const env = readEnv();
    const sig = `${env.accountId}|${env.accessKeyId}|${env.bucket}`;
    if (!_client || _envSig !== sig) {
        _client = new S3Client({
            region: 'auto',
            endpoint: `https://${env.accountId}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: env.accessKeyId,
                secretAccessKey: env.secretAccessKey,
            },
        });
        _envSig = sig;
    }
    return _client;
}

function utcDatePrefix(at: Date): string {
    const yyyy = String(at.getUTCFullYear());
    const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(at.getUTCDate()).padStart(2, '0');
    return `${REQLOG_PREFIX}/${yyyy}/${mm}/${dd}`;
}

/** 请求体键:`reqlog/{yyyy}/{mm}/{dd}/{request_id}.in.json`(日期 = UTC)。 */
export function reqlogInputKey(requestId: string, at: Date): string {
    return `${utcDatePrefix(at)}/${requestId}.in.json`;
}

/** 响应体键:`reqlog/{yyyy}/{mm}/{dd}/{request_id}.out.json`(日期 = UTC)。 */
export function reqlogOutputKey(requestId: string, at: Date): string {
    return `${utcDatePrefix(at)}/${requestId}.out.json`;
}

/** 第 i 张(0-based)输入图原始字节的键:
 *  `reqlog/{yyyy}/{mm}/{dd}/{request_id}.in.{i}.{ext}`。ext 带不带前导点都收。 */
export function reqlogInputImageKey(requestId: string, at: Date, index: number, ext: string): string {
    const cleanExt = ext.startsWith('.') ? ext.slice(1) : ext;
    return `${utcDatePrefix(at)}/${requestId}.in.${index}.${cleanExt}`;
}

/** 写一个日志对象进私有 bucket。私有 bucket 没有公开 URL —— 与 client.ts
 *  uploadImage 不同,这里不返回 URL,读取走 getLogObject。 */
export async function putLogObject(
    key: string,
    body: Buffer | string,
    contentType: string = 'application/json',
): Promise<void> {
    const env = readEnv();
    await client().send(
        new PutObjectCommand({
            Bucket: env.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
        }),
    );
}

/** 读回一个日志对象(后续 admin 查看页用)。对象不存在时 SDK 抛 NoSuchKey,
 *  由调用方兜(admin 页 404)。 */
export async function getLogObject(key: string): Promise<Buffer> {
    const env = readEnv();
    const res = await client().send(
        new GetObjectCommand({
            Bucket: env.bucket,
            Key: key,
        }),
    );
    if (!res.Body) {
        throw new Error(`R2 log object ${key}: empty response body`);
    }
    return Buffer.from(await res.Body.transformToByteArray());
}

/** 删一个日志对象(未来 retention 清理用)。R2 上删不存在的对象是 no-op。 */
export async function deleteLogObject(key: string): Promise<void> {
    const env = readEnv();
    await client().send(
        new DeleteObjectCommand({
            Bucket: env.bucket,
            Key: key,
        }),
    );
}

/** Test-only:重置缓存 client,让 re-mock 后的 S3Client 生效(镜像 client.ts)。 */
export function _resetLogStoreClientForTest(): void {
    _client = null;
    _envSig = null;
}
