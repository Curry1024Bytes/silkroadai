/** Private, persistent filesystem backend for customer request bodies. */
import 'server-only';
import { constants, accessSync, lstatSync } from 'node:fs';
import { mkdir, open, opendir, readFile, rename, rmdir, statfs, unlink, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { requestLogRetentionDays } from './retention';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MIN_FREE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_SWEEP_FILES = 200_000;
const LOG_KEY =
    /^reqlog\/(\d{4})\/(\d{2})\/(\d{2})\/[a-zA-Z0-9-]{1,80}\.(?:in\.json|out\.json|in\.\d{1,3}\.[a-zA-Z0-9]{1,8})$/;

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function privateDirectory(dir: string): boolean {
    try {
        const info = lstatSync(dir);
        if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) return false;
        if (process.getuid && info.uid !== process.getuid()) return false;
        accessSync(dir, constants.R_OK | constants.W_OK | constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** An explicit absolute path and a private, writable mount are required. */
export function localLogRoot(): string | null {
    const dir = process.env.REQUEST_LOG_LOCAL_DIR;
    if (!dir || !path.isAbsolute(dir) || dir === '/') return null;
    return privateDirectory(dir) ? dir : null;
}

function requiredRoot(): string {
    const root = localLogRoot();
    if (!root) throw new Error('private request-log local directory is not configured or writable');
    return root;
}

function objectPath(root: string, key: string): string {
    const match = LOG_KEY.exec(key);
    if (!match) throw new Error('invalid request-log object key');
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error('invalid request-log object date');
    return path.join(root, ...key.split('/'));
}

async function ensurePrivateParents(root: string, key: string): Promise<void> {
    const segments = key.split('/').slice(0, -1);
    let dir = root;
    for (const segment of segments) {
        dir = path.join(dir, segment);
        await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
        });
        if (!privateDirectory(dir)) throw new Error('request-log directory is not private');
    }
}

function minFreeBytes(): number {
    const raw = process.env.REQUEST_LOG_LOCAL_MIN_FREE_BYTES;
    if (raw == null || raw === '') return DEFAULT_MIN_FREE_BYTES;
    const configured = Number(raw);
    return Number.isSafeInteger(configured) && configured >= 0 ? configured : DEFAULT_MIN_FREE_BYTES;
}

function verifyPrivateParents(root: string, key: string): void {
    let dir = root;
    for (const segment of key.split('/').slice(0, -1)) {
        dir = path.join(dir, segment);
        if (!privateDirectory(dir)) throw new Error('request-log directory is not private');
    }
}

/** Write through a private temporary file, then atomically publish it. */
export async function putLocalLogObject(key: string, body: Buffer | string): Promise<void> {
    const root = requiredRoot();
    const target = objectPath(root, key);
    const bytes = Buffer.isBuffer(body) ? body.byteLength : Buffer.byteLength(body);
    const space = await statfs(root);
    if (space.bavail * space.bsize - bytes < minFreeBytes()) {
        throw new Error('request-log disk reserve reached');
    }
    await ensurePrivateParents(root, key);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
            await handle.writeFile(body);
        } finally {
            await handle.close();
        }
        await rename(temporary, target);
    } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
    }
}

export async function getLocalLogObject(key: string): Promise<Buffer> {
    const root = requiredRoot();
    const target = objectPath(root, key);
    verifyPrivateParents(root, key);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        throw new Error('request-log object is not a private regular file');
    }
    return readFile(target);
}

export async function deleteLocalLogObject(key: string): Promise<void> {
    const root = requiredRoot();
    const target = objectPath(root, key);
    verifyPrivateParents(root, key);
    await unlink(target).catch((error) => {
        if (!isMissing(error)) throw error;
    });
}

async function removeEmpty(dir: string): Promise<void> {
    await rmdir(dir).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
    });
}

/** Sweep expired files, including orphans left by a failed metadata insert.
 *  The date partition limits scans to days that could contain expired files;
 *  mtime gives each object at least the configured retention period. */
export async function sweepExpiredLocalLogObjects(now: Date = new Date()): Promise<{ deleted: number }> {
    if (process.env.REQUEST_LOG_STORE !== 'local') return { deleted: 0 };
    const root = requiredRoot();
    const prefix = path.join(root, 'reqlog');
    const cutoff = now.getTime() - requestLogRetentionDays() * DAY_MS;
    let deleted = 0;
    let inspected = 0;
    let years;
    try {
        years = await opendir(prefix);
    } catch (error) {
        if (isMissing(error)) return { deleted: 0 };
        throw error;
    }
    if (!privateDirectory(prefix)) {
        await years.close();
        throw new Error('request-log directory is not private');
    }
    for await (const year of years) {
        if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
        const yearPath = path.join(prefix, year.name);
        if (!privateDirectory(yearPath)) throw new Error('request-log directory is not private');
        for await (const month of await opendir(yearPath)) {
            if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
            const monthPath = path.join(yearPath, month.name);
            if (!privateDirectory(monthPath)) throw new Error('request-log directory is not private');
            for await (const day of await opendir(monthPath)) {
                if (!day.isDirectory() || !/^\d{2}$/.test(day.name)) continue;
                const dayStart = Date.UTC(Number(year.name), Number(month.name) - 1, Number(day.name));
                if (dayStart > cutoff) continue;
                const dayPath = path.join(monthPath, day.name);
                if (!privateDirectory(dayPath)) throw new Error('request-log directory is not private');
                for await (const file of await opendir(dayPath)) {
                    if (inspected++ >= MAX_SWEEP_FILES) return { deleted };
                    if (!file.isFile() && !file.isSymbolicLink()) continue;
                    const filePath = path.join(dayPath, file.name);
                    let info;
                    try {
                        info = await lstat(filePath);
                    } catch (error) {
                        if (isMissing(error)) continue;
                        throw error;
                    }
                    if (info.mtimeMs <= cutoff) {
                        await unlink(filePath).catch((error) => {
                            if (!isMissing(error)) throw error;
                        });
                        deleted++;
                    }
                }
                await removeEmpty(dayPath);
            }
            await removeEmpty(monthPath);
        }
        await removeEmpty(yearPath);
    }
    await removeEmpty(prefix);
    return { deleted };
}
