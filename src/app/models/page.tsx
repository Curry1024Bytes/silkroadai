/** Public and workspace catalogs share the same Portal-backed model plaza. */
import { ModelsCatalog } from './models-catalog';

export const dynamic = 'force-dynamic';
export const metadata = {
    title: '模型广场 — LLmRoute',
    description: 'LLmRoute 模型广场：按厂商、分组和类型筛选，查看人民币价格、完整计费条件、API 示例和真实运行表现。',
};

export default async function ModelsPage() {
    return ModelsCatalog({});
}
