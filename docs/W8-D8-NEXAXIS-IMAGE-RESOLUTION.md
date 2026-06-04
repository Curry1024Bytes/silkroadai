# W8 D8 — 让 Channel 17 (nexaxis.ai) Gemini 图像真返 2K/4K

> **日期**: 2026-06-04
> **任务**: 上游默认只返 1408×768 (~1K),但 portal 按 2K/4K 计费 → 客户超收。
> operator 已决定**不降价**,需要让上游真出 2K/4K。
> **结论**: ✅ 找到工作格式,portal 已改,端到端验证 2K→2048²、4K→4096²。**未 merge,待 operator review。**

---

## 0. TL;DR(给赶时间的人)

- **唯一工作格式**:走 **native Gemini endpoint** `POST /v1beta/models/{model}:generateContent`,在 `generationConfig.imageConfig.imageSize` 传 `"2K"` / `"4K"`。
    - Google 字段名是 **`imageSize`**,不是 brief 假设的 `imageResolution`(后者被 Google 直接 400 "Cannot find field")。
- **OpenAI 兼容的 `/v1/chat/completions` 路径(portal 原本用的)做不到** — nexaxis 的 chat→Gemini 转换器**静默丢弃** `imageConfig`(任何嵌套位置 / 任何字段名都丢)。这就是之前按 2K/4K 计费却只拿到 1K 图的根因。
- **好消息**:Channel 17 在我们这侧是 **Gemini 类型 (type 24) 渠道**,我们自己的 new-api **原生支持** `/v1beta/...:generateContent` 透传,并且**会把 `imageConfig` 转发到 nexaxis**(即使 `pass_through_body_enabled=false`,因为 native→native 不需要转换)。端到端实测:经过我们 new-api → Channel 17 → nexaxis,`imageSize:"2K"` → **2048×2048**。
- **Portal 改动**:`generate` route 对 2K/4K Gemini 模型改走 native endpoint 并注入 `imageConfig.imageSize`,不影响 gpt-image-2 / Imagen / 1K 的 Nano Banana。已加 18 个单测,全套绿。
- **没动任何被禁的东西**:ModelPrice / Channel 17 base_url·key·type·models 一概未改;没 merge。

---

## 1. 背景与架构

调用链(两跳 new-api):

```
portal /api/portal/image/generate
   → 我们的 new-api (ai.silkroadai.io)  [Channel 17 = "t3 1.4", type 24 Google Gemini, base=https://nexaxis.ai]
      → nexaxis.ai (也是一个 new-api 实例)
         → Google Gemini 账号池
```

- nexaxis.ai 自报 `<meta name="generator" content="new-api">` + `X-New-Api-Version` header → 它本身就是 new-api,讲 OpenAI / Claude / Gemini 兼容多格式。
- nexaxis 是 Gemini 账号经销(公告里写 "Gemini 账号库存""每日约新增 200 个账号"),按张转售。

Channel 17 实读配置(只读,没改):

| 字段                              | 值                                                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| name                              | `t3 1.4`                                                                                                                                                   |
| type                              | **24 = Google Gemini**(native 类型,不是 OpenAI-compat)                                                                                                     |
| base_url                          | `https://nexaxis.ai`                                                                                                                                       |
| group                             | `default`(portal 客户 token 也在这个 group,所以路由命中)                                                                                                   |
| 服务的图像模型                    | `gemini-2.5-flash-image` / `gemini-3.1-flash-image-preview` / `gemini-3-pro-image-preview` / `gemini-3.5-flash`(**Channel 17 是唯一服务这几个模型的渠道**) |
| setting.pass_through_body_enabled | `false`                                                                                                                                                    |

---

## 2. 阶段 A — 格式排查(直接打 nexaxis.ai)

对 `https://nexaxis.ai` 用上游 key 直接测了 **10+ 种 size 格式 × 2 模型**,每张返回图存盘后用 `sips` / `file` / PIL 三工具交叉量像素。

### 2.1 baseline + OpenAI-compat `/v1/chat/completions`(portal 原路径)

