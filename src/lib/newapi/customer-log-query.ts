import 'server-only';

import { queryLogs, type NewApiUsageLog } from '@/lib/newapi/client';
import { sdSpecialLogModelNames } from '@/lib/sd-special-video';

type LogQuery = Parameters<typeof queryLogs>[0];
type LogPage = Awaited<ReturnType<typeof queryLogs>>;

export async function* customerLogPages(args: LogQuery): AsyncGenerator<LogPage> {
    const names = args.model_name ? sdSpecialLogModelNames(args.model_name) : null;
    const pageSize = Math.min(100, Math.max(1, args.page_size ?? 50));
    if (!names) {
        for (let page = args.page ?? 1; ; page++) {
            const result = await queryLogs({ ...args, page, page_size: pageSize });
            yield result;
            if (result.items.length < pageSize) return;
        }
    }
    const sources = await Promise.all(
        names.map(async (name) => {
            const result = await queryLogs({ ...args, model_name: name, page: 1, page_size: pageSize });
            return { name, page: 1, index: 0, result };
        }),
    );
    const total = sources.reduce((sum, source) => sum + source.result.total, 0);
    let page: NewApiUsageLog[] = [];
    for (;;) {
        for (const source of sources) {
            if (source.index === source.result.items.length && source.result.items.length === pageSize) {
                source.result = await queryLogs({
                    ...args,
                    model_name: source.name,
                    page: ++source.page,
                    page_size: pageSize,
                });
                source.index = 0;
            }
            if (source.result.items.some((item) => item.model_name !== source.name))
                throw new Error('Model log filter was not respected');
        }
        const next = sources
            .filter((source) => source.index < source.result.items.length)
            .sort((left, right) => right.result.items[right.index].id - left.result.items[left.index].id)[0];
        if (!next) {
            if (page.length) yield { items: page, total };
            return;
        }
        page.push(next.result.items[next.index++]);
        if (page.length === pageSize) {
            yield { items: page, total };
            page = [];
        }
    }
}

export async function queryCustomerLogs(args: LogQuery): Promise<LogPage> {
    if (!args.model_name || !sdSpecialLogModelNames(args.model_name)) return queryLogs(args);
    let page = 0;
    let total = 0;
    for await (const result of customerLogPages({ ...args, page: 1 })) {
        total = result.total;
        if (++page === (args.page ?? 1)) return result;
    }
    return { items: [], total };
}
