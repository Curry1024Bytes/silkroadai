/**
 * 企业门户 /enterprise/docs SSR smoke —— 火山渠道章节的四档模型矩阵(2026-08-17 换上游后)。
 * 同 models-page / pay-form 的 renderToString 浅渲染模式;页面是纯静态 JSX,无需 mock。
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';

import EnterpriseDocsPage from '@/app/enterprise/(dash)/docs/page';
import { VOLC_MODELS, VOLC_RESOLUTIONS } from '@/lib/seedance/kuaizi-adapter';

describe('/enterprise/docs 火山渠道章节', () => {
    const html = renderToString(<EnterpriseDocsPage />);

    it('四档对客模型名全部出现在文档里', () => {
        for (const model of Object.keys(VOLC_MODELS)) {
            expect(html).toContain(model);
        }
    });

    it('分辨率矩阵与适配器的实际门控一致(文档不漂移)', () => {
        // 2.5 仅 480p/720p,不宣传 1080p/4k;pro 才有 4k —— 与 VOLC_RESOLUTIONS 同源
        expect(VOLC_RESOLUTIONS['2.5']).toEqual(['480p', '720p']);
        expect(VOLC_RESOLUTIONS.pro).toContain('4k');
        expect(VOLC_RESOLUTIONS.fast).not.toContain('4k');
        expect(html).toContain('480p / 720p / 1080p / 4k');
        expect(html).toContain('4~30 或 -1');
        // 2.5 首帧/首尾帧任务的 adaptive 约束必须写进文档(上游创建时同步拒)
        expect(html).toContain('adaptive');
    });
});
