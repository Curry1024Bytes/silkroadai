import { chmod, lstat, mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    deleteLogObject,
    getLogObject,
    isLogStoreConfigured,
    LogStoreNotConfiguredError,
    putLogObject,
    reqlogInputKey,
    reqlogOutputKey,
} from '@/lib/r2/log-store';
import { sweepExpiredLocalLogObjects } from '../local-log-store';

const at = new Date('2026-10-15T02:00:00Z');
let root: string;

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'llmroute-reqlog-'));
    await chmod(root, 0o700);
    process.env.REQUEST_LOG_STORE = 'local';
    process.env.REQUEST_LOG_LOCAL_DIR = root;
    process.env.REQUEST_LOG_LOCAL_MIN_FREE_BYTES = '0';
    process.env.REQUEST_LOGGING_RETENTION_DAYS = '7';
});

afterEach(async () => {
    delete process.env.REQUEST_LOG_STORE;
    delete process.env.REQUEST_LOG_LOCAL_DIR;
    delete process.env.REQUEST_LOG_LOCAL_MIN_FREE_BYTES;
    delete process.env.REQUEST_LOGGING_RETENTION_DAYS;
    await rm(root, { recursive: true, force: true });
});

describe('private local request-log storage', () => {
    it('writes, reads and deletes text and binary objects without R2 credentials', async () => {
        const inputKey = reqlogInputKey('request-1', at);
        const outputKey = reqlogOutputKey('request-1', at);
        expect(isLogStoreConfigured()).toBe(true);
        await putLogObject(inputKey, '{"prompt":"hello"}');
        await putLogObject(outputKey, Buffer.from([0, 255, 3]), 'application/octet-stream');
        expect((await getLogObject(inputKey)).toString()).toBe('{"prompt":"hello"}');
        expect(await getLogObject(outputKey)).toEqual(Buffer.from([0, 255, 3]));
        expect((await lstat(path.join(root, inputKey))).mode & 0o777).toBe(0o600);
        expect((await lstat(path.dirname(path.join(root, inputKey)))).mode & 0o777).toBe(0o700);
        await deleteLogObject(inputKey);
        await expect(readFile(path.join(root, inputKey))).rejects.toMatchObject({ code: 'ENOENT' });
        await deleteLogObject(inputKey);
    });

    it('fails closed for an unsafe mount, invalid backend, and traversal key', async () => {
        await chmod(root, 0o755);
        expect(isLogStoreConfigured()).toBe(false);
        await expect(putLogObject(reqlogInputKey('request-2', at), 'x')).rejects.toBeInstanceOf(
            LogStoreNotConfiguredError,
        );
        await chmod(root, 0o700);
        await expect(putLogObject('../outside.in.json', 'x')).rejects.toThrow('invalid request-log object key');
        process.env.REQUEST_LOG_STORE = 'unknown';
        expect(isLogStoreConfigured()).toBe(false);
        await expect(putLogObject(reqlogInputKey('request-2', at), 'x')).rejects.toBeInstanceOf(
            LogStoreNotConfiguredError,
        );
    });

    it('preserves free disk space and never writes when the reserve is reached', async () => {
        const key = reqlogOutputKey('request-3', at);
        process.env.REQUEST_LOG_LOCAL_MIN_FREE_BYTES = String(Number.MAX_SAFE_INTEGER);
        await expect(putLogObject(key, 'hello')).rejects.toThrow('disk reserve reached');
        await expect(readFile(path.join(root, key))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('sweeps seven-day-old bodies, including orphans, but retains recent bodies', async () => {
        const oldKey = reqlogInputKey('expired', new Date('2026-10-06T00:00:00Z'));
        const orphanKey = reqlogOutputKey('orphan', new Date('2026-10-06T00:00:00Z'));
        const freshKey = reqlogInputKey('fresh', new Date('2026-10-14T00:00:00Z'));
        await Promise.all([
            putLogObject(oldKey, 'old'),
            putLogObject(orphanKey, 'orphan'),
            putLogObject(freshKey, 'fresh'),
        ]);
        const old = new Date('2026-10-06T00:00:00Z');
        await utimes(path.join(root, oldKey), old, old);
        await utimes(path.join(root, orphanKey), old, old);
        expect(await sweepExpiredLocalLogObjects(new Date('2026-10-15T12:00:00Z'))).toEqual({ deleted: 2 });
        await expect(readFile(path.join(root, oldKey))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(path.join(root, orphanKey))).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await getLogObject(freshKey)).toString()).toBe('fresh');
    });
});
