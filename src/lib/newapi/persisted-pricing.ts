import 'server-only';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '@/generated/newapi-readonly/client';
import { createPublicKey } from 'node:crypto';
import { openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const OPTION_KEYS = ['ModelRatio', 'CompletionRatio', 'ModelPrice', 'GroupRatio'] as const;
type PersistedPricingOptions = Record<(typeof OPTION_KEYS)[number], string>;
const TIERED_OPTION_KEYS = [
    ...OPTION_KEYS,
    'billing_setting.billing_mode',
    'billing_setting.billing_expr',
    'GroupGroupRatio',
] as const;
export type PersistedTieredPricingOptions = Record<(typeof TIERED_OPTION_KEYS)[number], string>;
type VerificationFailure =
    'persisted_pricing_not_configured' | 'persisted_pricing_unavailable' | 'persisted_pricing_incomplete';

function failure(code: VerificationFailure): Error & { code: VerificationFailure } {
    const messages: Record<VerificationFailure, string> = {
        persisted_pricing_not_configured: '未配置 new-api 持久化价格只读连接，当前无法核验，不能发布计费价格。',
        persisted_pricing_unavailable: '无法读取 new-api 持久化价格，当前无法核验，不能发布计费价格。',
        persisted_pricing_incomplete: 'new-api 持久化价格配置不完整，当前无法核验，不能发布计费价格。',
    };
    // Never attach the original driver error/cause: it may contain credentials.
    return Object.assign(new Error(messages[code]), { code });
}

function pinnedRsaKey(): string | undefined {
    const file = process.env.NEWAPI_PRICING_RSA_PUBLIC_KEY_FILE?.trim();
    if (!file) return undefined;
    if (!isAbsolute(file)) throw failure('persisted_pricing_unavailable');
    const maxBytes = 16_384;
    let descriptor: number | undefined;
    try {
        descriptor = openSync(file, 'r');
        const stat = fstatSync(descriptor);
        if (!stat.isFile() || stat.size > maxBytes || stat.size < 32) throw new Error('Invalid public key file');
        // Read at most the bound plus one byte, even if the file grows after stat.
        const buffer = Buffer.alloc(maxBytes + 1);
        const count = readSync(descriptor, buffer, 0, buffer.length, 0);
        if (count > maxBytes) throw new Error('Public key exceeds size limit');
        // MySQL 8 can terminate its generated public_key.pem with one NUL.
        // Strip only that final byte; embedded or repeated NULs still fail PEM validation.
        const end = count > 0 && buffer[count - 1] === 0 ? count - 1 : count;
        const pem = buffer.subarray(0, end).toString('utf8').trim();
        if (!/^-----BEGIN (RSA PUBLIC KEY|PUBLIC KEY)-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END \1-----$/.test(pem))
            throw new Error('Expected one PEM public key');
        const key = createPublicKey(pem);
        if (key.asymmetricKeyType !== 'rsa') throw new Error('Expected an RSA public key');
        return key.export({ type: 'spki', format: 'pem' }).toString();
    } finally {
        if (descriptor !== undefined) closeSync(descriptor);
    }
}

function connectionOptions(raw: string) {
    try {
        const url = new URL(raw);
        const database = decodeURIComponent(url.pathname.slice(1));
        // Only plain connection coordinates and TLS opt-in are accepted. Do not
        // forward arbitrary driver URL options (e.g. initSql/sessionVariables).
        if (
            url.protocol !== 'mysql:' ||
            !url.hostname ||
            !url.username ||
            !database ||
            database.includes('/') ||
            url.hash ||
            [...url.searchParams.keys()].some((key) => key !== 'ssl') ||
            url.searchParams.getAll('ssl').length > 1 ||
            (url.searchParams.has('ssl') && url.searchParams.get('ssl') !== 'true')
        )
            throw new Error('Invalid connection configuration');
        // TLS is preferred. For an audited Docker-network connection without
        // TLS, a locally pinned server key supports MySQL caching_sha2_password
        // without accepting a key supplied by an unverified network endpoint.
        const rsa = url.searchParams.has('ssl') ? undefined : pinnedRsaKey();
        return {
            host: url.hostname.replace(/^\[|\]$/g, ''),
            port: url.port ? Number(url.port) : 3306,
            user: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
            database,
            ...(url.searchParams.has('ssl') ? { ssl: { rejectUnauthorized: true } } : {}),
            ...(rsa ? { cachingRsaPublicKey: rsa, rsaPublicKey: rsa } : {}),
            allowPublicKeyRetrieval: false,
            connectionLimit: 1,
            connectTimeout: 5_000,
            acquireTimeout: 7_000,
            socketTimeout: 10_000,
            // mariadb's queryTimeout issues MariaDB-only session SQL and rejects
            // MySQL 8. Socket timeout bounds stalled reads without that command.
            multipleStatements: false,
        };
    } catch {
        throw failure('persisted_pricing_unavailable');
    }
}

/**
 * Read four persisted option values through the independent MySQL Prisma client.
 * No API-memory fallback, cache, schema migration, raw SQL or new-api writes.
 * The dedicated database account must have SELECT on new-api.options only.
 * Errors explicitly mean verification is unavailable, never permission to publish.
 */
export async function readPersistedPricingOptions(): Promise<PersistedPricingOptions> {
    return readPersistedOptions(OPTION_KEYS);
}

/**
 * Tiered publication verifies the original dictionaries plus the expression,
 * mode and customer group overrides. A never-persisted override dictionary has
 * no overrides; an explicitly malformed row is still rejected. Legacy callers
 * retain their original four-option query and contract.
 */
export async function readPersistedTieredPricingOptions(): Promise<PersistedTieredPricingOptions> {
    return readPersistedOptions(TIERED_OPTION_KEYS, ['GroupGroupRatio']);
}

async function readPersistedOptions<const Keys extends readonly string[]>(
    keys: Keys,
    absentEmptyDictionaries: readonly Keys[number][] = [],
): Promise<Record<Keys[number], string>> {
    const raw = process.env.NEWAPI_PRICING_DATABASE_URL?.trim();
    if (!raw) throw failure('persisted_pricing_not_configured');

    let client: PrismaClient | undefined;
    try {
        client = new PrismaClient({
            adapter: new PrismaMariaDb(connectionOptions(raw)),
            log: [],
            errorFormat: 'minimal',
        });
        const rows = await client.newApiOption.findMany({
            where: { key: { in: [...keys] } },
            select: { key: true, value: true },
        });
        const values: Partial<Record<Keys[number], string>> = {};
        for (const row of rows) {
            if (
                !keys.includes(row.key) ||
                Object.hasOwn(values, row.key) ||
                typeof row.value !== 'string' ||
                !row.value.trim()
            )
                throw failure('persisted_pricing_incomplete');
            values[row.key as Keys[number]] = row.value;
        }
        for (const key of absentEmptyDictionaries) if (!Object.hasOwn(values, key)) values[key] = '{}';
        if (keys.some((key) => !Object.hasOwn(values, key))) throw failure('persisted_pricing_incomplete');
        return values as Record<Keys[number], string>;
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'persisted_pricing_incomplete')
            throw failure('persisted_pricing_incomplete');
        throw failure('persisted_pricing_unavailable');
    } finally {
        if (client)
            try {
                await client.$disconnect();
            } catch {
                throw failure('persisted_pricing_unavailable');
            }
    }
}
