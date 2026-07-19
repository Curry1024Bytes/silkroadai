/**
 * 独立门户客户上游 key 的 AES-256-GCM 加解密(P1)。
 *
 * 镜像 src/lib/oss/encryption.ts,但 env 独立(ENTERPRISE_UPSTREAM_ENC_KEY)——
 * 密钥职责分开:OSS secret 与上游 key 不共用一把加密 key。
 * ⚠️ 一旦投产且有客户上游 key 落库就【不可更换】(换了已存密文全解不开),进 1Password。
 *
 * - 存储格式:Base64( iv(12) ‖ authTag(16) ‖ ciphertext )。GCM 自带完整性校验。
 * - Env 在调用时才读(lazy),import 本身不读 env。
 */
import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
    const hex = process.env.ENTERPRISE_UPSTREAM_ENC_KEY;
    if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error('ENTERPRISE_UPSTREAM_ENC_KEY must be 64 hex chars (32 bytes). Generate: openssl rand -hex 32');
    }
    return Buffer.from(hex, 'hex');
}

export function encryptUpstreamKey(plaintext: string): string {
    const key = getKey();
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALG, key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptUpstreamKey(ciphertext: string): string {
    const key = getKey();
    const raw = Buffer.from(ciphertext, 'base64');
    if (raw.length < IV_LEN + TAG_LEN + 1) {
        throw new Error('decryptUpstreamKey: ciphertext too short / corrupted');
    }
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
