/**
 * Re-issue portal's per-customer new-api act-as credential as a named personal
 * access token (PAT) for customers provisioned before new-api rc.41.
 *
 * Why: rc.41 replaced the single `users.access_token` with scoped PATs
 * (`nap_…`). Legacy tokens keep working for 30 days after the first rc.41+
 * boot (`options.LegacyAccessTokenRetireAt`), then are rejected for good and
 * cannot be regenerated. Portal stores one legacy token per customer in
 * `users.newapi_access_token` and uses it for every /keys operation
 * (create / list / rename / delete / reveal). Portal does NOT hold the
 * customer's new-api password, so the path is:
 *   root login → admin security proof → PUT /api/user/ (new random password)
 *   → login as customer → password proof → POST /api/user/access_tokens
 *   → write `nap_…` back to portal DB.
 * (see `reissueCustomerAccessTokenViaAdminReset` in src/lib/newapi/client.ts)
 *
 * Idempotent: only rows whose token does not start with `nap_` are touched;
 * a customer's legacy token stays valid until retire day, so a crashed run
 * can simply be re-run.
 *
 * Preconditions: new-api ≥ rc.41 (the script refuses otherwise) and env has
 * DATABASE_URL + NEWAPI_BASE_URL (NEWAPI_ADMIN_TOKEN is NOT needed). The ROOT
 * dashboard login is only needed with --apply and is asked for interactively
 * on the terminal (never put it in .env / shell history); the env vars
 * NEWAPI_ROOT_USERNAME / NEWAPI_ROOT_PASSWORD are honoured if set.
 *   pnpm dlx tsx scripts/migrate-newapi-legacy-access-tokens.ts                 # dry-run (no credentials)
 *   pnpm dlx tsx scripts/migrate-newapi-legacy-access-tokens.ts --apply         # prompts for root password
 *   … --apply --limit 20      # first batch only
 *   … --apply --user <portal-uuid>
 * The portal image has no scripts/ dir or tsx — run it from a repo checkout
 * with tunnels to new-api master and the portal DB (runbook §2 step 5).
 */
import 'dotenv/config';
import { prisma } from '@/lib/db';
import {
    NewApiError,
    accessTokenModeForVersion,
    isLegacyNewApiAccessToken,
    loginNewApiUser,
    reissueCustomerAccessTokenViaAdminReset,
} from '@/lib/newapi/client';

const APPLY = process.argv.includes('--apply');
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx > 0 ? Number(process.argv[limitIdx + 1]) : undefined;
const userIdx = process.argv.indexOf('--user');
const ONLY_USER = userIdx > 0 ? process.argv[userIdx + 1] : undefined;

async function serverVersion(): Promise<string> {
    const base = process.env.NEWAPI_BASE_URL;
    if (!base) throw new Error('NEWAPI_BASE_URL missing');
    const res = await fetch(new URL('/api/status', base));
    const json = (await res.json()) as { data?: { version?: string } };
    return json.data?.version ?? '';
}

/** Ask for the root password on the terminal without echo (fallback: env). */
async function promptRootCredentials(): Promise<{ user: string; password: string }> {
    const user = process.env.NEWAPI_ROOT_USERNAME || 'root';
    if (process.env.NEWAPI_ROOT_PASSWORD) return { user, password: process.env.NEWAPI_ROOT_PASSWORD };
    if (!process.stdin.isTTY) throw new Error('no TTY: set NEWAPI_ROOT_PASSWORD or run interactively');
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    const write = process.stdout.write.bind(process.stdout);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (str: string) => {
        if (!muted) write(str);
    };
    const password = await new Promise<string>((resolve) => {
        rl.question(`new-api ${user} 密码(不回显): `, (answer) => {
            muted = false;
            write('\n');
            resolve(answer);
        });
        muted = true;
    });
    rl.close();
    if (!password) throw new Error('empty password');
    return { user, password };
}

async function main() {
    const version = await serverVersion();
    if (accessTokenModeForVersion(version) !== 'pat') {
        throw new Error(
            `new-api ${version || '(unknown version)'} has no personal access tokens — upgrade to ≥ rc.41 first`,
        );
    }
    console.log(`new-api ${version}: PAT flow available${APPLY ? '' : ' (dry-run, pass --apply to write)'}`);

    const rows = await prisma.user.findMany({
        where: {
            newapi_user_id: { not: null },
            newapi_access_token: { not: null },
            ...(ONLY_USER ? { id: ONLY_USER } : {}),
        },
        select: { id: true, email: true, newapi_user_id: true, newapi_username: true, newapi_access_token: true },
        orderBy: { created_at: 'asc' },
    });
    const pending = rows.filter((r) => r.newapi_access_token && isLegacyNewApiAccessToken(r.newapi_access_token));
    const todo = LIMIT ? pending.slice(0, LIMIT) : pending;
    console.log(
        `${rows.length} linked customer(s), ${pending.length} still on a legacy token, processing ${todo.length}`,
    );
    if (!APPLY || todo.length === 0) {
        for (const r of todo) console.log(`would migrate ${r.newapi_username} (uid ${r.newapi_user_id}) ${r.email}`);
        return;
    }

    const { user: rootUser, password: rootPassword } = await promptRootCredentials();
    // One root login session for the whole run (15-min JWT; re-login on expiry).
    let admin = await loginNewApiUser({ username: rootUser, password: rootPassword });
    let ok = 0;
    let failed = 0;
    for (const r of todo) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const { accessToken } = await reissueCustomerAccessTokenViaAdminReset({
                    admin: { session: admin.auth, userId: admin.user.id, password: rootPassword },
                    customer: { userId: r.newapi_user_id! },
                });
                // CAS on the old value so a concurrent registration/edit never gets clobbered.
                const res = await prisma.user.updateMany({
                    where: { id: r.id, newapi_access_token: r.newapi_access_token },
                    data: { newapi_access_token: accessToken },
                });
                if (res.count !== 1) throw new Error('portal row changed underneath us; not overwritten');
                console.log(`MIGRATED ${r.newapi_username} (uid ${r.newapi_user_id})`);
                ok++;
                break;
            } catch (e) {
                const expired = e instanceof NewApiError && e.status === 401 && attempt === 0;
                if (expired) {
                    admin = await loginNewApiUser({ username: rootUser, password: rootPassword });
                    continue;
                }
                failed++;
                console.error(
                    `FAILED ${r.newapi_username} (uid ${r.newapi_user_id}): ${e instanceof Error ? e.message : String(e)}`,
                );
                break;
            }
        }
    }
    console.log(`done: ${ok} migrated, ${failed} failed, ${pending.length - todo.length} not attempted`);
    if (failed > 0) process.exitCode = 1;
}

main()
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
