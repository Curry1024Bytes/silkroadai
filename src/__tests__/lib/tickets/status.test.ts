import { describe, expect, it } from 'vitest';
import {
    canTransition,
    formatTicketNumber,
    isActiveStatus,
    MAX_OPEN_TICKETS_PER_USER,
    REQUEST_ID_PATTERN,
    requiresRequestId,
} from '@/lib/tickets/status';

describe('ticket status machine', () => {
    it('customer can only reply out of waiting_customer and confirm/reopen out of resolved', () => {
        expect(canTransition('customer', 'waiting_customer', 'open')).toBe(true);
        expect(canTransition('customer', 'resolved', 'closed')).toBe(true);
        expect(canTransition('customer', 'resolved', 'open')).toBe(true);
        expect(canTransition('customer', 'open', 'closed')).toBe(false);
        expect(canTransition('customer', 'open', 'resolved')).toBe(false);
        expect(canTransition('customer', 'closed', 'open')).toBe(false);
    });
    it('staff can resolve / close from any live state but closed is terminal', () => {
        expect(canTransition('staff', 'open', 'waiting_customer')).toBe(true);
        expect(canTransition('staff', 'open', 'resolved')).toBe(true);
        expect(canTransition('staff', 'waiting_customer', 'closed')).toBe(true);
        expect(canTransition('staff', 'resolved', 'open')).toBe(true);
        expect(canTransition('staff', 'closed', 'open')).toBe(false);
    });
    it('system only auto-advances waiting_customer → resolved → closed', () => {
        expect(canTransition('system', 'waiting_customer', 'resolved')).toBe(true);
        expect(canTransition('system', 'resolved', 'closed')).toBe(true);
        expect(canTransition('system', 'open', 'closed')).toBe(false);
    });
});

describe('ticket helpers', () => {
    it('billing + api_error require a request_id', () => {
        expect(requiresRequestId('billing')).toBe(true);
        expect(requiresRequestId('api_error')).toBe(true);
        expect(requiresRequestId('recharge')).toBe(false);
        expect(requiresRequestId('other')).toBe(false);
    });
    it('formats the customer-facing number', () => {
        expect(formatTicketNumber(7)).toBe('T-000007');
        expect(formatTicketNumber(1234567)).toBe('T-1234567');
    });
    it('active statuses occupy the open-ticket quota', () => {
        expect(isActiveStatus('resolved')).toBe(true);
        expect(isActiveStatus('closed')).toBe(false);
        expect(MAX_OPEN_TICKETS_PER_USER).toBe(5);
    });
    it('request_id pattern accepts new-api ids and rejects junk', () => {
        expect(REQUEST_ID_PATTERN.test('202606231702394335219228268d9d6zT4rzDAs')).toBe(true);
        expect(REQUEST_ID_PATTERN.test('abc')).toBe(false);
        expect(REQUEST_ID_PATTERN.test('has space 123456')).toBe(false);
        expect(REQUEST_ID_PATTERN.test("x'; drop--123456")).toBe(false);
    });
});
