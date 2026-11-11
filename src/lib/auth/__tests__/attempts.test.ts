/**
 * Auth attempt log + brute-force throttle.
 *
 * Runs the real module against a small in-memory stand-in for
 * `prisma.authAttempt` (where / orderBy / skip semantics), so these assert
 * behaviour — "the 10th failure locks the account" — rather than query shapes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
    id: string;
    kind: string;
    outcome: string;
    email: string | null;
    ip: string | null;
    user_id: string | null;
    user_agent: string | null;
    created_at: Date;
}

type Cond = string | null | { in?: string[]; gt?: Date; lt?: Date };
type Where = Partial<Record<keyof Row, Cond>>;

const db = vi.hoisted(() => ({
    rows: [] as Row[],
    failReads: false,
    failWrites: false,
    seq: 0,
}));

function matches(row: Row, where: Where): boolean {
    for (const [key, cond] of Object.entries(where) as Array<[keyof Row, Cond]>) {
        const value = row[key];
        if (cond !== null && typeof cond === 'object') {
            if (cond.in && !cond.in.includes(value as string)) return false;
            if (cond.gt && !((value as Date) > cond.gt)) return false;
            if (cond.lt && !((value as Date) < cond.lt)) return false;
        } else if (value !== cond) {
            return false;
        }
    }
    return true;
}

vi.mock('@/lib/db', () => ({
    prisma: {
        authAttempt: {
            findFirst: async (args: { where: Where; skip?: number }) => {
                if (db.failReads) throw new Error('db down');
                const hits = db.rows
                    .filter((r) => matches(r, args.where))
                    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
                return hits[args.skip ?? 0] ?? null;
            },
            create: async (args: { data: Omit<Row, 'id'> }) => {
                if (db.failWrites) throw new Error('db down');
                const row: Row = { id: `row-${++db.seq}`, ...args.data };
                db.rows.push(row);
                return { id: row.id };
            },
            update: async (args: { where: { id: string }; data: Partial<Row> }) => {
                if (db.failWrites) throw new Error('db down');
                const row = db.rows.find((r) => r.id === args.where.id);
                if (!row) throw new Error('not found');
                Object.assign(row, args.data);
                return row;
            },
            deleteMany: async (args: { where: Where }) => {
                const before = db.rows.length;
                db.rows = db.rows.filter((r) => !matches(r, args.where));
                return { count: before - db.rows.length };
            },
        },
    },
}));

import {
    AUTH_RATE_LIMITS,
    checkAuthRateLimit,
    recordAuthAttempt,
    resolveAuthAttempt,
    tooManyAttemptsResponse,
} from '../attempts';

const NOW = new Date('2026-11-11T08:00:00.000Z');
const MIN = 60_000;
const IP = '203.0.113.7';
const EMAIL = 'victim@silkroadai.io';

/** Seed `n` rows, one second apart, the newest `agoMs` before NOW. */
function seed(n: number, row: Partial<Row> & { kind: string; outcome: string }, agoMs = MIN): void {
    for (let i = 0; i < n; i++) {
        db.rows.push({
            id: `seed-${++db.seq}`,
            email: null,
            ip: null,
            user_id: null,
            user_agent: null,
            created_at: new Date(NOW.getTime() - agoMs - i * 1000),
            ...row,
        });
    }
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    db.rows = [];
    db.failReads = false;
    db.failWrites = false;
    db.seq = 0;
    delete process.env.AUTH_RATE_LIMIT_DISABLED;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('checkAuthRateLimit — login, per email', () => {
    it('9 failures: still open', async () => {
        seed(9, { kind: 'login', outcome: 'bad_password', email: EMAIL });
        expect(await checkAuthRateLimit('login', { email: EMAIL, ip: null }, NOW)).toEqual({ limited: false });
    });

    it('10 failures: locked, and Retry-After is when the oldest one leaves the window', async () => {
        // newest 60s ago, one per second → the 10th-newest is 69s old
        seed(10, { kind: 'login', outcome: 'bad_password', email: EMAIL });
        const v = await checkAuthRateLimit('login', { email: EMAIL, ip: null }, NOW);
        expect(v).toEqual({ limited: true, scope: 'email', retryAfterSeconds: 15 * 60 - 69 });
    });

    it('counts unknown_email and inactive the same as bad_password (no existence oracle)', async () => {
        seed(4, { kind: 'login', outcome: 'unknown_email', email: 'ghost@example.com' });
        seed(3, { kind: 'login', outcome: 'inactive', email: 'ghost@example.com' });
        seed(3, { kind: 'login', outcome: 'bad_password', email: 'ghost@example.com' });
        const v = await checkAuthRateLimit('login', { email: 'ghost@example.com', ip: null }, NOW);
        expect(v.limited).toBe(true);
    });

    it('failures older than the 15-minute window do not count', async () => {
        seed(6, { kind: 'login', outcome: 'bad_password', email: EMAIL }, 16 * MIN);
        seed(9, { kind: 'login', outcome: 'bad_password', email: EMAIL });
        expect((await checkAuthRateLimit('login', { email: EMAIL, ip: null }, NOW)).limited).toBe(false);
    });

    it("another account's failures do not count", async () => {
        seed(25, { kind: 'login', outcome: 'bad_password', email: 'someone-else@example.com' });
        expect((await checkAuthRateLimit('login', { email: EMAIL, ip: null }, NOW)).limited).toBe(false);
    });

    it('successful logins never count, however many', async () => {
        seed(200, { kind: 'login', outcome: 'success', email: EMAIL, ip: IP });
        expect((await checkAuthRateLimit('login', { email: EMAIL, ip: IP }, NOW)).limited).toBe(false);
    });

    it('a successful login restarts the counter', async () => {
        seed(10, { kind: 'login', outcome: 'bad_password', email: EMAIL }, 5 * MIN);
        seed(1, { kind: 'login', outcome: 'success', email: EMAIL }, 4 * MIN);
        seed(3, { kind: 'login', outcome: 'bad_password', email: EMAIL }, 1 * MIN);
        expect((await checkAuthRateLimit('login', { email: EMAIL, ip: null }, NOW)).limited).toBe(false);
    });

    it('a completed password reset restarts the counter (locked-out owner recovers at once)', async () => {
        seed(40, { kind: 'login', outcome: 'bad_password', email: EMAIL }, 2 * MIN);
        expect((await checkAuthRateLimit('login', { email: EMAIL, ip: null }, NOW)).limited).toBe(true);
        seed(1, { kind: 'reset_password', outcome: 'success', email: EMAIL }, 1 * MIN);
        expect((await checkAuthRateLimit('login', { email: EMAIL, ip: null }, NOW)).limited).toBe(false);
    });

    it('…but 10 fresh failures after that success lock it again', async () => {
        seed(1, { kind: 'login', outcome: 'success', email: EMAIL }, 10 * MIN);
        seed(10, { kind: 'login', outcome: 'bad_password', email: EMAIL }, 1 * MIN);
        expect((await checkAuthRateLimit('login', { email: EMAIL, ip: null }, NOW)).limited).toBe(true);
    });

    it("a success on a different account, or a register row, does not restart this one's counter", async () => {
        seed(10, { kind: 'login', outcome: 'bad_password', email: EMAIL }, 3 * MIN);
        seed(1, { kind: 'login', outcome: 'success', email: 'attacker-own@example.com' }, 1 * MIN);
        seed(1, { kind: 'register', outcome: 'success', email: EMAIL }, 1 * MIN);
        expect((await checkAuthRateLimit('login', { email: EMAIL, ip: null }, NOW)).limited).toBe(true);
    });
});

describe('checkAuthRateLimit — login, per IP', () => {
    it('30 failures spread over 30 accounts from one IP: locked (credential stuffing)', async () => {
        for (let i = 0; i < 30; i++) {
            seed(1, { kind: 'login', outcome: 'unknown_email', email: `u${i}@example.com`, ip: IP }, MIN + i * 1000);
        }
        const v = await checkAuthRateLimit('login', { email: 'fresh-target@example.com', ip: IP }, NOW);
        expect(v).toMatchObject({ limited: true, scope: 'ip' });
    });

    it('29 from that IP: open; and a different IP is unaffected at 30', async () => {
        for (let i = 0; i < 29; i++) {
            seed(1, { kind: 'login', outcome: 'bad_password', email: `u${i}@example.com`, ip: IP });
        }
        expect((await checkAuthRateLimit('login', { email: 'x@example.com', ip: IP }, NOW)).limited).toBe(false);
        seed(1, { kind: 'login', outcome: 'bad_password', email: 'u29@example.com', ip: IP });
        expect((await checkAuthRateLimit('login', { email: 'x@example.com', ip: '198.51.100.9' }, NOW)).limited).toBe(
            false,
        );
    });

    it('a success from that IP does NOT restart the IP counter', async () => {
        for (let i = 0; i < 30; i++) {
            seed(1, { kind: 'login', outcome: 'bad_password', email: `u${i}@example.com`, ip: IP }, 3 * MIN);
        }
        // attacker logs into an account they own to try to wipe the slate
        seed(1, { kind: 'login', outcome: 'success', email: 'attacker-own@example.com', ip: IP }, 1 * MIN);
        expect((await checkAuthRateLimit('login', { email: 'next-target@example.com', ip: IP }, NOW)).limited).toBe(
            true,
        );
    });

    it('skips the IP rule for a non-public or missing address (would lump unrelated callers together)', async () => {
        for (const ip of ['172.20.0.1', '10.88.0.2', '127.0.0.1']) {
            for (let i = 0; i < 40; i++) {
                seed(1, { kind: 'login', outcome: 'bad_password', email: `${ip}-${i}@example.com`, ip });
            }
            expect((await checkAuthRateLimit('login', { email: 'x@example.com', ip }, NOW)).limited, ip).toBe(false);
        }
        expect((await checkAuthRateLimit('login', { email: 'x@example.com', ip: null }, NOW)).limited).toBe(false);
    });

    it('when both rules trip, reports the one that keeps the caller out longest', async () => {
        seed(30, { kind: 'login', outcome: 'bad_password', email: 'other@example.com', ip: IP }, 10 * MIN);
        seed(10, { kind: 'login', outcome: 'bad_password', email: EMAIL, ip: '198.51.100.9' }, 1 * MIN);
        const v = await checkAuthRateLimit('login', { email: EMAIL, ip: IP }, NOW);
        // the email lock is the fresher one → longer wait
        expect(v).toMatchObject({ limited: true, scope: 'email' });
    });
});

describe('checkAuthRateLimit — register / forgot_password', () => {
    it('register: 20 requests per hour per IP, any outcome', async () => {
        seed(19, { kind: 'register', outcome: 'attempt', ip: IP });
        expect((await checkAuthRateLimit('register', { ip: IP }, NOW)).limited).toBe(false);
        seed(1, { kind: 'register', outcome: 'attempt', ip: IP });
        expect(await checkAuthRateLimit('register', { ip: IP }, NOW)).toMatchObject({ limited: true, scope: 'ip' });
    });

    it('forgot_password: 10 requests per hour per IP', async () => {
        seed(9, { kind: 'forgot_password', outcome: 'attempt', ip: IP, email: 'a@example.com' }, 50 * MIN);
        expect((await checkAuthRateLimit('forgot_password', { ip: IP }, NOW)).limited).toBe(false);
        seed(1, { kind: 'forgot_password', outcome: 'attempt', ip: IP, email: 'b@example.com' });
        expect((await checkAuthRateLimit('forgot_password', { ip: IP }, NOW)).limited).toBe(true);
    });

    it('kinds are counted separately', async () => {
        seed(50, { kind: 'register', outcome: 'attempt', ip: IP, email: EMAIL });
        seed(50, { kind: 'forgot_password', outcome: 'attempt', ip: IP, email: EMAIL });
        expect((await checkAuthRateLimit('login', { email: EMAIL, ip: IP }, NOW)).limited).toBe(false);
    });

    it('no IP → not limited (server-side / tunnel callers)', async () => {
        seed(100, { kind: 'register', outcome: 'attempt', ip: null });
        expect((await checkAuthRateLimit('register', { ip: null }, NOW)).limited).toBe(false);
    });
});

describe('checkAuthRateLimit — safety valves', () => {
    it('fails OPEN when the count query errors (a DB blip must not take login down)', async () => {
        seed(50, { kind: 'login', outcome: 'bad_password', email: EMAIL, ip: IP });
        db.failReads = true;
        expect(await checkAuthRateLimit('login', { email: EMAIL, ip: IP }, NOW)).toEqual({ limited: false });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('failing open'), expect.any(Error));
    });

    it('AUTH_RATE_LIMIT_DISABLED=true switches the throttle off', async () => {
        seed(50, { kind: 'login', outcome: 'bad_password', email: EMAIL, ip: IP });
        process.env.AUTH_RATE_LIMIT_DISABLED = 'true';
        expect((await checkAuthRateLimit('login', { email: EMAIL, ip: IP }, NOW)).limited).toBe(false);
    });

    it('logs a line when it blocks (ops signal)', async () => {
        seed(10, { kind: 'login', outcome: 'bad_password', email: EMAIL });
        await checkAuthRateLimit('login', { email: EMAIL, ip: IP }, NOW);
        expect(warn).toHaveBeenCalledWith(
            '[auth-rate-limit] blocked',
            expect.objectContaining({ kind: 'login', scope: 'email', email: EMAIL, ip: IP }),
        );
    });

    it('published limits are the documented ones', () => {
        expect(AUTH_RATE_LIMITS.login.email).toEqual({ max: 10, windowMs: 15 * MIN });
        expect(AUTH_RATE_LIMITS.login.ip).toEqual({ max: 30, windowMs: 15 * MIN });
        expect(AUTH_RATE_LIMITS.register.ip).toEqual({ max: 20, windowMs: 60 * MIN });
        expect(AUTH_RATE_LIMITS.forgot_password.ip).toEqual({ max: 10, windowMs: 60 * MIN });
    });
});

