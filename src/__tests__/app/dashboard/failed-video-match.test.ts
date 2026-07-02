/**
 * matchFailedVideoConsumes — 把 type=6「视频任务失败(退款)」关联回它的 type=2 消费记录 id,
 * 让 dashboard 明细表把失败视频显示成「失败·¥0」而非「成功·¥X」。
 */
import { describe, expect, it } from 'vitest';
import { matchFailedVideoConsumes, type LogLite } from '@/app/(authenticated)/dashboard/failed-video-match';

const c = (id: number, model: string, quota: number, t: number): LogLite => ({
    id,
    model_name: model,
    quota,
    created_at: t,
});

describe('matchFailedVideoConsumes', () => {
    it('无失败记录 → 空集', () => {
        expect(matchFailedVideoConsumes([c(1, 'm', 100, 10)], []).size).toBe(0);
    });

    it('单个失败任务 → 匹配其之前同模型同 quota 的 type=2', () => {
        const consume = [c(1, 'dreamina-fast-480p-ref', 291850, 100)];
        const failed = [c(2, 'dreamina-fast-480p-ref', 291850, 103)]; // 3s 后失败
        const s = matchFailedVideoConsumes(consume, failed);
        expect(s.has(1)).toBe(true);
        expect(s.size).toBe(1);
    });

    it('成功 + 失败交织(同模型同 quota)→ 只标 1 条失败,计数正确', () => {
        const consume = [
            c(1, 'M', 291850, 100), // 失败任务的提交
            c(2, 'M', 291850, 160), // 成功任务的提交
        ];
        const failed = [c(9, 'M', 291850, 120)]; // 只有 1 条失败,时间在 id=1 之后、id=2 之前
        const s = matchFailedVideoConsumes(consume, failed);
        expect(s.size).toBe(1);
        expect(s.has(1)).toBe(true); // 取失败记录之前最靠近的那条(id=1)
        expect(s.has(2)).toBe(false);
    });

    it('两条同款失败 → 标两条', () => {
        const consume = [c(1, 'M', 291850, 100), c(2, 'M', 291850, 200)];
        const failed = [c(8, 'M', 291850, 150), c(9, 'M', 291850, 260)];
        const s = matchFailedVideoConsumes(consume, failed);
        expect(s.size).toBe(2);
        expect(s.has(1) && s.has(2)).toBe(true);
    });

    it('模型/quota 不匹配 → 不误标(不同时长的成功任务不受影响)', () => {
        const consume = [c(1, 'M', 100, 100)];
        const failed = [c(9, 'M', 291850, 120)]; // quota 不同
        expect(matchFailedVideoConsumes(consume, failed).size).toBe(0);
    });
});
