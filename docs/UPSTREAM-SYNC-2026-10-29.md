# 上游同步合并前报告：2026-10-29（#574 全站中英切换）

**状态：只出报告，尚未合并。** 本报告在 `main -> dev` 之前生成，等 operator 确认第 6 节的三项决定后再合并。截至本报告，没有修改 dev、main、prod，没有 migration、部署或登录 VPS。

## 1. 范围与分支状态（北京时间 2026-10-29 21:52 核对）

- 本批只含一个上游提交：`e7acdafcf62af7b0d874b6acf190fc4c532ca1cc`（#574），即当前 fork `origin/main`。本地 `main` 仍在 `5778304e`（#573），合并时只 fast-forward 到 `e7acdafc`，没有项目自定义提交。
- 官方 `upstream/main` 已前进到 `fa617133`（#575，2026-10-29 17:56:46），不在本批。#575 改 `log-display.ts`、`/api/portal/logs` 及导出、dashboard `sections.tsx`、`usage-aggregate.ts`，处理视频按 token 计费的预扣/结算行，与 dev 的 `f5525351` 语义重叠，需要单独出报告审计。
- 合并前：`dev` = `origin/dev` = `f5525351`；`prod` = `origin/prod` = `68120b4a`。共同基线 `5778304e`，`dev / main` 独有提交 260 / 1。
- 合并前基线：`pnpm test:ci` 391 files / 6310 passed / 1 skipped，全部通过。
- 本次 fetch 时 `~/.gitconfig` 的 GitHub 代理 `127.0.0.1:10808` 不通，单条命令用 `-c` 覆盖为 `7897`，未改配置。

## 2. 提交行为

### 2026-10-27 12:52:48 · `e7acdafc` · #574

标题：`feat(i18n): 全站中英语言切换(cookie locale + LocaleSwitcher,对齐 new-api) (#574)`。squash 提交，144 个文件，+6,990 / −1,619 行，新增 27 个文件。

- 新增 `src/lib/i18n/`：`defineMessages(zh, en)` 由 tsc 校验中英结构一致；服务端 `getLocale()`（React `cache`）按 `portal_locale` cookie → `Accept-Language` → `zh` 解析，无请求上下文时回 `zh`，现有中文 SSR 测试不用改；客户端 `LocaleProvider` / `useMessages`。
- 新增 `<LocaleSwitcher />`（中文 / EN）：写 cookie 后整页 reload，URL 不变。挂在页脚和控制台 header。根 layout 的 `<html lang>` 跟随语言。
- 13 个文案模块（landing / pricing / auth / pay / dashboard / logs / keys / storage / tools / image / chat / reseller / common），覆盖落地页、定价、登录注册找回、充值与支付结果、控制台概览、调用日志、Key、存储设置、工具箱、生图、对话、分销、404/500/loading。页面改为 `generateMetadata`，时间显示用 `intlLocale(locale)` 并保留 `timeZone: 'Asia/Shanghai'`。
- 共享函数加可选 `locale`，省略即中文、输出与原来一致：`formatCny` / `formatCount`（英文用 K/M/B 代替「万」）、`formatCacheTokens`、`sanitizeLogContent`、Key 有效期预设、生图模型 blurb/badge/尺寸/示例提示词。`/api/portal/logs` 的脱敏错误文案跟随语言。
- 不翻译的部分：`/docs` 正文与法律页（英文态显示「中文原文」提示条）、admin / enterprise 控制台、`/v1/*` 协议错误体。模型广场的 vendored i18next 跟随站点语言。旧支付链接 `?lang=en` 仅在支付页优先于 cookie。
- **客户可见变化**：浏览器首选语言不是 `zh*` 的访客，首次访问默认看到英文；爬虫不带 `Accept-Language`，仍是中文。

## 3. 数据库、配置与上线影响