describe('recordAuthAttempt / resolveAuthAttempt', () => {
    it('record → check → resolve round trip: a real failed login is what the throttle counts', async () => {
        for (let i = 0; i < 10; i++) {
            const at = new Date(NOW.getTime() - (10 - i) * 1000);
            await recordAuthAttempt({ kind: 'login', outcome: 'bad_password', email: EMAIL, ip: IP, now: at });
        }
        expect((await checkAuthRateLimit('login', { email: EMAIL, ip: IP }, NOW)).limited).toBe(true);
    });

    it('a provisional failure resolved to success stops counting', async () => {
        seed(9, { kind: 'login', outcome: 'bad_password', email: EMAIL }, 2 * MIN);
        const id = await recordAuthAttempt({ kind: 'login', outcome: 'bad_password', email: EMAIL, now: NOW });
        // in flight (bcrypt running): counted, so a parallel burst is held back
        const during = new Date(NOW.getTime() + 100);
        expect((await checkAuthRateLimit('login', { email: EMAIL, ip: null }, during)).limited).toBe(true);
        await resolveAuthAttempt(id, { outcome: 'success' });
        expect((await checkAuthRateLimit('login', { email: EMAIL, ip: null }, during)).limited).toBe(false);
        expect(db.rows.find((r) => r.id === id)?.outcome).toBe('success');
    });

    it('stores the app-clock timestamp and truncates oversized fields', async () => {
        const id = await recordAuthAttempt({
            kind: 'login',
            outcome: 'unknown_email',
            email: `${'a'.repeat(300)}@example.com`,
            ip: 'x'.repeat(80),
            userAgent: 'U'.repeat(1000),
            now: NOW,
        });
        const row = db.rows.find((r) => r.id === id)!;
        expect(row.created_at).toEqual(NOW);
        expect(row.email).toHaveLength(254);
        expect(row.ip).toHaveLength(45);
        expect(row.user_agent).toHaveLength(300);
        expect(row.user_id).toBeNull();
    });

    it('returns null instead of throwing when the write fails; resolve(null) is a no-op', async () => {
        db.failWrites = true;
        const id = await recordAuthAttempt({ kind: 'login', outcome: 'bad_password', email: EMAIL });
        expect(id).toBeNull();
        await expect(resolveAuthAttempt(id, { outcome: 'success' })).resolves.toBeUndefined();
    });

    it('resolve swallows a failed update', async () => {
        const id = await recordAuthAttempt({ kind: 'login', outcome: 'bad_password', email: EMAIL });
        db.failWrites = true;
        await expect(resolveAuthAttempt(id, { outcome: 'success' })).resolves.toBeUndefined();
    });

    it('occasionally prunes rows past the 180-day retention', async () => {
        seed(3, { kind: 'login', outcome: 'bad_password', email: 'old@example.com' }, 181 * 24 * 60 * MIN);
        seed(2, { kind: 'login', outcome: 'bad_password', email: 'recent@example.com' }, 179 * 24 * 60 * MIN);
        vi.spyOn(Math, 'random').mockReturnValue(0);
        await recordAuthAttempt({ kind: 'login', outcome: 'success', email: EMAIL, now: NOW });
        await new Promise((r) => setTimeout(r, 0));
        expect(db.rows.filter((r) => r.email === 'old@example.com')).toHaveLength(0);
        expect(db.rows.filter((r) => r.email === 'recent@example.com')).toHaveLength(2);
    });
});

describe('tooManyAttemptsResponse', () => {
    it('429 + Retry-After + machine-readable body', async () => {
        const res = tooManyAttemptsResponse({ limited: true, scope: 'email', retryAfterSeconds: 321 });
        expect(res.status).toBe(429);
        expect(res.headers.get('retry-after')).toBe('321');
        // scope is deliberately NOT in the body — it would tell a caller
        // which of the two counters they hit
        expect(await res.json()).toEqual({ error: 'too_many_attempts', retry_after_seconds: 321 });
    });
});
