# 第一周任务清单(W1:项目脚手架 + 数据库)

> 兼职每天 2-3 小时,7 天完成阶段 1
> 目标:`pnpm dev` 跑起来,数据库 schema 完成,LiteLLM client 单元测试通过

---

## D1:Clone fork + 跑通项目重命名(2-3 小时)

### 在你 Mac 上执行

```bash
# 1. clone 你的 fork(假设你已经在 GitHub 上 fork 了 touwaeriol/sub2apipay 到 yexioy/silkroadai)
cd ~/Code      # 或者你常用的代码目录
git clone git@github.com:yexioy/silkroadai.git
cd silkroadai

# 2. 把 bootstrap 包整体拷进来作为辅助资源
cp -r ~/Documents/"silk road ai"/litellm-portal-bootstrap ./_bootstrap
ls _bootstrap/

# 3. 跑重命名脚本
bash _bootstrap/scripts/01-rename-project.sh

# 4. 安装依赖(用 pnpm,sub2apipay 是 pnpm 项目)
pnpm install

# 5. 跑 dev 看能不能起来(先不管是否报错,验证基础链路)
cp .env.example .env
# 暂时填一些 mock 值让 build 不挂:
sed -i '' 's|LITELLM_MASTER_KEY=.*|LITELLM_MASTER_KEY=sk-master-fake|' .env
sed -i '' 's|DATABASE_URL=.*|DATABASE_URL="postgresql://localhost:5432/silkroadai_portal_dev"|' .env

# 6. commit 第一版重命名
git add -A
git commit -m "rename: sub2apipay → silkroadai-portal"
git push origin main
```

### 验收标准
- [ ] `git log` 第一个 commit 是 rename
- [ ] `package.json` 里 name 是 `silkroadai-portal`
- [ ] `src/lib/litellm/` 目录存在(原 `sub2api` 改名)
- [ ] `pnpm install` 无错误
- [ ] `.env.example` 内容是 LiteLLM 相关的,不再有 SUB2API_*

---

## D2:数据库 schema 改造(2-3 小时)

### 步骤

```bash
# 1. 启动一个本地 PostgreSQL(用 docker 最快)
docker run -d --name portal-pg \
  -e POSTGRES_USER=portal \
  -e POSTGRES_PASSWORD=devpass123 \
  -e POSTGRES_DB=silkroadai_portal_dev \
  -p 5433:5432 \
  postgres:16-alpine

# 2. 改 .env 里 DATABASE_URL
sed -i '' 's|DATABASE_URL=.*|DATABASE_URL="postgresql://portal:devpass123@localhost:5433/silkroadai_portal_dev"|' .env

# 3. 把 _bootstrap 里的 schema diff 应用到 prisma/schema.prisma
#    打开两个文件对比,把新的 model 追加到 schema.prisma 末尾
code prisma/schema.prisma _bootstrap/prisma/schema.diff.prisma
# 或者用 cursor / vim,把 _bootstrap 里的内容追加 + 修改 Order model

# 4. 跑 migration
pnpm prisma migrate dev --name add_user_and_litellm_key

# 5. 验证表创建成功
docker exec -it portal-pg psql -U portal -d silkroadai_portal_dev -c "\dt"
# 应该看到: users, litellm_keys, recharge_logs, orders, audit_logs, ...
```

### 验收标准
- [ ] `pnpm prisma migrate dev` 成功生成 migration
- [ ] PostgreSQL 里能看到 users / litellm_keys / recharge_logs 三张新表
- [ ] Order 表有 user_id (UUID) 字段且关联到 users 表

---

## D3:LiteLLM client 接入 + 单测(3-4 小时)

### 步骤

