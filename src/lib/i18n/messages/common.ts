import { BRAND_NAME } from '@/lib/public-config';
/**
 * Site-wide strings: chrome (header / footer / sidebar), generic actions,
 * error pages. Page-specific copy lives in its own `messages/<area>.ts`.
 */
import { defineMessages } from '../index';

export const commonMessages = defineMessages(
    {
        brand: {
            tagline: 'One route. Every model.',
            siteDescription: 'One route. Every model.',
        },
        sidebar: {
            navigation: '导航',
            close: '关闭导航',
            groupWorkspace: '工作区',
            groupResources: '资源与设置',
            groupMore: '更多服务',
            gpu: 'GPU 租赁',
            topUp: '充值',
            mobileAria: '移动导航',
        },
        shell: { skip: '跳到主要内容', open: '打开导航', workspace: '工作台' },
        locale: {
            switcherLabel: '语言',
            zh: '中文',
            en: 'EN',
        },
        nav: {
            home: '首页',
            back: '返回',
            backHome: '返回首页',
            backToSite: `返回 ${BRAND_NAME}`,
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
            wechat: '微信',
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
            logoutLabel: '退出登录',
            loggingOutLabel: '正在退出登录',
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
            notFoundPageTitle: `页面没找到 — ${BRAND_NAME}`,
        },
        legal: {
            languageNotice:
                'This document is published in Chinese. The Chinese text is the legally binding version; an English translation is in preparation.',
        },
        docs: {
            pageTitle: `集成文档 — ${BRAND_NAME}`,
            pageDescription: `${BRAND_NAME} 一键集成文档:Cursor、Cline、Continue、Claude Code Desktop、OpenAI Codex(CLI / IDE 插件 / 桌面 app)、Python / Node SDK。OpenAI / Anthropic 兼容协议,5 分钟接入。`,
            languageNotice:
                'Integration docs are currently in Chinese. Base URLs, model names and code samples are language-independent — an English edition is in progress.',
        },
        models: {
            pageTitle: `模型广场 — ${BRAND_NAME}`,
            pageDescription: `${BRAND_NAME} 当前接入的全部模型:按供应商 / 分组 / 类型 / 标签筛选,对比价格、端点与近 24 小时可用性。`,
        },
    },
    {
        brand: {
            tagline: 'One route. Every model.',
            siteDescription: 'One route. Every model.',
        },
        sidebar: {
            navigation: 'Navigation',
            close: 'Close navigation',
            groupWorkspace: 'Workspace',
            groupResources: 'Resources & settings',
            groupMore: 'More services',
            gpu: 'GPU rental',
            topUp: 'Top up',
            mobileAria: 'Mobile navigation',
        },
        shell: { skip: 'Skip to main content', open: 'Open navigation', workspace: 'Workspace' },
        locale: {
            switcherLabel: 'Language',
            zh: '中文',
            en: 'EN',
        },
        nav: {
            home: 'Home',
            back: 'Back',
            backHome: 'Back to home',
            backToSite: `Back to ${BRAND_NAME}`,
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
            wechat: 'WeChat',
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
            logoutLabel: 'Log out',
            loggingOutLabel: 'Logging out',
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
            notFoundPageTitle: `Page not found — ${BRAND_NAME}`,
        },
        legal: {
            languageNotice:
                'This document is published in Chinese. The Chinese text is the legally binding version; an English translation is in preparation.',
        },
        docs: {
            pageTitle: `Integration Docs — ${BRAND_NAME}`,
            pageDescription: `Connect Cursor, Cline, Continue, Claude Code, OpenAI Codex (CLI / IDE / desktop) and the Python / Node SDKs to ${BRAND_NAME}. OpenAI- and Anthropic-compatible — set up in 5 minutes.`,
            languageNotice:
                'Integration docs are currently in Chinese. Base URLs, model names and code samples are language-independent — an English edition is in progress.',
        },
        models: {
            pageTitle: `Model Plaza — ${BRAND_NAME}`,
            pageDescription: `Every model available on ${BRAND_NAME}: filter by vendor, group, type and tag; compare prices, endpoints and 24-hour availability.`,
        },
    },
);
