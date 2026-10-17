/**
 * 按张计费图片上游注册表(W10 image2 适配器)。
 *
 * 每个 provider = 一条 new-api 渠道(OpenAI 型),Base URL 指到
 * `https://portal.silkroadai.io/image-adapter/<provider>`,渠道 Key 填【真实上游的 key】——
 * 适配器把 new-api 带来的 Authorization 原样透传给真实上游,portal 不存上游凭据。
 *
 * 新增零散上游 = 这里加一行(OpenAI-images 兼容上游只需 baseUrl + brand)。
 */

export interface ImageProvider {
    /** 真实上游 base(不含 /v1),适配器拼 `${baseUrl}/v1/images/{generations|edits}`。 */
    baseUrl: string;
    /** 错误脱敏:出现在客户可见错误体里要抹掉的品牌名。 */
    brand: RegExp;
    /** true = 跳过盈利档/形状守门,放行【所有】可解析尺寸(仍要求 size 可解析)。
     *  用于"官方账单"上游(we-token 系):azure 直连对几乎所有非标准尺寸超收 5~229%,客户对不上
     *  官方计算器 → 全量走适配器合成官方 usage。默认(缺省)= 走 isProfitable/isElongated 守门。 */
    openAllTiers?: boolean;
    /** 自定义守门线(合成售价 token 数,≥ 放行)——设了此值走【纯盈利档】守门,**不带**狭长放行条款
     *  (2026-08-24 起兜底线全是 openAllTiers 官方账单上游,狭长图落下去照样拿官方账单,狭长条款
     *  已无账单意义,只会把亏钱的狭长低档放进来)。缺省 = 旧守门(MIN_SYNTH_CT 3,846 + 狭长放行),
     *  存量 provider 行为不动。 */
    gateMinCt?: number;
    /** 上游模型名覆盖:适配器默认给上游送 `model: "gpt-image-2"`;个别上游账号只认自家变体名
     *  (frimodel 新账号只挂 `gpt-image-2-high` / `gpt-image-2-adobe`)→ 在这里指定。 */
    upstreamModel?: string;
    /** 质量档守门:设了此值 → 只接归一后 quality 在列表内的请求(任意尺寸,含 size=auto,
     *  计费:显式 size 按请求尺寸 / auto 按返回图实际尺寸),其余 503 让路。与 openAllTiers / gateMinCt 互斥使用
     *  (onlyQualities 优先)。注意 normQuality 把 auto/standard/缺省归一成 low ——
     *  "所有 medium 请求" = 客户显式传 quality=medium 的请求。 */
    onlyQualities?: ReadonlyArray<'low' | 'medium' | 'high'>;
    /** true = 该上游【未验证/不支持】`background:"transparent"` → 带此参数的请求直接 503 让
     *  new-api failover 到支持透明的渠道(调上游之前拒,不花钱)。动机(2026-08-26 客户实测):
     *  不支持的上游会 200 返回【画进像素里的假棋盘格】(rgb24 无 alpha),客户拿到废图还被计费,
     *  比失败更糟 —— fail-closed:未逐家验证真出 alpha 之前一律拒,验证通过再翻开关。
     *  缺省(false)= 上游支持透明,参数经 FORWARD_EXTRAS 正常透传。 */
    noTransparentBackground?: boolean;
    /** 单次上游调用的超时(ms)。缺省 = adapter.ts 的 DEFAULT_UPSTREAM_TIMEOUT_MS(600s,与 Caddy 3010 /
     *  undici 各层对齐)。给【会挂死不回头】的上游单独调短:we-token 三条线(2026-09-10 实证,见 memory
     *  reference_image_504_600s_wetoken_hang)阵发性对 5-10% 请求 600s 不回响应头 → 我方三层 600s 同时到点,
     *  客户等满 10 分钟拿错误且 new-api 来不及换渠道。降到 300s = 挂死请求 5 分钟后 503 让 new-api failover
     *  到 ch186/208 等出图;代价是 we-token 侧 >300s 才成功的那 0.2%(当日 p99 203s / p99.9 390s)被误杀重跑。
     *  只按 provider 覆盖,别改全局缺省(2026-08-23 300→600 是为 n>1 大图客户改的,其他上游要留 600)。 */
    upstreamTimeoutMs?: number;
    /** 显式尺寸白名单(`WxH` 字符串)。设了名单的上游【只收】名单内的显式 size;名单外的显式尺寸、
     *  `size=auto` 与缺省一律 503 让路给别的渠道(调上游之前拒,不花钱)。给「只支持固定尺寸表」的上游用
     *  (pixellelabs:厂商确认只支持 10 比例 × 1K/2K/4K 共 30 个尺寸,其余会被静默改尺寸交付)。
     *  缺省(undefined)= 不按名单守门,沿用 openAllTiers / gateMinCt / onlyQualities 原有规则。 */
    sizes?: ReadonlyArray<string>;
    /** 发给上游的 quality 替换表(按归一后的请求档 → 上游档)。只改【发给上游的 body】;计费(synthUsage 按
     *  客户请求档合成官方账单)与响应回显(`quality` 字段)仍用客户请求档。给「某档上游不兑现、但 operator
     *  决定照常承接」的线用(pixellelabs:high 在上游静默等于 medium,2026-10-09 operator 拍板 high 用 medium
     *  替代、响应仍显示 high)。缺省 = 原样透传。 */
    upstreamQuality?: Partial<Record<'low' | 'medium' | 'high', 'low' | 'medium' | 'high'>>;
    /** 上游不是 OpenAI 同步形而是【异步任务】(提交拿任务 id → 轮询取图)时声明;缺省 = 同步直转。
     *  只影响声明了它的 provider:adapter.callUpstreamOnce 看到该字段才走 submit+poll 分支,其余 provider 路径不变。
     *  (与 @/lib/image-adapter25 的同名接口语义一致,两模块独立不共享。) */
    transport?: AsyncTaskTransport;
}

/** 异步任务形上游的传输描述(2026-10-15 为 suduma 引入)。提交与轮询都带 new-api 透传来的 Authorization。 */
export interface AsyncTaskTransport {
    kind: 'async-task';
    /** 提交路径(POST JSON,参考图/蒙版以 data URL 塞进 body `image` / `mask`),缺省 /v1/images/generations。 */
    submitPath?: string;
    /** 轮询路径,`{id}` 占位符替换成提交响应里的任务 id。 */
    pollPath: string;
    /** 提交响应里任务 id 的字段名。 */
    idField: string;
    /** 轮询间隔(ms)。 */
    pollIntervalMs: number;
    /** 从提交起算的最长等待(ms),超时视为上游失败 → failover。要留在 Caddy :3010 600s 之下。 */
    maxWaitMs: number;
    /** 拉取结果图 url 时附加的请求头(如图床要求浏览器 UA,否则 403)。 */
    imageFetchHeaders?: Record<string, string>;
}

/** we-token 系上游的单次调用超时(见 ImageProvider.upstreamTimeoutMs)。 */
export const WETOKEN_UPSTREAM_TIMEOUT_MS = 300_000;

/** pixellelabs 厂商确认的全部支持尺寸(2026-10-09 operator 与上游沟通所得):10 比例 × 1K/2K/4K。
 *  每一条都在官方约束内(16 倍数、最长边 ≤3840、比例 ≤3:1、像素 ∈ [655,360, 8,294,400]),但官方是约束集不是
 *  枚举表,这里只是官方合法尺寸的一个 30 点子集。 */