| 格式                                                                              | 结果像素            | 说明                                   |
| --------------------------------------------------------------------------------- | ------------------- | -------------------------------------- |
| baseline(无任何 size 提示)                                                        | **1408×768**        | Google 默认,= 客诉的 1K                |
| A `generationConfig.imageConfig.imageResolution:"2K"`                             | 1408×768            | 丢弃                                   |
| B 根级 `size:"2048x2048"`(OpenAI 风格)                                            | 1408×768            | 丢弃                                   |
| C model 名加 `-2k` 后缀                                                           | 503 model_not_found | 不存在该模型                           |
| D `extra_body.imageConfig`                                                        | 1408×768            | 丢弃                                   |
| E 自定义 `image_generation`/`image_config`                                        | 1408×768            | 丢弃                                   |
| H 根级 `imageConfig`                                                              | 1408×768            | 丢弃                                   |
| F prompt 里硬塞 "2K resolution"                                                   | 1024×1024           | 只改了形状,没改分辨率                  |
| **chat + 正确字段 `imageConfig.imageSize:"2K"`**(gc / 根级 / extra_body 三处都试) | **1408×768**        | **即使字段名正确,chat 路径仍全部丢弃** |

> **关键结论 1**:`/v1/chat/completions` 路径无论字段名(`imageResolution` vs `imageSize`)、无论嵌套位置(`generationConfig` / 根级 / `extra_body`),nexaxis 的 chat→Gemini 转换器都**静默丢弃** size 提示。chat 请求恒返 200(不报错),所以提示是被丢、不是被 Google 拒。**portal 原本的 chat 路径根本没法控分辨率。**

文件体积曾误导:A/B/D/H 的 PNG 体积(~1.7MB)是 baseline(~0.8MB)的两倍,一度像是变高清了 —— 实际三工具量出来都是 1408×768,体积差只是图像熵不同(同分辨率不同内容)。**像素才是唯一可信指标。**

### 2.2 native Gemini endpoint `/v1beta/models/{model}:generateContent`

case G(native + `imageConfig.imageResolution`)给了决定性线索 —— Google **本尊**回 400:

```
Unknown name "imageResolution" at 'generation_config.image_config': Cannot find field.
```

这说明:(1) native 路径**会把 generationConfig 透传给 Google**(chat 路径不会);(2) 字段名 `imageResolution` 是**错的**,Google 的 schema 里没有。于是改试 `imageSize`:

| native 探测(`gemini-3-pro-image-preview`)     | 结果                                             |
| --------------------------------------------- | ------------------------------------------------ |
| `imageConfig.imageSize:"2K"`                  | **2048×2048** ✅                                 |
| `imageConfig.imageSize:"4K"`                  | **4096×4096** ✅(首试 429 库存耗尽,retry 即成功) |
| `imageConfig.imageResolution:"4K"`            | 400 Cannot find field                            |
| `imageConfig.resolution:"4K"`                 | 400 Cannot find field                            |
| `imageConfig.aspectRatio:"1:1"`(无 imageSize) | 1024×1024                                        |
| 仅 `responseModalities:["IMAGE"]`             | 1408×768                                         |

flash 模型 `gemini-3.1-flash-image-preview` native 探测:

|                  | 结果                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| `imageSize:"2K"` | **2048×2048** ✅                                                          |
| `imageSize:"4K"` | 503 `No available channel ... under group vertex` → **flash 上限就是 2K** |

> **关键结论 2**:唯一工作格式 = **native `/v1beta/...:generateContent` + `generationConfig.imageConfig.imageSize`**。
>
> - `gemini-3.1-flash-image-preview`:支持到 2K(4K 不可用)→ 与 operator 计费 "flash=2K" 吻合。
> - `gemini-3-pro-image-preview`(Nano Banana Pro):支持 2K **和** 4K → 与计费 "pro=4K" 吻合。
> - **两个模型都能真出各自被计费的分辨率**,定价没问题,只是之前没把 size 传到上游。

### 2.3 工作请求体(可直接复制)

```bash
POST https://nexaxis.ai/v1beta/models/gemini-3-pro-image-preview:generateContent
Authorization: Bearer <上游 key>           # 或 ?key=<上游 key>
Content-Type: application/json

{
  "contents": [{ "parts": [{ "text": "a photorealistic calico cat ..." }] }],
  "generationConfig": {
    "responseModalities": ["IMAGE"],
    "imageConfig": { "imageSize": "4K", "aspectRatio": "1:1" }
  }
}
```

响应 = native Gemini 形:`candidates[0].content.parts[].inlineData.data`(base64)。

