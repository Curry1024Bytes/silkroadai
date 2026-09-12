import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
    adapter: vi.fn(),
    client: vi.fn(),
    findMany: vi.fn(),
    disconnect: vi.fn(),
}));

vi.mock('@prisma/adapter-mariadb', () => ({
    PrismaMariaDb: class {
        constructor(...args: unknown[]) {
            mocks.adapter(...args);
        }
    },
}));
vi.mock('@/generated/newapi-readonly/client', () => ({
    PrismaClient: class {
        newApiOption = { findMany: mocks.findMany };
        $disconnect = mocks.disconnect;
        constructor(...args: unknown[]) {
            mocks.client(...args);
        }
    },
}));

import { readPersistedPricingOptions } from '@/lib/newapi/persisted-pricing';

const options = {
    ModelRatio: '{"test":1}',
    CompletionRatio: '{"test":2}',
    ModelPrice: '{}',
    GroupRatio: '{"default":1}',
};
const rows = () => Object.entries(options).map(([key, value]) => ({ key, value }));

beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('NEWAPI_PRICING_DATABASE_URL', 'mysql://readonly:fixture-secret@localhost:13306/newapi');
    vi.stubEnv('NEWAPI_PRICING_RSA_PUBLIC_KEY_FILE', undefined);
    mocks.findMany.mockResolvedValue(rows());
    mocks.disconnect.mockResolvedValue(undefined);
});

describe('explicitly pinned server RSA public key', () => {
    let directory: string;
    let publicKey: string;
    beforeAll(() => {
        directory = mkdtempSync(path.join(tmpdir(), 'llmroute-pinned-rsa-'));
        const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
        publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
        const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const files = {
            'valid.pem': publicKey,
            'mysql-terminated.pem': publicKey + '\0',
            'repeated-null.pem': publicKey + '\0\0',
            'embedded-null.pem': publicKey.replace('-----END', '\0-----END'),
            'invalid.pem': 'not a public key fixture-secret',
            'oversized.pem': 'x'.repeat(16_385),
            'ec.pem': ec.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
            'private.pem': pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
            'multiple.pem': publicKey + publicKey,
        };
        for (const [name, content] of Object.entries(files))
            writeFileSync(path.join(directory, name), content, { mode: 0o600 });
    });
    afterAll(() => rmSync(directory, { recursive: true, force: true }));

    it('passes a validated pinned public key and disables network public-key retrieval', async () => {
        vi.stubEnv('NEWAPI_PRICING_RSA_PUBLIC_KEY_FILE', path.join(directory, 'valid.pem'));
        await readPersistedPricingOptions();
        expect(mocks.adapter).toHaveBeenCalledWith(
            expect.objectContaining({
                cachingRsaPublicKey: publicKey,
                rsaPublicKey: publicKey,
                allowPublicKeyRetrieval: false,
            }),
        );
        expect(mocks.adapter.mock.calls[0][0]).not.toHaveProperty('ssl');
    });

    it('prefers verified TLS without loading an unused RSA file', async () => {
        vi.stubEnv('NEWAPI_PRICING_DATABASE_URL', 'mysql://readonly:fixture@localhost/newapi?ssl=true');
        vi.stubEnv('NEWAPI_PRICING_RSA_PUBLIC_KEY_FILE', path.join(directory, 'missing.pem'));
        await readPersistedPricingOptions();
        expect(mocks.adapter.mock.calls[0][0]).toMatchObject({
            ssl: { rejectUnauthorized: true },
            allowPublicKeyRetrieval: false,
        });
        expect(mocks.adapter.mock.calls[0][0]).not.toHaveProperty('cachingRsaPublicKey');
    });

    it('accepts the single trailing NUL in MySQL-generated public key files', async () => {
        vi.stubEnv('NEWAPI_PRICING_RSA_PUBLIC_KEY_FILE', path.join(directory, 'mysql-terminated.pem'));
        await readPersistedPricingOptions();
        expect(mocks.adapter.mock.calls[0][0]).toMatchObject({
            cachingRsaPublicKey: publicKey,
            rsaPublicKey: publicKey,
            allowPublicKeyRetrieval: false,
        });
    });

    it.each([
        'relative',
        'missing.pem',
        'invalid.pem',
        'oversized.pem',
        'ec.pem',
        'private.pem',
        'multiple.pem',
        'repeated-null.pem',
        'embedded-null.pem',
        'directory',
    ])('refuses an invalid pinned key without forwarding contents or paths (%s)', async (name) => {
        const file =
            name === 'relative' ? 'relative.pem' : name === 'directory' ? directory : path.join(directory, name);
        vi.stubEnv('NEWAPI_PRICING_RSA_PUBLIC_KEY_FILE', file);
        const error = await readPersistedPricingOptions().catch((e: unknown) => e);
        expect(error).toMatchObject({ code: 'persisted_pricing_unavailable' });
        expect(String(error)).not.toContain(file);
        expect(String(error)).not.toContain('fixture-secret');
        expect(String(error)).not.toContain('BEGIN');
        expect(mocks.adapter).not.toHaveBeenCalled();
        expect(mocks.findMany).not.toHaveBeenCalled();
    });
});
afterEach(() => vi.unstubAllEnvs());

