// Names: public DNS for your domains (registrar-hosted or on your own Public
// DNS server), local DNS for internal names, the reverse proxy's name → back
// end mapping, and the update mirror's way to the internet (direct or through a
// forward proxy). Everything is checked with the same packet walker as traffic.

import { INTERNET_IP, MGMT_PORT, ROLES } from '../balance';
import { parseIp } from '../state/ip';
import type { Device, DeviceId, RuntimeCache, ServerDevice, Service, WorldState } from '../state/types';
import { backendPort, buildCtx, resolveFromHost, resolveInbound, type NetCtx } from './net';

const up = (d: Device | undefined) => !!d && d.health.state !== 'failed' && !d.compromised && !(d.health.state === 'repairing' && d.health.repairKind === 'full');
const hasRole = (d: Device | undefined, role: string): d is ServerDevice => d?.kind === 'server' && d.roles.some((r) => r.role === role);

/** Split a name into its owned domain and record. */
function lookupOwned(s: WorldState, fqdn: string): { dom: WorldState['domains'][string]; recs: { ip: string }[] } | null {
  const n = fqdn.toLowerCase();
  for (const d of Object.values(s.domains)) {
    if (n !== d.name && !n.endsWith('.' + d.name)) continue;
    const host = n === d.name ? '@' : n.slice(0, -(d.name.length + 1));
    return { dom: d, recs: d.records.filter((r) => (r.name || '@') === host && parseIp(r.ip) !== null) };
  }
  return null;
}

/** How the internet resolves one of your names. */
export function resolvePublic(s: WorldState, ctx: NetCtx, fqdn: string): { ip: string | null; ips: string[]; why: string } {
  const own = lookupOwned(s, fqdn);
  if (!own) return { ip: null, ips: [], why: `${fqdn} is not one of your domains. Buy the domain in the Internet tab.` };
  if (own.dom.hosting === 'self') {
    const ns = parseIp(own.dom.nsIp);
    if (ns === null) return { ip: null, ips: [], why: `${own.dom.name} is set to self-hosted DNS but has no name server IP.` };
    const p = resolveInbound(ctx, { src: parseIp('198.51.100.53')!, srcAny: false, dst: ns, proto: 'udp', sport: 50053, dport: 53, syn: false, mbps: 0, dir: 'fwd' });
    const srv = p.reachedServer ? s.devices[p.reachedServer] : undefined;
    if (p.blocked || !hasRole(srv, 'dns_public') || !up(srv)) {
      return { ip: null, ips: [], why: `The internet cannot ask your name server ${own.dom.nsIp} (udp/53): ${p.blocked ? p.explain : 'no Public DNS role answers there'}` };
    }
  }
  if (!own.recs.length) return { ip: null, ips: [], why: `${own.dom.name} has no record with an IP for "${fqdn}". Add one in the Internet tab.` };
  const ips = [...new Set(own.recs.map((r) => r.ip))];
  const list = ips.join(', ');
  return { ip: ips[0]!, ips, why: `${fqdn} → ${list}${ips.length > 1 ? ' (round robin, health-checked)' : ''} · ${own.dom.hosting === 'self' ? 'answered by your name server' : 'registrar DNS'}` };
}

/** How a host resolves a name: literal IP, or ask the DNS server it is configured with. */
export function resolveFor(s: WorldState, ctx: NetCtx, host: ServerDevice, name: string): { ip: string | null; why: string } {
  if (parseIp(name) !== null) return { ip: name, why: '' };
  const dnsIp = parseIp(host.dns);
  if (dnsIp === null) return { ip: null, why: `${host.name} has no DNS server set, so it cannot look up "${name}". Set one under Network, or use an IP.` };
  const p = resolveFromHost(ctx, host, dnsIp, 'udp', 53, 'fwd');
  const dns = p.reachedServer ? s.devices[p.reachedServer] : undefined;
  if (p.blocked || !dns || dns.kind !== 'server' || !up(dns)) return { ip: null, why: `${host.name} cannot reach its DNS server ${host.dns}: ${p.explain}` };
  const local = dns.roles.find((r) => r.role === 'dns_local');
  const pub = dns.roles.some((r) => r.role === 'dns_public');
  if (!local && !pub) return { ip: null, why: `${dns.name} (${host.dns}) runs no DNS role.` };
  const rec = local?.records?.find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (rec) return { ip: rec.ip, why: `${dns.name} answered ${name} → ${rec.ip}` };
  // not a local name: forward to the internet (works for your own public names)
  const out = resolveFromHost(ctx, dns, parseIp(INTERNET_IP)!, 'udp', 53, 'fwd');
  if (out.blocked) return { ip: null, why: `${dns.name} does not know "${name}" and cannot ask the internet: ${out.explain}` };
  const r = resolvePublic(s, ctx, name);
  return r.ip ? { ip: r.ip, why: `${dns.name} forwarded the lookup: ${r.why}` } : { ip: null, why: `"${name}" is unknown: add it to ${dns.name}'s local zone. (${r.why})` };
}