---

## 3. 阶段 A.5 — 端到端验证(经过我们自己的 new-api)

portal 不直接打 nexaxis,而是打我们的 new-api。所以关键问题是:**我们的 new-api 会不会把 `imageConfig` 转发到 Channel 17?**(`pass_through_body_enabled=false`,有疑虑。)

验证方法(低足迹、可回滚):用 admin API 临时建一个 root 的 throwaway token(group=`default`),直接打**我们 new-api** 的 native endpoint,测完**立即删 token**。

| 经过我们 new-api → Channel 17 → nexaxis | 结果像素         |
| --------------------------------------- | ---------------- |
| native baseline(无 imageConfig)         | **1408×768**     |
| native + `imageConfig.imageSize:"2K"`   | **2048×2048** ✅ |

> **关键结论 3**:我们的 new-api **会**把 `imageConfig` 原样转发到 nexaxis(native→native 不做转换,所以 `pass_through_body_enabled=false` 不影响)。**端到端可行**,Channel 17 不用动 type/config。
> 另外:我们 new-api 的 `/v1beta/...:generateContent` customer endpoint 确实存在(bogus key 回 401,非 404)。throwaway token 已删除干净。

---

## 4. 阶段 B — Portal 改动

### 4.1 改了什么

只动两个源文件(+两个测试文件),**不影响** gpt-image-2 / Imagen / 1K 的 Nano Banana:

**`src/lib/image-gen/models.ts`**

- `ImageModelInfo` 加可选字段 `geminiImageSize?: '2K' | '4K'`(= 路由信号)。只标在需要 >1K 的 SKU:
    - `gemini-3.1-flash-image-preview` → `'2K'`
    - `gemini-3-pro-image-preview` → `'4K'`
    - `nano-banana-pro-preview`(3-pro 别名)→ `'4K'`
    - `gemini-2.5-flash-image`(物理上限 1408×768,计费 1K)/ `gpt-image-2` / Imagen → 不设,保持原路径。
- 加 `sizeToAspectRatio(size)`:把 portal 的 `1024x1024 / 1024x1792 / 1792x1024` 映射成 Gemini `1:1 / 9:16 / 16:9`(分辨率由 `imageSize` 控,形状由 `aspectRatio` 控,正交)。

**`src/app/api/portal/image/generate/route.ts`**

- 新增 `fetchViaGeminiNative(args, imageSize)`:打 `${NEWAPI_PROXY_URL}/v1beta/models/{model}:generateContent`,注入 `generationConfig.imageConfig.{imageSize, aspectRatio}`,解析 native `candidates[].content.parts[].inlineData.data`(同时兼容 snake_case `inline_data`)。每次调用返 1 图,`count` 个并发(镜像 chat 路径)。
- `fetchImagesFromUpstream` 顶部:`findImageModel(model)?.geminiImageSize` 命中 → 走 native;否则保持原 chat→images/generations 智能 fallback。
- **2K/4K 模型故意 NOT fallback 到 chat**:chat 只能出 1K,而客户已按 2K/4K 计费 —— 静默降级成 1K 正是要修的 bug。所以 native 失败(含 nexaxis 库存 429)就把错误抛出去(走既有的 quota/content-filter/502 处理),不静默降级。

### 4.2 为什么不在 chat body 里塞参数(brief 的原方案)

brief 的 Phase B 伪代码假设往 chat body 塞 `generationConfig` 就行 —— 阶段 A 证否了:两跳 new-api 的 chat→Gemini 转换器都丢弃 `imageConfig`。而且我们的 new-api 和 nexaxis 是同一套 new-api 软件,chat 路径行为对称(都丢)。所以必须走 native endpoint。

### 4.3 测试

- `src/lib/image-gen/__tests__/models.test.ts`:+6 断言(`geminiImageSize` 三模型正确 / 其它 SKU 不设 / 只用 2K|4K / `sizeToAspectRatio` 映射)。
- `src/__tests__/app/portal-image/generate-route.test.ts`:+5 用例(2K 路由到 native 且 `imageSize=2K`+`aspectRatio=1:1` / 4K 路由 `imageSize=4K`+landscape `16:9`+兼容 snake_case / gpt-image-2 绝不碰 native / 空 candidates 安全过滤→400 content_filter / native 402 quota 透传)。
- `pnpm tsc --noEmit` ✅ 0 错;`pnpm eslint <4 files>` ✅ 0 错 0 警;两文件 **38/38 PASS**。

