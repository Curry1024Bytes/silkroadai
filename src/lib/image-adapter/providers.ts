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
     *  计费走"返回图实际尺寸"),其余 503 让路。与 openAllTiers / gateMinCt 互斥使用
     *  (onlyQualities 优先)。注意 normQuality 把 auto/standard/缺省归一成 low ——
     *  "所有 medium 请求" = 客户显式传 quality=medium 的请求。 */
    onlyQualities?: ReadonlyArray<'low' | 'medium' | 'high'>;
    /** true = 该上游【未验证/不支持】`background:"transparent"` → 带此参数的请求直接 503 让
     *  new-api failover 到支持透明的渠道(调上游之前拒,不花钱)。动机(2026-08-26 客户实测):
     *  不支持的上游会 200 返回【画进像素里的假棋盘格】(rgb24 无 alpha),客户拿到废图还被计费,
     *  比失败更糟 —— fail-closed:未逐家验证真出 alpha 之前一律拒,验证通过再翻开关。
     *  缺省(false)= 上游支持透明,参数经 FORWARD_EXTRAS 正常透传。 */
    noTransparentBackground?: boolean;
}

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
    wetoken: {
        baseUrl: 'https://us-la.we-token.cc',
        brand: /\bwe-?token\b|\badobe\b|\bfirefly\b/gi,
        openAllTiers: true,
        noTransparentBackground: true,
    },
    wetokenasia: {
        baseUrl: 'https://asian-acc.we-token.cc',
        brand: /\bwe-?token\b|\badobe\b|\bfirefly\b/gi,
        openAllTiers: true,
        noTransparentBackground: true,
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
    // ---- 2026-08-24 operator 新接【真 OpenAI 签名】守门上游(new-api 型分销网关,IP 直连)----
    // oaidist:出图带 OpenAI 原生 C2PA 证书链(签名证书 `OpenAI OpCo, LLC` + OpenAI TSA 时间戳链,
    // 10/10 实测无 adobe/firefly 痕迹 → 回程剥离层不触发,签名【保留】= 客户可验官方凭证)。
    // 上游只用它的 gpt-image-2(它还挂着 gemini/seedance 等,渠道 models 列表只配 gpt-image-2)。
    // 守门:gateMinCt 1,756(¥0.06/张 成本保本线,operator 2026-08-24 拍板)= 1024² medium 起放行、
    // 1280×1024 medium(1,510)及以下拒;纯盈利档,无狭长放行(见 gateMinCt 字段注释)。
    // ⚠️ 该上游对约束外尺寸【不拒反而静默降级】(7000² 请求 200 返 2048² 实测)→ 计费必须按
    // 返回图实际尺寸合成(adapter.ts 已改为全 provider 按实际尺寸,防超收)。
    // 错误体是 new-api 通用形("new_api_error"/"(distributor)"),无独特品牌,brand 兜 IP + 该词。
    // 透明背景:信任支持(真 OpenAI 原生参数)—— 2026-08-26 想实测但其 gpt-image-2 号池整个不可用
    // (model_not_found),恢复后用 probe-transparent.py 补一发确认。
    oaidist: {
        baseUrl: 'http://64.32.31.178:3009',
        brand: /\bdistributor\b|64\.32\.31\.178/gi,
        gateMinCt: 1_756,
    },
    // oaidistfull:oaidist 同一上游、同一 key 的【全量】线(镜像 wetokengated/wetoken 双线玩法):
    // openAllTiers 放行所有档位含 size=auto,合成官方 usage 兜住被守门线拒下来的低档/auto 流量。
    // 上游对约束外尺寸静默降级的坑由"按返回图实际尺寸计费"(#403)兜底,auto 同样按实际尺寸。
    oaidistfull: {
        baseUrl: 'http://64.32.31.178:3009',
        brand: /\bdistributor\b|64\.32\.31\.178/gi,
        openAllTiers: true,
    },
};
