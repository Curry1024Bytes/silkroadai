# W7 D1 — Pricing Audit & Margin Report

**Date**: 2026-05-06
**Audit scope**: 379 models across 3 channels (siliconflow id=1, sub2api Anthropic id=2, sub2api-openai id=3)
**Reference data**:
- new-api `/api/pricing` snapshot at audit time (379 rows, 1 with `pricing_version`)
- new-api `channels` table (model membership per channel)
- SiliconFlow public pricing page (https://www.siliconflow.com/pricing) for SF wholesale
- DeepSeek-V3/R1 SF pricing from web search (early-2025; verify before launch)
- OpenAI / Anthropic public direct pricing for "vs Direct" comparison
- USD→CNY rate: 7.2 (config `USD_TO_CNY_RATE` default)
- new-api quota formula confirmed: `customer_usd_per_1M = model_ratio × 2`; output multiplied by `completion_ratio`

**Deliverable**: `~/Documents/silk road ai/docs/W7-D1-pricing-audit.xlsx` (3 sheets)
**Audit-only — no code changes, no DB changes, no new-api changes.**

---

## 🚨 TL;DR — biggest finding before W7 D5 launch

> **261 of 379 models (69%) sit at `model_ratio = 37.5` with `completion_ratio = 1`** — the new-api default fallback ratio (= claude-opus-thinking tier, $75/1M input + $75/1M output). This is **almost certainly NOT what we want to charge customers** for, e.g., `deepseek-v3.2` or `qwen3-32b`.
>
> Of those 261:
> - **siliconflow channel: 188 / 190 (99%)** — virtually the entire SF channel is mispriced.
> - **sub2api-openai: 6 / 157 (4%)** — mostly fine.
> - **sub2api Anthropic: 0 / 32 (0%)** — best-configured channel.
>
> **Until pricing is set explicitly per-model, any customer that exercises a SiliconFlow model will be billed at $150/1M tokens (in+out) — a ~1500-2000× markup over real SF wholesale.** Either we get free transactions because the gate is wrong or we burn customer goodwill the moment any of them tries deepseek and sees their balance evaporate.

**Recommended W7 D5 prerequisite**: operator (or me, with operator instruction) walks the 188 SF + 6 OpenAI default-fallback models and sets sensible model_ratio + completion_ratio per the SF wholesale data in the xlsx Sheet 1. Until then `/pricing` should NOT go public.

---

## 1. Audit overview

### 1.1 Channels in prod
| ch | name              | type | n models | role |
|---:|-------------------|:----:|---------:|---|
| 1  | siliconflow       | OpenAI (1) | 190 | open-source / Chinese / cheap |
| 2  | sub2api           | Anthropic Claude (14) | 32  | Anthropic Claude family |
| 3  | sub2api           | OpenAI (1) | 157 | OpenAI gpt-* + audio + image-gen |

**Total**: 379 (matches `/api/pricing` count and W6 D3 `/models` page).

### 1.2 Margin band distribution (priority models, n=63)

| band | count | meaning |
|---:|---:|---|
| 🟥 LOSS  | 1  | Customer price < wholesale (亏本卖) — `deepseek-ai/DeepSeek-R1` blended margin = -12.8% (vs SF Pro tier ¥4/¥16) — but customer-side ratio looks like a default-fallback misconfig anyway, see §2 |
| 🟥 RED    | 0 | <20% margin |
| 🟨 YELLOW | 0 | 20-30% |
| 🟩 GREEN  | 0 | 30-60% (none in sample) |
| 🟦 BLUE   | 14 | >60% — but **all 14 are SF default-fallback models** where the "60%+ margin" is illusory (¥540 customer vs ¥0.30 wholesale = 99.95% margin on paper, but customers won't pay ¥540 for a model that costs ¥0.30 anywhere else) |
| ⏳ TBD   | 48 | Wholesale not yet known: 25 sub2api models awaiting operator's monthly bill data + 23 SF models not on the public Pro pricing page |

Note: with 14 BLUE all driven by misconfig and only 1 LOSS, the band stats are NOT representative until the 188 SF defaults are set explicitly. The xlsx Sheet 2 surfaces every misconfig row.

---

## 2. 🟥 红牌模型 (亏损 / 临界)

### 2.1 The single LOSS row in current data

**`deepseek-ai/DeepSeek-R1`** (siliconflow channel)
- Customer-side: model_ratio=0.8, cr=1 → $1.6/1M input, $1.6/1M output → ¥11.52/1M each side
- SF Pro wholesale: ¥4/1M input, ¥16/1M output (early-2025 web-search data)
- Blended margin: **-12.8%** — we're selling DeepSeek-R1 at a loss
- **Action**: bump `model_ratio` to ~2.0 (=$4/1M, ≥10% margin) OR confirm SF wholesale has dropped (verify before launch)
- Caveat: customer-side ratio 0.8 is suspiciously low for a "thinking" model; the prod default is 37.5 for most R1 variants. Different R1 SKUs have different ratios — needs sweep.

### 2.2 Hidden LOSS / RED candidates (default-fallback masking)

The 188 SF default-fallback models LOOK like 99%+ margin in raw arithmetic but in reality:
- nobody will actually pay ¥540 / 1M for `deepseek-v3.2` (real SF Pro wholesale: ¥0.27/¥0.42)
- if any user accidentally hits one and sees the bill, support fire
- if the new-api billing path treats `pricing_version=null` as "free / unmetered", we're giving away SF traffic with no revenue

**Action**: every SF model in the channel needs an explicit (model_ratio, completion_ratio) override. See §6 for the proposed spreadsheet of corrections.

### 2.3 Anthropic suspicious entries

| model | current ratio→USD | retail USD | ratio over retail |
|---|---|---|---|
| `claude-sonnet-4-6` | mr=37.5 cr=5 → in $75 / out $375 | $3 / $15 (Sonnet 4.5 retail) | **25×** |
| `claude-sonnet-4-5-20250929-thinking` | mr=37.5 cr=5 → $75 / $375 | $3 / $15 | **25×** |
| `claude-opus-4-7-thinking` | mr=37.5 cr=5 → $75 / $375 | $15 / $75 (Opus 4.x retail) | **5×** |
| `claude-opus-4-5-20251101-thinking` | mr=37.5 cr=5 → $75 / $375 | $15 / $75 | **5×** |
| `claude-opus-4-1-20250805-thinking` | mr=37.5 cr=5 → $75 / $375 | $15 / $75 | **5×** |

**Question for operator**: are these thinking-mode SKUs genuinely 5-25× retail (because Anthropic's actual API charges extra for chain-of-thought reasoning tokens)? Or did the model_ratio fall through to the 37.5 default? See `vs Direct` sheet — these are the highest-risk models for sophisticated users to bypass via direct Anthropic billing.

---

## 3. 🟨 黄牌模型 (薄利)

**Currently zero rows** in the YELLOW band (20-30% margin).

This is suspicious — most healthy AI middlemen sit precisely in this band. The absence indicates:
- Either we have very few correctly-priced models (most are still default-fallback BLUE), or
- Our explicit pricing leans toward extremes (very high margin or LOSS) without intermediate ratios

**After the W7-D5 prerequisite re-pricing**, expect the YELLOW band to fill out as the natural healthy operating zone for SF reseller margins.

---

## 4. 🟦 暴利模型 (毛利 > 60%, 客户可能找替代)

The 14 BLUE rows in the current sample are **all SF default-fallback misconfigs** (188 actually exist, only the priority-list slice surfaced). Once those are corrected, expect the real BLUE pool to be:

- **Anthropic Claude `claude-opus-4-7` non-thinking** ($5/$25 vs retail $15/$75) — currently at **1/3 retail**, which is great for users but suspicious for us. Are we sure we're not selling Opus 4.7 at a loss against sub2api wholesale? Operator must fill sub2api wholesale before we can answer.
- **gpt-5 / gpt-5-mini** ($2/$8 vs $14.4/$57.6 retail) — also priced below retail in CNY, presumably to stay attractive vs OpenAI direct China-route.

**No genuine暴利 (>60%) rows confirmed** — the BLUE band is illusory once misconfigs are cleared.

---

## 5. vs 上游直购对比 (Sheet 3 highlights)

The "vs Direct" sheet ranks models by `max(in_ratio, out_ratio)` — higher = more incentive for customers to bypass us.

### 🟥 RED (worst-case ratio > 2× retail; users will leave)

| model | our cny/1M (in/out) | upstream cny/1M (in/out) | worst ratio |
|---|---|---|---|
| `claude-sonnet-4-6` | 540 / 2700 | 21.6 / 108 | **25×** |

Single sustained RED. If we don't fix Sonnet-4-6's ratio, anyone paying attention will route through Anthropic direct or OpenRouter at ~1/25 the cost.

### 🟨 YELLOW (worst-case ratio 1.5×-2×)

None in current data. The OpenAI gpt-5.x family slots are mostly at-or-below retail.

### 🟩 GREEN (1.0×-1.5× — healthy reseller premium)

- `claude-3-5-haiku-20241022`: 1.25× — good, reflects China-route convenience premium
- `claude-3-opus-20240229`: 1.0× — at par with retail
- `gpt-5` output: 1.25× input 0.625× — slightly mixed but acceptable

### 🟦 BLUE (≤1× retail — we're cheaper than direct)

- `claude-opus-4-20250514`, `claude-opus-4-1-20250805`, `claude-opus-4-5-20251101` all at 1.00× — at parity with retail
- `claude-opus-4-7`: 0.33× — selling Opus 4.7 at 1/3 of upstream retail is a customer giveaway. **Operator must verify sub2api wholesale doesn't make this a loss.**
- `gpt-5-mini` input: 0.625× — same. Below-retail input pricing is a competitive lure for sign-ups; only a problem if it goes below sub2api wholesale.

---

## 6. 运营者待决策清单 (operator action items, blocking W7 D5 launch)

### ⏳ A1. **Fill sub2api / sub2api-openai wholesale** (CRITICAL — blocks launch margin math)
Spreadsheet has 25 sub2api models with `Wholesale ¥/1M In/Out` blank. Need:
- **sub2api Anthropic**: monthly bill ÷ tokens consumed = ¥/1M for at least the top-volume models (claude-opus-4-7, claude-sonnet-4-6, claude-3-5-sonnet-20241022, claude-haiku-4-5-20251001).
- **sub2api-openai**: same, broken out for gpt-4o, gpt-4o-mini, gpt-5, gpt-5-mini, o1, o3-mini, dall-e-3, whisper-1.

Once filled, the live margin formula in column M of Sheet 1 auto-computes margins.

### ⏳ A2. **Re-price the 188 SF default-fallback models** (CRITICAL)
Either:
- (a) Use the SF wholesale data in Sheet 1 + a target margin (e.g. 35%) to compute new (model_ratio, completion_ratio) per-model, then apply via new-api admin UI, OR
- (b) For now, set a single flat ratio (e.g. mr=0.5, cr=1 → $1/1M each side ≈ ¥7.2/1M) for all unpriced SF models so /pricing publishes uniform-but-cheap numbers; refine post-launch.

Without A2, the 188 SF models are effectively **billed at $150/1M** (or unbilled, depending on new-api's null-pricing-version behavior) — both outcomes are incompatible with public launch.

### ⏳ A3. **Decide: claude-sonnet-4-6 + claude-*-thinking ratios — premium or default fallback?**
Currently $75/$375 per 1M tokens. If genuine thinking-mode premium, leave it but flag in /pricing UI ("thinking 模式定价 5× 标准"). If misconfig, drop to mr=1.5, cr=5 (= $3/$15, retail-matched).

### ⏳ A4. **Decide: which 6 sub2api-openai default-fallback models to fix or remove**
Spreadsheet shows 6 OpenAI-channel models at default fallback (mostly `gpt-5.x` + `gpt-image-2`). Either set explicit ratios from OpenAI retail or remove from the channel models list.

### ⏳ A5. **Decide /pricing public model selection (推荐 ~12)**
`/models` page shows 379. `/pricing` cannot. Suggested public list:
1. **Chat (mainstream)**: gpt-4o, gpt-5, gpt-4o-mini, gpt-5-mini
2. **Premium reasoning**: o1, o3, claude-opus-4-7, claude-sonnet-4-5
3. **China-side cheap**: deepseek-v3.2 (after A2 re-pricing), glm-4.6, kimi-k2-instruct-0905, qwen3-235b-a22b-instruct-2507
4. **Audio / image**: dall-e-3, whisper-1, sora-2 (per-call pricing, present `quota_type=1`)
5. **Embedding (optional)**: text-embedding-3-large, BAAI/bge-m3 (free)

12 main + 5 specialty = ~17. Worth A/B testing the layout.

---

## 7. silkroadai.io 根域现状

**`https://silkroadai.io`** → **HTTP 200**, 40,185 bytes, `text/html; charset=utf-8`.
- Title: "Silk Road AI — Connecting Global Intelligence. Powering the AI Future."
- Description: "Claude、ChatGPT、Gemini 一站式 API 中转。按量计费，企业级稳定，Claude Code 等开发工具无缝接入。"
- Lang: zh-CN; static landing page, no obvious framework dependency in the head.

**`https://www.silkroadai.io`** → **HTTP 301** redirect to `https://silkroadai.io/` (canonical resolution working correctly).

**Implication for landing-page brief**: a Chinese marketing landing already exists. Before W7 next batch builds a new one, evaluate the existing page for: (a) freshness of model claims (need /models + /pricing parity), (b) CTAs (does it link to `/login` and `/pay`?), (c) freshness of the "API 中转" framing now that we have proper Portal + Pay + Dashboard. May be a refactor of the existing instead of a from-scratch build.

---

## 8. 计算公式 + 假设 (for verification)

### Formula confirmed
```
input_usd_per_1M  = model_ratio × 2
output_usd_per_1M = model_ratio × completion_ratio × 2
customer_cny_per_1M = usd × 7.2  (USD_TO_CNY_RATE default)
```

### Calibration samples
| model | mr | cr | computed input | retail | match |
|---|---|---|---|---|---|
| `o1-2024-12-17` | 7.5 | 4 | $15 / $60 | $15 / $60 | ✓ |
| `gpt-4o` | 1.25 | 4 | $2.50 / $10 | $2.50 / $10 | ✓ |
| `text-embedding-3-large` | 0.065 | 1 | $0.13 | $0.13 | ✓ |
| `whisper-1` | 15 | 1 | $30 / $30 (per-token equiv) | $0.006/min — N/A | model treated as token-priced; verify against actual usage |

### Group ratio
`channels.group_ratio` is **not a column** in the prod schema; new-api defaults `group_ratio=1` for the `default` group (the only group in prod, per `/api/pricing.auto_groups`). **No VIP / discount tier currently active.** A5 (operator decision) covers whether to enable.

### Quota math
Customer's CNY/1M input × tokens / 1_000_000 = CNY consumed. Internally new-api converts to raw quota: `CNY × QUOTA_PER_USD / USD_TO_CNY_RATE` ≈ 69,444 quota per CNY. portal balance is shown in CNY; raw quota only surfaced as small text in /balance card.

---

## 9. Sheet-by-sheet guide

### Sheet 1 — Pricing Master (63 priority rows × 14 columns)
Rows sorted by channel (siliconflow → sub2api Anthropic → sub2api-openai), within channel by Customer ¥/1M In descending. Live formula in column M (Margin %) recomputes when wholesale columns K/L are filled.

### Sheet 2 — Margin Alerts (alerts only)
LOSS / RED / YELLOW / BLUE / TBD bands. Sorted by severity. Action 建议 column has the recommended next step per row.

### Sheet 3 — vs Direct OpenAI/Anthropic (29 rows)
Models where I have upstream retail. Risk column: RED (>2× retail), YELLOW (1.5-2×), GREEN (1-1.5×), BLUE (≤1×). Rows sorted by worst-case ratio descending — top of sheet = most at-risk-of-bypass.

---

## 10. Caveats + data quality

- **DeepSeek-V3 / R1 SF wholesale** comes from web-search early-2025 articles (sources cited in xlsx Notes). SF prices may have moved; verify before launch.
- **Kimi-K2-Thinking** SF wholesale set at ¥4/¥16 (estimate from official Kimi pricing). SF page confirmed only standard K2-Instruct-0905 at ¥0.4/¥2.0.
- **BAAI/bge-m3** marked SF promo: free / 限时免费 — verify the promo period is still active before W7 D5 launch.
- **Anthropic retail** for `claude-opus-4-7` and `claude-haiku-4-5-20251001` are estimates (model SKUs newer than Anthropic's most-recent public pricing page snapshot in this audit's research).
- The xlsx is a **point-in-time snapshot** (2026-05-06). Re-run the build script (`_bootstrap/build-pricing-audit.py`) periodically to refresh from `/api/pricing`.
- I deliberately **left sub2api wholesale blank** rather than guessing — the brief said "Claude Code 不要瞎猜数字". Operator fills, formulas auto-compute.

---

## 11. Files

| path | size | purpose |
|---|---|---|
| `/Users/mac/Documents/silk road ai/docs/W7-D1-pricing-audit.xlsx` | ~18 KB | 3-sheet xlsx |
| `~/Documents/silkroadai/docs/W7-D1-PRICING-AUDIT.md` | this file | decision briefing |
| `_bootstrap/build-pricing-audit.py` | committed in this batch | regenerator script |
| `/tmp/newapi-pricing.json` | 79 KB | raw `/api/pricing` snapshot, useful for re-runs |
| `/tmp/newapi-channel-models.tsv` | 7.9 KB | channel→model membership |

---

**版本**: 1.0
**最后更新**: 2026-05-06