| 项目                              | 影响                                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| migration / schema                | 无                                                                                                                                                                   |
| 环境变量 / 依赖                   | 无新增；`package.json`、lockfile 未变                                                                                                                                |
| Nginx / Cloudflare / Docker       | 无文件变更                                                                                                                                                           |
| 新 cookie                         | `portal_locale`，1 年，`Path=/`，`SameSite=Lax`，非 httpOnly（前端需读写，内容只是语言偏好），仅当前域名                                                             |
| 缓存                              | dev 根 layout 已调用 `headers()`，全站本来就是动态渲染；仓库 Nginx 不缓存 HTML。按 cookie 切换语言不会把一种语言的页面缓存给别人。合并后用 `pnpm build` 的路由表复核 |
| 计费 / 鉴权 / 支付 / new-api 调用 | 不变，只改展示                                                                                                                                                       |

## 4. 与 dev 的冲突预判

`git merge-tree --write-tree dev origin/main` 预演：**62 个文件冲突，共 165 个冲突块**（61 个内容冲突 + 1 个 modify/delete）。范围远大于 `f5525351` 那几个文件。原因是 dev 自基线以来有 260 个提交，其中 2026-07-27 的品牌与控制台改版（`customer-shell`、`portal-sections`、新 sidebar、落地页、定价页）、Key 页重写、docs 正文抽到 `docs-content.tsx`、工具箱首页迁到 `(authenticated)/tools`、品牌常量集中到 `src/lib/public-config.ts`，正好落在 #574 逐行替换文案的同一批文件上。冲突最多的是 `keys-list.tsx` 18、`logs-viewer.tsx` 11、`call-detail-table.tsx` 9、`pricing/page.tsx` 7。

不冲突但必须处理的部分：

1. **上游品牌与客服混入。** 13 个新文案模块会无冲突并入，但全部带上游品牌、域名或客服：`Silk Road AI`、`images.silkroadai.io`、`support@silkroadai.io`，充值求助微信 `lambda_yyh充值`、支付结果页微信 `Globe_Ads`、对话页 `Global_Ads`。照搬会让充值页、支付结果页显示上游的客服微信。合并时一律改为引用 `public-config.ts` 的 `BRAND_NAME` / `SUPPORT_WECHAT` / `SUPPORT_EMAIL` / `IMAGE_CDN_BASE_URL`。生图示例提示词「赛博朋克丝绸之路」是内容，不是品牌，保留。
2. **#574 翻译的是旧文件结构。** dev 概览页实际渲染走 `portal-sections.tsx`，`sections.tsx` 只剩数据加载、横幅和骨架屏，#574 翻译的汇总卡与明细容器在 dev 上已不使用。dev 控制台 header 在 `customer-shell.tsx`，不在 #574 改的 `(authenticated)/layout.tsx`；dev 页脚在控制台路径不渲染，所以切换器要挂到 `customer-shell`，否则控制台里没有切换入口。
3. **dev 新增或改写的中文。** 粗略统计，冲突文件里约 260 条 dev 中文文案不在 #574 的 zh 文案中（Key、落地页、对话、定价、生图工具最多）。dev 替代 #574 已翻译部分的文件（`portal-sections`、`customer-shell`、`(authenticated)/tools`、模型广场外壳和价格单元格、支付页首充横幅）另有约 75 条。
4. **#574 从未覆盖的 dev 页面**（`/gpu`、`docs-content.tsx` 正文约 780 条、admin / enterprise）在英文态仍是中文，属于范围外，与 #574 对 `/docs` 正文的处理一致。

## 5. 冲突处理原则

