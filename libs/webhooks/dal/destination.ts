import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Rejects non-public destinations, including IPv4-mapped IPv6 addresses. */
export function isPublicAddress(address: string): boolean {
    const value = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (isIP(value) === 4) {
        const [a, b] = value.split('.').map(Number);
        return !(
            a === 0 ||
            a === 10 ||
            a === 127 ||
            a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && (b === 168 || b === 0)) ||
            (a === 198 && (b === 18 || b === 19))
        );
    }
    return isIP(value) === 6 && /^[23]/.test(value) && !value.startsWith('2001:db8:');
}

/** Resolves once; the HTTP transport must connect to this validated address. */
export async function resolveDestination(raw: string) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
        throw new Error('Webhook requires an HTTPS URL on port 443 without credentials or fragment');
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
        throw new Error('Webhook destination must resolve only to public IP addresses');
    }
    return { url, address: addresses[0].address, family: addresses[0].family };
}