/** suduma 2.0 实测【如实交付】的尺寸(2026-10-15):1024² / 1536×1024 / 1024×1536 / 2048² / 1280×720(edits)+ 文档列出的
 *  2048×1152(4K 请求被降到的原生尺寸)。其余(1344×1008 / 2880² / 4K / 1000×1000 / auto)上游静默降级或改尺寸 → 让路。 */
export const SUDUMA_SIZES: ReadonlyArray<string> = [
    '1024x1024',
    '1536x1024',
    '1024x1536',
    '2048x2048',
    '2048x1152',
    '1280x720',
];

export const PIXELLELABS_SIZES: ReadonlyArray<string> = [
    // 3:1 / 21:9 / 16:9
    '1536x512',
    '3072x1024',
    '3840x1280',
    '1344x576',
    '2688x1152',
    '3840x1648',
    '1280x720',
    '2048x1152',
    '3840x2160',
    // 3:2 / 4:3 / 1:1
    '1152x768',
    '2304x1536',
    '3520x2352',
    '1024x768',
    '2048x1536',
    '3312x2480',
    '1024x1024',
    '2048x2048',
    '2880x2880',
    // 3:4 / 2:3 / 9:16 / 1:3
    '768x1024',
    '1536x2048',
    '2480x3312',
    '768x1152',
    '1536x2304',
    '2352x3520',
    '720x1280',
    '1152x2048',
    '2160x3840',
    '512x1536',
    '1024x3072',
    '1280x3840',
];

