/** Public and workspace catalogs share the same Portal-backed model plaza. */
import { getLocale } from '@/lib/i18n/server';
import { commonMessages } from '@/lib/i18n/messages/common';
import { pickMessages } from '@/lib/i18n';
import { ModelsCatalog } from './models-catalog';

export const dynamic = 'force-dynamic';
const metadata = {
    title: '模型广场 — LLmRoute',
    description: 'LLmRoute 模型广场：按厂商、分组和类型筛选，查看人民币价格、完整计费条件、API 示例和真实运行表现。',
};

export async function generateMetadata() {
    const locale = await getLocale();
    return locale === 'zh'
        ? metadata
        : {
              title: pickMessages(commonMessages, locale).models.pageTitle,
              description: pickMessages(commonMessages, locale).models.pageDescription,
          };
}

export default async function ModelsPage() {
    return ModelsCatalog({});
}
