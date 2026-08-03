# W5 Deploy Runbook(历史归档)— portal.silkroadai.io

> [!WARNING]
> 本文记录 2026-05 的旧 VPS `23.27.113.88`、旧域名 `portal.silkroadai.io` 和 Caddy 部署,
> **不适用于当前 `llmroute.club` 生产服务器**。请勿复制本文命令到当前 VPS。
>
> 当前生产环境是 `82.29.71.122` / AlmaLinux 9.7 / Nginx / Cloudflare Full (strict),
> 唯一权威步骤见 [`../deploy/部署与运维手册.md`](../deploy/部署与运维手册.md)。
> 本文件仅保留作历史审计,其中 IP、域名、证书、反向代理和首次部署步骤均视为过期。

**Target**: VPS `vps` (= root@23.27.113.88)
**App URL**: `https://portal.silkroadai.io`
**Container port**: 3002 (host) ↔ 3002 (container)
**Stack**: Next.js 16 (standalone) + Postgres 16 (Docker), reverse-proxied by host Caddy with auto Let's Encrypt SSL

---

## 1. First-time deployment(W5 D3 — once)

### 1.1 Prep on developer Mac

`.env` source: `~/Desktop/silkroadai-prod-env.txt`. **Must contain** all keys
listed in `.env.example` plus `POSTGRES_PASSWORD` (derived from the password
inside `DATABASE_URL`). The deploy script auto-derives this; if you edit the
env manually, keep them in sync.

Sanity-check the source file is straight ASCII (no curly quotes, no
unintended backticks):

```bash
LC_ALL=C grep -nP '[^\x20-\x7E\t]' ~/Desktop/silkroadai-prod-env.txt && \
  echo "⚠️ non-ASCII chars present, sanitize before upload" || echo "ok"
```

If chars present, the deploy script auto-sanitizes (strips backticks,
replaces U+201C/U+201D smart quotes with straight `"`).

### 1.2 VPS prerequisites(已就位 W5 D1)

- Docker ≥ 28 + Docker Compose v5
- `caddy` running as systemd service, `Caddyfile` at `/etc/caddy/Caddyfile`
- DNS `portal.silkroadai.io` A → `23.27.113.88`
- Host port 3002 free
- new-api running on host port 3000 (reachable from container via
  `host.docker.internal`)

### 1.3 Deploy steps

```bash
# 1. Clone
ssh vps "mkdir -p /opt/silkroadai-portal && cd /opt/silkroadai-portal && \
         git clone https://github.com/yexioy/silkroadai.git . && \
         git checkout prod"

# 2. Upload + sanitize .env, append POSTGRES_PASSWORD for compose interpolation
scp ~/Desktop/silkroadai-prod-env.txt vps:/opt/silkroadai-portal/.env.raw
ssh vps "cd /opt/silkroadai-portal && \
  python3 -c 'import sys,re;
data = open(\".env.raw\",\"rb\").read().decode(\"utf-8\")
# Strip backticks (markdown quoting artifacts) and curly quotes
data = data.replace(\"“\",\"\\\"\").replace(\"”\",\"\\\"\").replace(\"\`\",\"\")
open(\".env\",\"w\").write(data)
# Extract password from DATABASE_URL → POSTGRES_PASSWORD
m = re.search(r\"^DATABASE_URL=\\\"?postgresql://[^:]+:([^@]+)@\", data, re.M)
if m:
    with open(\".env\",\"a\") as f: f.write(f\"\\nPOSTGRES_PASSWORD={m.group(1)}\\n\")
'
  rm .env.raw
  chmod 600 .env"

# 3. Build + start
ssh vps "cd /opt/silkroadai-portal && \
         docker compose -f docker-compose.prod.yml up -d --build"

# 4. Verify containers
ssh vps "docker compose -f /opt/silkroadai-portal/docker-compose.prod.yml ps"

# 5. Wait for migrations (start.sh runs them automatically)
sleep 15
ssh vps "docker logs silkroadai-portal 2>&1 | grep -E 'Migrations|server'"

# 6. Internal smoke
ssh vps "curl -sS -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:3002/login"
# Expect HTTP 200 or 307

# 7. Caddy block
ssh vps "cat >> /etc/caddy/Caddyfile <<'EOF'

portal.silkroadai.io {
    reverse_proxy localhost:3002 {
        flush_interval -1
        transport http {
            read_timeout 60s
            write_timeout 60s
        }
    }
    encode gzip
    request_body { max_size 10MB }
    header {
        Strict-Transport-Security \"max-age=31536000; includeSubDomains\"
        X-Content-Type-Options \"nosniff\"
    }
}
EOF"
ssh vps "caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy"

# 8. Wait for SSL
sleep 20
ssh vps "journalctl -u caddy --since '1 min ago' | grep -E 'certificate|portal.silkroadai'"

# 9. Public smoke
curl -sS -o /dev/null -w "HTTP %{http_code}  cert: %{ssl_verify_result}\n" \
  https://portal.silkroadai.io/login
```

