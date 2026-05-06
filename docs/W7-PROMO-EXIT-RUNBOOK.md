# W7 Launch Promo Exit Runbook

**Date launched**: 2026-05-06
**Promo end**: **2026-06-09 (UTC+8 23:59)**
**Manual trigger**: operator (this is intentionally not automated)

This runbook is the playbook for ending the W7 launch promo at the
30-day mark. The promo discounted sub2api Anthropic + sub2api OpenAI
prices to 50% of retail. Exit restores them to retail (mr × 2).

SiliconFlow channel (id=1) was on cost-plus pricing throughout —
**no exit action needed there**.

---

## TL;DR

```bash
# On 2026-06-09 evening (or later), from a workstation with new-api SSH tunnel:
ssh -fN -L 3000:localhost:3000 -o ServerAliveInterval=60 vps
cd ~/Documents/silkroadai
pnpm dlx tsx _bootstrap/exit-w7-promo.ts                    # dry-run, review diff
pnpm dlx tsx _bootstrap/exit-w7-promo.ts --apply            # PUT to admin API

# Then in the portal repo:
git checkout -b chore/w7-promo-exit
# Edit src/app/landing/page.tsx + src/app/pricing/page.tsx — remove promo banner / strikethrough
# Commit, push, deploy via VPS rebuild
```

---

## Pre-flight checklist

- [ ] Promo banner copy review — confirm 2026-06-09 截止 is still the agreed date
- [ ] Notify Frankqy via WeChat that promo is ending (give him a heads-up so he can stockpile if he wants)
- [ ] Optional: post a short blog/announcement on `silkroadai.io` 24h before
- [ ] Confirm the SSH tunnel works: `curl http://localhost:3000/api/status` returns 200

## Step 1 — back up new-api db (cheap insurance)

```bash
ssh vps 'docker exec new-api-db pg_dump -U newapi newapi > /tmp/newapi-pre-w7-exit.sql'
ssh vps 'gzip /tmp/newapi-pre-w7-exit.sql && ls -la /tmp/newapi-pre-w7-exit.sql.gz'
```

Backup is small (~few MB) and reversible if the exit script writes
something unexpected.

## Step 2 — run the exit script in dry-run, review

```bash
pnpm dlx tsx _bootstrap/exit-w7-promo.ts
```

The script enumerates `model_ratio` for sub2api channel 2 (Anthropic)
and channel 3 (OpenAI), prints `old → old × 2` per model, and stops.
Manual sanity check on a few:

| model | promo mr (now) | retail mr (after exit) | retail $/1M input |
|---|---|---|---|
| `claude-opus-4-7` | 7.5 | **15.0** | $15 |
| `claude-sonnet-4-6` | 1.5 | **3.0** | $3 |
| `claude-haiku-4-5` | 0.5 | **1.0** | $1 |
| `gpt-5.5` | 2.5 | **5.0** | $5 |
| `gpt-5.4-mini` | 0.25 | **0.5** | $0.50 |

If any number doesn't match expected retail, **stop and investigate**.
Do NOT run `--apply`.

## Step 3 — apply

```bash
pnpm dlx tsx _bootstrap/exit-w7-promo.ts --apply
```

Each PUT writes one channel. Output looks like:

```
──── sub2api (id=2) ────
  claude-opus-4-7   7.5 → 15.0  (×2)
  ... (5 more)
  → PUT /api/channel/
  ✓ updated
```

## Step 4 — verify pricing is now retail

```bash
# Pull /api/pricing and grep for one whitelist SKU per channel
source .env
curl -sH "Authorization: $NEWAPI_ADMIN_TOKEN" -H "New-Api-User: $NEWAPI_ADMIN_USER_ID" \
  http://localhost:3000/api/pricing | jq '.[] | select(.model_name=="claude-opus-4-7")'
# Should show model_ratio: 15
```

Pricing changes are **immediate** — new-api applies the new ratios on
the next request. There's no cache to bust on the new-api side.

## Step 5 — bust the portal /pricing 60s ISR

The portal `/pricing` page renders with ISR `revalidate=60`. After
exiting the promo, force a refresh so customers see retail prices
immediately:

```bash
ssh vps 'docker compose -f /opt/silkroadai-portal/docker-compose.prod.yml restart portal'
```

(Or wait 60s — both work. Restart is cleaner for visible effect.)

## Step 6 — rebuild portal landing + /pricing without promo banner

In `src/app/landing/page.tsx` (when it lands in W7 D2):
- Remove the promo banner block ("上线钜惠 · 海外模型 5 折 …")
- Optionally replace with a low-key "正式价已生效" notice that fades after a week

In `src/app/pricing/page.tsx`:
- Remove the strikethrough on retail prices (or keep "限时回归" highlight if running a follow-up promo)
- Verify the prices in the page match new-api `/api/pricing`

Commit, push, VPS rebuild.

## Step 7 — close out

- [ ] Sentry: confirm 0 errors during exit window
- [ ] Frankqy notified that promo is over
- [ ] Internal note in CLAUDE.md "当前进度" — log exit timestamp + commit hash
- [ ] Followup: if SF margins were thin during promo, this is a good time to revisit the SF mr formula (currently `wholesale_¥/5.83`)

---

## What if exit needs to be reverted?

If something breaks post-exit and you need to roll back to promo prices:

```bash
# Re-run apply-w7-pricing.ts (which applies promo prices, not retail)
pnpm dlx tsx _bootstrap/apply-w7-pricing.ts --apply
```

`apply-w7-pricing.ts` is idempotent and always writes the configured
promo ratios. Running it after exit will restore promo prices for
the sub2api channels.

If you need to roll back the new-api db state entirely:

```bash
ssh vps 'docker exec -i new-api-db psql -U newapi newapi < /tmp/newapi-pre-w7-exit.sql'
```

---

## Why not auto-trigger on a cron?

Three reasons:

1. **Pricing is a business-critical surface.** Surprise price hikes
   even when announced are bad UX. A human pressing "go" gives one
   more layer of "is this really what we want today" gating.
2. **Promo extension is plausible.** If acquisition is still
   accelerating on day 30, operator may want to extend. A cron would
   be one more thing to defuse.
3. **Calendar drift is real.** Holiday closures, "let's wait until
   the next billing cycle", customer email-blasts that miss the
   window — all easier to manage when an actual person is reading
   the date and pushing the button.
