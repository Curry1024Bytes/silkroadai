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
}

/** we-token 系上游的单次调用超时(与 @/lib/image-adapter/providers 的同名常量语义一致,模块独立不共享)。 */
export const WETOKEN_UPSTREAM_TIMEOUT_MS = 300_000;

/** 2.5 系官方模型名。token 公式两者完全相同(2026-09-09 官 key 交叉验证逐 token 一致),
 *  区别是 sunburst 更慢(max 档 147s vs 46s)、画质更好;单价由 operator 在 new-api 后台按官方设。 */
export const GPT_IMAGE_25_MODELS = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'] as const;

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
};
