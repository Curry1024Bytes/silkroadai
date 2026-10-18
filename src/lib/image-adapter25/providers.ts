/**
 * gpt-image-2.5(flare / sunburst)按张计费上游注册表 —— 与 gpt-image-2 适配器(@/lib/image-adapter)
 * 【完全独立】的新模块。operator 2026-09-09 拍板:2.5 的新特性(5 档 quality、官方输入图 token 公式、
 * 一渠道承两模型、n 原生支持)在新适配器上重新设计,不混改 2.0,不影响 2.0 任何行为。
 *
 * 每个 provider = 一条 new-api 渠道(OpenAI 型),Base URL 指到
 * `http://172.20.0.1:3010/image-adapter25/<provider>`,渠道 Key 填【真实上游的 key】—— 适配器把
 * new-api 带来的 Authorization 原样透传给真实上游,portal 不存上游凭据。
 * 渠道 models 配 `gpt-image-2.5-flare,gpt-image-2.5-sunburst`(两模型 token 数逐档相同,只差单价)。
 */

export interface ImageProvider25 {
    /** 真实上游 base(不含 /v1),适配器拼 `${baseUrl}/v1/images/{generations|edits}`。 */
    baseUrl: string;
    /** 错误脱敏:出现在客户可见错误体里要抹掉的品牌名。 */
    brand: RegExp;
    /** 允许透传给上游的模型名白名单。2.5 一条渠道承两个模型,必须按【客户请求的模型】透传
     *  (flare / sunburst 上游分开算),不能像 2.0 那样写死一个名。不在名单 → 503 让路(配置错)。 */
    models: ReadonlyArray<string>;
    /** 单次上游调用超时(ms),缺省 = adapter.ts DEFAULT_UPSTREAM_TIMEOUT_MS(600s)。语义与 2.0 的
     *  ImageProvider.upstreamTimeoutMs 相同:we-token 会阵发性挂死不回头(2026-09-10 实证,2.5 线当日
     *  1,974 次 600s 空等),300s 让 new-api 早点 failover / 早点把错误交回客户。 */
    upstreamTimeoutMs?: number;
    /** 该上游【真正交付】的 quality 档位白名单(按 normQuality25 归一后的 5 档值;auto/缺省已归一成 low)。
     *  缺省 = 5 档全收。设了名单的 provider 收到名单外档位 → 503 让路给别的渠道,【不打上游】——
     *  因为有的上游对高档位是静默降级(收 max 的钱交 medium 的图),而不是拒绝;适配器不能替客户吃这个亏。 */
    qualities?: ReadonlyArray<'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
    /** true = 上游【原生 honor n】(一次调用真返 n 张,实测验证过)→ 适配器把 n 原样透传、一次拿 n 张。
     *  缺省(false)= 上游对 n>1 只回 1 张(yobox25 / yuanshudian25 / synoralink25 / qimg25 同后端实测
     *  「n=2 只返 1 张」,ominiapi25 同;zdchat25 返 1 或 2 不定)→ 适配器【并发扇出 n 次单图请求】
     *  自己凑 n(镜像 2.0 适配器的做法)。2026-10-11 客户反馈「n 最多 3」:此前 2.5 对所有上游都原生透传,
     *  靶 yobox25 每次只回 1 张 + 串行补齐只补 2 轮 → 1+1+1 封顶 3 张(近 48h 日志 n=4 请求 10/10 都只拿 3)。
     *  fail-safe 方向:没验证过原生 n 的上游一律扇出 —— 扇出对真支持 n 的上游也只是多几次调用,不丢图。 */
    nativeN?: boolean;
    /** 上游不是 OpenAI 同步形而是【异步任务】(提交拿任务 id → 轮询取图)时声明;缺省 = 同步直转。
     *  只影响声明了它的 provider:adapter.callUpstream 看到该字段才走 submit+poll 分支,其余 provider 代码路径不变。 */
    transport?: AsyncTaskTransport;
    /** 客户模型名 → 上游模型名映射(上游用了别名,如 suduma 的 `-gzs` 同步变体)。只影响发给上游的 `model` 字段;
     *  入口白名单(models)、计费、回显仍按客户模型名。缺省 = 原样透传。 */
    modelMap?: Readonly<Record<string, string>>;
    /** 同步直转路径拉取上游返图 url 时附加的请求头(如图床要求浏览器 UA,否则 403;suduma 的 img.911339.xyz)。
     *  异步 transport 的同名字段只作用于 transport 路径。 */
    imageFetchHeaders?: Readonly<Record<string, string>>;
    /** 上游【如实交付】的显式尺寸白名单(小写 `WxH`)。设了名单的 provider 收到名单外显式尺寸 → 503 让路,不打上游
     *  (上游对名单外尺寸是静默改尺寸,如 suduma -gzs 把 1536×1024 缩成 1152×768);`auto` 不受名单约束。缺省 = 任意尺寸。 */
    sizes?: ReadonlyArray<string>;
}

