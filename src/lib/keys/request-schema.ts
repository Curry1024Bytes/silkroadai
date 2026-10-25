import { z } from 'zod';
import { MAX_QUOTA_CNY } from './quota-expiry';

export const QuotaCnySchema = z
    .number()
    .positive('quotaCny must be > 0')
    .max(MAX_QUOTA_CNY)
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, 'quotaCny supports at most 2 decimals');
export const ExpiresAtSchema = z
    .string()
    .datetime({ offset: true, message: 'expiresAt must be an ISO datetime with a timezone' })
    .refine((value) => !Number.isNaN(Date.parse(value)), 'expiresAt must be an ISO datetime')
    .refine((value) => Date.parse(value) > Date.now(), 'expiresAt must be in the future');