### 4.4 ⚠️ 顺手修了 3 个**预存**的失败测试(已确认非我引入)

`generate-route.test.ts` 里 3 个 gpt-image-2 用例(happy-path×2 + R2-fail)在本分支 HEAD 上**改动前就已经红**(`git stash` 我的改动后复跑确认:3 failed / 14 passed)。根因是 PR #67 (W8 D7) 把 dispatch 改成 "chat-first → wrong-endpoint fallback" 后,这几个 mock 没跟着更新(chat 调用返回了非 chat 形 body,导致 dispatch 在 fallback 前就 400)。

我把这些 mock 修成"chat 调用返回 `convert_request_failed` wrong-endpoint 信号 → fallback 到 images/generations"(= W8 D7 设计的真实行为)。**必须修**,因为它们失败时会跳过 `fetchSpy.mockRestore()`,污染同文件后续我的用例(我的 4K 用例单跑通过、全跑被污染成 500 —— 修了预存失败后即稳定通过)。

> **建议 operator**:本分支可能在 `main` 上也有这几个红(PR #67 遗留),值得单独跟进。

---

## 5. 全套测试现状(诚实汇报)

`pnpm vitest run` 全套:**131 文件 / 1175 用例 → 1170 pass, 4 fail, 1 skip**。

那 4 个 fail **全部预存、与本次改动无关**(`git stash` 我的 4 个文件后复跑,4 个仍然失败),都在我**没碰**的文件里,源于本分支其它在途未提交的工作(`M src/data/image-models.ts` + landing 永久定价 PR #69/#70):

- `src/__tests__/data/image-models.test.ts` — "default selection is first entry"(`@/data/image-models`,**不是**我改的 `@/lib/image-gen/models`)
- `src/__tests__/components/image/model-selector.test.tsx` — "shows label + ¥ price"
- `src/__tests__/app/landing-page.test.tsx` ×2 — 永久 ¥ 定价行

**本次改动净效果:新增失败 0,顺带修复预存失败 3。**

---

## 6. 部署 + 验证建议(operator)

1. review 分支 `fix/gemini-image-resolution-channel-17`(只改 image gen,不碰定价/渠道)。
2. 部署(手动,CI 不自动部署):
    ```bash
    ssh vps "cd /opt/silkroadai-portal && git pull && docker compose -f docker-compose.prod.yml up -d --build portal"
    ```
3. 部署后真实 smoke(portal `/image` UI 或带 cookie curl):
    - `gemini-3.1-flash-image-preview` 出图 → 存盘 `sips` 量应 ≥ 2048(2K)。
    - `gemini-3-pro-image-preview` 出图 → 应 ≥ 4096(4K)。
    - `gpt-image-2` 仍正常(回归)。
4. **nexaxis 库存注意**:4K 偶发 429 "exceeded your current quota"(它家 Gemini 账号池每日有限,公告写"今日库存已发完")。这会以干净错误抛给客户(不扣费),不会静默降级成 1K。若 429 频繁 → 联系 nexaxis 客服或多配一个 Gemini 上游分摊。

---

## 7. 边界确认(brief 红线)

- ❌ 未改 `ModelPrice` / 定价脚本。
- ❌ 未改 Channel 17 的 base_url / key / type / models。
- ❌ 未 merge 任何 PR。
- ❌ 未影响 Claude / OpenAI / 其它 image model(gpt-image-2 / Imagen / 2.5-flash 路径不变,单测已固化)。
- ❌ 未给客户回话。
- ✅ throwaway 测试 token 已删除;诊断脚本留在本地 `scripts/`(含上游 key,**未提交**,避免泄密)。

---

## 附:本地诊断脚本(未提交,含上游 key)

- `scripts/test-nexaxis-image-resolution.mjs` — 阶段 A 主测(10+ 格式 × 模型)
- `scripts/inspect-nexaxis-response.mjs` — 深挖响应里所有 base64 图(排除多图/缩略图误判)
- `scripts/probe-nexaxis-native.mjs` — native endpoint 字段名探测(找到 `imageSize`)
- `scripts/probe-nexaxis-chat-imagesize.mjs` — chat 路径正确字段名 + native 4K retry
