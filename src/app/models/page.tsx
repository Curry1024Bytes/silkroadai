/**
 * Public model catalog. The authenticated workspace renders the same data
 * through /workspace/models so this SEO-facing route remains public.
 */
import { ModelsCatalog } from './models-catalog';

export const revalidate = 60;
export const metadata = {
    title: '模型清单 — LLmRoute',
    description:
        'LLmRoute 当前接入的全部模型,按厂商分组(OpenAI / Anthropic / Google / 字节跳动 等),覆盖对话 / 视觉 / 图像 / 视频,可搜索检索。',
};

export default async function ModelsPage() {
    return ModelsCatalog({});
}
