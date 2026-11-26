import { describe, expect, it } from 'vitest';
import {
    buildLogQuery,
    EMPTY_FILTERS,
    groupLogs,
    taskId,
    type LogRow,
} from '@/app/admin/(console)/request-logs/request-log-display';

const log = (id: string, fields: Partial<LogRow> = {}): LogRow => ({
    id,
    created_at: '2026-11-26T02:08:31Z',
    tenant_id: 'tenant-1',
    user_id: 'user-1',
    path: '/api/v3/contents/generations/tasks/task_1',
    method: 'GET',
    status_code: 404,
    model: null,
    success: false,
    incomplete: false,
    streamed: false,
    input_tokens: null,
    output_tokens: null,
    input_bytes: 0,
    output_bytes: 56,
    duration_ms: 24,
    input_r2_key: null,
    output_r2_key: null,
    ...fields,
});

describe('请求日志显示', () => {
    it('同一失败视频轮询可折叠，保留每条记录，其他客户、响应结果及请求类型独立', () => {
        const latest = log('latest');
        const unrelated = log('auth', { path: '/models', status_code: 401 });
        const older = log('older');
        const others = [
            log('ok', { status_code: 200, success: true }),
            log('submit', { method: 'POST' }),
            log('user', { user_id: 'user-2' }),
            log('tenant', { tenant_id: 'tenant-2' }),
            log('task', { path: '/api/v3/contents/generations/tasks/task_2' }),
            log('interrupted', { incomplete: true }),
            log('anon1', { user_id: null }),
            log('anon2', { user_id: null }),
            log('content', { path: '/v1/videos/task_1/content' }),
        ];
        const rows = [latest, unrelated, older, ...others];
        expect(groupLogs(rows, true)).toEqual([[latest, older], [unrelated], ...others.map((row) => [row])]);
        expect(groupLogs(rows, false)).toEqual(rows.map((row) => [row]));
    });

    it('识别方舟路径和 v1 捕获层保存的简写任务路径', () => {
        for (const path of [
            '/api/v3/contents/generations/tasks/task_1',
            '/doubao/api/v3/contents/generations/tasks/task_1',
            '/v1/videos/task_1',
            '/videos/task_1',
        ]) {
            expect(taskId(log('id', { path }))).toBe('task_1');
        }
    });

    it('日期区间按北京时间覆盖整天，失败和中断分别查询', () => {
        const filters = { ...EMPTY_FILTERS, path: ' task_abc ', from: '2026-11-26', to: '2026-11-26' };
        const failed = buildLogQuery(filters, 'failed', 2, 50);
        expect(new Date(failed.get('from')!).toISOString()).toBe('2026-11-25T16:00:00.000Z');
        expect(new Date(failed.get('to')!).toISOString()).toBe('2026-11-26T15:59:59.999Z');
        expect(Object.fromEntries(failed)).toMatchObject({
            path: 'task_abc',
            page: '2',
            page_size: '50',
            success: 'false',
        });
        const incomplete = buildLogQuery(filters, 'incomplete', 1, 20);
        expect(incomplete.get('incomplete')).toBe('true');
        expect(incomplete.has('success')).toBe(false);
    });
});
