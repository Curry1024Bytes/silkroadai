/**
 * Public landing page (`src/app/page.tsx`): metadata, header nav, hero,
 * why-us cards, tools showcase, how-it-works steps, pricing teaser and the
 * `?oauth_error=` banner. `zh` is byte-identical to the pre-i18n copy.
 */
import { defineMessages } from '../index';

export const landingMessages = defineMessages(
    {
        meta: {
            title: 'Silk Road AI · 一个 Key,接入 200+ AI 模型 | ChatGPT、Claude、Gemini 国内中转',
            description: '国内开发者的 AI API 聚合网关。海外大模型直连,人民币付费,价格透明,5 分钟接入。',
            keywords: ['ChatGPT API', 'Claude API', 'Gemini API', 'AI API 中转', '国内调用 OpenAI', 'AI 网关'],
            ogTitle: 'Silk Road AI · 一个 Key,接入 200+ AI 模型',
            ogDescription: '国内直连 ChatGPT/Claude/Gemini · 人民币付费 · 价格透明',
        },
        header: {
            tools: '工具',
            console: '进入控制台 →',
        },
        hero: {
            title: '一个 Key,接入 200+ AI 模型',
            subtitle: '国内开发者直连 ChatGPT、Claude、Gemini 等海外大模型 · 人民币付费 · 价格透明 · 5 分钟接入',
            ctaStart: '立即开始 →',
            ctaModels: '查看模型清单',
            compat: '完全 OpenAI 兼容,任何 SDK 一行替换 base URL。',
        },
        promo: {
            ariaLabel: '上线促销',
            headline: '上线钜惠 · 海外模型 5 折',
            body: ' · ChatGPT / Claude / Gemini 全系列 · 限时 30 天 · ',
            deadline: '6 月 9 日截止',
        },
        whyUs: {
            direct: {
                title: '国内可直连',
                line1a: '海外节点 + 国内可访问域名,',
                line1b: '无需代理 / VPN',
                line1c: '。',
                line2: 'ChatGPT、Claude、Gemini 直接调用,毫秒级响应。',
            },
            models: {
                title: '200+ 主流模型聚合',
                line1: '海外:OpenAI gpt-5 系列 / Anthropic Claude 4 系列 / Google Gemini',
                line2: '国内:DeepSeek、通义千问、智谱 GLM、月之暗面 Kimi、腾讯混元',
                line3a: '统一 OpenAI 兼容接口,无需迁移代码',
                line3b: '。',
            },
            pricing: {
                title: '定价透明 · 人民币付费',
                line1a: '海外模型 = 上游官方原生满血 API · 直连',
                line1b: ' ChatGPT / Claude / Gemini',
                line2: '1 美金 = 100 万积分 · 固定汇率 ¥7',
                line3a: '余额永不失效,可申请退款',
                line3b: '。',
            },
        },
        tools: {
            title: '工具箱',
            subtitle: '开箱即用,更快用上 Silk Road AI · 更多工具陆续接入',
            tagOnline: '在线工具',
            tagDownload: '下载安装',
            ctaUse: '立即使用',
            ctaDownload: '下载 & 接入',
            seedance: {
                title: 'Seedance 视频测试工具',
                desc: '填入你的 API Key,在线生成 Seedance 视频 —— 全部模型、全部玩法(文生 / 图生 / 首尾帧 / 参考音频),无需写代码。',
            },
            chat: {
                title: 'AI 对话测试工具',
                desc: '填入你的 API Key,在线测试 AI 对话(逐字流式)—— 覆盖你这把 key 能用的全部对话模型(GPT / Claude / Gemini / DeepSeek 等)。',
            },
            image: {
                title: 'AI 生图测试工具',
                desc: '填入你的 API Key,在线测试文生图 / 图生图 —— 覆盖你这把 key 能用的全部生图模型(Gemini / GPT Image 等)。',
            },
            codex: {
                title: 'OpenAI Codex 接入',
                desc: 'Codex CLI / IDE 插件 / 桌面版接入 Silk Road AI,一份配置直连 ChatGPT,人民币计费。',
            },
            claudeCode: {
                title: 'Claude Code 接入',
                desc: 'Claude Code 桌面 / CLI 接入 Silk Road AI,配好 Base URL + Key 即用 Claude,人民币计费。',
            },
        },
        howItWorks: {
            title: '三步开始使用',
            step1: {
                title: '注册登录',
                bodyA: '邮箱验证 / Google / GitHub 一键登录,',
                bodyStrong: '不绑定手机号',
            },
            step2: {
                title: '充值开通',
                bodyA: '支付宝 / 微信 ¥10 起,',
                bodyStrong: '单笔最高 ¥10000',
            },
            step3: {
                title: '接入调用',
                bodyA: '复制 ',
                bodyB: ',任何 OpenAI SDK 改一行 ',
                bodyC: ' 即可',
            },
        },
        pricing: {
            title: '价格预览',
            subtitle: '¥ 用 $1 官方等价额度 · 海外模型骨折价',
            cheapPoolTitle: '海外模型 · 号池低价(默认渠道)',
            enterpriseTitle: '企业 / 合规渠道 · 官方授权',
            enterpriseDesc: '走云厂商官方原生接口,可签订商务合同 · 适合金融 / 政企 / 出海合规要求场景',
            perDollar: '/ $1',
            /** Cheap-pool badge: "官方仅 2.9%" */
            officialOnly: (pct: string) => `官方仅 ${pct}`,
            /** Enterprise big label: "3.8 折" (= 38% of list) */
            discount: (zhe: string) => `${zhe} 折`,
            /** Enterprise badge (currently not rendered): "官方 38%" */
            official: (pct: string) => `官方 ${pct}`,
            providerVertex: 'Vertex AI / t3 池',
            fullPricing: '完整 per-model 价格 →',
            allModels: '全部 200+ 模型清单 →',
            enterpriseWechat: '企业合作微信',
        },
        oauth: {
            codes: {
                google_denied: 'Google 登录被取消,请重试。',
                github_denied: 'GitHub 登录被取消,请重试。',
                google_invalid: 'Google 登录失败 — 请重试,或使用邮箱密码登录。',
                github_invalid: 'GitHub 登录失败 — 请重试,或使用邮箱密码登录。',
                oauth_state_mismatch: '登录会话已过期,请重新登录。',
                oauth_provider_error: '第三方登录服务暂不可达,请稍后重试。',
            } as Record<string, string>,
            failed: (code: string) => `登录失败:${code}`,
            backToLogin: '返回登录',
        },
    },
    {
        meta: {
            title: 'Silk Road AI · One key, 200+ AI models | ChatGPT, Claude, Gemini gateway',
            description:
                'AI API gateway for developers in China. Direct access to overseas frontier models, pay in CNY, transparent pricing, integrate in 5 minutes.',
            keywords: ['ChatGPT API', 'Claude API', 'Gemini API', 'AI API gateway', 'OpenAI from China', 'LLM gateway'],
            ogTitle: 'Silk Road AI · One key, 200+ AI models',
            ogDescription: 'ChatGPT / Claude / Gemini, accessible from China · Pay in CNY · Transparent pricing',
        },
        header: {
            tools: 'Tools',
            console: 'Open console →',
        },
        hero: {
            title: 'One key, 200+ AI models',
            subtitle:
                'Direct access to ChatGPT, Claude, Gemini and other frontier models from China · Pay in CNY · Transparent pricing · Integrate in 5 minutes',
            ctaStart: 'Get started →',
            ctaModels: 'Browse models',
            compat: 'Fully OpenAI-compatible — swap one base URL in any SDK.',
        },
        promo: {
            ariaLabel: 'Launch promotion',
            headline: 'Launch deal · 50% off overseas models',
            body: ' · Entire ChatGPT / Claude / Gemini line-up · 30 days only · ',
            deadline: 'Ends June 9',
        },
        whyUs: {
            direct: {
                title: 'Direct access from China',
                line1a: 'Overseas nodes + a China-accessible domain, ',
                line1b: 'no proxy / VPN needed',
                line1c: '.',
                line2: 'Call ChatGPT, Claude and Gemini directly with millisecond latency.',
            },
            models: {
                title: '200+ models, one gateway',
                line1: 'Overseas: OpenAI gpt-5 series / Anthropic Claude 4 series / Google Gemini',
                line2: 'China: DeepSeek, Qwen, Zhipu GLM, Moonshot Kimi, Tencent Hunyuan',
                line3a: 'One OpenAI-compatible API — no code migration',
                line3b: '.',
            },
            pricing: {
                title: 'Transparent pricing · Pay in CNY',
                line1a: 'Overseas models = the official, full-strength upstream API · direct to',
                line1b: ' ChatGPT / Claude / Gemini',
                line2: '$1 = 1,000,000 credits · fixed rate ¥7',
                line3a: 'Balance never expires, refunds available on request',
                line3b: '.',
            },
        },
        tools: {
            title: 'Tools',
            subtitle: 'Ready out of the box — get productive on Silk Road AI faster · more tools coming',
            tagOnline: 'Online tool',
            tagDownload: 'Download & install',
            ctaUse: 'Try it now',
            ctaDownload: 'Download & connect',
            seedance: {
                title: 'Seedance video playground',
                desc: 'Paste your API key and generate Seedance videos in the browser — every model, every mode (text / image / first-last frame / reference audio), no code required.',
            },
            chat: {
                title: 'AI chat playground',
                desc: 'Paste your API key and test chat models with token-by-token streaming — covers every chat model your key can use (GPT / Claude / Gemini / DeepSeek and more).',
            },
            image: {
                title: 'AI image playground',
                desc: 'Paste your API key and test text-to-image / image-to-image — covers every image model your key can use (Gemini / GPT Image and more).',
            },
            codex: {
                title: 'OpenAI Codex setup',
                desc: 'Connect Codex CLI / IDE plugins / desktop app to Silk Road AI — one config file, direct ChatGPT access, billed in CNY.',
            },
            claudeCode: {
                title: 'Claude Code setup',
                desc: 'Connect Claude Code desktop / CLI to Silk Road AI — set the base URL + key and start using Claude, billed in CNY.',
            },
        },
        howItWorks: {
            title: 'Get started in three steps',
            step1: {
                title: 'Sign up',
                bodyA: 'Email verification or one-click Google / GitHub sign-in — ',
                bodyStrong: 'no phone number required',
            },
            step2: {
                title: 'Top up',
                bodyA: 'Alipay / WeChat Pay from ¥10, ',
                bodyStrong: 'up to ¥10000 per order',
            },
            step3: {
                title: 'Integrate',
                bodyA: 'Copy your ',
                bodyB: ' and point any OpenAI SDK at it by changing one line: ',
                bodyC: '',
            },
        },
        pricing: {
            title: 'Pricing preview',
            subtitle: 'Pay in ¥ for $1 of official credit · rock-bottom prices on overseas models',
            cheapPoolTitle: 'Overseas models · Low-cost pool (default)',
            enterpriseTitle: 'Enterprise / compliance tier · Officially authorized',
            enterpriseDesc:
                'Native cloud-vendor APIs with a signed commercial contract · for finance, government and overseas compliance requirements',
            perDollar: '/ $1',
            officialOnly: (pct: string) => `Only ${pct} of list`,
            discount: (zhe: string) => `${Math.round(Number(zhe) * 10)}% of list`,
            official: (pct: string) => `${pct} of list`,
            providerVertex: 'Vertex AI / t3 pool',
            fullPricing: 'Full per-model pricing →',
            allModels: 'All 200+ models →',
            enterpriseWechat: 'Enterprise sales on WeChat:',
        },
        oauth: {
            codes: {
                google_denied: 'Google sign-in was cancelled. Please try again.',
                github_denied: 'GitHub sign-in was cancelled. Please try again.',
                google_invalid: 'Google sign-in failed — try again, or log in with email and password.',
                github_invalid: 'GitHub sign-in failed — try again, or log in with email and password.',
                oauth_state_mismatch: 'Your sign-in session expired. Please log in again.',
                oauth_provider_error: 'The third-party sign-in service is unreachable. Please try again later.',
            } as Record<string, string>,
            failed: (code: string) => `Sign-in failed: ${code}`,
            backToLogin: 'Back to login',
        },
    },
);

export type LandingMessages = (typeof landingMessages)['zh'];