/** Does the host reach the internet on tcp/443? */
function internetOk(s: WorldState, ctx: NetCtx, host: ServerDevice): { ok: boolean; why: string } {
  const p = resolveFromHost(ctx, host, parseIp(INTERNET_IP)!, 'tcp', 443, 'fwd');
  const upl = Object.values(s.devices).find((d) => d.kind === 'uplink');
  if (!p.blocked && p.reachedServer === upl?.id) return { ok: true, why: '' };
  return { ok: false, why: p.explain };
}

export function refreshNames(s: WorldState, cache: RuntimeCache): void {
  const ctx = buildCtx(s, cache);
  cache.resolve = {};
  for (const v of Object.values(s.services)) if (v.fqdn) cache.resolve[v.id] = resolvePublic(s, ctx, v.fqdn);
  // reverse proxies: for each service, can a proxy that knows its name reach the back end?
  cache.proxyChk = {};
  const proxies = Object.values(s.devices).filter((d): d is ServerDevice => hasRole(d, 'proxy') && up(d));
  for (const v of Object.values(s.services)) {
    if (!v.fqdn) continue;
    for (const px of proxies) {
      const rules = (px.roles.find((r) => r.role === 'proxy')!.rules ?? []).filter((r) => r.fqdn === v.fqdn);
      if (!rules.length) continue;
      const key = `${v.id}@${px.id}`;
      // every rule for this name adds back ends; a rule may also list several, comma-separated
      const backends = [...new Set(rules.flatMap((r) => r.backend.split(/[\s,]+/).filter(Boolean)))];
      const results = backends.map((be) => checkBackend(s, ctx, cache, px, v, be));
      const okOnes = results.filter((r) => r.ok);
      const seen = new Set<string>();
      const healthy = okOnes.filter((r) => r.id && !seen.has(r.id) && seen.add(r.id)).map((r) => ({ id: r.id!, ip: r.ip! }));
      cache.proxyChk[key] = okOnes.length
        ? { ok: true, why: backends.length > 1 ? `${px.name} balances ${v.fqdn} over ${okOnes.length}/${backends.length} healthy back ends${results.some((r) => !r.ok) ? ` (down: ${results.filter((r) => !r.ok).map((r) => r.name).join(', ')})` : ''}` : okOnes[0]!.why }
        : { ok: false, why: results.map((r) => r.why).join(' · ') || `${px.name} has no back end for ${v.fqdn}` };
      cache.proxyChk[key]!.backends = healthy;
    }
  }
  refreshMirrors(s, ctx, cache);
}

function checkBackend(s: WorldState, ctx: NetCtx, cache: RuntimeCache, px: ServerDevice, v: Service, backend: string): { ok: boolean; why: string; name: string; id?: string; ip?: string } {
  {
    {
      const rule = { backend };
      const res = resolveFor(s, ctx, px, rule.backend);
      if (!res.ip) return { ok: false, why: res.why, name: backend };
      const p = resolveFromHost(ctx, px, parseIp(res.ip)!, 'tcp', backendPort(v), 'fwd');
      const hit = p.reachedServer ? s.devices[p.reachedServer] : undefined;
      // any server running the same kind of role can take the request (load balancing)
      const role = s.devices[v.serverId]?.kind === 'server' ? (s.devices[v.serverId] as ServerDevice).roles.find((r) => r.serviceId === v.id)?.role : undefined;
      const capable = hit?.kind === 'server' && up(hit) && (hit.id === v.serverId || cache.takeover[v.serverId] === hit.id || (role && hit.roles.some((r) => r.role === role)));
      if (!p.blocked && capable) return { ok: true, why: `${px.name} passes ${v.fqdn} to ${backend}${res.ip !== backend ? ` (${res.ip})` : ''}`, name: backend, id: hit!.id, ip: res.ip };
      return { ok: false, why: p.blocked ? `${px.name} cannot reach ${backend} on tcp/${backendPort(v)}: ${p.explain}` : `${backend} does not run this kind of service`, name: backend };
    }
  }
}

