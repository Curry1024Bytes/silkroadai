/**
 * /tools/seedance 测试工具三个同源转发路由(models / submit / poll)的转发目标。
 *
 * ⚠️ 必须指向 portal 自身的 /v1 代理(同进程自调,同 cn-proxy 调适配器的写法),
 * 【不能】直连 new-api(NEWAPI_BASE_URL):seedance-cn(ch95 国内企业线)模型的
 * 拦截、档次门控、按真实 usage 的适配器自扣计费全部在 /v1 代理层(cn-proxy)。
 * 直连 new-api 会绕过这一层 —— cn 模型在 new-api 故意无价(计费在适配器),裸进
 * relay 触发默认兜底预扣(2026-07-20 客户实测:5s fast-1080p 被预扣 ¥112.5 拒单);
 * 就算余额够,也会按兜底错价计费。非 cn 模型(逆向/海外档)代理会原样透传 new-api,
 * 行为不变。
 */
export const PORTAL_SELF_V1_BASE = process.env.PORTAL_SELF_V1_BASE || 'http://127.0.0.1:3002';
