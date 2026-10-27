/**
 * /chat — AI 对话 page + assistant-ui console island.
 *
 * `errors` maps the `error` codes of `/api/portal/chat/stream` to
 * customer-facing copy (the route's own `message` bodies stay Chinese;
 * the adapter prefers this map and falls back to the raw message).
 */
import { defineMessages } from '../index';

export const chatMessages = defineMessages(
    {
        page: {
            metaTitle: 'AI 对话 — Silk Road AI',
            title: 'AI 对话',
            intro: '选择我们接入的任意对话模型,实时流式回复;视觉模型可传图,可开启联网搜索。不保存历史,刷新即清空。',
            noModels: '当前无法获取可用模型,请稍后重试。',
        },
        errors: {
            user_not_provisioned: '账户未完成 new-api 关联,联系客服 Global_Ads',
            user_not_found: '对话服务暂不可用,请稍后再试',
            newapi_create_failed: '对话服务暂不可用,请稍后再试',
            newapi_lookup_failed: '对话服务暂不可用,请稍后再试',
            persistence_failed: '对话服务暂不可用,请稍后再试',
            upstream_unreachable: '上游服务不可达,请稍后重试',
            internal_error: '服务暂时不可用,请稍后重试',
            invalid_credentials: '登录已过期,请重新登录',
        } as Record<string, string>,
        console: {
            networkFailed: '⚠️ 网络连接失败,请稍后重试',
            requestFailed: (status: number) => `请求失败 (${status})`,
            interrupted: '⚠️ 连接中断,以上回复可能不完整,请重试。',
            contentFilterEmpty: '⚠️ 上游内容过滤导致本次无输出,请重试或更换模型。',
            emptyOutput: '⚠️ 本次无返回内容,请重试。',
            emptyTitle: '开始对话',
            emptyHint: '选择上方模型,输入消息即可。对话不会保存,刷新后清空。',
            copy: '复制',
            uploadImage: '上传图片',
            placeholder: '输入消息,Enter 发送,Shift+Enter 换行',
            send: '发送',
            stop: '停止',
            remove: '移除',
            newChat: '新对话',
            webSearchTitle: '联网搜索:开启后会先检索网络再回答(需 operator 开通搜索服务)',
            webSearch: '联网',
            pickModel: '选择模型',
            officialTitle: (multiplier: string) => `官方稳定渠道,计费约为普通池的 ${multiplier} 倍`,
            official: (multiplier: string) => `官方 ${multiplier}×`,
            noModels: '暂无可用模型',
            vision: '视觉',
        },
        markdown: {
            copy: '复制',
            copied: '已复制',
        },
    },
    {
        page: {
            metaTitle: 'AI Chat — Silk Road AI',
            title: 'AI Chat',
            intro: 'Pick any chat model we offer and get streamed replies in real time; vision models accept images, and web search can be switched on. Nothing is saved — refresh to clear.',
            noModels: 'Model list is unavailable right now — please try again later.',
        },
        errors: {
            user_not_provisioned:
                'Your account is not linked to the API backend yet — contact support (WeChat: Global_Ads)',
            user_not_found: 'Chat is temporarily unavailable — please try again later',
            newapi_create_failed: 'Chat is temporarily unavailable — please try again later',
            newapi_lookup_failed: 'Chat is temporarily unavailable — please try again later',
            persistence_failed: 'Chat is temporarily unavailable — please try again later',
            upstream_unreachable: 'Upstream service unreachable — please try again later',
            internal_error: 'Service temporarily unavailable — please try again later',
            invalid_credentials: 'Your session has expired — please log in again',
        } as Record<string, string>,
        console: {
            networkFailed: '⚠️ Network error — please try again later',
            requestFailed: (status: number) => `Request failed (${status})`,
            interrupted: '⚠️ Connection interrupted — the reply above may be incomplete. Please retry.',
            contentFilterEmpty: '⚠️ The upstream content filter produced no output — retry or switch models.',
            emptyOutput: '⚠️ No content was returned — please retry.',
            emptyTitle: 'Start a conversation',
            emptyHint: 'Pick a model above and type a message. Chats are not saved and clear on refresh.',
            copy: 'Copy',
            uploadImage: 'Upload image',
            placeholder: 'Type a message — Enter to send, Shift+Enter for a new line',
            send: 'Send',
            stop: 'Stop',
            remove: 'Remove',
            newChat: 'New chat',
            webSearchTitle:
                'Web search: look up the web before answering (requires the operator to enable the search service)',
            webSearch: 'Web',
            pickModel: 'Select model',
            officialTitle: (multiplier: string) =>
                `Official stable channel — billed at about ${multiplier}× the standard pool`,
            official: (multiplier: string) => `Official ${multiplier}×`,
            noModels: 'No models available',
            vision: 'vision',
        },
        markdown: {
            copy: 'Copy',
            copied: 'Copied',
        },
    },
);