```bash
# 1. 拷贝 LiteLLM client 第一版
cp _bootstrap/src/lib/litellm/client.ts src/lib/litellm/client.ts

# 2. 删掉原来的 sub2api 类型文件(已迁移到 litellm/)
ls src/lib/litellm/
# 你应该看到老的 client.ts、types.ts、__tests__/ 等,把老的 client.ts 删了
git rm src/lib/litellm/client.ts.bak 2>/dev/null
# (重命名脚本应该已经帮你 mv 过来,可能保留了原 client,直接覆盖即可)

# 3. 改 .env 让 LITELLM 指向 VPS 上的实际 LiteLLM 服务
# 注意:开发期间可以让 portal 调远程 VPS 的 LiteLLM
# 也可以通过 SSH 隧道:
#   ssh -L 4000:localhost:4000 root@23.27.113.88
sed -i '' 's|LITELLM_BASE_URL=.*|LITELLM_BASE_URL="http://localhost:4000"|' .env
sed -i '' 's|LITELLM_MASTER_KEY=.*|LITELLM_MASTER_KEY="sk-master-真实-key"|' .env

# 4. 写一个最简单的烟雾测试
cat > src/lib/litellm/__tests__/client.smoke.test.ts <<'EOF'
import { describe, it, expect } from 'vitest';
import { listModels, checkLiteLLMHealth } from '../client';

describe('LiteLLM client smoke test', () => {
    it('should respond to health check', async () => {
        const health = await checkLiteLLMHealth();
        expect(health).toBeDefined();
    });

    it('should list available models', async () => {
        const result = await listModels();
        expect(result.data).toBeInstanceOf(Array);
        expect(result.data.length).toBeGreaterThan(0);
        console.log('Available models:', result.data.map(m => m.id).join(', '));
    });
});
EOF

# 5. 跑测试
pnpm vitest run src/lib/litellm/__tests__/client.smoke.test.ts
```

### 验收标准
- [ ] 烟雾测试通过(能调通你 VPS 上的 LiteLLM)
- [ ] 控制台能打印出 15 个模型的列表
- [ ] LITELLM_MASTER_KEY 没有 hardcode 进代码,只在 .env 里

---

## D4-5:替换 admin-auth + user/route 的旧 Sub2API 调用(4-6 小时)

### 步骤

需要改的文件:
- `src/lib/admin-auth.ts` — 替换 `isSub2ApiAdmin()` 为 `isPortalAdmin()`(查本地 User 表的 user_role 或环境变量 ADMIN_TOKEN)
- `src/app/api/user/route.ts` — 替换 `getCurrentUserByToken` 为本地 JWT 校验 + 查 User 表
- `src/app/api/users/[id]/route.ts` — 改为查本地 User + 调 LiteLLM `getUserInfo`
- `src/app/api/admin/user-balance/route.ts` — 改为算本地 max_budget - cached_spend

**新增**:
- `src/lib/auth/jwt.ts` — JWT 签发 / 校验工具(用 `jose` 库,Next.js 标准)
- `src/lib/auth/session.ts` — 从 cookie 读 session

**示意代码**(写在 `src/lib/auth/jwt.ts`):

```ts
import { SignJWT, jwtVerify } from 'jose';

const SECRET = new TextEncoder().encode(process.env.PORTAL_JWT_SECRET);
const EXPIRES = process.env.PORTAL_JWT_EXPIRES || '7d';

export async function signSession(userId: string): Promise<string> {
    return await new SignJWT({ sub: userId })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(EXPIRES)
        .sign(SECRET);
}

export async function verifySession(token: string): Promise<string | null> {
    try {
        const { payload } = await jwtVerify(token, SECRET);
        return payload.sub as string;
    } catch {
        return null;
    }
}
```

### 验收标准
- [ ] 项目中不再 import 任何老的 Sub2API token 校验函数
- [ ] `pnpm build` 成功
- [ ] grep 找不到 `getCurrentUserByToken` / `isSub2ApiAdmin` 等老函数

---

## D6-7:跑通"创建客户 + 发首个 Key"端到端(3-4 小时)

### 步骤

```bash
# 1. 写 portal 注册 API(先不做邮箱验证,后面再加)
# 文件: src/app/api/auth/register/route.ts
```

