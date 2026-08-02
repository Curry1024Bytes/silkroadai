/**
 * 存量 AK/SK 行补 secret_key_hash(2026-07-30,SK 直接当 Bearer key 用)。
 *
 * 解密 secret_key_enc(AES-256-GCM,key=ENTERPRISE_UPSTREAM_ENC_KEY,格式
 * iv(12)‖tag(16)‖ct base64,与 src/lib/enterprise/crypto.ts 一致 —— 此处内联实现,
 * 不 import 应用模块以绕开 'server-only')→ sha256 → 写 secret_key_hash。
 *
 * 幂等:只处理 secret_key_hash IS NULL 的行;解密失败的行报告并跳过(不中断)。
 *
 * 用法(VPS 上,.env 需有 DATABASE_URL + ENTERPRISE_UPSTREAM_ENC_KEY):
 *   pnpm tsx scripts/backfill-aksk-secret-hash.ts           # dry-run,只报告
 *   pnpm tsx scripts/backfill-aksk-secret-hash.ts --apply   # 实际写库
 */
import { createDecipheriv, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');

function decryptSecret(ciphertext: string): string {
    const hex = process.env.ENTERPRISE_UPSTREAM_ENC_KEY;
    if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error('ENTERPRISE_UPSTREAM_ENC_KEY must be 64 hex chars');
    }
    const raw = Buffer.from(ciphertext, 'base64');
    if (raw.length < 12 + 16 + 1) throw new Error('ciphertext too short / corrupted');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(hex, 'hex'), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

async function main() {
    const prisma = new PrismaClient();
    try {
        const rows = await prisma.enterpriseAkSk.findMany({
            where: { secret_key_hash: null },
            select: { id: true, access_key: true, secret_key_enc: true },
        });
        console.log(`${rows.length} row(s) missing secret_key_hash${APPLY ? '' : ' (dry-run, pass --apply to write)'}`);
        let done = 0;
        for (const row of rows) {
            let hash: string;
            try {
                hash = createHash('sha256').update(decryptSecret(row.secret_key_enc)).digest('hex');
            } catch (e) {
                console.error(`SKIP ${row.access_key}: decrypt failed — ${String(e)}`);
                continue;
            }
            if (APPLY) {
                await prisma.enterpriseAkSk.update({ where: { id: row.id }, data: { secret_key_hash: hash } });
            }
            console.log(`${APPLY ? 'WROTE' : 'would write'} ${row.access_key} → ${hash.slice(0, 12)}…`);
            done++;
        }
        console.log(`done: ${done}/${rows.length}`);
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