- 以 dev 文件为基础（结构、样式、行为、品牌），在其上重放 #574 的 i18n 改法；不整文件采用任何一侧。zh 文案以 dev 当前文本为准，dev 现有中文测试断言不变。
- `CLAUDE.md`：保留 dev 全文，只加入 #574 的编码规范「用户可见文案走 i18n messages」，不写入上游进度记录。
- `src/app/layout.tsx`：保留 dev 的 Manrope、`metadataBase`、LLmRoute 标题；采用 `getLocale()` + `LocaleProvider`。删除旧的 `?lang` 分支和 `data-pathname`：它们读的 `x-search` / `x-pathname` 头在仓库里没有任何地方设置，一直是空值。
- `src/app/tools/page.tsx`（dev 删、上游改）：保留删除，dev 的工具箱首页在 `(authenticated)/tools/page.tsx`。
- `src/app/docs/page.tsx`：保留 dev 的薄包装；英文提示条和 `generateMetadata` 放进 `docs-content.tsx`，`/docs` 与 `/workspace/docs` 共用。
- `plaza-island.tsx`：保留 dev 的 `embedded` 参数，加入 #574 的 i18next 跟随语言。
- 测试：#574 新增和修改的测试全部保留；只按 dev 的真实品牌、文案和结构调整断言（如 `Silk Road AI` → `LLmRoute`），不删除、不放宽英文断言，逐项记入合并后审计。

### `f5525351` 视频退款显示（按 brief 原样保留）

- 行为不变：结算退款、配不上预扣行的失败退款都是负金额独立行；配上的失败视频预扣行显示「失败」¥0；金额写作 `-¥0.05`；CSV 消耗列统一 4 位小数。
- 文案单一来源：在 `logsMessages` 新增 `refunds` 段，含「结算退款」「失败退款」「结算说明」「退款说明」四个标签、失败退款说明句，以及配不上预扣行、结算退款两个带金额的句子函数，中英各一套。`log-display.ts` 已依赖 `logsMessages`，dashboard、调用日志页、API 路由共用。`FAILED_VIDEO_REFUND_NOTE` 与 #574 的 `dashboardMessages.usage.videoRefunded` 是同一句，合并到 `refunds` 段，删除 dashboard 里的重复项。
- 服务端拼的句子按 #574 的机制出英文：`/api/portal/logs` 用 `getLocale()`；概览页 `page.tsx` 取 locale 传给 `loadUsageData`。`refundLabel(result, locale)` 和句子函数的 `locale` 默认 `zh`，现有中文断言不变。
- 金额格式：`formatSignedCny` 继续用 `zh-CN` 数字分组，中英显示相同。

## 6. 需要 operator 确认的三项决定

1. **英文覆盖范围。** 推荐 A：给冲突文件和 dev 替代文件里的 dev 文案补英文（约 300 条），让 #574 已做成双语的页面在 dev 上也完整。B：只合 #574 原有文案和 `f5525351` 的四条，dev 改写的文案在英文态保持中文，同一页会中英混排，概览页正文和控制台 header 仍是中文。
2. **首次访问的默认语言。** 推荐沿用 #574：按浏览器 `Accept-Language`。后果：浏览器是英文的现有客户，合并上线后首次进入会看到英文控制台，`/models` 广场价格单元格之外的范围外页面和文档正文仍是中文。另一选择：默认一律中文，只有点切换才变英文；现有客户体验完全不变，但偏离上游。
3. **CSV 导出 `/api/portal/logs/export`**（#574 未改）。推荐保持全中文，对账文件格式稳定。另一选择：表头、结果列、详情一起跟随站点语言（约 20 条）。brief 要求的服务端说明句出英文，在调用日志页和概览页按 #574 机制实现，不受此项影响。

## 7. 合并后验证计划

- 合并在独立 worktree 进行，验证通过后再 fast-forward 本地 `dev`，共享工作区不会长时间停在冲突状态。
- `pnpm typecheck`、`pnpm test:ci`（对照基线 391 / 6310 / 1 skipped）、`pnpm -s exec eslint --ignore-pattern '.claude/**' .`、改动文件 `prettier --check`；另跑 `pnpm build` 看路由表。
- 品牌扫描：`git grep` 客户可见文案中不再出现 `Silk Road`、`silkroadai.io`、上游客服微信；`X-Silkroadai-*` 头与 `silkroadai` 元数据命名空间按 CLAUDE.md 保留。
- `f5525351` 原有测试全部通过；为四个标签和两个服务端句子补英文断言。
- 只推 `origin/dev`；不动 prod，不部署。合并后在本报告追加三方取舍与实际结果。

