# PR-S Verification — Gemini family + ChatGPT image-2 pricing

> Operator brief: PR-S Stage 1-5 — apply pricing across the new Gemini channel +
> sub2api-openai gpt-image-2, then surface in landing/docs.
> Apply date: 2026-05-09.

## Stage 1 — Channel audit

GET `/api/channel/?p=1&page_size=20` (admin auth):

|  ID | Name        |                  Type | Status |                 Models |
| --: | ----------- | --------------------: | -----: | ---------------------: |
|   1 | siliconflow |     1 (OpenAI-compat) | active |                    118 |
|   2 | sub2api     | 14 (Anthropic Claude) | active |                      6 |
|   3 | sub2api     |     1 (OpenAI-compat) | active |                     17 |
|   4 | Gemini 官方 |           24 (Google) | active | 23 → 16 (post-disable) |

Channel 4 (operator-added) raw model list:

```
nano-banana-pro-preview, lyria-3-clip-preview, lyria-3-pro-preview,
deep-research-max-preview-04-2026, deep-research-preview-04-2026,
deep-research-pro-preview-12-2025, gemini-2.5-pro-preview-tts,
gemma-4-31b-it, gemini-3.1-pro-preview, gemini-3.1-pro-preview-customtools,
gemini-3.1-flash-lite, gemini-3-pro-image-preview,
gemini-3.1-flash-image-preview, gemini-3.1-flash-tts-preview,
gemini-robotics-er-1.6-preview, gemini-embedding-2, aqa,
imagen-4.0-ultra-generate-001, veo-3.1-generate-preview,
veo-3.1-fast-generate-preview, veo-3.1-lite-generate-preview,
gemini-2.5-flash-native-audio-latest, gemini-3.1-flash-live-preview
```

Channel 3 (sub2api-openai) `gpt-image-2` confirmed in `models` list. No
ratio set in current `ModelRatio` / `CompletionRatio` / `ModelPrice`.

## Stage 2 — Google AI Studio official pricing

WebFetched https://ai.google.dev/gemini-api/docs/pricing on 2026-05-09.

| SKU                                               | Status | Pricing                                                       |
| ------------------------------------------------- | ------ | ------------------------------------------------------------- |
| gemini-3.1-pro-preview                            | ✓      | in $2 / out $12 (≤200k); $4 / $18 (>200k)                     |
| gemini-3.1-flash-lite                             | ✓      | in $0.25 (text/img/video) $0.50 (audio) / out $1.50           |
| gemini-3.1-flash-image-preview                    | ✓      | in $0.50 / out $3 text + $60/1M images (~$0.045-$0.151/image) |
| gemini-3-pro-image-preview                        | ✓      | in $2 / out $12 text + $120/1M images (~$0.134-$0.24/image)   |
| gemini-3.1-flash-tts-preview                      | ✓      | in $1 / out $20 audio                                         |
| gemini-2.5-pro                                    | ✓      | in $1.25 / out $10 (≤200k tier)                               |
| gemini-2.5-flash                                  | ✓      | in $0.30 / out $2.50                                          |
| gemini-embedding-2                                | ✓      | in $0.20 (text)                                               |
| gemini-2.5-flash-image-preview ("nano-banana" 🍌) | ✓      | $0.039/image standard                                         |
| imagen-4.0-ultra-generate-001                     | ✓      | $0.06/image                                                   |
| veo-3.1-generate-preview                          | ✓      | $0.40/sec (720p/1080p)                                        |
| veo-3.1-fast-generate-preview                     | ✓      | $0.10/sec (720p)                                              |
| veo-3.1-lite-generate-preview                     | ✓      | $0.05/sec (720p)                                              |
| lyria-3-pro-preview                               | ✓      | $0.08/request                                                 |

**Not in Google docs (operator-decided handling)**:

- `nano-banana-pro-preview` — operator alias for `gemini-3-pro-image-preview` ($0.187/image)
- `lyria-3-clip-preview` — operator: same $0.08/request as `lyria-3-pro-preview`
- `gemini-2.5-flash-native-audio-latest` — operator: 2.5 flash audio tier ($1/$2.50/M)
- `gemini-3.1-pro-preview-customtools` — operator: shares parent tier ($4/$18/M)
- `gemma-4-31b-it`, `aqa`, `gemini-2.5-pro-preview-tts`, `gemini-3.1-flash-live-preview`,
  `gemini-robotics-er-1.6-preview`, 3× `deep-research-*` — operator: disable from channel

