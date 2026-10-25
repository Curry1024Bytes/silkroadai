import { ModelsCatalog } from '@/app/models/models-catalog';

export const dynamic = 'force-dynamic';
export const metadata = { title: '模型广场 — LLmRoute' };

export default async function WorkspaceModelsPage() {
    return ModelsCatalog({ embedded: true });
}
