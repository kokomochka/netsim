// IPv4 helpers used by config validation now and by the path resolver in Phase 2.

export function parseIp(s: string): number | null {
  const parts = s.trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

export function formatIp(n: number): string {
  return [24, 16, 8, 0].map((sh) => (n >>> sh) & 255).join('.');
}

export function prefixToMask(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/** Accepts "255.255.255.0", "/24" or "24". Returns prefix length or null. */
export function parseMask(s: string): number | null {
  const t = s.trim();
  const m = /^\/?(\d{1,2})$/.exec(t);
  if (m) {
    const p = Number(m[1]);
    return p <= 32 ? p : null;
  }
  const n = parseIp(t);
  if (n === null) return null;
  // must be contiguous ones followed by zeros
  const inv = ~n >>> 0;
  if ((inv & (inv + 1)) !== 0) return null;
  let p = 0;
  for (let b = 31; b >= 0; b--) if ((n >>> b) & 1) p++;
  return p;
}

export interface Cidr { net: number; prefix: number }

/** Accepts "10.0.0.0/8" or a bare IP (treated as /32). */
export function parseCidr(s: string): Cidr | null {
  const [ip, pre] = s.trim().split('/');
  const n = parseIp(ip ?? '');
  if (n === null) return null;
  if (pre === undefined) return { net: n, prefix: 32 };
  if (!/^\d{1,2}$/.test(pre)) return null;
  const prefix = Number(pre);
  if (prefix > 32) return null;
  return { net: (n & prefixToMask(prefix)) >>> 0, prefix };
}

export function formatCidr(c: Cidr): string {
  return `${formatIp(c.net)}/${c.prefix}`;
}

export function inCidr(ip: number, c: Cidr): boolean {
  const m = prefixToMask(c.prefix);
  return ((ip & m) >>> 0) === c.net;
}

export function isAny(s: string): boolean {
  const t = s.trim().toLowerCase();
  return t === '' || t === 'any' || t === '*';
}

/** 'any' | '80' | '1000-2000' */
export function parsePortRange(s: string): [number, number] | null {
  if (isAny(s)) return [1, 65535];
  const m = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/.exec(s.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] !== undefined ? Number(m[2]) : a;
  if (a < 1 || b > 65535 || a > b) return null;
  return [a, b];
}

/** Network address for an interface, or null if ip/mask are incomplete. */
export function subnetOf(ip: string, mask: string): Cidr | null {
  const n = parseIp(ip);
  const p = parseMask(mask);
  if (n === null || p === null) return null;
  return { net: (n & prefixToMask(p)) >>> 0, prefix: p };
}
