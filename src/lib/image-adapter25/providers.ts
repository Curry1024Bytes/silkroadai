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
}

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
    },
};