function refreshMirrors(s: WorldState, ctx: NetCtx, cache: RuntimeCache): void {
  // update mirrors need the internet, directly or through a forward proxy
  cache.mirrorOk = {};
  for (const d of Object.values(s.devices)) {
    if (!hasRole(d, 'mirror')) continue;
    const r = d.roles.find((x) => x.role === 'mirror')!;
    if (!r.upstream || r.upstream === 'direct') {
      const o = internetOk(s, ctx, d);
      cache.mirrorOk[d.id] = o.ok ? { ok: true, why: 'Downloads releases straight from the internet.' } : { ok: false, why: `No internet: ${o.why}` };
      continue;
    }
    const px = s.devices[r.upstream];
    if (!hasRole(px, 'fwd_proxy') || !up(px)) { cache.mirrorOk[d.id] = { ok: false, why: 'The chosen forward proxy is down or gone.' }; continue; }
    const p = resolveFromHost(ctx, d, parseIp(px.ip) ?? 0, 'tcp', ROLES.fwd_proxy.port, 'fwd');
    if (p.blocked || p.reachedServer !== px.id) { cache.mirrorOk[d.id] = { ok: false, why: `Cannot reach ${px.name} on tcp/3128: ${p.explain}` }; continue; }
    const o = internetOk(s, ctx, px);
    cache.mirrorOk[d.id] = o.ok ? { ok: true, why: `Downloads releases through ${px.name}.` } : { ok: false, why: `${px.name} has no internet: ${o.why}` };
  }
  refreshDoors(s, ctx, cache);
}

/** Smart doors lock only while a badge reader next to them can ask an Auth server. */
function refreshDoors(s: WorldState, ctx: NetCtx, cache: RuntimeCache): void {
  cache.doors = {};
  const readers = Object.values(s.devices).filter((d) => d.kind === 'badge');
  for (const [k, t] of Object.entries(s.floor.tiles)) {
    if (t !== 'smartdoor') continue;
    const [x, y] = k.split(',').map(Number) as [number, number];
    const near = readers.filter((r) => r.gridPos.gx === x && r.gridPos.gy === y);
    if (!near.length) { cache.doors[k] = { state: 'open', why: 'This door has no controller, so it stays unlocked.' }; continue; }
    let why = '';
    let closed = false;
    for (const r of near) {
      if (r.kind !== 'badge') continue;
      if (!up(r)) { why = `the door controller is down`; closed ||= r.failMode === 'closed'; continue; }
      const ip = parseIp(r.authIp);
      if (ip === null) { why = `no Auth server IP set`; closed ||= r.failMode === 'closed'; continue; }
      const p = resolveFromHost(ctx, r, ip, 'tcp', ROLES.auth.port, 'fwd');
      const srv = p.reachedServer ? s.devices[p.reachedServer] : undefined;
      if (!p.blocked && hasRole(srv, 'auth') && up(srv)) { cache.doors[k] = { state: 'locked', why: `checks badges against ${srv.name}` }; break; }
      why = p.blocked ? `the door cannot reach ${r.authIp} on tcp/389: ${p.explain}` : `${r.authIp} runs no Auth role`;
      closed ||= r.failMode === 'closed';
    }
    why = why.replace(/\.+$/, '');
    if (!cache.doors[k]) cache.doors[k] = closed ? { state: 'sealed', why: `${why}. Fail-closed: nobody gets through, staff included.` } : { state: 'open', why: `${why}. Fail-open: anyone can walk in.` };
  }
}

/** Is this service served correctly by whoever its traffic reached? */
export function servedOk(s: WorldState, cache: RuntimeCache, v: Service, reached: DeviceId | null): { ok: boolean; why: string } {
  if (!reached) return { ok: false, why: '' };
  if (reached === v.serverId || cache.takeover[v.serverId] === reached) return { ok: true, why: '' };
  const host = s.devices[reached];
  // named services: any server running the same role is a replica (DNS round robin / failover)
  const own = s.devices[v.serverId];
  const role = own?.kind === 'server' ? own.roles.find((r) => r.serviceId === v.id)?.role : undefined;
  if (v.fqdn && role && host?.kind === 'server' && host.roles.some((r) => r.role === role) && up(host)) return { ok: true, why: `${host.name} answers ${v.fqdn} as a replica` };
  if (hasRole(host, 'proxy')) {
    const c = cache.proxyChk[`${v.id}@${reached}`];
    if (!c) return { ok: false, why: `${host.name} is a reverse proxy but has no rule for ${v.fqdn ?? 'this name'}.` };
    return c;
  }
  return { ok: false, why: `Traffic reached ${host?.name ?? '?'}, which is not the server running this service.` };
}

export const mirrorReady = (cache: RuntimeCache) => Object.values(cache.mirrorOk ?? {}).some((m) => m.ok);
export { MGMT_PORT };
