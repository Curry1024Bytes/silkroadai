import 'server-only';
import { prisma } from '@/lib/db';
import type { NativeTokenBinding } from './types';

export class CustomerTokenBindingError extends Error {
    readonly status = 503;
    readonly code = 'customer_pricing_binding_unavailable';

    constructor(message = '客户专属计费配置尚未完成核验，请稍后重试。') {
        super(message);
        this.name = 'CustomerTokenBindingError';
    }
}

type BindingLimits = { maxAutoGroups?: number; allowedGroups?: readonly string[] };

function validGroup(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value === value.trim() && !value.includes(',');
}

/** Empty auto groups inherit new-api's global list, so they must never represent a scoped tier. */
export function validateNativeTokenBinding(value: NativeTokenBinding, limits: BindingLimits = {}): NativeTokenBinding {
    if (!validGroup(value.group) || typeof value.cross_group_retry !== 'boolean')
        throw new CustomerTokenBindingError('客户计费分组配置无效。');
    if (value.group !== 'auto') {
        if ((value.auto_groups !== null && value.auto_groups.length !== 0) || value.cross_group_retry)
            throw new CustomerTokenBindingError('普通计费分组不能包含自动分组配置。');
        return { group: value.group, auto_groups: null, cross_group_retry: false };
    }
    const groups = value.auto_groups;
    if (
        !Array.isArray(groups) ||
        groups.length === 0 ||
        groups.some((group) => !validGroup(group) || group === 'auto') ||
        new Set(groups).size !== groups.length ||
        value.cross_group_retry
    )
        throw new CustomerTokenBindingError('专属计费必须包含完整、唯一的模型分组。');
    if (
        limits.maxAutoGroups !== undefined &&
        (!Number.isSafeInteger(limits.maxAutoGroups) ||
            limits.maxAutoGroups < 1 ||
            groups.length > limits.maxAutoGroups)
    )
        throw new CustomerTokenBindingError('专属模型分组数量超过 new-api 当前允许的上限。');
    if (limits.allowedGroups && groups.some((group) => !limits.allowedGroups!.includes(group)))
        throw new CustomerTokenBindingError('专属计费包含未获授权的模型分组。');
    return { group: 'auto', auto_groups: [...groups], cross_group_retry: false };
}

function ordinaryBinding(publicGroup: string): NativeTokenBinding {
    if (publicGroup === 'auto') throw new CustomerTokenBindingError('必须指定当前档次的公开计费分组。');
    return validateNativeTokenBinding({ group: publicGroup, auto_groups: null, cross_group_retry: false });
}

type StoredBinding = { public_group: string; model_groups: unknown; status: string };

function bindingFromRow(row: StoredBinding | null, publicGroup: string): NativeTokenBinding {
    const ordinary = ordinaryBinding(publicGroup);
    if (!row) return ordinary;
    if (row.status !== 'active' || row.public_group !== publicGroup) throw new CustomerTokenBindingError();
    return validateNativeTokenBinding({
        group: 'auto',
        auto_groups: row.model_groups as string[],
        cross_group_retry: false,
    });
}

/** Read on every issuance; a failed/applying publication must not mint a public-price fallback Key. */
export async function resolveCustomerTokenBinding(
    userId: string,
    tierKey: string,
    publicGroup: string,
): Promise<NativeTokenBinding> {
    ordinaryBinding(publicGroup);
    const row = await prisma.customerPricingBinding.findUnique({
        where: { user_id_tier_key: { user_id: userId, tier_key: tierKey } },
        select: { public_group: true, model_groups: true, status: true },
    });
    return bindingFromRow(row, publicGroup);
}

/** Provisioning and internal services already resolve a concrete public group before reaching here. */
export async function resolveCustomerTokenBindingForGroup(
    userId: string,
    publicGroup: string,
): Promise<NativeTokenBinding> {
    ordinaryBinding(publicGroup);
    const rows = await prisma.customerPricingBinding.findMany({
        where: { user_id: userId, public_group: publicGroup },
        select: { public_group: true, model_groups: true, status: true },
        take: 2,
    });
    if (rows.length > 1) throw new CustomerTokenBindingError('客户计费分组存在重复绑定，请联系管理员核对。');
    return bindingFromRow(rows[0] ?? null, publicGroup);
}

/** Preserve token identity and constraints; only this exact routing assignment satisfies the binding. */
export function nativeTokenBindingMatches(
    token: { group: string; auto_groups?: string[] | null; cross_group_retry?: boolean },
    expected: NativeTokenBinding,
): boolean {
    const binding = validateNativeTokenBinding(expected);
    if (token.group !== binding.group || (token.cross_group_retry ?? false) !== binding.cross_group_retry) return false;
    if (binding.group !== 'auto') return token.auto_groups == null || token.auto_groups.length === 0;
    return (
        Array.isArray(token.auto_groups) &&
        token.auto_groups.length === binding.auto_groups!.length &&
        token.auto_groups.every((group, index) => group === binding.auto_groups![index])
    );
}
