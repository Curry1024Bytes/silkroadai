import { NextResponse } from 'next/server';
import { ChannelGroupRetirementError } from './channel-group-retirement';
import { PricingPublishError } from './pricing-publish-lock';

/** Never include raw upstream errors or imply that an acknowledged remote delete was undone. */
export function retirementErrorResponse(error: unknown) {
    if (error instanceof ChannelGroupRetirementError || error instanceof PricingPublishError)
        return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        ['P2028', 'P2034', 'P2025', 'P2002'].includes(String(error.code))
    )
        return NextResponse.json(
            { error: 'retirement_conflict', message: '配置正在被修改，请刷新任务后重试。' },
            { status: 409 },
        );
    return NextResponse.json(
        { error: 'retirement_failed', message: '任务未完成，请刷新查看实际进度；已撤销的 Key 不会恢复。' },
        { status: 500 },
    );
}