---

## 2. Rolling update(future code changes)

Only deploy a tested commit already fast-forwarded from `dev` to `prod`.
`main` is an upstream-only mirror and must never be deployed directly.

```bash
ssh vps "cd /opt/silkroadai-portal && git pull --ff-only origin prod && \
         docker compose -f docker-compose.prod.yml up -d --build portal"
# start.sh runs migrate deploy on container start — Postgres untouched.
```

If only env changed (no code): re-run with new .env file → `up -d` (no
--build).

---

## 3. Rollback

### 3.1 Code rollback

```bash
ssh vps "cd /opt/silkroadai-portal && \
         git log --oneline -10  # pick a known-good SHA, e.g. abc1234
         git reset --hard <SHA> && \
         docker compose -f docker-compose.prod.yml up -d --build portal"
```

### 3.2 Schema rollback(rare — Prisma migrate is forward-only by design)

Use `prisma migrate resolve --rolled-back <migration_name>` only if a bad
migration ran. For data-incompatible rollbacks, restore Postgres from
backup (W5 D4 will set up `pg_dump` cron — not yet).

---

## 4. Common failures + recovery

### 4.1 SSL not signed within 30s

```bash
ssh vps "journalctl -u caddy --since '5 min ago' | tail -30"
```

Look for:

- `connection refused`(DNS not propagated;wait then retry)
- `rate limit exceeded`(LE 50/week per registered domain;contact ops)
- `wrong host`(Caddyfile typo;`caddy validate` then `systemctl reload caddy`)

Manually re-trigger:

```bash
ssh vps "systemctl restart caddy && sleep 30 && \
         journalctl -u caddy --since '1 min ago' | grep certificate"
```

### 4.2 Postgres healthcheck never goes healthy

```bash
ssh vps "docker logs silkroadai-portal-db 2>&1 | tail -30"
```

Common causes:

- Volume from a previous deploy with different password → `docker compose
down -v && docker compose up -d`(⚠️ destroys data — only first-time)
- POSTGRES_PASSWORD mismatch between `.env` and DATABASE_URL → re-run
  step 2 (sanitize + derive password) → recreate

### 4.3 Migrate failed on container start

```bash
ssh vps "docker logs silkroadai-portal 2>&1 | grep -E 'migration|error' | tail"
```

Common causes:

- DATABASE_URL points to wrong host(should be `portal-postgres:5432`,
  not localhost)
- Postgres still starting(start.sh waits for `prisma migrate deploy` but
  not for postgres readiness — depends_on healthcheck handles this for
  fresh `up`,but a `restart portal` alone may race)
  Fix: `docker compose restart portal-postgres && sleep 5 && docker compose restart portal`

### 4.4 portal container exits immediately

```bash
ssh vps "docker logs silkroadai-portal 2>&1 | tail -50"
```

Most common: missing required env(e.g. `NEWAPI_ADMIN_TOKEN` not set →
`newapi/client.ts` throws at module load). Verify
`grep -c '^[A-Z]' .env` shows all expected keys present.

### 4.5 Caddy validate fails

```bash
ssh vps "caddy validate --config /etc/caddy/Caddyfile"
```

If you accidentally appended a duplicate `portal.silkroadai.io` block, edit
out the dupe. Caddyfile syntax is whitespace-strict — `}` must be at
column 0.

---

## 5. Useful one-liners

```bash
# Tail live logs
ssh vps "docker logs -f silkroadai-portal"

# Force migrate (idempotent — does nothing if no pending migrations)
ssh vps "docker compose -f /opt/silkroadai-portal/docker-compose.prod.yml \
         exec -T portal node node_modules/prisma/build/index.js \
         migrate deploy --config prisma.config.ts"

# Hard restart everything
ssh vps "cd /opt/silkroadai-portal && docker compose -f docker-compose.prod.yml restart"

# DB shell
ssh vps "docker compose -f /opt/silkroadai-portal/docker-compose.prod.yml \
         exec -T portal-postgres psql -U portal silkroadai_portal_prod"

# Backup (manual; W5 D4 will cron this)
ssh vps "docker compose -f /opt/silkroadai-portal/docker-compose.prod.yml \
         exec -T portal-postgres pg_dump -U portal silkroadai_portal_prod \
         | gzip > /tmp/silkroadai-portal-\$(date +%Y%m%d-%H%M).sql.gz"
```

---

**Authored W5 D3.** Update on each non-trivial deploy change.
