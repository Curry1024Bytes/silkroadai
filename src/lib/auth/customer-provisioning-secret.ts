import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_ENV = 'PORTAL_CUSTOMER_PROVISIONING_ENC_KEY';

function readKey(): Buffer {
    const value = process.env[KEY_ENV];
    if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error(`${KEY_ENV} must be 64 hex chars (32 bytes)`);
    }
    return Buffer.from(value, 'hex');
}

/** Encrypts the stable new-api password stored while provisioning is pending. */
export function encryptCustomerProvisioningPassword(password: string): string {
    if (!password) throw new Error('Provisioning password must not be empty');
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, readKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/** Authentication fails closed if ciphertext or key has been changed. */
export function decryptCustomerProvisioningPassword(encrypted: string): string {
    const bytes = Buffer.from(encrypted, 'base64');
    if (bytes.length < IV_LENGTH + TAG_LENGTH + 1) {
        throw new Error('Invalid customer provisioning ciphertext');
    }
    const iv = bytes.subarray(0, IV_LENGTH);
    const tag = bytes.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = bytes.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, readKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