describe('persisted new-api pricing read boundary', () => {
    it.each([undefined, '', '   '])('fails closed without a configured read-only URL (%s)', async (url) => {
        vi.stubEnv('NEWAPI_PRICING_DATABASE_URL', url);
        await expect(readPersistedPricingOptions()).rejects.toMatchObject({ code: 'persisted_pricing_not_configured' });
        expect(mocks.adapter).not.toHaveBeenCalled();
        expect(mocks.client).not.toHaveBeenCalled();
        expect(mocks.findMany).not.toHaveBeenCalled();
    });

    it('selects only the four named persisted options and returns their original strings', async () => {
        expect(await readPersistedPricingOptions()).toEqual(options);
        expect(mocks.findMany).toHaveBeenCalledExactlyOnceWith({
            where: { key: { in: ['ModelRatio', 'CompletionRatio', 'ModelPrice', 'GroupRatio'] } },
            select: { key: true, value: true },
        });
        expect(mocks.disconnect).toHaveBeenCalledOnce();
        expect(mocks.client).toHaveBeenCalledWith(expect.objectContaining({ log: [], errorFormat: 'minimal' }));
    });

    it('rereads persistence on every invocation instead of trusting cached values', async () => {
        const changed = { ...options, ModelRatio: '{"test":3}' };
        mocks.findMany
            .mockResolvedValueOnce(rows())
            .mockResolvedValueOnce(Object.entries(changed).map(([key, value]) => ({ key, value })));
        expect(await readPersistedPricingOptions()).toEqual(options);
        expect(await readPersistedPricingOptions()).toEqual(changed);
        expect(mocks.findMany).toHaveBeenCalledTimes(2);
        expect(mocks.disconnect).toHaveBeenCalledTimes(2);
    });

    it.each(['ModelRatio', 'CompletionRatio', 'ModelPrice', 'GroupRatio'])(
        'refuses missing %s without inventing defaults',
        async (missing) => {
            mocks.findMany.mockResolvedValue(rows().filter((row) => row.key !== missing));
            await expect(readPersistedPricingOptions()).rejects.toMatchObject({ code: 'persisted_pricing_incomplete' });
            expect(mocks.disconnect).toHaveBeenCalledOnce();
        },
    );

    it.each([null, '', ' ', 4])('refuses non-string or blank stored values (%s)', async (value) => {
        mocks.findMany.mockResolvedValue([{ key: 'ModelRatio', value }, ...rows().slice(1)]);
        await expect(readPersistedPricingOptions()).rejects.toMatchObject({ code: 'persisted_pricing_incomplete' });
    });

    it('rejects case-insensitive database key matches rather than substituting a different option', async () => {
        mocks.findMany.mockResolvedValue([{ key: 'modelratio', value: '{}' }, ...rows().slice(1)]);
        await expect(readPersistedPricingOptions()).rejects.toMatchObject({ code: 'persisted_pricing_incomplete' });
    });

    it('rejects duplicate and unexpected rows without returning unrelated option values', async () => {
        for (const extra of [{ key: 'SMTPToken', value: 'fixture-secret' }, rows()[0]]) {
            mocks.findMany.mockResolvedValue([...rows(), extra]);
            const error = await readPersistedPricingOptions().catch((e: unknown) => e);
            expect(error).toMatchObject({ code: 'persisted_pricing_incomplete' });
            expect(String(error)).not.toContain('fixture-secret');
        }
    });

    it('cleans up a failed query and never exposes the driver message or error cause', async () => {
        mocks.findMany.mockRejectedValue(new Error('mysql://readonly:fixture-secret@localhost/newapi query failure'));
        const error = await readPersistedPricingOptions().catch((e: unknown) => e);
        expect(error).toMatchObject({ code: 'persisted_pricing_unavailable' });
        expect(String(error)).not.toContain('fixture-secret');
        expect(error).not.toHaveProperty('cause');
        expect(mocks.disconnect).toHaveBeenCalledOnce();
    });

    it('sanitizes client construction and connection setup failures', async () => {
        mocks.client.mockImplementation(() => {
            throw new Error('fixture-secret client error');
        });
        const error = await readPersistedPricingOptions().catch((e: unknown) => e);
        expect(error).toMatchObject({ code: 'persisted_pricing_unavailable' });
        expect(String(error)).not.toContain('fixture-secret');
        expect(mocks.findMany).not.toHaveBeenCalled();
    });

    it('does not report verification success if connection cleanup itself fails', async () => {
        mocks.disconnect.mockRejectedValue(new Error('fixture-secret close error'));
        const error = await readPersistedPricingOptions().catch((e: unknown) => e);
        expect(error).toMatchObject({ code: 'persisted_pricing_unavailable' });
        expect(String(error)).not.toContain('fixture-secret');
    });
});