## 8. 实际合并结果（2026-11-02，北京时间）

operator 已确认采用第 6 节推荐方案：

- dev 改写/新增的客户文案补齐英文；首次访问按 `Accept-Language`，并由 `portal_locale` cookie 持久化；CSV 保持中文。
- `MERGE_HEAD=e7acdafcf62af7b0d874b6acf190fc4c532ca1cc` 的 62 个冲突路径已逐一处理，未保留冲突标记；`tools/page.tsx` 继续删除，工具箱使用 `(authenticated)/tools/page.tsx`。
- 业务语义以 dev 为准：保留 LLmRoute customer shell、动态模型/价格目录、Key 额度/到期与失效状态、视频退款两类负金额行、失败退款配对、固定 API 路径和现有品牌配置。上游 i18n 的消息模块、LocaleProvider、Cookie/Accept-Language 解析和页面级英文覆盖按冲突文件重放。
- 日志退款语义保持：结算退款独立负金额行；配不上预扣的失败退款独立负金额行；配上的失败退款将预扣行改成失败且金额 ¥0；CSV 对账格式保持中文。
- 生产兼容：无 migration、无 API/Nginx/Cloudflare/Docker 变更；新增开发依赖 `eslint-plugin-react-hooks`，并将本地 `.claude/**` 工作目录加入 ESLint 忽略。没有修改 new-api 源码、渠道、价格或生产环境。

三方语义审计按文件类别完成：

| 文件类别 | dev 基线语义 | 上游语义 | 最终选择 |
| --- | --- | --- | --- |
| dashboard / portal-sections / call-detail / usage loader | LLmRoute 账户卡、热门模型、调用明细、视频退款与固定金额格式 | 旧结构的 i18n 文案与语言上下文 | 保留 dev 结构和退款/计量行为，接入 dashboard messages 与 locale-aware formatting |
| logs viewer / `/api/portal/logs` / export | 过滤、脱敏、失败配对、结算/失败退款分类 | 全站英文过滤器、状态、脱敏文案 | 保留 dev refundKind/配对/CSV 语义，接入 logs messages；CSV 仍中文 |
| keys / pricing / models | 动态拓扑、专属倍率、Key 额度/到期、LLmRoute URL | 上游旧版页面结构与英文 messages | 保留 dev 数据与路由结构，接入对应 messages；不采用上游旧硬编码价格或公共 URL |
| auth / pay / reseller / storage / tools / image | LLmRoute 品牌、客户路由、现有功能入口 | 上游中英文页面文案与 metadata | 保留 dev 行为和链接，采用双语消息并替换上游品牌/客服 |
| docs / legal / admin / enterprise | docs-content、法律和控制台现有结构 | 上游公共文档外壳及语言提示 | 保留 docs-content 与 LLmRoute URL；正文/法律/管理端范围仍按报告规定不翻译 |
| tests | dev 既有行为断言 | #574 新增英文回归 | 保留上游回归场景；仅将旧品牌、已删除 GPU、workspace 路由和 dev 结构差异改为当前契约 |

验证结果：

- `corepack pnpm test:ci`: **400 files / 6404 passed / 1 skipped / 0 failed**。
- `corepack pnpm typecheck`: 通过。
- `corepack pnpm lint`: 通过，0 errors；保留既有 warnings。
- 改动文件 Prettier 检查：通过；`git diff --check`：通过。
- `corepack pnpm build`: 通过，Next 路由表生成成功。构建仅提示项目主目录存在误创建的 `/Users/elon/pnpm-lock.yaml`，不属于应用代码；构建未部署。
- 当前 merge 尚未提交、未推送、未进入 prod，未登录 VPS。