/** 异步任务形上游的传输描述(2026-10-15 为 suduma 引入)。提交与轮询都带 new-api 透传来的 Authorization。 */
export interface AsyncTaskTransport {
    kind: 'async-task';
    /** 提交路径(POST JSON,参考图/蒙版以 data URL 塞进 body `image` / `mask` 字段),缺省 /v1/images/generations。 */
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

/** we-token 系上游的单次调用超时(与 @/lib/image-adapter/providers 的同名常量语义一致,模块独立不共享)。 */
export const WETOKEN_UPSTREAM_TIMEOUT_MS = 300_000;

/** 2.5 系官方模型名。token 公式两者完全相同(2026-09-09 官 key 交叉验证逐 token 一致),
 *  区别是 sunburst 更慢(max 档 147s vs 46s)、画质更好;单价由 operator 在 new-api 后台按官方设。 */
export const GPT_IMAGE_25_MODELS = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'] as const;

/** suduma `-gzs` 2.5 实测【如实交付】的尺寸(2026-10-18):1024² / 2048² / 2880² / 3840×2160 / 1280×720 如实;
 *  1536×1024 → 1152×768、1024×1536 → 768×1152、1000×1000 → 1024² 被改尺寸 → 表外让路(operator 2026-10-18 拍板加白名单)。 */
export const SUDUMAGZS25_SIZES: ReadonlyArray<string> = [
    '1024x1024',
    '2048x2048',
    '2880x2880',
    '3840x2160',
    '1280x720',
];

export const IMAGE_PROVIDERS_25: Record<string, ImageProvider25> = {
    // wetokenasia25:asian-acc.we-token.cc 对 gpt-image-2.5 是【真 OpenAI 直通】—— 同一主机跑
    // gpt-image-2 是 Adobe Firefly 转售,跑 2.5 出图带 OpenAI OpCo 证书链、返回的 usage 就是官方精确值
    // (viper3 官 key 交叉验证 196/439/1756/3122/7024 逐 token 命中)。2026-09-09 实测:6 档 quality
    // 全收(low/medium/high/xhigh/max/auto)、size 全部如实含 8.29MP 上限(2880² / 3840×2160 不降级)、
    // edits multipart 通、透明真出 RGBA(67%)、n 原生 honor。全量线(operator 拍板),无守门。
    // 上游自己校验官方最小像素(655,360),约束外直接 400,不用我们重复校验。
    wetokenasia25: {
        baseUrl: 'https://asian-acc.we-token.cc',
        brand: /\bwe-?token\b|\badobe\b|\bfirefly\b/gi,
        models: GPT_IMAGE_25_MODELS,
        upstreamTimeoutMs: WETOKEN_UPSTREAM_TIMEOUT_MS, // 2026-09-11:we-token 挂死不回头,600s→300s
        nativeN: true, // 2026-09-09 实测 n 原生 honor(一次真返 n 张)
    },
    // llmway25:llmway.ai 对 gpt-image-2.5 两模型是真 OpenAI 直通(2026-09-13 实测 27/27 带 OpenAI OpCo
    // C2PA、PNG 原始编码单 IDAT 不经重编码;1024² / 1536×1024 / 1024×1536 / 2880² / 3840×2160 全如实、
    // 2880²+4K 是原生非放大、n 原生 honor、透明真 RGBA、webp 真返、edits 通;auto 返 1024×1536 标准尺寸)。
    // 【硬伤】xhigh / max 被上游静默降到 medium(6/6 回显 quality=medium、usage 574 与 medium 同),不是
    // 拒绝 —— 直通会变成收 max 的钱交 medium 的图,故 qualities 只放 low/medium/high,高两档 503 让路
    // 给 wetokenasia25 / 直连官 key 渠道。上游 usage 是自造表(383/574/765,与官方公式无关),适配器
    // 本就按返回图实际尺寸自算,不受影响。另:非法 quality 上游当 medium 出图、1000×1000 上游返 1008²,
    // 入口 400 拦截靠适配器现有校验;一次 4K 响应体 JSON 损坏(2/1)重试即好,交 new-api 重试链。
    llmway25: {
        baseUrl: 'https://llmway.ai',
        brand: /\bllmway\b|\badobe\b|\bfirefly\b/gi,
        models: GPT_IMAGE_25_MODELS,
        qualities: ['low', 'medium', 'high'],
        nativeN: true, // 2026-09-13 实测 27/27 n 原生 honor
    },
    // ominiapi25:www.ominiapi.com(key sk-WrSC…)对 gpt-image-2.5 两模型是 OpenAI 为主的号池。2026-09-13 实测
    // 纯 OpenAI 但随机 5xx ~37%;2026-09-14 复测 36/36 全 200 但混回 Adobe(xhigh 6 次 5 次落 Adobe、回显 medium
    // usage 1756;max 5/5 OpenAI 7024),延迟翻倍(low 45–98s / max 141–205s),8/27 响应是【裸壳】(只有
    // created+data,无 usage/quality/size)。池子每天在变,别把某天的探测当常态。
    // 【全量线(operator 2026-09-14 拍板)】不设 qualities,5 档全收,同时作 ch223 llmway 阵发全挂时的
    // low/medium/high 兜底。两个已由适配器通吃的点在这里点名(有测试锁死):
    //  ① 裸壳响应:适配器只读 data[].b64_json|url,created/usage/quality/size/background/output_format 全部
    //     自合成(usage 按返回图实际尺寸 + 官方 5 档公式),上游给不给壳无关;
    //  ② C2PA:stripAdobeImageMetadataB64 按内容自定向 —— 元数据块含 adobe/firefly 才剥(像素不动),
    //     OpenAI 原生签名字节原样保留(客户可验官方凭证)。
    // 已知代价:xhigh 落 Adobe 时上游交付 1756 档画质、我们按 xhigh 3122 计费(operator 知情接受);n>1 上游
    // 只返 1 张(按实际张数计费);webp 被忽略返 PNG;非法 quality/size 上游不 400(入口 400 靠适配器)。
    ominiapi25: {
        baseUrl: 'https://www.ominiapi.com',
        brand: /\bomini\s?api\b|\bomini\b|\badobe\b|\bfirefly\b/gi,
        models: GPT_IMAGE_25_MODELS,
        // 无 qualities = 5 档全收(全量线)。2026-09-13 曾只放 xhigh/max,09-14 改全量。
    },
    // zdchat25:api.zdapi.cc(key sk-g2HE…)。【2026-09-23 厂商搬站】原域名 new.zdchat.cc(45.78.73.20)整机失联
    // —— 三个出口(server1 / server2 / 本地)ICMP 全丢、443/80/22 全 timeout,适配器每次固定 ~10.5s
    // `fetch failed` 再 failover,当天 ch230 一小时刷出 4000+ 条 503;apex zdchat.cc 另一台活着但 nginx 502。
    // 新入口 api.zdapi.cc(40.160.130.122)同一家(图床仍 r2.52image.xyz)、key 不变,server2 实测:
    // /v1/models 只回 flare+sunburst 两个、generations low 196 / xhigh 3122(官方档位值,非 llmway 那种静默降档)、
    // edits multipart 通、返回 url 可下载。provider 名 zdchat25 保持不变(ch230 的 base_url 路径按它拼,改名即断线)。
    // 以下 2026-09-17 那轮 37/37 全档实测是在旧域名做的,新域名只抽测了 low/xhigh/edits/双模型:
    // 37/37 全 200、全部 OpenAI OpCo C2PA + 原始编码、
    // usage 逐档官方(196/439/1756/3122/7024;1536×1024 1372、1024×1536 158、2880² 5930、4K 3336)、5 档全如实
    // (sunburst 同)、尺寸全如实含 4K 原生非放大、透明真 RGBA、edits 通;零 Adobe、零 5xx;延迟 low 15–23s /
    // xhigh 35–63s / max 58–129s。指纹与 ominiapi 的 OpenAI 侧同款号池(1000×1000 不 400 返 1024² 计 192、
    // Trufo/OpenAI TSA 两 CA 混出、壳带 model),同类平台隔天就变,别把某天结论当常态。
    // 【全量线(operator 2026-09-17 拍板)】不设 qualities。已知毛病全由适配器兜:n>1 时返 1 或 2 张不定
    // (按实际张数计费)、webp/jpeg 被忽略返 PNG(jpeg 由适配器转码兜底)、非法 quality/size 上游不 400
    // (入口 400 靠适配器)、edits 输入 token 旧域名报 0 / 新域名报实数(适配器一律 synthUsage25 自算,两边都不受影响)、
    // size=auto 返非标尺寸(按返回图实际尺寸计费)、
    // 返回 url 指向 r2.52image.xyz 刚返回时可能 0 字节(fetchImageAsB64 已带重试)。
    zdchat25: {
        baseUrl: 'https://api.zdapi.cc',
        brand: /\bzdchat\b|\bzdapi\b|\b52image\b|\badobe\b|\bfirefly\b/gi,
        models: GPT_IMAGE_25_MODELS,
    },
    // yuanshudian25:api.yuanshudian.com(元数点,2.5 专用 key sk-Dlbb…;与 2.0 适配器里的 `yuanshudian`
    // Firefly 线是【完全不同的后端】,别混)。2026-10-01 实测 31 发 30 个 200(唯一 400 是故意发的非法 quality):
    //  - 30/30 OpenAI OpCo C2PA,softwareAgent = `API / gpt-image`(与 asian-acc 真直通同款,不是号池的
    //    `gpt-image / 2.0`),PNG 原始编码单 IDAT,零 Adobe;
    //  - 5 档如实:延迟随档单调(low 22–33s / high 35s / xhigh 46–49s / max 68–73s / sunburst max 123s),
    //    尺寸全如实含 2880² 与 4K(4K 边缘比 2.6、中心裁片原生锐利),透明真 RGBA,webp 真返 WEBP,
    //    size=auto → 1254²(= 官方 2.5 缺省),非法 quality 上游正确 400(`Provider API error: Invalid value…`);
    //  - 毛病(全由适配器兜):n=2 只返 1 张(n 补齐段补打);1000×1000 不 400 返 992²(入口尺寸校验拦);
    //    壳只有 created/data/usage(适配器自合成);usage 非官方公式且逐张浮动(low 263–289 / high ~4290 /
    //    4K high 16417,壳带 reasoning_tokens)—— synthUsage25 自算,不受影响;返回 url 图床 cdn.jd23kjs.work
    //    (CF,server2 拉 10MB 0.15s;fetchImageAsB64 带重试)。
    // 【成本 = 按张 $0.09 一口价】(账单接口差分:28 张 252 美分,单发 high 与 low 各 +9.0 美分),与档位/尺寸
    // 无关。对官方 $30/M:low 15× / medium 6.8× / high 1.7× / xhigh 0.96× / max 0.43× / 4K high 0.90× /
    // 2880² high 0.51× —— 只有 xhigh、max 与大尺寸不亏。
    // 【全量线(operator 2026-10-01 拍板,知情上述成本)】不设 qualities。要收紧成只放高档,加
    // `qualities: ['xhigh','max']` 一行即可(机制见 llmway25)。
    yuanshudian25: {
        baseUrl: 'https://api.yuanshudian.com',
        brand: /\byuanshudian\b|\bjd23kjs\b|provider api error:?\s*|\badobe\b|\bfirefly\b/gi,
        models: GPT_IMAGE_25_MODELS,
    },
    // synoralink25:api.synoralink.com(key sk-b4fa…)。自研网关(非 new-api:nginx 直出,错误体
    // `{"code":"INSUFFICIENT_BALANCE",…}`,无任何账单接口 → 单价只能从对方后台看,接入时未知)。
    // 2026-10-04 实测 32 发 31 个 200(唯一 400 是故意发的非法 quality):
    //  - 31/31 OpenAI OpCo C2PA,softwareAgent `API / gpt-image`,PNG 原始编码单 IDAT,零 Adobe;
    //  - 档位是真的:延迟逐档单调且可复现(low 14–21s / medium 21s / high 30–32s / xhigh 41s×3 /
    //    max 72–77s / sunburst max 156s),4K 原生裁片 low 发糊、high/max 皮纹缝线清晰;
    //  - 尺寸全如实含 2880² 与 4K,透明真 RGBA,webp 真返,edits 三种输入尺寸通,size=auto → 1312×1199。
    // 【与 yuanshudian25 是同一套后端、不同账号】:裸壳结构、逐张浮动的 usage(带 reasoning_tokens)、
    // 图床 cdn.jd23kjs.work、`Provider API error:` 前缀、1000×1000 → 992²、n=2 只返 1 张,逐项相同;
    // 但账号池与余额各自独立 —— 10-03 本线号池空(51 发全 503 `No available compatible accounts` /
    // 502 `Upstream service temporarily unavailable`,>1h)时 yuanshudian 同时段仍 ~70% 成功,
    // 所以两条线互为容灾。毛病同样全由适配器兜(n 补齐、自合成壳与 usage、url 拉回重试)。
    // 余额为 0 时上游回 403 `INSUFFICIENT_BALANCE`(连 /v1/models 都 403)→ 走通用 failover 503。
    // 【全量线(operator 2026-10-04 拍板)】不设 qualities。
    synoralink25: {
        baseUrl: 'https://api.synoralink.com',
        brand: /\bsynoralink\b|\bjd23kjs\b|provider api error:?\s*|\badobe\b|\bfirefly\b/gi,
        models: GPT_IMAGE_25_MODELS,
    },
    // qimg25:qimg.cc(new-api rc.30 外套自研号池层,错误码 `ERR-XXXX` / `pool_upstream_unavailable`),key sk-G99w…。
    // 2026-10-09 实测 2.5:= Adobe Firefly Services 中转 OpenAI —— **flare 返 OpenAI OpCo 原生签名**(softwareAgent
    // API/gpt-image,原始编码单 IDAT,Adobe 原样转发 OpenAI 字节),**sunburst 返 Adobe 签名**(modelVersions
    // gpt-image-2.5-prism)→ 由 stripAdobeImageMetadataB64 按内容剥。图床 = Firefly S3 预签名 url(会过期,
    // fetchImageAsB64 拉回;透明请求才 b64)。
    //  - 五档全兑现(第二轮密排小字报纸题复核:延迟 medium 27s / high 40s / xhigh 75s / max 75s 单调,4K PNG 体积
    //    13.2→15.9MB 单调,4K 裁片四档肉眼可分)。⚠️ 它的 usage 记账用 2.0 三档词表:high 记 7024、xhigh/max 不认识记
    //    1756,非法值 400 文案也只列 low/medium/high —— 第一轮曾据此误判「xhigh/max 降档」,是错的。适配器自合成
    //    usage,不受影响;quality 原样透传即可。
    //  - 尺寸 1536×1024 / 1024×1536 / 2880² / 4K 全如实;auto → 1024²、回显 quality=medium、size 空串(适配器自合成);
    //    透明真 RGBA;webp 被忽略;n=2 只返 1 张(n 补齐段兜);1000×1000 → 1008²(入口尺寸校验拦);edits 通、输入
    //    token 报 0(自算)。
    //  - 计费 = 按张一口价:flare $0.05(单发 low/max 各 +5 美分)、sunburst 约 $0.07。对官方 $30/M:low 8.5× /
    //    medium 3.8× / high 0.95× / xhigh 0.53× / max 0.24×。
    //  - 稳定性:同站 2.0 key 的「10k pool」自 10-09 07:57Z 起整池挂 >1 天;2.5 池首发也出过一次 18s 的
    //    `10k pool upstream unavailable`(503,走通用 failover)。
    // 【全量线(operator 2026-10-10 拍板)】不设 qualities。
    // yobox25:max.yoboxai.com(YoBoxAI,new-api v0.0.0;key sk-qOd3…)。2026-10-10 实测 31 发 30 个 200(唯一 400 是故意
    // 发的非法 quality;10 并发零抖动):与 yuanshudian25 / synoralink25 同一后端(裸壳、浮动 usage 带 reasoning_tokens、
    // 图床 cdn.jd23kjs.work、`Provider API error:` 前缀、1000×1000 → 992²、n=2 只返 1 张、auto → 1312×1199),但:
    //  - **flare 与 sunburst 都是 OpenAI OpCo 原生签名**(softwareAgent API/gpt-image,原始编码;sunburst 不是 Adobe);
    //  - 五档真兑现(延迟 low 22s / medium 22s / high 42–44s / xhigh 48–50s / max 76–81s / sunburst max 188–198s,
    //    4K PNG 体积随档上升);尺寸全如实含 2880²/4K;透明真 RGBA;webp 真返;edits 通。
    //  - 计费按张一口价:flare 0.864、sunburst 1.02「单位」/张(账单接口 1/100 QuotaUnit;该站 quota_per_unit 500000,
    //    单位是 $ 还是 ¥ 待 operator 按充值核实)—— 任一单位都比同后端元数点($0.09)便宜 10 倍以上。
    // 【全量线(operator 2026-10-10 拍板)】不设 qualities。毛病全由现有逻辑兜(n 补齐、壳自合成、url 拉回重试)。
    yobox25: {
        baseUrl: 'https://max.yoboxai.com',
        brand: /\byobox\s?ai\b|\byobox\b|\bjd23kjs\b|provider api error:?\s*|\badobe\b|\bfirefly\b/gi,
        models: GPT_IMAGE_25_MODELS,
    },
    // suduma25:www.suduma.com(非 new-api,自研站;key sk-21fb…)。2026-10-15 实测 2.5-flare 23 发:
    //  - 【接口是异步任务】POST /v1/images/generations(JSON)→ `{taskOrderId, requestId, status:"created"}`,
    //    轮询 GET /v1/tasks/{requestId}(用 requestId 不是 taskOrderId)→ `{status: succeeded|failed, data:[{type:"image", url}]}`,
    //    无 usage / 无 quality 回显;edits 只是别名,参考图走 JSON body `image`(url 或 base64,最多 16 张)、蒙版 `mask`;
    //    quality 必填(缺 → 400「请在请求里指定 quality」),价表外组合 → 400「没有匹配的价格」→ 适配器恒发归一后的档位;
    //  - 图床 img.911339.xyz 不带浏览器 UA 回 403 → imageFetchHeaders 加 UA;
    //  - low / medium / auto / 1536×1024 / 1024×1536 / 2880² / 4K low / 透明(真 RGBA)/ edits:全 OpenAI Media Service
    //    签名 `API/gpt-image`(真 2.5 API 款);延迟 low 35–64s / medium 64s;
    //  - ⚠️ high / xhigh / max / sunburst max 探针全部【无 C2PA】且 4K max 返 2048×1152(封顶 2K)—— 高档位混到另一个
    //    无签名池;operator 2026-10-15 拍板仍放 quality 全量(不设 qualities),计费照官方档;
    //  - 硬拒(任务 failed `provider request invalid`,几秒即回):1000×1000、1280×720、n>1 → 适配器 n 扇出成单张,
    //    尺寸拒 → failover;`provider task failed` 偶发(size=auto 一次,重试成功)→ failover;
    //  - 无账单接口,价格待商家报;sunburst low 也是 OpenAI 签 `API/gpt-image`(没 prism)。
    suduma25: {
        baseUrl: 'https://www.suduma.com',
        brand: /\bsuduma\b|\b911339\b|img\.911339\.xyz|provider (?:task failed|request invalid)|\badobe\b|\bfirefly\b/gi,
        models: GPT_IMAGE_25_MODELS,
        transport: {
            kind: 'async-task',
            submitPath: '/v1/images/generations',
            pollPath: '/v1/tasks/{id}',
            idField: 'requestId',
            pollIntervalMs: 4_000,
            maxWaitMs: 300_000, // 实测 max 档 204s;留在 Caddy :3010 600s 之下
            imageFetchHeaders: {
                'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
            },
        },
    },
    // ztyunjuan25:ztyunjuan.com(new-api rc.40,default 组;key sk-ddBI…)。2026-10-15 实测 2.5 23 发 22 个 200(唯一 400 是
    // 故意发的非法 quality;10 并发仅 1 发 429):**与 qimg.cc 同一后端族**(ERR- 码、文案逐字相同、Firefly S3 预签名图床、
    // 1000×1000 → 1008²、n=2 返 1 张、webp 忽略、usage 表用 2.0 词表:high 回 7024 / xhigh、max 回 1756),但是另一个站 = 独立账号池。
    //  - **flare 全 OpenAI Media Service 签名 `API/gpt-image`(含 high / xhigh / max / 4K max)**,延迟单调 low 25s / medium 25s /
    //    high 38s / xhigh 44s / max 70s、4K max 65s;透明真 RGBA;2880² / 4K 如实;edits 1024² / 1280×720 / 2048² 全通;
    //  - sunburst = Adobe 签名(prism),low 35s / max 169s → 由 stripAdobeImageMetadataB64 剥;
    //  - 挂牌 = 实扣:flare $0.05 / sunburst $0.07 一口价(quota_type=1),失败不计费。
    // 【全量线(operator 2026-10-15 拍板)】不设 qualities;价值在于 qimg 之外的第二个账号池(qimg 生产一半 503 = 容量上限)。
    ztyunjuan25: {
        baseUrl: 'https://ztyunjuan.com',
        brand: /\bztyunjuan\b|\b10k pool\b|\bERR-[0-9A-F]{6,}\b|pre-signed-firefly[a-z0-9.-]*|s3-accelerate[a-z0-9.-]*|bad request to openai:?\s*|\badobe\b|\bfirefly\b/gi,
        models: GPT_IMAGE_25_MODELS,
    },
    // sudumagzs25:www.suduma.com 的 `-gzs` 同步变体(2026-10-18 上游新增;同 key sk-21fb…)。与 suduma25(异步任务形)的区别:
    // POST /v1/images/generations 直接等 60–130s 返 OpenAI 同步壳 `{created, data:[{url}]}`,不再提交+轮询 → 走普通同步直转,
    // 只需把客户模型名映射成 `gpt-image-2.5-flare-gzs` / `-sunburst-gzs`(modelMap)。图床仍 img.911339.xyz,拉回要浏览器 UA
    // (imageFetchHeaders,否则 403)。
    // 实测特征见 memory suduma-gpt-image-probe「-gzs」段;operator 2026-10-18 拍板用变体名重做两个适配器,quality 全量不设 qualities。
    sudumagzs25: {
        baseUrl: 'https://www.suduma.com',
        brand: /\bsuduma\b|\b911339\b|img\.911339\.xyz|-gzs\b|provider (?:task failed|request invalid|temporarily unavailable)|\badobe\b|\bfirefly\b/gi,
        models: GPT_IMAGE_25_MODELS,
        modelMap: {
            'gpt-image-2.5-flare': 'gpt-image-2.5-flare-gzs',
            'gpt-image-2.5-sunburst': 'gpt-image-2.5-sunburst-gzs',
        },
        sizes: SUDUMAGZS25_SIZES,
        imageFetchHeaders: {
            'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
        },
        upstreamTimeoutMs: 300_000,
    },
    qimg25: {
        baseUrl: 'https://qimg.cc',
        brand: /\bqimg\b|\b10k pool\b|pre-signed-firefly[a-z0-9.-]*|s3-accelerate[a-z0-9.-]*|\badobe\b|\bfirefly\b/gi,
        models: GPT_IMAGE_25_MODELS,
    },
    // monkeycoding25:api.monkeycoding.club 的 2.5 两模型(自研 Go 网关 + Cloudflare,非 new-api)。2026-10-18 实测 26/26 200,
    // flare / sunburst 两名字 usage、延迟逐位相同 = 同一条线;6 并发零 429/5xx。
    //  - quality 只兑现 low/medium/high;xhigh / max / 不传 / 非法值 → 200 + 回显 low + usage 196(静默降 low 不是拒,4K max 裁片
    //    明显比 4K high 糊)→ qualities 只放三档,xhigh/max 503 让路不打上游(不能收 max 的钱交 low 的图);
    //  - 官 key 对照(2026-10-18):官方 2.5 high 18–22s / max 48–73s,本上游 2.5 high 6 样本 20–99s(最快 20s ≈ 官方 high + 中转),
    //    与真 high 不矛盾但延迟分不开 high/medium;上游 usage 报 2.0 词表(medium 1764 / high 7017 = 官方 4 倍)→ 适配器丢弃自算官方档;
    //  - 图被 Go 网关重编码(IDAT 32KB 分块):零 C2PA、webp/jpeg 回 PNG(服务端转码兜底)、透明回 RGB(交付前 alpha 校验 → 让路);
    //  - 尺寸 1024² ~ 3840×2160 全如实;网关不校验(1000² 原样、4000×2000 也出)→ 入口校验靠适配器;auto → 1254²(官方 2.5 auto 尺寸);
    //  - n=2 只返 1 张 → 扇出(不标 nativeN);edits 单图 / image[] 多图 / mask / 显式 size 通,不传 size → 1254²。
    //  operator 2026-10-19 拍板「2.0 跟 2.5 全接」。
    monkeycoding25: {
        baseUrl: 'https://api.monkeycoding.club',
        brand: /\bmonkey\s?-?coding\b|\badobe\b|\bfirefly\b/gi,
        models: GPT_IMAGE_25_MODELS,
        qualities: ['low', 'medium', 'high'],
    },
};
