import 'server-only';
import { lookup } from 'node:dns/promises';
import { isIPv4, type LookupFunction } from 'node:net';
import { Agent } from 'undici';

/** Only routable IPv4 is supported for callbacks; IPv6 and special-use ranges fail closed. */
export function isPublicCallbackIpv4(address: string): boolean {
    if (!isIPv4(address)) return false;
    const [a, b, c] = address.split('.').map(Number);
    return !(
        a === 0 ||
        a === 10 ||
        a === 127 ||
        a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113)
    );
}

/** Validate the addresses returned to the socket itself, avoiding a validate-then-resolve DNS race. */
export const callbackLookup: LookupFunction = (hostname, options, callback) => {
    void lookup(hostname, { family: 4, all: true }).then(
        (addresses) => {
            if (!addresses.length || addresses.some(({ address }) => !isPublicCallbackIpv4(address))) {
                callback(new Error('callback destination is not a public IPv4 address'), '');
                return;
            }
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0].address, 4);
        },
        () => callback(new Error('callback destination could not be resolved safely'), ''),
    );
};

/** A dedicated dispatcher prevents global proxies or a second DNS lookup from bypassing this check. */
export const callbackDispatcher = new Agent({ connect: { family: 4, lookup: callbackLookup } });
