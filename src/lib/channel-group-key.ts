import { createHash } from 'node:crypto';

const MAX_KEY_LENGTH = 50;

/** Generate a new Portal identifier without renaming any existing tier keys. */
export function generateChannelGroupKey(group: string, usedKeys: Iterable<string>): string {
    const source = group.trim();
    const readable = source
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    // Keep distinct non-ASCII names distinct even when their readable part is the same.
    // Hash long names as well so truncation does not discard their distinguishing suffix.
    const needsHash = /[^\x00-\x7f]/.test(source) || readable.length > MAX_KEY_LENGTH || !readable;
    const digest = needsHash ? createHash('sha256').update(source).digest('hex').slice(0, 10) : '';
    const prefix = (readable || 'tier').slice(0, MAX_KEY_LENGTH - (digest ? digest.length + 1 : 0));
    const base = digest ? `${prefix.replace(/-+$/g, '')}-${digest}` : prefix;
    const used = new Set(usedKeys);
    let key = base;
    for (let index = 2; used.has(key); index++) {
        const suffix = `-${index}`;
        key = `${base.slice(0, MAX_KEY_LENGTH - suffix.length).replace(/-+$/g, '')}${suffix}`;
    }
    return key;
}
