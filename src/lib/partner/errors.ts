import 'server-only';

import { NewApiError } from '@/lib/newapi/client';
import { UserTierMultiplierError } from '@/lib/newapi/user-tier-multiplier';
import { SaleOptionsError } from '@/lib/pricing-rules/options';

/** 代理定价、客户归组的业务错误。status 直接作为 HTTP 状态码返回。 */
export class PartnerPricingError extends Error {
    constructor(
        message: string,
        public readonly status: number = 400,
    ) {
        super(message);
        this.name = 'PartnerPricingError';
    }
}

/** 把代理相关错误映射成接口响应；未知错误只记日志，不把内部信息返回给前端。 */
export function partnerErrorResponse(error: unknown): { body: { error: string; message: string }; status: number } {
    if (error instanceof PartnerPricingError)
        return { body: { error: 'partner_pricing', message: error.message }, status: error.status };
    if (error instanceof UserTierMultiplierError)
        return { body: { error: 'newapi_sync', message: error.message }, status: error.status };
    if (error instanceof SaleOptionsError)
        return { body: { error: 'newapi_option_invalid', message: error.message }, status: 502 };
    if (error instanceof NewApiError)
        return { body: { error: 'newapi_unavailable', message: 'new-api 请求失败，请稍后重试。' }, status: 502 };
    console.error('[partner] unexpected error', error);
    return { body: { error: 'internal_error', message: '操作失败，请稍后重试。' }, status: 500 };
}
