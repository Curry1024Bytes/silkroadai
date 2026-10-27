/**
 * Site-wide strings: chrome (header / footer / sidebar), generic actions,
 * error pages. Page-specific copy lives in its own `messages/<area>.ts`.
 */
import { defineMessages } from '../index';

export const commonMessages = defineMessages(
    {
        brand: {
            tagline: 'Connecting Global Intelligence.',
        },
        locale: {
            switcherLabel: '语言',
            zh: '中文',
            en: 'EN',
        },
        nav: {
            home: '首页',
            backHome: '返回首页',
            backToSite: '返回 Silk Road AI',
            console: '进入控制台',
            dashboard: '概览',
            logs: '调用日志',
            keys: 'API Keys',
            tools: '工具箱',
            storage: '存储设置',
            models: '模型清单',
            docs: '文档',
            pricing: '价格',
            login: '登录',
            register: '注册',
            topUp: '+ 充值',
            resellerJoin: '邀请赚佣金',
            resellerConsole: '代理后台',
            sidebarAria: '客户后台导航',
            footerAria: '页脚导航',
        },
        footer: {
            terms: '服务条款',
            privacy: '隐私政策',
            refund: '退款政策',
            supportWechat: '客服:微信',
        },
        support: {
            needHelp: '需要帮助?微信',
            email: '邮箱',
        },
        auth: {
            logout: '退出',
            loggingOut: '退出中…',
            unverified: '邮箱未验证,部分功能受限。',
            verificationSent: '验证邮件已发送,请查收 ✓',
            resend: '重发验证邮件',
            sending: '发送中…',
            requestFailed: (status: number) => `请求失败 (${status})`,
            networkError: '网络错误',
        },
        announcement: {
            details: '查看详情',
            dismiss: '关闭公告',
        },
        loading: {
            page: '页面加载中',
        },
        errors: {
            notFoundTitle: '页面没找到',
            notFoundBody: '您访问的链接可能已变更或不存在。',
            viewModels: '查看模型清单',
            serverErrorTitle: '服务暂不可用',
            serverErrorBody: '我们已收到错误,请稍后重试。',
            errorId: '错误编号:',
            notFoundPageTitle: '页面没找到 — Silk Road AI',
        },
        legal: {
            languageNotice:
                'This document is published in Chinese. The Chinese text is the legally binding version; an English translation is in preparation.',
        },
        docs: {
            pageTitle: '集成文档 — Silk Road AI',
            pageDescription:
                'Silk Road AI 一键集成文档:Cursor、Cline、Continue、Claude Code Desktop、OpenAI Codex(CLI / IDE 插件 / 桌面 app)、Python / Node SDK。OpenAI / Anthropic 兼容协议,5 分钟接入。',
            languageNotice:
                'Integration docs are currently in Chinese. Base URLs, model names and code samples are language-independent — an English edition is in progress.',
        },
        models: {
            pageTitle: '模型广场 — Silk Road AI',
            pageDescription:
                'Silk Road AI 当前接入的全部模型:按供应商 / 分组 / 类型 / 标签筛选,对比价格、端点与近 24 小时可用性。',
        },
    },
    {
        brand: {
            tagline: 'Connecting Global Intelligence.',
        },
        locale: {
            switcherLabel: 'Language',
            zh: '中文',
            en: 'EN',
        },
        nav: {
            home: 'Home',
            backHome: 'Back to home',
            backToSite: 'Back to Silk Road AI',
            console: 'Open console',
            dashboard: 'Overview',
            logs: 'Request logs',
            keys: 'API Keys',
            tools: 'Tools',
            storage: 'Storage',
            models: 'Models',
            docs: 'Docs',
            pricing: 'Pricing',
            login: 'Log in',
            register: 'Sign up',
            topUp: '+ Top up',
            resellerJoin: 'Refer & earn',
            resellerConsole: 'Reseller console',
            sidebarAria: 'Customer console navigation',
            footerAria: 'Footer navigation',
        },
        footer: {
            terms: 'Terms of Service',
            privacy: 'Privacy Policy',
            refund: 'Refund Policy',
            supportWechat: 'Support: WeChat',
        },
        support: {
            needHelp: 'Need help? WeChat',
            email: 'Email',
        },
        auth: {
            logout: 'Log out',
            loggingOut: 'Logging out…',
            unverified: 'Email not verified — some features are limited.',
            verificationSent: 'Verification email sent, please check your inbox ✓',
            resend: 'Resend verification email',
            sending: 'Sending…',
            requestFailed: (status: number) => `Request failed (${status})`,
            networkError: 'Network error',
        },
        announcement: {
            details: 'Details',
            dismiss: 'Dismiss announcement',
        },
        loading: {
            page: 'Loading page',
        },
        errors: {
            notFoundTitle: 'Page not found',
            notFoundBody: 'The link you followed may have changed or no longer exists.',
            viewModels: 'Browse models',
            serverErrorTitle: 'Service temporarily unavailable',
            serverErrorBody: 'The error has been recorded — please try again shortly.',
            errorId: 'Error ID:',
            notFoundPageTitle: 'Page not found — Silk Road AI',
        },
        legal: {
            languageNotice:
                'This document is published in Chinese. The Chinese text is the legally binding version; an English translation is in preparation.',
        },
        docs: {
            pageTitle: 'Integration Docs — Silk Road AI',
            pageDescription:
                'Connect Cursor, Cline, Continue, Claude Code, OpenAI Codex (CLI / IDE / desktop) and the Python / Node SDKs to Silk Road AI. OpenAI- and Anthropic-compatible — set up in 5 minutes.',
            languageNotice:
                'Integration docs are currently in Chinese. Base URLs, model names and code samples are language-independent — an English edition is in progress.',
        },
        models: {
            pageTitle: 'Model Plaza — Silk Road AI',
            pageDescription:
                'Every model available on Silk Road AI: filter by vendor, group, type and tag; compare prices, endpoints and 24-hour availability.',
        },
    },
);
