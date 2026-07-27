import { ModelsCatalog } from '@/app/models/models-catalog';

export const metadata = { title: '模型清单 — LLmRoute' };

export default async function WorkspaceModelsPage() {
    return ModelsCatalog({ embedded: true });
}
