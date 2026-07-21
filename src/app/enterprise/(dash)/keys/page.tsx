/**
 * 企业门户 API 密钥页(P2):列表 server 渲染,创建/禁用走 /api/enterprise/keys(client island)。
 */
import { prisma } from '@/lib/db';
import { getEnterpriseSessionUser } from '@/lib/enterprise/session';
import { KeysManager } from './keys-manager';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · API 密钥' };

export default async function EnterpriseKeysPage() {
    const user = (await getEnterpriseSessionUser())!;
    const keys = await prisma.enterpriseKey.findMany({
        where: { user_id: user.id },
        orderBy: { created_at: 'asc' },
        select: {
            id: true,
            name: true,
            key_prefix: true,
            status: true,
            created_at: true,
            last_used_at: true,
        },
    });

    return (
        <KeysManager
            initialKeys={keys.map((k) => ({
                id: k.id,
                name: k.name,
                key_prefix: k.key_prefix,
                status: k.status,
                created_at: k.created_at.toISOString(),
                last_used_at: k.last_used_at ? k.last_used_at.toISOString() : null,
            }))}
        />
    );
}
