/**
 * /logs(客户「调用日志」页)+ the customer-facing error-copy produced by
 * `src/lib/newapi/log-display.ts` (`sanitizeLogContent`).
 */
import { defineMessages } from '../index';

export const logsMessages = defineMessages(
    {
        pageTitle: '调用日志 · Silk Road AI',
        heading: '调用日志',
        subtitle: '按日期范围,以及 Request ID / 令牌 / 模型 / 渠道 搜索每一次调用;失败的调用可展开查看详情。',
        filters: {
            start: '起始时间',
            end: '结束时间',
            requestId: 'Request ID',
            requestIdPlaceholder: '精确匹配',
            token: '令牌名(Key)',
            tokenPlaceholder: '如 prod-openai',
            model: '模型名',
            modelPlaceholder: '如 gpt-image-2',
            channel: '渠道 ID',
            channelPlaceholder: '数字',
            exportCsv: '导出 CSV',
            exportTitle: '按当前过滤条件导出 CSV(Excel 可直接打开)',
            searching: '查询中…',
            search: '搜索',
        },
        errors: {
            notProvisioned: '账号尚未开通,暂无调用日志。',
            loadFailed: '加载失败,请稍后重试。',
        },
        empty: '该时间段 / 条件下暂无调用记录',
        table: {
            colTime: '时间',
            colModel: '模型',
            colKey: 'Key',
            colRequestId: 'Request ID',
            colDuration: '时长',
            colTokens: 'Tokens(输入/输出)',
            colCost: '消耗',
            colResult: '结果',
            copyFullRequestId: '复制完整 Request ID',
            copied: '已复制',
            copy: '复制',
            failed: '失败',
            success: '成功',
            callFailed: '调用失败',
            errorDetail: '错误详情',
            noErrorDetail: '(无错误详情)',
        },
        pager: {
            page: (n: number) => `第 ${n} 页`,
            loading: ' · 加载中…',
            prev: '上一页',
            next: '下一页',
        },
        /** Friendly replacements written by `sanitizeLogContent` (server-side; raw upstream text never reaches the browser). */
        sanitized: {
            unsafe: '图片内容被安全系统判定为不适宜,请调整提示词后重试',
            badSize: '图片尺寸参数不合规(请使用「宽x高」像素格式,如 1024x1024)',
            busy: '服务繁忙,请稍后重试',
            upstream: '上游',
        },
    },
    {
        pageTitle: 'Request logs · Silk Road AI',
        heading: 'Request logs',
        subtitle:
            'Search every request by date range, Request ID, API key, model or channel; expand a failed request to see the details.',
        filters: {
            start: 'From',
            end: 'To',
            requestId: 'Request ID',
            requestIdPlaceholder: 'Exact match',
            token: 'API key name',
            tokenPlaceholder: 'e.g. prod-openai',
            model: 'Model',
            modelPlaceholder: 'e.g. gpt-image-2',
            channel: 'Channel ID',
            channelPlaceholder: 'Number',
            exportCsv: 'Export CSV',
            exportTitle: 'Export the current filter as CSV (opens in Excel)',
            searching: 'Searching…',
            search: 'Search',
        },
        errors: {
            notProvisioned: 'Your account is not provisioned yet — no request logs.',
            loadFailed: 'Failed to load, please try again later.',
        },
        empty: 'No requests match this period / filter',
        table: {
            colTime: 'Time',
            colModel: 'Model',
            colKey: 'Key',
            colRequestId: 'Request ID',
            colDuration: 'Latency',
            colTokens: 'Tokens (prompt / completion)',
            colCost: 'Cost',
            colResult: 'Result',
            copyFullRequestId: 'Copy full Request ID',
            copied: 'Copied',
            copy: 'Copy',
            failed: 'Failed',
            success: 'Success',
            callFailed: 'Request failed',
            errorDetail: 'Error details',
            noErrorDetail: '(no error details)',
        },
        pager: {
            page: (n: number) => `Page ${n}`,
            loading: ' · loading…',
            prev: 'Previous',
            next: 'Next',
        },
        sanitized: {
            unsafe: 'The image was flagged by the safety system — please adjust your prompt and try again',
            badSize: 'Invalid image size parameter (use "WIDTHxHEIGHT" in pixels, e.g. 1024x1024)',
            busy: 'Service busy, please try again later',
            upstream: 'upstream',
        },
    },
);

export type LogsMessages = (typeof logsMessages)['zh'];