ChatGPT Image-2 (operator-stated, can't reach OpenAI docs):

- `gpt-image-2` — $0.04/image standard (per operator)

## Stage 3 — Markup policy + apply

Policy (operator):

- **Image** (Gemini family + gpt-image-2): retail = wholesale × **1.5**
- **Text / video / audio / embedding**: retail = wholesale × **1.0**
  (zero markup; operator recovers margin via post-launch upstream swap)

Implementation: `_bootstrap/apply-pr-s-pricing.ts` (sister of W7 launch script).
Writes global options:

- `ModelRatio` + `CompletionRatio` for per-token (text/embedding/audio per-token)
- `ModelPrice` for flat per-call (image/video/per-request audio)

Plus PUT `/api/channel/4` to drop 7 disabled SKUs from `channel.models`.

### Apply log (live, 2026-05-09)

```
[ModelRatio + CompletionRatio] — per-token
  gemini-2.5-flash                                   mr 0.15 → 0.30   cr 8.33
  gemini-2.5-pro                                     mr 0.625 → 1.25  cr 8
  gemini-3.1-flash-lite                              mr — → 0.25      cr 6
  gemini-3.1-pro-preview                             mr — → 4         cr 4.5  (>200k tier)
  gemini-3.1-pro-preview-customtools                 mr — → 4         cr 4.5
  gemini-embedding-2                                 mr — → 0.2       cr 1
  gemini-3.1-flash-tts-preview                       mr — → 1         cr 20
  gemini-2.5-flash-native-audio-latest               mr — → 1         cr 2.5

[ModelPrice] — flat per-call (USD)
  gemini-2.5-flash-image-preview                     — → $0.0585    (= $0.039 × 1.5)
  gemini-3.1-flash-image-preview                     — → $0.15      (= $0.10 × 1.5)
  gemini-3-pro-image-preview                         — → $0.2805    (= $0.187 × 1.5)
  nano-banana-pro-preview                            — → $0.2805    (alias of -3-pro-image)
  imagen-4.0-ultra-generate-001                      — → $0.09      (= $0.06 × 1.5)
  gpt-image-2                                        — → $0.06      (= $0.04 × 1.5)
  veo-3.1-fast-generate-preview                  $0.15 → $0.10      (corrected to 720p tier)
  veo-3.1-lite-generate-preview                      — → $0.05
  lyria-3-pro-preview                                — → $0.08
  lyria-3-clip-preview                               — → $0.08

[Channel 4] dropped 7 SKUs:
  - aqa
  - gemini-2.5-pro-preview-tts
  - gemini-3.1-flash-live-preview
  - gemini-robotics-er-1.6-preview
  - deep-research-pro-preview-12-2025
  - deep-research-preview-04-2026
  - deep-research-max-preview-04-2026

→ PUT /api/option/ ModelRatio        ✓
→ PUT /api/option/ CompletionRatio   ✓
→ PUT /api/option/ ModelPrice        ✓
→ PUT /api/channel/4                 ✓ (16 models post-disable)
```

### Heads-up — 3 SKUs priced but not yet routable

`gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-2.5-flash-image-preview` —
operator listed them in Stage-3 spec; ratios written; not in any
channel.models. They'll 503 until added. Operator decision queued.

## Stage 4 — Real-call verification

Token: portal admin user 1, `unlimited_quota` token id=5. Calls hit
prod `https://ai.silkroadai.io` via the customer path (not admin).

### 4.1 — `gemini-3.1-flash-lite` text

```
POST /v1/chat/completions  {model: gemini-3.1-flash-lite, "say hi in one word"}
→ 200, content="Hi", prompt=6 / completion=1 tokens
log row: model_ratio=0.25, completion_ratio=6, group_ratio=1, quota=3
```

Math: `(6 × 0.25) + (1 × 0.25 × 6) = 1.5 + 1.5 = 3` ✓ exact.

### 4.2 — `gemini-3.1-flash-image-preview` image

```
POST /v1/chat/completions  {model: gemini-3.1-flash-image-preview, "generate a tiny image of a cat"}
→ 200 (content_filter, no actual image but quota still applied)
log row: model_price=$0.15, prompt=8 / completion=0, quota=150000
```

Math: `$0.15 × QPU(1M) = 150,000` ✓ exact (ModelPrice mode flat-fee).

### 4.3 — `gpt-image-2` image (channel 3, sub2api-openai)

```
POST /v1/images/generations  {model: gpt-image-2, "a tiny cat"}
→ 200, returned b64_json image bytes
log row: model_price=$0.06, prompt=32 / completion=196, quota=60000
```

Math: `$0.06 × QPU(1M) = 60,000` ✓ exact.

### 4.4 — `gemini-embedding-2` embedding

```
POST /v1/embeddings  {model: gemini-embedding-2, input: "hello world"}
→ 200, vector dim=3072
log row: model_ratio=0.20, completion_ratio=1, prompt=3, quota=1
```

Math: `(3 × 0.20) + 0 = 0.6` → new-api rounds up to integer = 1.
Within rounding noise (sub-cent absolute). ✓ acceptable.

**All 4 sample calls within rounding noise of expected formula.**

## Stage 5 — Landing + docs surfaces

### Landing pricing teaser (`src/app/page.tsx`)

Added 2 rows in the 海外 section between OpenAI and SF entries:

- Gemini 3.1 Pro · 旗舰长上下文 · $4 / 1M · $18 / 1M
- Gemini 3.1 Flash Lite · 高速 / 高吞吐 · $0.25 / 1M · $1.50 / 1M

Zero-markup → no `promoIn`/`promoOut`; render as plain bold (no
strikethrough) since they're outside the 5 折 promo set.

### `/docs` (`src/app/docs/page.tsx`)

Added section 07 "Google Gemini · 通过同一 base URL 调用" between
Node SDK (06) and 常见错误码 (now 08). Surfaces concrete model names
for text / image / video / embedding tiers + a model-clue list keyed
by use case. Errors section renumbered 07 → 08.

`/models` page auto-syncs from `/api/channel/models_enabled` — 15 of
the 19 priced SKUs appear (the 3 unrouted 2.5-series + embedding which
are excluded by models_enabled's chat-completions-only filter).

## Out of scope (operator follow-up)

- Add `gemini-2.5-flash` / `gemini-2.5-pro` / `gemini-2.5-flash-image-preview`
  to channel 4 if they should be callable.
- Real-call verification for video/audio/big-image SKUs (single-call
  cost $0.4-0.6; operator handpick post-launch when ROI clearer).
- `/image` UI page + R2 + history gallery — separate PR-T (operator).
- Post-launch 0-markup upstream swap (cheaper providers for text /
  video / audio to recover margin).