describe('restricted MySQL connection configuration', () => {
    it('decodes credentials correctly and retains TLS verification', async () => {
        vi.stubEnv('NEWAPI_PRICING_DATABASE_URL', 'mysql://read%40only:test%3Apass%2Fword@[::1]:13306/newapi?ssl=true');
        await readPersistedPricingOptions();
        expect(mocks.adapter).toHaveBeenCalledWith(
            expect.objectContaining({
                host: '::1',
                port: 13306,
                user: 'read@only',
                password: 'test:pass/word',
                database: 'newapi',
                ssl: { rejectUnauthorized: true },
                connectionLimit: 1,
                connectTimeout: 5000,
                acquireTimeout: 7000,
                socketTimeout: 10000,
                multipleStatements: false,
            }),
        );
        expect(mocks.adapter.mock.calls[0][0]).not.toHaveProperty('queryTimeout');
    });

    it.each([
        'postgresql://readonly:fixture-secret@localhost/newapi',
        'not-a-url',
        'mysql://localhost/newapi',
        'mysql://readonly:fixture-secret@localhost/',
        'mysql://readonly:fixture-secret@localhost/db/other',
        'mysql://readonly:fixture-secret@localhost/newapi?initSql=DELETE',
        'mysql://readonly:fixture-secret@localhost/newapi?ssl=false',
        'mysql://readonly:fixture-secret@localhost/newapi?ssl=true&ssl=true',
        'mysql://readonly:fixture-secret@localhost/newapi#unexpected',
    ])('rejects unsupported configuration without forwarding driver options (%s)', async (url) => {
        vi.stubEnv('NEWAPI_PRICING_DATABASE_URL', url);
        const error = await readPersistedPricingOptions().catch((e: unknown) => e);
        expect(error).toMatchObject({ code: 'persisted_pricing_unavailable' });
        expect(String(error)).not.toContain('fixture-secret');
        expect(mocks.adapter).not.toHaveBeenCalled();
        expect(mocks.findMany).not.toHaveBeenCalled();
    });
});
