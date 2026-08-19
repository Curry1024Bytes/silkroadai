/**
 * 企业门户 /enterprise/docs SSR smoke —— 火山渠道章节的四档模型矩阵(2026-08-17 换上游后)。
 * 同 models-page / pay-form 的 renderToString 浅渲染模式;页面是纯静态 JSX,无需 mock。
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';

import EnterpriseDocsPage from '@/app/enterprise/(dash)/docs/page';
import { isVolcModelWithdrawn, VOLC_MODELS, VOLC_RESOLUTIONS } from '@/lib/seedance/kuaizi-adapter';

describe('/enterprise/docs 火山渠道章节', () => {
    const html = renderToString(<EnterpriseDocsPage />);

    it('在售档位都在文档里;下架档位写明停售(不能悄悄消失,客户会以为是自己写错了)', () => {
        for (const model of Object.keys(VOLC_MODELS)) {
            expect(html).toContain(model);
        }
        expect(Object.keys(VOLC_MODELS).some(isVolcModelWithdrawn)).toBe(true);
        expect(html).toContain('暂停服务');
    });

    it('分辨率矩阵与适配器的实际门控一致(文档不漂移)', () => {
        // 2.5 = 480p/720p/1080p(上游 v1.2 放开 1080p),仍无 4k;pro 才有 4k —— 与 VOLC_RESOLUTIONS 同源
        expect(VOLC_RESOLUTIONS['2.5']).toEqual(['480p', '720p', '1080p']);
        expect(VOLC_RESOLUTIONS['2.5']).not.toContain('4k');
        expect(VOLC_RESOLUTIONS.pro).toContain('4k');
        expect(VOLC_RESOLUTIONS.fast).not.toContain('4k');
        expect(html).toContain('480p / 720p / 1080p / 4k');
        expect(html).toContain('4~30 或 -1');
        expect(html).toContain('480p / 720p / 1080p');
        // 2.5 首帧/首尾帧任务的 adaptive 约束必须写进文档(上游创建时同步拒)
        expect(html).toContain('adaptive');
    });

    // 2026-08-19 原生化:任务 id 本身就是火山官方任务号了 —— 既没有 vendor_task_id 字段,
    // 也没有「渠道侧原始 id」响应头。文档里不能再提这两样,否则客户去找一个不存在的字段。
    it('不再出现 vendor_task_id / 渠道侧原始 id 响应头', () => {
        expect(html).not.toContain('vendor_task_id');
        expect(html).not.toContain('X-Silkroadai-Vendor-Task-Id');
    });

    it('写明「任务 ID 就是火山官方任务号」+ 提交会等上游受理', () => {
        expect(html).toContain('火山官方的任务编号');
        expect(html).toContain('同一个号');
        expect(html).toContain('提交会等上游受理后再返回');
    });
});
