/**
 * Cloudflare R2 client (PR-T1 Phase 2).
 *
 * R2 is S3-compatible, so we use the AWS SDK with R2's endpoint
 * (`https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com`). The bucket
 * `silkroadai-image-gen` was created by the operator with a
 * **public-read** ACL — this matches the customer-share UX intent
 * (random UUID-tagged keys make guessing infeasible), and lets the
 * portal hand back direct R2 URLs without a presigning round-trip.
 *
 * Object key convention (must match `src/app/api/portal/image/generate`):
 *   `image-gen/{user_id}/{generation_id}/{index}.png`
 *
 * Server-only (`import 'server-only'`) — `R2_SECRET_ACCESS_KEY` must
 * NEVER reach a client bundle. Env reads happen lazily inside the
 * helper functions; module load itself reads no env so vitest /
 * typecheck don't blow up when env is unset.
 */
import 'server-only';
import { DeleteObjectCommand, DeleteObjectsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

interface R2EnvSnapshot {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
}

/** Read env at call time (not import time) so test harnesses + the
 *  Next.js dev server boot don't crash before env is wired. Throws
 *  with a typed message so the call site can surface a 503 with a
 *  clear ops signal. */
function readEnv(): R2EnvSnapshot {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_BUCKET_NAME;
    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
        throw new Error(
            'R2 env not configured: need R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME',
        );
    }
    return { accountId, accessKeyId, secretAccessKey, bucket };
}

/** Lazy-singleton S3 client. We keep one per process — credentials
 *  don't change between requests, and the SDK's connection pooling
 *  needs the same client for keepalive. */
let _client: S3Client | null = null;
let _envSig: string | null = null;

function client(): S3Client {
    const env = readEnv();
    // Bust the cached client if env changed (test harness mutation).
    const sig = `${env.accountId}|${env.accessKeyId}|${env.bucket}`;
    if (!_client || _envSig !== sig) {
        _client = new S3Client({
            region: 'auto',
            endpoint: `https://${env.accountId}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: env.accessKeyId,
                secretAccessKey: env.secretAccessKey,
            },
            // R2 doesn't need / use SigV4 path-style + virtual-host
            // distinctions; the SDK default works.
        });
        _envSig = sig;
    }
    return _client;
}

/** Compose the public R2 object URL. Per operator: bucket is
 *  public-read so direct URLs work without presigning. UUID in the
 *  path is the access guard. */
export function getPublicUrl(key: string): string {
    const env = readEnv();
    return `https://${env.accountId}.r2.cloudflarestorage.com/${env.bucket}/${key}`;
}

/** Upload a buffer to R2. Returns the public URL.
 *  `contentType` defaults to `image/png` since image-gen is the only
 *  caller today; explicit param keeps the helper general. */
export async function uploadImage(key: string, body: Buffer, contentType: string = 'image/png'): Promise<string> {
    const env = readEnv();
    await client().send(
        new PutObjectCommand({
            Bucket: env.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            // `CacheControl` defaults to public,max-age=31536000 — generated
            // images are immutable so a year-long cache is safe + saves
            // bandwidth.
            CacheControl: 'public, max-age=31536000, immutable',
        }),
    );
    return getPublicUrl(key);
}

/** Delete a single R2 object. Idempotent — deleting a non-existent
 *  object is a no-op on R2 (200 OK). */
export async function deleteImage(key: string): Promise<void> {
    const env = readEnv();
    await client().send(
        new DeleteObjectCommand({
            Bucket: env.bucket,
            Key: key,
        }),
    );
}

/** Batch delete (max 1000 keys per call per S3 API limit). For the
 *  cleanup cron's "delete one ImageGeneration row" use case we expect
 *  N ≤ 4 keys per row, so a single DeleteObjects call is fine. */
export async function deleteImages(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    if (keys.length > 1000) {
        throw new Error(`deleteImages: max 1000 keys per call, got ${keys.length}`);
    }
    const env = readEnv();
    await client().send(
        new DeleteObjectsCommand({
            Bucket: env.bucket,
            Delete: {
                Objects: keys.map((Key) => ({ Key })),
                Quiet: true,
            },
        }),
    );
}

/** Compose an R2 key for a generated image. Caller passes user/gen
 *  ids + the image index (0-based) within a multi-image batch. */
export function imageKey(userId: string, generationId: string, index: number): string {
    return `image-gen/${userId}/${generationId}/${index}.png`;
}

/** Test-only: reset the cached client so a re-mocked S3Client gets
 *  picked up. NOT exported via index — referenced by full path
 *  `@/lib/r2/client.ts:_resetForTest` only inside vitest. */
export function _resetClientForTest(): void {
    _client = null;
    _envSig = null;
}
