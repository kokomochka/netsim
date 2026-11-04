// Config checks shown in the panels. Phase 2 — extended for firewall interfaces.
import { formatCidr, inCidr, isAny, parseCidr, parseIp, parseMask, parsePortRange, subnetOf, type Cidr } from './ip';
import type { Device, FirewallDevice, RouterDevice, WorldState } from './types';

export type Check = { level: 'bad' | 'warn' | 'hint'; msg: string } | null;

export const bad = (msg: string): Check => ({ level: 'bad', msg });
export const warn = (msg: string): Check => ({ level: 'warn', msg });
export const hint = (msg: string): Check => ({ level: 'hint', msg });

export function checkIp(v: string, emptyHint = 'Not set'): Check {
  if (v.trim() === '') return hint(emptyHint);
  return parseIp(v) === null ? bad('Use four numbers from 0 to 255, like 192.168.1.10') : null;
}

export function checkMask(v: string): Check {
  if (v.trim() === '') return hint('Not set');
  return parseMask(v) === null ? bad('Use a prefix length like /24') : null;
}

/** An address box in CIDR form: IP and prefix both needed. */
export function checkAddr(ip: string, mask: string, emptyHint = 'Not set'): Check {
  if (!ip.trim()) return hint(emptyHint);
  return checkIp(ip) ?? (parseMask(mask) === null ? bad('Add the prefix length, like /24') : null);
}

export function checkCidr(v: string, allowAny: boolean): Check {
  if (allowAny && isAny(v)) return null;
  if (v.trim() === '') return bad('Enter a network like 10.0.0.0/8');
  const c = parseCidr(v);
  if (!c) return bad(allowAny ? 'Use any, an IP, or a network like 198.51.100.0/24' : 'Use a network like 10.0.0.0/8');
  const [ip] = v.trim().split('/');
  if (parseIp(ip!) !== c.net) return warn(`Host bits are ignored: this means ${formatCidr(c)}`);
  return null;
}

export function checkPorts(v: string): Check {
  return parsePortRange(v) === null ? bad('Use any, a port like 443, or a range like 8000-8100') : null;
}

/** Every configured IP → who uses it, for duplicate detection. */
export function ipOwners(s: WorldState): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const add = (ip: string, who: string) => {
    if (parseIp(ip) === null) return;
    const k = ip.trim();
    m.set(k, [...(m.get(k) ?? []), who]);
  };
  for (const d of Object.values(s.devices)) {
    if (d.kind === 'server') add(d.ip, d.name);
    if (d.kind === 'uplink') add(d.uplinkIp, `${d.name} (ISP)`);
    if (d.kind === 'router') for (const i of d.interfaces) add(i.ip, `${d.name} ${d.ports[i.port]?.label ?? ''}`);
    if (d.kind === 'firewall') for (const i of d.interfaces) add(i.ip, `${d.name} ${i.name}`);
  }
  return m;
}

export function duplicateCheck(s: WorldState, ip: string, self: string): Check {
  const owners = ipOwners(s).get(ip.trim()) ?? [];
  const others = owners.filter((o) => o !== self);
  return others.length ? bad(`Also used by ${others.join(', ')}`) : null;
}

export function routerSubnets(r: RouterDevice): { port: number; cidr: Cidr }[] {
  const out: { port: number; cidr: Cidr }[] = [];
  for (const i of r.interfaces) {
    const c = subnetOf(i.ip, i.mask);
    if (c) out.push({ port: i.port, cidr: c });
  }
  return out;
}

export function firewallSubnets(fw: FirewallDevice): { port: number; name: string; cidr: Cidr }[] {
  const out: { port: number; name: string; cidr: Cidr }[] = [];
  for (const i of fw.interfaces) {
    const c = subnetOf(i.ip, i.mask);
    if (c) out.push({ port: i.port, name: i.name, cidr: c });
  }
  return out;
}

export function serverGatewayCheck(d: Extract<Device, { kind: 'server' }>): Check {
  if (d.gateway.trim() === '') return hint('Needed to reach other subnets and the internet');
  const ipErr = checkIp(d.gateway);
  if (ipErr) return ipErr;
  const net = subnetOf(d.ip, d.mask);
  const gw = parseIp(d.gateway)!;
  if (net && !inCidr(gw, net)) return warn(`Gateway is outside this server's subnet (${formatCidr(net)})`);
  if (gw === parseIp(d.ip)) return warn('Gateway is this server itself');
  return null;
}

export function overlapCheck(r: RouterDevice, port: number): Check {
  const nets = routerSubnets(r);
  const mine = nets.find((n) => n.port === port);
  if (!mine) return null;
  for (const n of nets) {
    if (n.port === port) continue;
    const a = mine.cidr;
    const b = n.cidr;
    const p = Math.min(a.prefix, b.prefix);
    const overlap = inCidr(a.net, { net: b.net, prefix: p }) || inCidr(b.net, { net: a.net, prefix: p });
    if (overlap) return warn(`Overlaps the subnet on ${r.ports[n.port]?.label}`);
  }
  return null;
}

export function l3Subnets(d: RouterDevice | FirewallDevice): { port: number; name: string; cidr: Cidr }[] {
  return d.kind === 'router'
    ? routerSubnets(d).map((n) => ({ ...n, name: d.ports[n.port]?.label ?? '' }))
    : firewallSubnets(d);
}

export function nextHopCheck(d: RouterDevice | FirewallDevice, nextHop: string): Check {
  const ipErr = checkIp(nextHop, 'Enter the next router\'s IP');
  if (ipErr) return ipErr;
  const ip = parseIp(nextHop)!;
  const on = l3Subnets(d).find((n) => inCidr(ip, n.cidr));
  if (!on) return warn('Next hop is not on any connected subnet, so this route is ignored');
  return hint(`leaves via ${on.name}`);
}

export function natCheck(s: WorldState, d: RouterDevice | FirewallDevice, publicIp: string, privateIp: string): Check {
  const a = checkIp(publicIp, 'Public address visitors use');
  if (a) return a;
  const b = checkIp(privateIp, 'Real address of the server');
  if (b) return b;
  const up = Object.values(s.devices).find((x) => x.kind === 'uplink');
  const blk = up?.kind === 'uplink' ? parseCidr(up.publicSubnet) : null;
  if (blk && !inCidr(parseIp(publicIp)!, blk)) return warn(`${publicIp} is not in your public block ${up?.kind === 'uplink' ? up.publicSubnet : ''}`);
  if (!l3Subnets(d).some((n) => inCidr(parseIp(publicIp)!, n.cidr))) return warn('No interface is on the public address\'s subnet, so nobody will answer ARP for it');
  return null;
}

/** Check a firewall interface's security level is valid (0–100). */
export function checkSecurityLevel(v: number): Check {
  if (v < 0 || v > 100 || !Number.isInteger(v)) return bad('Security level must be 0–100');
  return null;
}

/** Check a rate limit value for the DDoS scrubber. */
export function checkRateLimit(v: number): Check {
  if (v <= 0 || !Number.isFinite(v)) return bad('Must be a positive number');
  return null;
}