最小实现:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { hash } from 'bcrypt';
import { prisma } from '@/lib/prisma';
import { provisionNewCustomer } from '@/lib/litellm/client';
import { signSession } from '@/lib/auth/jwt';
import { z } from 'zod';

const RegisterSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    nickname: z.string().optional(),
});

export async function POST(req: NextRequest) {
    const body = await req.json();
    const parse = RegisterSchema.safeParse(body);
    if (!parse.success) return NextResponse.json({ error: parse.error.message }, { status: 400 });
    const { email, password, nickname } = parse.data;

    // 1. 检查 email 唯一
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return NextResponse.json({ error: 'Email already registered' }, { status: 409 });

    // 2. 创建 portal user(密码加密)
    const user = await prisma.user.create({
        data: {
            email,
            password_hash: await hash(password, 10),
            nickname,
            email_verified: false,
        },
    });

    // 3. 在 LiteLLM 创建 user + 生成首个 key
    try {
        const provisioned = await provisionNewCustomer({
            portal_user_id: user.id,
            email: user.email,
            initial_max_budget: 0,
        });

        await prisma.user.update({
            where: { id: user.id },
            data: { litellm_user_id: provisioned.litellm_user_id },
        });

        await prisma.liteLLMKey.create({
            data: {
                user_id: user.id,
                litellm_key: provisioned.litellm_key,
                key_alias: provisioned.key_alias,
                max_budget: 0,
                cached_spend: 0,
            },
        });
    } catch (err) {
        // 回滚:删 portal user
        await prisma.user.delete({ where: { id: user.id } });
        throw err;
    }

    // 4. 返回 session token
    const token = await signSession(user.id);
    return NextResponse.json({ user_id: user.id, token });
}
```

测试:

```bash
# 启动 dev server
pnpm dev

# 在另一个 terminal,curl 测试
curl -X POST http://localhost:3002/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@silkroadai.io","password":"test12345"}'

# 应该返回 { user_id: "...", token: "ey..." }

# 验证 LiteLLM 那边也创建了 user 和 key
curl http://localhost:4000/user/info?user_id=<上面返回的 portal_user_id> \
  -H "Authorization: Bearer sk-master-真实-key"
```

### 验收标准
- [ ] 用 curl 注册一个测试用户成功
- [ ] portal DB 里有 users 记录 + litellm_keys 记录
- [ ] LiteLLM DB 里有对应的 user 和 key
- [ ] portal_user.litellm_user_id 和 litellm 那边的 user_id 对得上
- [ ] LiteLLMKey.litellm_key 是有效的 sk-xxx,可以拿来调 LiteLLM API

---

## 第一周结束时,你应该有:

```
✅ 一个能跑的 Next.js 项目(pnpm dev),改名为 silkroadai-portal
✅ PostgreSQL 数据库带 User / LiteLLMKey / RechargeLog 三张新表
✅ src/lib/litellm/client.ts 完整封装的 LiteLLM Admin API
✅ JWT 认证基础(sign/verify)
✅ /api/auth/register 端到端跑通
```

第二周开始就是登录 / 邮箱验证 / 充值流程的事了。

---

## 遇到问题怎么办?

把当时的命令 + 错误信息 + 相关文件内容贴给我,我们逐个排查。

常见问题预判:

| 症状 | 可能原因 |
|---|---|
| `pnpm install` 报 ERESOLVE | Node 版本不对,看 `.node-version` 文件,用 nvm 切到对应版本 |
| Prisma migrate 失败 | DATABASE_URL 不对,或 PostgreSQL 没启动 |
| LiteLLM client 调用 401 | LITELLM_MASTER_KEY 错了或 LiteLLM 服务不通 |
| LiteLLM client 调用 404 | LITELLM_BASE_URL 没设或 path 拼错 |
| 注册接口 500 | 看 dev server 控制台日志,90% 是 prisma 字段名不对 |