export const IMAGE_PROVIDERS: Record<string, ImageProvider> = {
    // ominiapi:1k/2k/4k 统一 ¥0.1/张 → 只值得接 4K 全档 + 2K-high(守门在 adapter.ts)
    // 2026-08-14:上游端点 www. → api.(api. 连接更快;www 仍活,非强制迁移)。
    // 透明背景:支持(2026-08-26 ominiapi 平台实测真 RGBA,54% 采样像素 alpha<250;两账号同平台)。
    ominiapi: { baseUrl: 'https://api.ominiapi.com', brand: /\bomini(?:api)?\b/gi },
    // codexvip:同源 Adobe Firefly 转售(usage_source=adobe2api,出图带 Firefly C2PA →
    // stripAdobeImageMetadataB64 自动剥),¥0.06/张(比 ominiapi 便宜)。与 ch154 同 prio 分流承压。
    codexvip: {
        baseUrl: 'https://subdirect.aicodexvip.top',
        brand: /\b(?:aicodexvip|aicodex|codexvip|adobe2api)\b/gi,
        noTransparentBackground: true, // 未验证真出 alpha(2026-08-26),验证通过再翻
    },
    // wetoken(us-la.we-token.cc)= ch153 那条 US 线上游;wetokenasia(asian-acc.we-token.cc)= ch83 上游。
    // 两条都是 adobe Firefly 转售,直连按【面积刻度】超收(非标准尺寸 +5~229%,客户对不上官方计算器)。
    // 2026-08-15 operator 拍板 ch83+ch153 全量走适配器 → openAllTiers 放行所有尺寸、合成官方 usage → 官方
    // 标准账单可对账。key 由各自 new-api 渠道透传(代码不存)。C2PA 由 proxy 剥。
    // 透明背景:未验证(2026-08-26 探测时 adobe 全线故障 502,带不带参数都挂,分不清)→ fail-closed
    // 先拒,上游恢复后用 scratchpad probe-transparent.py 重探,真出 alpha 再翻三条 we-token 的开关。
    // 超时 300s(2026-09-11,#PR):we-token 两 host 都会阵发性挂死不回头,600s 等满 = 客户 10 分钟超时。
    wetoken: {
        baseUrl: 'https://us-la.we-token.cc',
        brand: /\bwe-?token\b|\badobe\b|\bfirefly\b/gi,
        // 2026-09-13 operator 拍板:we-token 两线(ch176/177)只收 low/medium,high 503 让路给别的渠道。
        // 原 openAllTiers(全量官方账单)改成 onlyQualities —— 尺寸仍任意(含 size=auto),计费仍按返回图
        // 实际尺寸合成官方账单;只是 high 档不再打这两条线。注意 gate 代码里 openAllTiers 会整体跳过守门,
        // 两者不能并存,这里必须去掉 openAllTiers 才会生效。
        onlyQualities: ['low', 'medium'],
        noTransparentBackground: true,
        upstreamTimeoutMs: WETOKEN_UPSTREAM_TIMEOUT_MS,
    },
    wetokenasia: {
        baseUrl: 'https://asian-acc.we-token.cc',
        brand: /\bwe-?token\b|\badobe\b|\bfirefly\b/gi,
        // 2026-09-13 operator 拍板:we-token 两线(ch176/177)只收 low/medium,high 503 让路给别的渠道。
        // 原 openAllTiers(全量官方账单)改成 onlyQualities —— 尺寸仍任意(含 size=auto),计费仍按返回图
        // 实际尺寸合成官方账单;只是 high 档不再打这两条线。注意 gate 代码里 openAllTiers 会整体跳过守门,
        // 两者不能并存,这里必须去掉 openAllTiers 才会生效。
        onlyQualities: ['low', 'medium'],
        noTransparentBackground: true,
        upstreamTimeoutMs: WETOKEN_UPSTREAM_TIMEOUT_MS,
    },
    // ---- 2026-09-16 operator:asian-acc 拆三条【按档专线】(low/medium/high 各一条独立渠道)----
    // 上游 asian-acc(we-token,Adobe Firefly 转售)对 gpt-image-2 暴露三个【专用档位模型名】
    // gpt-image-2-low / -medium / -high,按档【按次】收费(2026-09-16 实测三名都有效、均 Adobe、1024²)。
    // 每条 provider:upstreamModel 钉一个档位名 + onlyQualities 守同档 —— 客户显式该 quality 才走这条,
    // 别档 503 让 new-api failover 到对应档渠道(与 frimodellow/frimodelmedium 同款,upstreamModel+onlyQualities
    // 组合已验证)。计费仍按适配器官方公式(按客户请求 quality 合成),与上游按次档价无关。C2PA 由适配器
    // 按内容剥(Adobe → 剥)。透明未验证 → fail-closed 拒。超时 300s(we-token 阵发挂死,同 wetoken/wetokenasia)。
    // 与旧 wetokenasia(low/medium 合并线,ch176)并存:operator 决定停不停旧渠道,代码保留不删避免 ch176 503。
    wetokenasialow: {
        baseUrl: 'https://asian-acc.we-token.cc',
        brand: /\bwe-?token\b|\badobe\b|\bfirefly\b/gi,
        upstreamModel: 'gpt-image-2-low',
        onlyQualities: ['low'],
        noTransparentBackground: true,
        upstreamTimeoutMs: WETOKEN_UPSTREAM_TIMEOUT_MS,
    },
    wetokenasiamedium: {
        baseUrl: 'https://asian-acc.we-token.cc',
        brand: /\bwe-?token\b|\badobe\b|\bfirefly\b/gi,
        upstreamModel: 'gpt-image-2-medium',
        onlyQualities: ['medium'],
        noTransparentBackground: true,
        upstreamTimeoutMs: WETOKEN_UPSTREAM_TIMEOUT_MS,
    },
    wetokenasiahigh: {
        baseUrl: 'https://asian-acc.we-token.cc',
        brand: /\bwe-?token\b|\badobe\b|\bfirefly\b/gi,
        upstreamModel: 'gpt-image-2-high',
        onlyQualities: ['high'],
        noTransparentBackground: true,
        upstreamTimeoutMs: WETOKEN_UPSTREAM_TIMEOUT_MS,
    },
    // wetokengated:同 us-la.we-token.cc 上游,但【不带 openAllTiers】→ 走盈利档+狭长守门(= ch154/ominiapi
    // 那套)。给 ch175 用:让它只接狭长/盈利档,方图低档/auto 拒 → 走 ch176/ch177。2026-08-15 operator 指定。
    wetokengated: {
        baseUrl: 'https://us-la.we-token.cc',
        brand: /\bwe-?token\b|\badobe\b|\bfirefly\b/gi,
        noTransparentBackground: true,
    },
    // ---- 2026-08-21 operator 新接两家【全量】上游,给 ch176/ch177 那条全量线扩容 ----
    // ominiapifull:ominiapi 平台【另一个账号的 key】(与上面 gated 的 `ominiapi` 是两条独立渠道,别混),
    // 端点用 operator 给的 www.(api. 同样 200,留 www 以免与另一账号的线路混淆)。同为 Firefly 转售:
    // 直连 b64_json 生效,出图带 adobe/firefly C2PA(proxy 回程剥)。openAllTiers = 全量接、合成官方 usage。
    // 透明背景:支持 ✅(2026-08-26 实测本账号:1024² RGBA、54% 采样像素透明,真 alpha 非假棋盘格)。
    ominiapifull: { baseUrl: 'https://www.ominiapi.com', brand: /\bomini(?:api)?\b/gi, openAllTiers: true },
    // frimodel:new-api 型网关,**API host 是 api.frimodel.com**(operator 给的 platform. 是控制台,
    // nginx 对 /v1/* 恒 403)。同为 Adobe Firefly 转售。契约差异:generations【无视 response_format】恒返
    // 预签名 S3 url(适配器 url→b64 兜底拉回,绝不外泄),edits 才直接给 b64;size/quality 均如实生效。
    frimodel: {
        baseUrl: 'https://api.frimodel.com',
        brand: /\bfri-?model\b|\bfirefly\b|\bs3-accelerate\.amazonaws\.com\b/gi,
        openAllTiers: true,
        noTransparentBackground: true, // 未验证真出 alpha(2026-08-26),验证通过再翻
    },
    // frimodelmedium:frimodel 平台【新账号】(2026-08-27 接入,与上面老账号 key 不同、模型编排不同:
    // 只挂 gpt-image-2-high / gpt-image-2-adobe 两个变体名,不认裸 gpt-image-2 → upstreamModel 覆盖)。
    // 实测契约:尺寸分毫不差(1024²/4K 均精确)、generations 直返 b64、edits 恒返 Firefly S3 预签名
    // url(url→b64 兜底接住)、quality 参数上游钉死 medium 刻度、透明不支持(colortype=2 假图)。
    // 守门:onlyQualities=['medium'] —— operator 2026-08-27 拍板【所有 medium 请求】走这条(任意
    // 尺寸含 auto);low/high/auto(→low)503 让路。客户按 medium 计费。
    // 模型名用 -adobe:上游明确建议(稳定线);-high 实测契约相同(quality 同样钉死 medium 刻度),
    // 要换回改 upstreamModel 一行。
    frimodelmedium: {
        baseUrl: 'https://api.frimodel.com',
        brand: /\bfri-?model\b|\bfirefly\b|\bs3-accelerate\.amazonaws\.com\b/gi,
        upstreamModel: 'gpt-image-2-adobe',
        onlyQualities: ['medium'],
        noTransparentBackground: true, // 实测 colortype=2 假图(2026-08-27)
    },
    // frimodellow:frimodel 平台【第三个账号】(2026-08-28 接入,挂 low/adobe/medium/high 四变体)。
    // 守门:onlyQualities=['low'] —— operator 拍板【所有 low 请求】走这条;注意 normQuality 把
    // auto/standard/缺省也归一成 low,所以这条线承接的是 low + auto + 缺省的全部流量(占比最大)。
    // upstreamModel=gpt-image-2-low(上游指定)。契约按 frimodel 家族推定(-adobe 同 key 实测:
    // adobe C2PA、尺寸如实、b64 直返);⚠️ 接入当天 -low 线路上游侧 500 do_request_failed
    // (同 key -adobe 正常 → 是它家 low 上游断,非账号问题),渠道先建停用,上游修好再开。
    frimodellow: {
        baseUrl: 'https://api.frimodel.com',
        brand: /\bfri-?model\b|\bfirefly\b|\bs3-accelerate\.amazonaws\.com\b/gi,
        upstreamModel: 'gpt-image-2-low',
        onlyQualities: ['low'],
        noTransparentBackground: true, // frimodel 家族实测不出真 alpha
    },
    // frimodelhigh:frimodel 平台【第四个账号】(2026-09-20 接入,key sk-VUVYjx…,组 gpt_image_adobe)。
    // 2026-09-20 实测:裸 gpt-image-2 与字面 -high 均【不可用】(前者 no-channel,后者 400
    // "Invalid free model: gpt-image-high" —— 此号 -high 路由坏);真高质量档在 **gpt-image-2-adobe**
    // (1024² up_out=7024=官方 high 刻度、1536×1024 尺寸分毫不差、Firefly S3 预签名 url 交付,
    // url→b64 兜底从 server2 拉回 200)。同 frimodel 家族 = Adobe Firefly 底(pre-signed-firefly-prod
    // S3、C2PA present)→ C2PA 由适配器层按内容剥(#440)、错误/回显/JPEG 亦下沉,不外泄。
    // 守门 onlyQualities=['high']:只接客户显式 quality=high,其余 503 让路。透明 fail-closed。
    // 计费按适配器官方 high 公式(按返回图实际尺寸合成),不取上游 usage。
    // ⚠️【已知瞬时特征】共享 "10k pool":高负载时偶发 503 "pool upstream unavailable" / 429
    //   "Upstream rate limit reached"(非确定性、非按尺寸),做兜底守门线可接受,别设唯一主力。
    frimodelhigh: {
        baseUrl: 'https://api.frimodel.com',
        brand: /\bfri-?model\b|\bfirefly\b|\bs3-accelerate\.amazonaws\.com\b/gi,
        upstreamModel: 'gpt-image-2-adobe',
        onlyQualities: ['high'],
        noTransparentBackground: true, // frimodel 家族实测不出真 alpha
    },
    // frimodeladobe2:frimodel 平台【第五个账号】(2026-10-13 接入,key sk-j3DN…,组 gpt_image_adobe2)。
    // 2026-10-13 server2 直打 18 发 16 个 200 实测:`/v1/models` 只有 gpt-image-2-adobe / -low / -medium
    // (裸 gpt-image-2 → 503 model_not_found);三个名都走 gpt-image-2-adobe 即可(quality 参数上游认)。
    // 【与 frimodel 前四号不同】出图是【真 OpenAI 字节】:16/16 C2PA issuer `OpenAI OpCo, LLC`、
    // softwareAgent `API`(OpenAI Media Service API),raw 零 adobe/firefly —— Adobe 中转原样转发 OpenAI
    // (同 qimg 2.5-flare / yobox 2.0 一类);但图床仍是 Firefly S3 预签名 url(generations / edits 都恒返 url,
    // 无视 b64)→ url→b64 兜底拉回,brand 抹 firefly / s3-accelerate。C2PA 按内容剥:OpenAI 签名原样保留。
    // 档位:high 静默降 medium(回显 medium、usage 1756;4K 记 3336)、三档单发延迟一样(46–54s)→
    // 【只放 low/medium】,high 503 让路给真 high 线;xhigh 上游 400。尺寸 1024²/1536×1024/2048²/4K 全如实
    // (4K 242s);auto → 1536×1024;1000×1000 不 400 出 992²(入口尺寸校验靠适配器);webp 被忽略返 PNG;
    // n 原生 honor(n=2 真返 2 张,2.0 适配器仍扇出单图,无影响);edits multipart 通;4 并发 1K 延迟 85s。
    // 透明 → 上游 400 "Transparent background is not supported for gpt-image-2" → noTransparentBackground。
    // 【计费 = 按张一口价 $0.054】(7 单逐单账单差分全 5.4 美分,与档位/尺寸/edits 无关):对官方 $30/M
    // low 9.2×(亏)/ medium 1024² 1.02× / 2048² medium 0.5× / 4K medium 0.54× —— medium 大尺寸最划算。
    // 共享 frimodel "10k pool",偶发 503/429 由 new-api failover 兜(本次 18 发零 5xx)。
    frimodeladobe2: {
        baseUrl: 'https://api.frimodel.com',
        brand: /\bfri-?model\b|\bfirefly\b|\bs3-accelerate\.amazonaws\.com\b/gi,
        upstreamModel: 'gpt-image-2-adobe',
        onlyQualities: ['low', 'medium'],
        noTransparentBackground: true, // 2026-10-13 实测上游 400 不支持
    },
    // pandatk:Adobe Firefly 转售(2026-08-28 接入,claim=Adobe_Firefly + Adobe 全证书链,C2PA 由
    // proxy 回程剥)。实测契约:认裸 gpt-image-2、b64 直返、【尺寸全如实】(1024²/1536×1024/2048²/
    // 2560×1440/4K 逐像素精确)、quality 钉死 medium 刻度(记账恒官方 medium 公式 ±1)、41-67s。
    // openAllTiers 全量线(operator 拍板),与 ch186 同 prio 并排分流;透明未验证 → fail-closed 拒。
    pandatk: {
        baseUrl: 'https://api.pandatk.com',
        brand: /\bpandatk\b|\bfirefly\b/gi,
        openAllTiers: true,
        noTransparentBackground: true,
    },
    // revehigh:reve.amlkcloud.top(amlkcloud 家,2026-09-20 接入)—— gpt-image-2 的【high 专线】。
    // 2026-09-20 实测:认裸 gpt-image-2、【尺寸全如实】(1024²/1536×1024/2048²/2880²/3840×2160 逐像素
    // 精确,不降级)、high 比 low 细节更足(184 vs 133KB)、17-26s。输出【JPEG】(非 PNG):≤2K 直返 b64、
    // 2880²+4K 走 img.dengche.cc CDN 的 url(适配器 url→b64 拉回;⚠️ 该 CDN 挡 Python-urllib UA 但放行
    // node undici → 适配器 fetch 200 实测通,无需改 UA)。无可读 C2PA、无 adobe/OpenAI 签名 → 无泄漏、
    // 无需剥。守门 onlyQualities=['high']:只接客户显式 quality=high,其余 503 让路。透明 fail-closed
    // (JPEG 无 alpha 通道)。计费仍按适配器官方 high 公式(按返回图实际尺寸合成)。
    // 【已知特征】输出恒 JPEG —— 客户请求默认(png)也拿 JPEG;适配器不转 jpeg→png(只 png→jpeg)。
    revehigh: {
        baseUrl: 'https://reve.amlkcloud.top',
        brand: /\bamlkcloud\b|\bdengche\b|\breve\b/gi,
        onlyQualities: ['high'],
        noTransparentBackground: true,
    },
    // revefull:reve.amlkcloud.top 同一上游 + 同一 key 的【全量】线(镜像 revehigh,openAllTiers)。
    // 2026-09-23 实测(dump JPEG 段核实):low/medium/auto 出图【带 C2PA,但 claim_generator=`OpenAI
    // Media` / `org.contentauth.c2pa`,APP11 段内零 adobe/firefly】—— 这与【真 gpt-image 官方出图自带
    // 的内容凭证一致,不是外泄他家上游身份】,故内容自定向剥离(#440,只在命中 adobe/firefly 时剥)
    // 正确【放行】,客户拿到的 C2PA 与官方一致。若该混合池某张真带 adobe,strip 无条件跑仍会剥。
    // ⚠️【low/medium 大尺寸静默降级】:low 1536×1024 → 实交 1264×848、medium 2048² → 实交 1536²
    // (high 档才尺寸全如实);⚠️ 2026-09-27 起显式 size 改按【客户请求尺寸】计费(对齐官方计算器),
    // 这类降级 = 卖小图收大图钱,只在 auto 路径仍按返回图实际尺寸(imageDimensions 解 JPEG SOF)。输出恒 JPEG(≤2K b64 / 大图走 img.dengche.cc CDN url→b64)。
    // 透明 fail-closed(JPEG 无 alpha)。brand 多兜 firefly 纯防御(实测无,防未来漂移到 adobe 时文案泄漏)。
    revefull: {
        baseUrl: 'https://reve.amlkcloud.top',
        brand: /\bamlkcloud\b|\bdengche\b|\breve\b|\bfirefly\b/gi,
        openAllTiers: true,
        noTransparentBackground: true,
    },
    // ---- oaidist/oaidistfull(ch201/ch202)守门 + 全量线 ----
    // 【上游变迁史】2026-08-24 首接 64.32.31.178:3009 是真 OpenAI 签名;2026-09-06 复测该上游【静默
    // 变成 Adobe Firefly】(见 memory image2 project + ch83-adobe-c2pa-image-leak,上游会偷偷换后端)。
    // 2026-09-07 operator 换上游到 llmway.ai(新 key,渠道 key 字段更新):实测真 OpenAI 签名(OpenAI
    // OpCo 证书链,无 adobe)、quality 三档真分档(low/medium/high 画质递增,high 质量本批最佳)、
    // 尺寸如实、速度最快(23-29s)。slug 名保留 oaidist/oaidistfull(渠道 base_url 路径不变),只换 baseUrl+key。
    // C2PA 由适配器层统一按内容剥(#440)—— 上游身份再漂移也不漏,故不追签名变化。
    // 守门:gateMinCt 1,756(¥0.06/张 保本线)= 1024² medium 起放行、1280×1024 medium(1,510)及以下拒。
    // 计费按【客户请求尺寸】合成(2026-09-27 起,adapter.ts 全 provider 通用;auto 按返回图实际尺寸)。brand 兜 llmway +
    // 通用 distributor 词(+ 旧 IP,历史兜底无害)。
    oaidist: {
        baseUrl: 'https://llmway.ai',
        brand: /\bllmway\b|\bdistributor\b|64\.32\.31\.178/gi,
        gateMinCt: 1_756,
    },
    // oaidistfull:oaidist 同一上游、同一 key 的【全量】线(镜像 wetokengated/wetoken 双线玩法):
    // openAllTiers 放行所有档位含 size=auto,合成官方 usage 兜住被守门线拒下来的低档/auto 流量。
    oaidistfull: {
        baseUrl: 'https://llmway.ai',
        brand: /\bllmway\b|\bdistributor\b|64\.32\.31\.178/gi,
        openAllTiers: true,
    },
    // ---- junze / junzestable(钧泽 API,ai.junze.me)2026-09-24 接入,【紧急备用线】----
    // 定位:operator 2026-09-24 拍板 —— 两条渠道【先建停用】(status=2),只在现有 image2 主力线
    // (ch176/177/178/186/201/202 等)全挂时手工启用兜底。因此【不设 gateMinCt 守门线】:备用线的
    // 价值是"什么都能接住",宁可低档亏钱也不能把客户请求拒成 503 —— 同 ominiapifull / oaidistfull /
    // pandatk 那批 openAllTiers 兜底线的定位。启用期间低档是亏的(见下方成本表),按天盯着,主力恢复即停。
    //
    // 【成本】按张固定,与 size / quality / 档位全无关(权威来源:上游 `GET /api/log/token?key=sk-xxx`
    // 带 `Authorization: sk-xxx`,逐条 quota ÷ quota_per_unit 500,000):
    //   - junze       key sk-Wwqj…yXp0 → **$0.03/张 = ¥0.216**(汇率 7.2)
    //   - junzestable key sk-Ce6A…y03Q → **$0.045/张 = ¥0.324**(贵 50%,上游承诺"稳定不断";
    //     两 key 同上游同契约,逐项实测一致:1024²/4K token 值、Firefly 主机、quality 行为全同
    //     → 只有"更稳"这一个卖点,主力备用选 junze,junze 也不行时再上 junzestable)
    //   `n>1` 按张收(n=2 = 2×单价);内容安全 451 不计费。
    // 【盈亏(售价 = 合成 ct × 3.9e-5,见 MIN_SYNTH_CT 注释的换算)】能覆盖 junze ¥0.216 成本的只有
    //   1024² high(7,024→¥0.274 +27%)/2560×1440 high(7,370→¥0.287)/4K high(13,342→¥0.520)/
    //   2048² high(14,272→¥0.557)/2880² high(23,718→¥0.925);**全部 medium/low 档亏**
    //   (medium 天花板 2880²=5,930→¥0.231 勉强打平,1024² medium 仅 ¥0.068 vs 成本 ¥0.216)。
    //   junzestable 再往上抬一档:1024² high / 2560×1440 high 也亏。**这是备用线的既定代价。**
    // 【上游身份】Adobe Firefly Services 转售 OpenAI —— 出图 C2PA claim = `OpenAI Media Service API`
    // (OpenAI OpCo 证书链,SSL.com C2PA ICA),但分发主机是 `pre-signed-firefly-prod.s3-accelerate
    // .amazonaws.com` 预签名 url(X-Amz-Expires=86400 → 24h 过期,适配器 url→b64 拉回,绝不外泄)。
    // C2PA 由适配器按内容剥(#440,命中 adobe/firefly 才剥;本家 claim 是 OpenAI 官方内容凭证,
    // 与 revefull 同理【正确放行】)。另带 `c2pa.watermarked.unbound` 隐形水印(官方出图本就有)。
    // 【⚠️ quality 钉死 medium 刻度】low/medium/high 三种请求上游一律回 `quality:"medium"`,
    // 自报 out_tokens:1024²=1056、1536×1024=1568、2048²=1584、2560×1440=2352、3840×2160=3336
    // —— 4K 那个 3336 正好是官方 **medium** 公式值(high 应 13,342)→ 上游【拿不到 high 档渲染】。
    // 同站的 `gpt-image-high`($0.08/张)实测同样是 medium 刻度(1024²=1756 / 4K=3336),不是 high 专线,
    // 且带 quality 参数会 400 `Invalid free model` → 不接,upstreamModel 保持裸 gpt-image-2。
    // 适配器计费按【客户请求的 quality】+ 返回图实际尺寸合成官方账单(全 provider 通用)→ 启用期间
    // high 档客户按 high 计费但拿 medium 渲染。**这是 operator 知情接受的应急取舍**(备用线短暂启用,
    // 优于全站出图失败);若某天要改成诚实按 medium 收,把 openAllTiers 换成
    // onlyQualities: ['medium'] 一行即可(同 frimodelmedium 先例)。
    // 【尺寸】1024²/1536×1024/1024×1536/2048²/2560×1440/3840×2160 逐像素如实;**方图上限 2880²**
    // (3072²/3840² 静默降到 2880²)—— ⚠️ 2026-09-27 起显式 size 按请求尺寸计费,这类降级会按请求尺寸
    // 收费(2880² 交付、3072² 计费属超收;3072² 已被 proxy 层官方约束 400 挡住,直打适配器才会到这)。
    // `size:"auto"` 与【不传 size】→ 2048×2048(非官方缺省),auto-size 归一层已统一处理。
    // 【其余实测】generations / edits multipart / 多参考图 image[] / mask / response_format=b64_json
    // 全支持;12 并发 12/12 成功、p50 39s(单发 38-70s,12 并发 95-112s);451 文案
    // `Try modifying the prompts or the seeds`(非官方措辞,#379 内容安全分类已覆盖 `appear to be unsafe`);
    // 503 错误体含 `under group default (distributor)` → brand 兜 distributor。
    // 透明背景未验证 → fail-closed 拒(家族惯例;openAllTiers 不豁免这条)。
    junze: {
        baseUrl: 'https://ai.junze.me',
        brand: /\bjun-?ze\b|\bdistributor\b|\bfirefly\b|\bs3-accelerate\.amazonaws\.com\b/gi,
        openAllTiers: true,
        noTransparentBackground: true,
    },
    junzestable: {
        baseUrl: 'https://ai.junze.me',
        brand: /\bjun-?ze\b|\bdistributor\b|\bfirefly\b|\bs3-accelerate\.amazonaws\.com\b/gi,
        openAllTiers: true,
        noTransparentBackground: true,
    },
    // junzehigh:钧泽 API 的 `gpt-image-high` SKU(2026-10-14 公告新增,$0.07/张一口价不分尺寸档位;同 key sk-Wwqj)。
    // 2026-10-15/16 实测:走的是「10k pool」网关(与 qimg key1 / ztyunjuan 逐字相同的错误文案 + ERR- 码生成器 + 9 key 成功壳,
    // 调 gpt-image-high 回显 model=gpt-image-2;后面是 Adobe Firefly,全 Adobe Inc. 签名 → 由剥离逻辑处理)。
    //  - **三档真**(10-16 25/25):1K low 20s / medium 59s / high 132–135s(usage 7024);4K low 49s / medium 70s / high 104s(13342),
    //    4K PNG 11.3 / 14.3 / 16.1 MB 单调;1344×1008 / 2048² / 2880² / 4K 全如实;auto → 1024²;1000 → 1008²;edits 通;
    //  - 透明 → 400 `Transparent background is not supported for this model` → noTransparentBackground;xhigh → 400;
    //  - 可用性随池按天波动:10-15 7/27(10k pool unavailable + 429 `generation concurrency limit reached` / `account selection is busy`,
    //    10 并发即 429),10-16 25/25 零 429。n=2 返 1 张(适配器扇出)。
    // 【全量线(operator 2026-10-16 拍板)】openAllTiers;客户仍叫 gpt-image-2,上游模型名用 upstreamModel 映射成 gpt-image-high。
    junzehigh: {
        baseUrl: 'https://ai.junze.me',
        brand: /\bjun-?ze\b|\bdistributor\b|\b10k pool\b|\bERR-[0-9A-F]{6,}\b|pre-signed-firefly[a-z0-9.-]*|s3-accelerate[a-z0-9.-]*|bad request to openai:?\s*|\badobe\b|\bfirefly\b/gi,
        upstreamModel: 'gpt-image-high',
        openAllTiers: true,
        noTransparentBackground: true,
    },
    // llmway:llmway.ai「生图分组」key(sk-UP8r…;与 2.5 适配器的 llmway25 不同 key 不同线)。2026-10-16 实测 gpt-image-2:
    //  - Adobe Firefly 线(全 Adobe Inc. 签名 → 剥离逻辑处理;Firefly S3 预签名 url 拉回);$0.06/张一口价(quota_type=1)不分尺寸档位;
    //  - **上游只渲染 medium**(内部组名 llm-gpt-2-medium;1K high 58–61s = medium 61s,4K 三档延迟 51/56/56s、PNG 15.3/15.5/15.7 MB
    //    无差;xhigh 不报错照收回显 medium)→ operator 2026-10-16 拍板「缺资源,接全量,low/high 都用 medium 替代,响应体由适配器
    //    合成」:upstreamQuality low→medium / high→medium,回显与计费仍按客户请求档(同 pixellelabs high→medium 的做法);
    //  - 尺寸 1344×1008 / 2048² / 2880² / 4K 如实;auto → 1402×1122;1000→1024²;n=2 返 1(扇出);webp 忽略;edits 通;
    //  - 透明 → 500 `poll failed: 400 Bad request to openai: Transparent background is not supported` → noTransparentBackground;
    //  - usage 表是自家的(1024² 383/574/765…)→ 适配器自算忽略;
    //  - ⚠️ llmway 侧该模型只挂 1 条渠道,上游账号池空即整线熔断(503 channel_circuit_open「temporarily suspended by circuit breaker」,
    //    10-16 停 >1h)→ 503 failover;放最低位。
    llmway: {
        baseUrl: 'https://llmway.ai',
        brand: /\bllm-?way\b|\bllm-gpt-2-[a-z]+\b|circuit breaker|auto-recovery probe[^(]*|\bpoll failed:?\s*|pre-signed-firefly[a-z0-9.-]*|s3-accelerate[a-z0-9.-]*|bad request to openai:?\s*|\badobe\b|\bfirefly\b/gi,
        openAllTiers: true,
        upstreamQuality: { low: 'medium', high: 'medium' },
        noTransparentBackground: true,
    },
    // luckfill:api.luckfill.com「平价 api」adobe特价组 key(sk-ZPfu…,gr 0.3)。2026-10-17 实测 gpt-image-2 26 发 24 成:
    //  - Firefly 转售的真 OpenAI 字节(全 OpenAI Media Service 签名 `API/gpt-image-2`,Firefly S3 预签名 url 拉回;签名保留);
    //  - **上游只渲染 medium**(组描述「image2 中质量」;low/high/xhigh 全回显 medium,1K ct 恒 1056,延迟 high=medium;
    //    ct 表 1056/1568/1584/2247/3336 与钧泽 2.0 逐项相同 = 同一条 Firefly medium 线)→ operator 2026-10-18 拍板「全量,
    //    medium 替代 low/high」:upstreamQuality low→medium / high→medium,回显与计费按客户请求档(同 llmway / pixellelabs);
    //  - $0.03/张一口价(quota_type=1,0.1 × gr 0.3)不分尺寸档位,medium 档 Firefly 线里最便宜;
    //  - 尺寸 1344×1008 / 2048² / 2880² / 4K 如实;auto → 2048²(非官方);1000→1008²;n=2 原生返 2 张(2.0 适配器仍扇出单张);
    //    webp 忽略;edits 通;透明 → 400 `poll failed: 400 Bad request to openai: Transparent…` → noTransparentBackground;
    //  - ⚠️ 内容审核随机误杀:`a red apple on a white table` 一发 451 `legal_error`(1/26)→ #504 逻辑按内容安全终态 400 返客户。
    luckfill: {
        baseUrl: 'https://api.luckfill.com',
        brand: /\bluck-?fill\b|adobe特价|\b(?:submit|poll) failed:?\s*|pre-signed-firefly[a-z0-9.-]*|s3-accelerate[a-z0-9.-]*|bad request to openai:?\s*|\badobe\b|\bfirefly\b/gi,
        openAllTiers: true,
        upstreamQuality: { low: 'medium', high: 'medium' },
        noTransparentBackground: true,
    },
    // ---- yuanshudian(元数点 API,api.yuanshudian.com)2026-09-28 接入,【全量线】----
    // 定位:openAllTiers 全量兜底(同 pandatk / ominiapifull / oaidistfull / junze 那批):不设 gateMinCt,
    // 所有档位含 size=auto 都接,按【客户请求尺寸 + quality】合成官方账单(#496)。
    // 【身份】new-api rc.26,系统名「元数点 API」,nginx 直出无 CF;key 在分组 `Gpt_image2_adobe`(gr 0.7),
    // `/v1/models` 只有裸 `gpt-image-2`(渠道 ch87)。出图 C2PA = **Adobe Inc. / Adobe Firefly / c2pa.opened**
    // (Firefly 原生输出,不是 OpenAI 包装的那种;字节 adobe×50 firefly×6 零 openai)→ 靠适配器内容自定向
    // strip(#227/#440,命中 adobe/firefly 才剥)兜住,交付客户的字节零 adobe。
    // 【成本】按张固定 **$0.1 × gr 0.7 = $0.07/张 = ¥0.504**(汇率 7.2;站内充值 ¥7.3/$1),与 size/quality/n
    // 全无关(2026-09-28 上游 `/api/log/token` 逐条 quota 实测 8 张全 0.07);失败(502/503)不计费。
    // 【盈亏(售价 = 合成 ct × 3.9e-5,见 MIN_SYNTH_CT 注释)】覆盖 ¥0.504 需 ct ≥ ~12,923 → 只有
    //   4K high(13,342→¥0.520)/ 2048² high(14,272→¥0.557)/ 2880² high(23,718→¥0.925)赚;
    //   1024² high(7,024→¥0.274)/ 2560×1440 high(7,370→¥0.287)及全部 medium/low 档亏。**全量线既定代价**,
    //   operator 2026-09-28 拍板接全量;要改守门把 openAllTiers 换成 gateMinCt: 12_923 一行即可。
    // 【尺寸 / quality 全如实(7/7 实测)】1024² low/high、1536×1024 high、2048² medium、3840×2160 high
    //   逐像素等于请求;响应 usage 逐 token 等于官方公式(196/7024/5488/3568/13342/1756),quality 档是真的
    //   (与 junze 钉死 medium 不同)。不传 size → 上游默认 1264×848(非官方 auto)→ auto 归一层显式发尺寸即可。
    //   edits multipart 1024² ✓。认 `response_format: b64_json`(显式要则返纯 b64);缺省只返 url,图床
    //   `r2.52image.xyz`(= zdchat/zdapi 同一图床,疑同源号池)→ 适配器 url→b64 拉回(含 1s/3s 重试),不外泄。
    // 【稳定性差】上游池阵发性抖动:实测一个 ~1.5 分钟窗口内 6 并发 × 3 轮全部 `502 candidate upstream
    //   unavailable`,第 4 轮全过;另见 `503 image upload queue is busy; please retry shortly`。两者都是 5xx
    //   → classifyUpstreamError 走 failover(换渠道 / 重试),不终态化。成功延迟 25–65s。
    // 【brand】兜 yuanshudian / 52image(图床域)/ candidate upstream(其 502 文案)/ firefly / adobe(sanitize 已兜 adobe)。
    // 透明背景未验证 → fail-closed(家族惯例,openAllTiers 不豁免)。
    yuanshudian: {
        baseUrl: 'https://api.yuanshudian.com',
        brand: /\byuan-?shu-?dian\b|\b52image\b|\bcandidate upstream\b|\bfirefly\b/gi,
        openAllTiers: true,
        noTransparentBackground: true,
    },
    // ---- open302(开放堆栈,open302.com,杭州词元智界)2026-09-28 接入,【全量线】----
    // 定位:openAllTiers 全量兜底(同 yuanshudian / pandatk / junze 那批):不设 gateMinCt,所有档位含
    // size=auto 都接,按【客户请求尺寸 + quality】合成官方账单(#496)。
    // 【身份】**不是 new-api**(`/api/status` `/api/pricing` `/api/log/token` 全回官网 HTML,`/v1/dashboard/billing/*`
    // 404,响应头只有 `X-Request-Id: req_…`),nginx 直出;key 64 位带下划线。`/v1/models` 28 个,图类含 gpt-image-2 /
    // gpt-image-2.5-flare / -sunburst / gemini image 系;本 provider 只挂裸 `gpt-image-2`。
    // 【成本】**API 侧查不到**(无计费端点),只能看站方后台扣费 —— 接入后 operator 按后台核单价;盈亏表待补。
    // 【⚠️ quality high 不给】1024² high → 回显 `medium` ct 1756;4K high → 回显 `medium` ct 3336(官方 medium 值);
    //   low 如实(196)。即上游只有 low/medium 两档。openAllTiers 按客户请求的 quality 计费 → **high 档客户按 high
    //   收但拿 medium 渲染**(同 junze 启用期间的应急取舍,operator 2026-09-28 拍板接全量);要诚实按档收,把
    //   openAllTiers 换成 onlyQualities: ['low', 'medium'] 一行(同 we-token 先例)。
    // 【尺寸如实】1024² / 2048² / **3840×2160 真 4K**(11.9MB,241s)逐像素等于请求;edits multipart 1024² ✓;
    //   不传 size → 上游默认 1024²(非官方 auto)→ auto 归一层显式发尺寸即可。usage 回官方公式(196/1756/3568/3336)。
    // 【⚠️ 三源混池】同 key 同模型 7 张:4 张完全无 C2PA(字节零 openai/adobe,疑 ChatGPT 逆向剥过元数据)、
    //   2 张 Adobe Inc. / Adobe Firefly / c2pa.opened(edits、2048²)、1 张 OpenAI OpCo / OpenAI Media Service API
    //   (4K,无 watermarked.unbound,像 Azure/官方直连)。Adobe 那路靠适配器内容自定向 strip(#227/#440)兜住,
    //   OpenAI 签名是真官方凭证正确放行,无 C2PA 那路字节原样。三家渲染风格一致、中文招牌全对。
    // 【响应形态】认 `response_format: b64_json`(返纯 b64);缺省只返 url(自家图床 `r2.open302.com`,无需 UA)
    //   → 适配器 url→b64 拉回不外泄。延迟 low 21s / medium 40–62s / 4K 241s。
    // 【brand】兜 open302 / 词元 / 开放堆栈 / firefly(adobe 由 sanitize 通用兜)。非 new-api 错误体形态未知,
    //   classifyUpstreamError 默认保守 failover。透明背景 / n>1 / 安全文案 / 并发未测 → 透明 fail-closed。
    open302: {
        baseUrl: 'https://open302.com',
        brand: /\bopen-?302\b|词元|开放堆栈|\bfirefly\b/gi,
        openAllTiers: true,
        noTransparentBackground: true,
    },
    // pixellelabs:api.pixellelabs.com(自研网关,错误码 `ERR-XXXX`)。2026-10-09 实测 gpt-image-2:24/24 真 OpenAI
    // API 签名(softwareAgent API/gpt-image-2,原始编码,b64 直返),按张 $0.06 一口价(账单差分 high/low 各 6 美分)。
    //  - 【high 静默降 medium】:high×3/auto/xhigh 全报 usage 1756、延迟与 medium 相同(57–60s);4K high 报 3336、
    //    2880² high 5930 都是 medium 网格值。operator 2026-10-09 拍板:high 请求发上游时用 medium 替代,
    //    响应仍回显 high、计费仍按 high 合成 → upstreamQuality {high:'medium'}。
    //  - 【只支持固定尺寸表】:厂商确认 10 比例 × 1K/2K/4K 共 30 个尺寸(下方 PIXELLELABS_SIZES);表外会被静默
    //    改尺寸交付(实测 1536×1024 → 2304×1536、1024×1536 → 1536×2304、1344×1008 → 2048×1536),operator 拍板
    //    表外让路 → sizes 白名单;auto 同样让路(表里没有 auto,且它恒出 1024²)。生产抽样(2026-10-09 8h)
    //    表内尺寸约占 2.0 流量 57%,2560×1440 / 1920×1088 / 1536×1024 / 1024×1536 / 1792×1024 等 43% 走别的渠道。
    //  - n 只支持 1(上游 400 `n currently supports 1 only`)—— 适配器 n 是扇出单图实现,无影响。
    //  - 透明请求被上游 451「blocked for safety reasons」伪装(普通橙汁杯也拒 = 不支持透明)→ noTransparentBackground
    //    在入口拦,否则 #504 后 451 会变成终态 moderation_blocked 错误交给客户。
    //  - webp 被忽略返 PNG(适配器按字节 sniff 回显);1000×1000 上游正确 400;延迟 26–92s 偏慢。
    //  计费:openAllTiers 显式尺寸按请求尺寸合成官方账单(low 196 / medium 1756 / high 7024…),与上游 $0.06 无关。
    // yobox:max.yoboxai.com(YoBoxAI,new-api v0.0.0;key sk-qOd3…)。2026-10-10 实测 gpt-image-2 29 发 24 个 200(5 败 =
    // 3 发 `gpt-image-2-adobe` SKU 他家 Adobe 渠道挂 + 透明不支持 + 故意发的非法 quality):
    //  - **24/24 OpenAI OpCo 签名,softwareAgent `API/gpt-image-2`**(真 2.0 API 款,原始编码);
    //  - **三档真兑现,high 是真 high**:延迟 low 17–26s / medium 47–48s / high 120–151s(与官方 89–117s 同量级;
    //    9 家里除 we-token 外首次);4K low 边缘比 5.0(软)vs high 2.7;
    //  - **`size:auto` → 1122×1402 = 官方 2.0 auto 缺省尺寸**(官 key 实测值)—— 官方 API 直通的强指纹;
    //  - 尺寸 1536×1024 / 1024×1536 / 1344×1008 / 2048² / 2880² / 4K 全如实;webp 真返;edits 通;n=2 只返 1 张(适配器
    //    扇出);1000×1000 → 992²;非法 xhigh → 400(2.0 词表正确);上游 usage 浮动(2.5 式记账)→ 适配器自算。
    //  - **透明 → 上游 400 `Transparent background is not supported for this model`**(明拒不伪装)→ noTransparentBackground。
    //  - 计费按档一口价:low 0.72 / medium ~0.72 / high 0.864「单位」/张,与尺寸无关(单位 $ 或 ¥ 待 operator 核实;
    //    若 $,high 对官方 1024² $0.21 = 0.04×)。
    // 【全量线(operator 2026-10-10 拍板)】openAllTiers,quality 原样透传,显式尺寸按请求尺寸计费。
    // qimg:qimg.cc(new-api rc.30 外套自研号池层,错误码 `ERR-XXXXXXXXXX`;default 组 key sk-G99w…)。
    //  - **Adobe Firefly Services 中转 OpenAI 2.0**:全部 Adobe Inc. 签名(C2PA remoteProvider.3rdParty / modelId gpt-image /
    //    details "GPT Image 2"),无 OpenAI 签名 → 由 stripAdobeImageMetadataB64 剥;图床 Firefly S3 预签名 url(会过期,拉回);
    //  - 2026-10-11 首测 high 被网关静默降 medium(回显 medium / 1756 / 72s)→ 当时 onlyQualities=[low,medium];
    //    **2026-10-14 复测 high 已真兑现**:回显 high、usage 7024(1K)/ 13342(4K)、延迟 1K 107–150s / 4K 112s(medium 63–66s、
    //    low 18–47s)、4K PNG 12.4 / 14.9 / 16.6 MB、micro1/meso4(4K)1.08 / 1.31 / 1.55 单调;qimg 定价页把旧「image2 high分组」
    //    标为遗弃 = high 已并入 default 组 → operator 2026-10-15 拍板放全量 openAllTiers(三档原样透传、显式尺寸按请求计费);
    //  - 尺寸 1536×1024 / 1024×1536 / 1344×1008 / 2048² / 2880² / 4K 全如实;edits 通;auto → 1024²;1000×1000 → 1008²;
    //    webp 被忽略返 png;n=2 只返 1 张(适配器扇出);
    //  - 透明 → 400 `Transparent background is not supported for this model` → noTransparentBackground;
    //  - 挂牌价 $0.05/张一口价(`/api/pricing` quota_type=1,与尺寸/档位无关;10-11 差分曾测 $0.035,同 key 上线后计数器被生产
    //    流量污染不可再差分);⚠️ 生产(ch266)跑量时池子约一半回 503 `pool upstream unavailable` = 容量上限,探针 10 并发全通。
    // ⚠️ 2.5 走 qimg25(ch263)。
    qimg: {
        baseUrl: 'https://qimg.cc',
        brand: /\bqimg\b|\b10k pool\b|\bERR-[0-9A-F]{6,}\b|pre-signed-firefly[a-z0-9.-]*|s3-accelerate[a-z0-9.-]*|bad request to openai:?\s*|\badobe\b|\bfirefly\b/gi,
        openAllTiers: true,
        noTransparentBackground: true,
    },
    // suduma:www.suduma.com(非 new-api,自研站;key sk-21fb…;与 2.5 适配器的 suduma25 同站同 key)。2026-10-15 实测
    // gpt-image-2 23 发 19 个 200:
    //  - 【接口是异步任务】POST /v1/images/generations(JSON)→ `{requestId}`,轮询 GET /v1/tasks/{requestId} →
    //    `{status, data:[{type:"image", url}]}`;无 usage / 无 quality 回显;edits 只是别名,参考图走 JSON `image`(data URL
    //    数组,最多 16 张)、蒙版 `mask`;图床 img.911339.xyz 不带浏览器 UA 回 403;
    //  - **quality 只认 medium / high**(low / 缺省 → 400「没有匹配的价格」;xhigh 同)→ upstreamQuality low→medium:客户要 low
    //    上游交 medium、按 low 计费(operator 2026-10-15 拍板 2.0 也接且档位放开;代价是 low 请求付上游 medium 价);
    //  - **全部无 C2PA 签名**(PNG 只有 IHDR/IDAT/IEND),尺寸封顶 2K:1344×1008→1024×768、2880²→2048²、4K→2048×1152、
    //    1000×1000→1024² —— 2.0 适配器显式尺寸按【请求】尺寸计费,放行会收 4K 的钱交 2K 的图 → sizes 白名单只放实测如实
    //    的尺寸(+ 文档列出的 2048×1152),表外(含 auto)503 让路;
    //  - 透明返非 RGBA(假透明)→ noTransparentBackground;webp 被忽略;n=2 返 1 张(适配器扇出);
    //    延迟 medium 59–84s / high 85–91s;size=auto 偶发 `provider task failed`;无账单接口价格待商家报。
    suduma: {
        baseUrl: 'https://www.suduma.com',
        brand: /\bsuduma\b|\b911339\b|img\.911339\.xyz|provider (?:task failed|request invalid)|\badobe\b|\bfirefly\b/gi,
        openAllTiers: true,
        sizes: SUDUMA_SIZES,
        upstreamQuality: { low: 'medium' },
        noTransparentBackground: true,
        transport: {
            kind: 'async-task',
            submitPath: '/v1/images/generations',
            pollPath: '/v1/tasks/{id}',
            idField: 'requestId',
            pollIntervalMs: 4_000,
            maxWaitMs: 300_000, // 实测 edits 最长 134s;留在 Caddy :3010 600s 之下
            imageFetchHeaders: {
                'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
            },
        },
    },
    // ztyunjuan:ztyunjuan.com(new-api rc.40,default 组;key sk-ddBI…)。2026-10-15 实测 gpt-image-2 24 发 21 个 200(3 个失败
    // 都是预期:透明 400 / xhigh 400 / 1 发 edits 429):**与 qimg.cc 同一后端族**(ERR- 码、文案逐字相同、Firefly S3 预签名图床、
    // 1000×1000 → 1008²、n=2 返 1 张、webp 忽略),但是另一个站 = 独立账号池(qimg 生产一半 503 是容量上限,这条分摊)。
    //  - 全 Adobe Inc. 签名(`com.adobe.details GPT Image 2`,Firefly 线)→ 由 stripAdobeImageMetadataB64 剥;
    //  - **三档真**:1K low 25s / medium 68s / high 137–142s(usage 7024),4K low 47s / medium 65s / high 110s(13342),
    //    4K PNG 11.9 / 13.1 / 15.8 MB 单调;1344×1008 / 2048² / 2880² / 4K 全如实;auto → 1024²;edits 通;
    //  - 透明 → 400 `Transparent background is not supported for this model` → noTransparentBackground;
    //  - 挂牌 = 实扣 $0.05/张一口价(quota_type=1),失败不计费。
    // 【全量线(operator 2026-10-15 拍板)】openAllTiers,quality 原样透传,显式尺寸按请求尺寸计费(上游尺寸如实,不需 sizes)。
    ztyunjuan: {
        baseUrl: 'https://ztyunjuan.com',
        brand: /\bztyunjuan\b|\b10k pool\b|\bERR-[0-9A-F]{6,}\b|pre-signed-firefly[a-z0-9.-]*|s3-accelerate[a-z0-9.-]*|bad request to openai:?\s*|\badobe\b|\bfirefly\b/gi,
        openAllTiers: true,
        noTransparentBackground: true,
    },
    yobox: {
        baseUrl: 'https://max.yoboxai.com',
        brand: /\byobox\s?ai\b|\byobox\b|\bjd23kjs\b|provider api error:?\s*|\bone_hub(?:_error)?\b|\badobe\b|\bfirefly\b/gi,
        openAllTiers: true,
        noTransparentBackground: true,
    },
    pixellelabs: {
        baseUrl: 'https://api.pixellelabs.com',
        brand: /\bpixelle\s?labs?\b|\bERR-[0-9A-F]{6,}\b|\bfirefly\b/gi,
        openAllTiers: true,
        sizes: PIXELLELABS_SIZES,
        upstreamQuality: { high: 'medium' },
        noTransparentBackground: true,
    },
};
