import { describe, expect, it } from 'vitest';
import { extractNewApiSessionCookie, parseNewApiLoginResult } from '../client';

describe('extractNewApiSessionCookie', () => {
    it('keeps compatibility with the legacy session cookie', () => {
        expect(
            extractNewApiSessionCookie('session=abc123; Path=/; HttpOnly; SameSite=Strict'),
        ).toBe('session=abc123');
    });

    it('does not treat the current refresh cookie as an API session', () => {
        expect(extractNewApiSessionCookie('new_api_refresh=refresh456; Path=/api/user/auth; HttpOnly')).toBeNull();
    });

    it('returns null when login did not set a supported cookie', () => {
        expect(extractNewApiSessionCookie('other=value; Path=/')).toBeNull();
    });

    it('uses the current login payload access token and nested user', () => {
        expect(
            parseNewApiLoginResult({
                access_token: 'access-123',
                user: { id: 7, username: 'customer', role: 1 },
            }),
        ).toEqual({
            accessToken: 'access-123',
            user: { id: 7, username: 'customer', role: 1 },
        });
    });

    it('normalizes the legacy direct user payload for cookie fallback', () => {
        expect(parseNewApiLoginResult({ id: 8, username: 'legacy', role: 1 })).toEqual({
            accessToken: null,
            user: { id: 8, username: 'legacy', role: 1 },
        });
    });
});
