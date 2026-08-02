import { describe, expect, it } from 'vitest';
import { extractNewApiSessionCookie } from '../client';

describe('extractNewApiSessionCookie', () => {
    it('supports the current new-api refresh cookie', () => {
        expect(
            extractNewApiSessionCookie(
                'new_api_refresh=abc123; Path=/api/user/auth; HttpOnly; SameSite=Strict',
            ),
        ).toBe('new_api_refresh=abc123');
    });

    it('keeps compatibility with the legacy session cookie', () => {
        expect(extractNewApiSessionCookie('session=legacy456; Path=/; HttpOnly')).toBe('session=legacy456');
    });

    it('returns null when login did not set a supported cookie', () => {
        expect(extractNewApiSessionCookie('other=value; Path=/')).toBeNull();
    });
});
