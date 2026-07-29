/**
 * 企业门户 API 密钥页(P2):列表 server 渲染,创建/禁用走 /api/enterprise/keys(client island)。
 */
import { prisma } from '@/lib/db';
import { getEnterpriseSessionUser } from '@/lib/enterprise/session';
import { KeysManager } from './keys-manager';
import { AkSkManager } from './aksk-manager';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · API 密钥' };

export default async function EnterpriseKeysPage() {
    const user = (await getEnterpriseSessionUser())!;
    const [keys, aksk] = await Promise.all([
        prisma.enterpriseKey.findMany({
            where: { user_id: user.id },
            orderBy: { created_at: 'asc' },
            select: {
                id: true,
                name: true,
                key_prefix: true,
                region: true,
                status: true,
                created_at: true,
                last_used_at: true,
            },
        }),
        prisma.enterpriseAkSk.findMany({
            where: { user_id: user.id },
            orderBy: { created_at: 'asc' },
            select: { id: true, access_key: true, name: true, status: true, created_at: true, last_used_at: true },
        }),
    ]);

    return (
        <div className="space-y-6">
            <KeysManager
                initialKeys={keys.map((k) => ({
                    id: k.id,
                    name: k.name,
                    key_prefix: k.key_prefix,
                    region: k.region,
                    status: k.status,
                    created_at: k.created_at.toISOString(),
                    last_used_at: k.last_used_at ? k.last_used_at.toISOString() : null,
                }))}
            />
            <AkSkManager
                initialItems={aksk.map((a) => ({
                    id: a.id,
                    access_key: a.access_key,
                    name: a.name,
                    status: a.status,
                    created_at: a.created_at.toISOString(),
                    last_used_at: a.last_used_at ? a.last_used_at.toISOString() : null,
                }))}
            />
        </div>
    );
}
