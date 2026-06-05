/**
 * 客户 OSS secret 的 AES-256-GCM 加解密(W9 D3 PR-C)。
 *
 * - Key 来自 `PORTAL_OSS_ENC_KEY` env(64 hex = 32 bytes)。
 *   operator 部署前必须先:`echo "PORTAL_OSS_ENC_KEY=$(openssl rand -hex 32)" >> .env`
 * - 存储格式:Base64( iv(12) ‖ authTag(16) ‖ ciphertext )。
 *   GCM 自带完整性校验 — DB 里被改过的密文 decrypt 时直接 throw。
 * - Env 在调用时才读(镜像 r2/client.ts 的 lazy 模式),import 本身不读 env,
 *   测试 / build / dev server 启动不会因 env 未配而炸。
 *
 * Server-only — secret 永远不能进 client bundle。
 */
import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
    const hex = process.env.PORTAL_OSS_ENC_KEY;
    if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error('PORTAL_OSS_ENC_KEY must be 64 hex chars (32 bytes). Generate: openssl rand -hex 32');
    }
    return Buffer.from(hex, 'hex');
}

export function encryptSecret(plaintext: string): string {
    const key = getKey();
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALG, key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptSecret(ciphertext: string): string {
    const key = getKey();
    const raw = Buffer.from(ciphertext, 'base64');
    if (raw.length < IV_LEN + TAG_LEN + 1) {
        throw new Error('decryptSecret: ciphertext too short / corrupted');
    }
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
