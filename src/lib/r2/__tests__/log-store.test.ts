/**
 * 数据存储 Phase 1 第①步 — 私有 log bucket helper 单测。
 *
 * Mock @aws-sdk/client-s3(镜像 client.test.ts 的方式),锁住:
 *   - 键约定格式(reqlog/{yyyy}/{mm}/{dd}/{request_id}.…,UTC 日期 + 零填充)
 *   - fail-closed:R2_LOG_BUCKET_NAME 未配置 → 所有 I/O helper 抛
 *     LogStoreNotConfiguredError 且【零】SDK 调用 —— 即使公开读 image
 *     bucket 的 R2_BUCKET_NAME 配着,也绝不写过去(本模块最关键的守护)
 *   - Put/Get/Delete 的命令形状(Bucket = log bucket,不是 image bucket)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSend = vi.fn();

interface CapturedCommand {
    type: string;
    input: Record<string, unknown>;
}

let captured: CapturedCommand[] = [];

vi.mock('@aws-sdk/client-s3', () => {
    class S3Client {
        send = mockSend;
    }
    class PutObjectCommand {
        constructor(public input: Record<string, unknown>) {
            captured.push({ type: 'Put', input });
        }
    }
    class GetObjectCommand {
        constructor(public input: Record<string, unknown>) {
            captured.push({ type: 'Get', input });
        }
    }
    class DeleteObjectCommand {
        constructor(public input: Record<string, unknown>) {
            captured.push({ type: 'Delete', input });
        }
    }
    return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
});

import {
    REQLOG_PREFIX,
    LogStoreNotConfiguredError,
    isLogStoreConfigured,
    reqlogInputKey,
    reqlogOutputKey,
    reqlogInputImageKey,
    putLogObject,
    getLogObject,
    deleteLogObject,
    _resetLogStoreClientForTest,
} from '@/lib/r2/log-store';

beforeEach(() => {
    process.env.R2_ACCOUNT_ID = 'acc-stub';
    process.env.R2_ACCESS_KEY_ID = 'key-id-stub';
    process.env.R2_SECRET_ACCESS_KEY = 'secret-stub';
    process.env.R2_LOG_BUCKET_NAME = 'silkroadai-request-logs';
    // 故意把公开读 image bucket 的 env 也配着 —— 断言 log 路径永远不碰它。
    process.env.R2_BUCKET_NAME = 'silkroadai-image-gen';
    captured = [];
    mockSend.mockReset();
    mockSend.mockResolvedValue(undefined);
    _resetLogStoreClientForTest();
});

afterEach(() => {
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_LOG_BUCKET_NAME;
    delete process.env.R2_BUCKET_NAME;
});

describe('键约定(单一事实源格式锁)', () => {
    const at = new Date('2026-06-13T08:30:00Z');

    it('请求体键:reqlog/{yyyy}/{mm}/{dd}/{request_id}.in.json', () => {
        expect(reqlogInputKey('req-uuid-1', at)).toBe('reqlog/2026/06/13/req-uuid-1.in.json');
    });

    it('响应体键:reqlog/{yyyy}/{mm}/{dd}/{request_id}.out.json', () => {
        expect(reqlogOutputKey('req-uuid-1', at)).toBe('reqlog/2026/06/13/req-uuid-1.out.json');
    });

    it('输入图键:reqlog/{yyyy}/{mm}/{dd}/{request_id}.in.{i}.{ext}', () => {
        expect(reqlogInputImageKey('req-uuid-1', at, 0, 'png')).toBe('reqlog/2026/06/13/req-uuid-1.in.0.png');
        expect(reqlogInputImageKey('req-uuid-1', at, 3, 'webp')).toBe('reqlog/2026/06/13/req-uuid-1.in.3.webp');
    });

    it('ext 带前导点也收(归一化掉,不产生 ..png)', () => {
        expect(reqlogInputImageKey('req-uuid-1', at, 1, '.jpeg')).toBe('reqlog/2026/06/13/req-uuid-1.in.1.jpeg');
    });

    it('月/日零填充', () => {
        expect(reqlogInputKey('r', new Date('2026-01-02T03:04:05Z'))).toBe('reqlog/2026/01/02/r.in.json');
    });

    it('日期取 UTC,不随机器时区漂(与 PG created_at 同源)', () => {
        // 2026-06-13T23:30:00-05:00 == 2026-06-14T04:30:00Z → 必须落 06/14 前缀
        expect(reqlogInputKey('r', new Date('2026-06-13T23:30:00-05:00'))).toBe('reqlog/2026/06/14/r.in.json');
    });

    it('所有键都在 REQLOG_PREFIX 之下', () => {
        expect(reqlogInputKey('r', at).startsWith(`${REQLOG_PREFIX}/`)).toBe(true);
        expect(reqlogOutputKey('r', at).startsWith(`${REQLOG_PREFIX}/`)).toBe(true);
        expect(reqlogInputImageKey('r', at, 0, 'png').startsWith(`${REQLOG_PREFIX}/`)).toBe(true);
    });
});

describe('isLogStoreConfigured', () => {
    it('全配齐 → true', () => {
        expect(isLogStoreConfigured()).toBe(true);
    });

    it('缺 R2_LOG_BUCKET_NAME → false(即使 image bucket 的 R2_BUCKET_NAME 配着)', () => {
        delete process.env.R2_LOG_BUCKET_NAME;
        expect(process.env.R2_BUCKET_NAME).toBe('silkroadai-image-gen');
        expect(isLogStoreConfigured()).toBe(false);
    });

    it('缺共享凭证(如 R2_SECRET_ACCESS_KEY)→ false', () => {
        delete process.env.R2_SECRET_ACCESS_KEY;
        expect(isLogStoreConfigured()).toBe(false);
    });
});

describe('fail-closed:env 未配置时绝不发任何 SDK 调用', () => {
    beforeEach(() => {
        delete process.env.R2_LOG_BUCKET_NAME;
        // R2_BUCKET_NAME(公开读 image bucket)仍然配着 —— 守护点:不准回落过去。
    });

    it('putLogObject 抛 LogStoreNotConfiguredError,零 send', async () => {
        await expect(putLogObject('reqlog/2026/06/13/x.in.json', 'body')).rejects.toBeInstanceOf(
            LogStoreNotConfiguredError,
        );
        expect(mockSend).not.toHaveBeenCalled();
        expect(captured).toHaveLength(0);
    });

    it('getLogObject 抛 LogStoreNotConfiguredError,零 send', async () => {
        await expect(getLogObject('reqlog/2026/06/13/x.in.json')).rejects.toBeInstanceOf(LogStoreNotConfiguredError);
        expect(mockSend).not.toHaveBeenCalled();
    });

    it('deleteLogObject 抛 LogStoreNotConfiguredError,零 send', async () => {
        await expect(deleteLogObject('reqlog/2026/06/13/x.in.json')).rejects.toBeInstanceOf(LogStoreNotConfiguredError);
        expect(mockSend).not.toHaveBeenCalled();
    });
});

describe('putLogObject', () => {
    it('PutObject 形状正确,Bucket = 私有 log bucket(不是公开 image bucket)', async () => {
        const body = Buffer.from('{"messages":[]}');
        await putLogObject('reqlog/2026/06/13/req-1.in.json', body);
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(captured[0].type).toBe('Put');
        expect(captured[0].input).toEqual({
            Bucket: 'silkroadai-request-logs',
            Key: 'reqlog/2026/06/13/req-1.in.json',
            Body: body,
            ContentType: 'application/json',
        });
        expect(captured[0].input.Bucket).not.toBe(process.env.R2_BUCKET_NAME);
    });

    it('contentType 可显式覆盖(输入图字节)', async () => {
        await putLogObject('reqlog/2026/06/13/req-1.in.0.png', Buffer.from('png-bytes'), 'image/png');
        expect(captured[0].input.ContentType).toBe('image/png');
    });
});

describe('getLogObject', () => {
    it('GetObject 形状正确并返回字节 Buffer', async () => {
        mockSend.mockResolvedValue({
            Body: { transformToByteArray: async () => new Uint8Array([104, 105]) },
        });
        const buf = await getLogObject('reqlog/2026/06/13/req-1.out.json');
        expect(captured[0].type).toBe('Get');
        expect(captured[0].input).toEqual({
            Bucket: 'silkroadai-request-logs',
            Key: 'reqlog/2026/06/13/req-1.out.json',
        });
        expect(buf.toString('utf8')).toBe('hi');
    });

    it('响应没有 Body → 抛错(不静默返回空)', async () => {
        mockSend.mockResolvedValue({ Body: undefined });
        await expect(getLogObject('reqlog/2026/06/13/req-1.out.json')).rejects.toThrow(/empty response body/);
    });
});

describe('deleteLogObject', () => {
    it('DeleteObject 形状正确(私有 bucket)', async () => {
        await deleteLogObject('reqlog/2026/06/13/req-1.in.json');
        expect(captured[0].type).toBe('Delete');
        expect(captured[0].input).toEqual({
            Bucket: 'silkroadai-request-logs',
            Key: 'reqlog/2026/06/13/req-1.in.json',
        });
    });
});
