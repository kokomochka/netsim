// Packet-level path engine (Phase 3).
//
// Models what an apprentice has to configure by hand:
//   • L2: frames cross cables, switches and transparent scrubbers. A host only
//     reaches an IP that answers ARP on its own segment. Without the MAC
//     learning unlock, switches flood every port (hub behaviour).
//   • L3: hosts send to the destination if it is on their subnet, otherwise to
//     their gateway. Routers and firewalls do longest-prefix match over
//     connected networks, static routes and (when unlocked) OSPF routes.
//   • Firewalls: static NAT, then ACL on the real address, zone security
//     levels, default policy. Return traffic of allowed connections is
//     permitted (stateful).
//   • The reply path is resolved too, so a missing gateway, a missing return
//     route or an un-NATed private source breaks the service.

import { MGMT_PORT, MON_AGENT_PORT, ROLES, SNMP_PORT, FLOW_SHAPE } from '../balance';
import { STRIDE as STRIDE_NET } from '../state/city';
import { formatCidr, formatIp, inCidr, isAny, parseCidr, parseIp, parsePortRange, prefixToMask, subnetOf, type Cidr } from '../state/ip';
import type {
  BlockReason, Cable, CableId, DdosScrubberDevice, Device, DeviceId, FirewallDevice, FirewallInterface,
  Flow, Hop, L3Device, NatEntry, ResolvedPath, Route, RuntimeCache, ServerDevice, Service, WorldState, PortVlan,
} from '../state/types';

// ─── Context ────────────────────────────────────────────────────────────────

interface Link { cableId: CableId; peerId: DeviceId; peerPort: number; cable: Cable }

export interface NetCtx {
  s: WorldState;
  links: Map<string, Link>;
  learned: RuntimeCache['learned'];
  /** standby server id → primary server it currently stands in for */
  standbyFor: Map<DeviceId, DeviceId>;
  stpBlocked: Record<CableId, DeviceId>;
  storm: Record<DeviceId, true>;
  vpnUp: NonNullable<RuntimeCache['vpnUp']>;
}

export function buildCtx(s: WorldState, cache: RuntimeCache): NetCtx {
  const links = new Map<string, Link>();
  for (const c of Object.values(s.cables)) {
    links.set(`${c.a.deviceId}:${c.a.port}`, { cableId: c.id, peerId: c.b.deviceId, peerPort: c.b.port, cable: c });
    links.set(`${c.b.deviceId}:${c.b.port}`, { cableId: c.id, peerId: c.a.deviceId, peerPort: c.a.port, cable: c });
  }
  const standbyFor = new Map<DeviceId, DeviceId>();
  for (const [primary, standby] of Object.entries(cache.takeover ?? {})) standbyFor.set(standby, primary);
  return { s, links, learned: cache.learned, standbyFor, stpBlocked: cache.stpBlocked ?? {}, storm: cache.storm ?? {}, vpnUp: cache.vpnUp ?? {} };
}

const isL2 = (d: Device) => d.kind === 'switch' || d.kind === 'ddos_scrubber';
const devUp = (d: Device) => d.health.state !== 'failed' && !(d.health.state === 'repairing' && d.health.repairKind === 'full');
const ipStr = (n: number) => formatIp(n);
const portLabel = (d: Device, p: number) => d.ports[p]?.label ?? `port ${p}`;

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface L3If { port: number; ip: number; ipText: string; cidr: Cidr; name: string; vlan: number | null }

/** Configured, usable L3 interfaces of a device (port up + cabled). */
export function l3Ifaces(ctx: NetCtx, d: Device, requireLink = true): L3If[] {
  const out: L3If[] = [];
  const add = (port: number, ip: string, mask: string, name: string, vlan: number | null = null) => {
    const n = parseIp(ip);
    const c = subnetOf(ip, mask);
    if (n === null || !c) return;
    if (requireLink && (!d.ports[port]?.up || !ctx.links.has(`${d.id}:${port}`))) return;
    out.push({ port, ip: n, ipText: ip.trim(), cidr: c, name, vlan });
  };
  switch (d.kind) {
    case 'server': add(0, d.ip, d.mask, 'eth0'); d.extra.forEach((x, i) => add(i + 1, x.ip, x.mask, `eth${i + 1}`)); break;
    case 'desk': add(0, d.ip, d.mask, 'eth0'); break;
    case 'tower': add(0, d.ip, d.mask, 'eth0'); break;
    case 'badge': add(0, d.ip, d.mask, 'eth0'); break;
    case 'router':
      for (const i of d.interfaces) add(i.port, i.ip, i.mask, portLabel(d, i.port));
      for (const v of d.subifs ?? []) add(v.port, v.ip, v.mask, `${portLabel(d, v.port)}.${v.vlan}`, v.vlan);
      break;
    case 'firewall':
      for (const i of d.interfaces) add(i.port, i.ip, i.mask, i.name);
      for (const v of d.subifs ?? []) add(v.port, v.ip, v.mask, v.name || `vlan${v.vlan}`, v.vlan);
      break;
    case 'uplink': {
      const c = parseCidr(d.publicSubnet);
      if (c) add(0, d.uplinkIp, `/${c.prefix}`, 'WAN');
      break;
    }
    default: break;
  }
  return out;
}

function answersArp(ctx: NetCtx, d: Device, port: number, ip: number, tag: number | null = null): 'own' | 'proxy' | null {
  // a box only hears frames in the VLAN of its interface: untagged for the port itself
  const ifs = l3Ifaces(ctx, d).filter((i) => i.port === port && i.vlan === tag);
  if (ifs.some((i) => i.ip === ip)) return 'own';
  const primary = ctx.standbyFor.get(d.id);
  if (primary) { const pd = ctx.s.devices[primary]; if (pd?.kind === 'server' && parseIp(pd.ip) === ip) return 'own'; }
  if ((d.kind === 'router' || d.kind === 'firewall') && ifs.some((i) => inCidr(ip, i.cidr))) {
    if (d.nat.some((n) => parseIp(n.publicIp) === ip)) return 'proxy';
  }
  return null;
}

// ─── L2 segment walk ────────────────────────────────────────────────────────

interface SegNode { devId: DeviceId; inPort: number; cableId: CableId; parent: number; outPort: number | null; tag: number | null }

interface SegResult {
  nodes: SegNode[];
  endpoints: number[];     // indexes of L3 endpoints
  cables: CableId[];
  dead: string[];          // reasons branches ended
}

/** A switch port's VLAN setup (missing = access port in VLAN 1). */
export function portVlan(d: Device, port: number): PortVlan {
  return (d.kind === 'switch' ? d.vlans?.[port] : undefined) ?? { mode: 'access', vid: 1, allowed: 'all' };
}

/** Does a trunk carry this VLAN? "all", or a list like "10,20,30-35". */
export function trunkAllows(allowed: string, vid: number): boolean {
  const t = (allowed ?? 'all').trim().toLowerCase();
  if (!t || t === 'all') return true;
  return t.split(/[\s,]+/).some((part) => {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return false;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    return vid >= a && vid <= b;
  });
}

/** Breadth-first walk of the broadcast domain (one VLAN) that starts at dev:port.
 *  `tag` is the 802.1Q tag the frame leaves with (null = untagged). */
export function walkSegment(ctx: NetCtx, devId: DeviceId, port: number, tag: number | null = null): SegResult {
  const res: SegResult = { nodes: [], endpoints: [], cables: [], dead: [] };
  const seenCable = new Set<CableId>();
  const queue: { devId: DeviceId; port: number; parent: number; wire: number | null }[] = [{ devId, port, parent: -1, wire: tag }];
  while (queue.length) {
    const q = queue.shift()!;
    const link = ctx.links.get(`${q.devId}:${q.port}`);
    if (!link || seenCable.has(link.cableId)) continue;
    if (ctx.stpBlocked[link.cableId]) { seenCable.add(link.cableId); continue; }
    seenCable.add(link.cableId);
    res.cables.push(link.cableId);
    const peer = ctx.s.devices[link.peerId];
    if (!peer) continue;
    if (q.parent >= 0) res.nodes[q.parent]!.outPort = res.nodes[q.parent]!.outPort ?? q.port;
    const idx = res.nodes.push({ devId: peer.id, inPort: link.peerPort, cableId: link.cableId, parent: q.parent, outPort: null, tag: q.wire }) - 1;
    if (!devUp(peer)) { res.dead.push(`${peer.name} has failed`); continue; }
    if (!peer.ports[link.peerPort]?.up) { res.dead.push(`${peer.name} ${portLabel(peer, link.peerPort)} is down (NIC fault)`); continue; }
    if (peer.kind === 'switch') {
      if (ctx.storm[peer.id]) { res.dead.push(`broadcast storm on ${peer.name}: switches are looped without spanning tree`); continue; }
      // which VLAN is the frame in, now that it is inside the switch?
      const pin = portVlan(peer, link.peerPort);
      let vid: number;
      if (pin.mode === 'access') {
        if (q.wire !== null && q.wire !== pin.vid) { res.dead.push(`${peer.name} ${portLabel(peer, link.peerPort)} is an access port in VLAN ${pin.vid} and drops frames tagged ${q.wire}`); continue; }
        vid = pin.vid;
      } else {
        vid = q.wire ?? 1;
        if (!trunkAllows(pin.allowed, vid)) { res.dead.push(`the trunk on ${peer.name} ${portLabel(peer, link.peerPort)} does not carry VLAN ${vid}`); continue; }
      }
      const members = peer.stack ? Object.values(ctx.s.devices).filter((x) => x.kind === 'switch' && x.stack === peer.stack && devUp(x)) : [peer];
      for (const m of members) {
        for (const p of m.ports) {
          if ((m.id === peer.id && p.index === link.peerPort) || !p.up) continue;
          const pout = portVlan(m, p.index);
          if (pout.mode === 'access') { if (pout.vid === vid) queue.push({ devId: m.id, port: p.index, parent: idx, wire: null }); }
          else if (trunkAllows(pout.allowed, vid)) queue.push({ devId: m.id, port: p.index, parent: idx, wire: vid === 1 ? null : vid });
        }
      }
    } else if (peer.kind === 'ddos_scrubber') {
      queue.push({ devId: peer.id, port: link.peerPort === 0 ? 1 : 0, parent: idx, wire: q.wire });
    } else {
      res.endpoints.push(idx);
    }
  }
  return res;
}

// ─── Packet ─────────────────────────────────────────────────────────────────

export interface Pkt {
  src: number;
  srcAny: boolean;        // "visitors from everywhere"
  dst: number;
  proto: 'tcp' | 'udp' | 'icmp';
  sport: number;
  dport: number;
  syn: boolean;
  mbps: number;
  dir: 'fwd' | 'ret';
  host?: string;          // name the client asked for (HTTP Host / TLS SNI)
}

function srcMatches(pkt: Pkt, cidrText: string): boolean {
  if (isAny(cidrText)) return true;
  const c = parseCidr(cidrText);
  if (!c) return false;
  if (pkt.srcAny) return c.prefix === 0;
  return inCidr(pkt.src, c);
}

const pktDesc = (p: Pkt) => `${p.srcAny ? 'visitors' : ipStr(p.src)} → ${ipStr(p.dst)} ${p.proto}${p.proto === 'icmp' ? '' : `/${p.dport}`}`;

// ─── Path builder ───────────────────────────────────────────────────────────

class PathBuilder {
  p: ResolvedPath = {
    hops: [], blocked: false, blockedAt: null, reason: null, explain: '', ruleId: null,
    floodCables: [], resources: [], ret: null, reachedServer: null,
  };
  matches: string[] = [];
  hop(h: Omit<Hop, 'cableId'> & { cableId?: CableId | null }): Hop {
    const full: Hop = { cableId: null, ...h };
    this.p.hops.push(full);
    return full;
  }
  last(): Hop | undefined { return this.p.hops[this.p.hops.length - 1]; }
  block(reason: BlockReason, explain: string, ruleId: string | null = null): ResolvedPath {
    this.p.blocked = true;
    this.p.reason = reason;
    this.p.explain = explain;
    this.p.ruleId = ruleId;
    this.p.blockedAt = Math.max(0, this.p.hops.length - 1);
    return this.done();
  }
  ok(explain: string): ResolvedPath { this.p.explain = explain; return this.done(); }
  done(): ResolvedPath {
    (this.p as ResolvedPath & { matches?: string[] }).matches = this.matches;
    return this.p;
  }
}

export function pathMatches(p: ResolvedPath): string[] {
  return (p as ResolvedPath & { matches?: string[] }).matches ?? [];
}

/**
 * Deliver a frame from `from:outPort` to whoever answers ARP for nextHop.
 * Appends L2 hops; returns the endpoint reached or null (path blocked).
 */
function l2Deliver(ctx: NetCtx, b: PathBuilder, from: Device, outPort: number, nextHop: number, pkt: Pkt, tag: number | null = null): { dev: Device; inPort: number; tag: number | null } | null {
  const link = ctx.links.get(`${from.id}:${outPort}`);
  if (!link) {
    b.block('link_down', `${from.name} ${portLabel(from, outPort)} has no cable plugged in.`);
    return null;
  }
  if (!from.ports[outPort]?.up) {
    b.block('link_down', `${from.name} ${portLabel(from, outPort)} is down (NIC fault).`);
    return null;
  }
  const seg = walkSegment(ctx, from.id, outPort, tag);
  let target = -1;
  let how: 'own' | 'proxy' | null = null;
  for (const i of seg.endpoints) {
    const n = seg.nodes[i]!;
    const d = ctx.s.devices[n.devId]!;
    const a = answersArp(ctx, d, n.inPort, nextHop, n.tag);
    if (a) { target = i; how = a; break; }
  }
  const lastHop = b.last()!;
  if (target < 0) {
    lastHop.cableId = link.cableId;
    for (const c of seg.cables) if (c !== link.cableId) b.p.floodCables.push(c);
    b.p.resources.push(`cab:${link.cableId}`);
    const extra = seg.dead.length ? ` (${seg.dead.join('; ')})` : '';
    b.block('arp_fail',
      `${from.name} asked "who has ${ipStr(nextHop)}?" on ${portLabel(from, outPort)} and nobody answered${extra}. ` +
      'Check that the next device has that IP on the port this cable reaches.');
    return null;
  }
  // reconstruct the chain from the start to the target
  const chain: number[] = [];
  for (let i = target; i >= 0; i = seg.nodes[i]!.parent) chain.unshift(i);
  const onPath = new Set(chain.map((i) => seg.nodes[i]!.cableId));
  const anySwitch = chain.some((i) => ctx.s.devices[seg.nodes[i]!.devId]?.kind === 'switch');
  const learning = ctx.s.unlocks.macLearning;
  if (anySwitch && !learning) for (const c of seg.cables) if (!onPath.has(c)) b.p.floodCables.push(c);

  lastHop.cableId = seg.nodes[chain[0]!]!.cableId;
  for (let k = 0; k < chain.length; k++) {
    const n = seg.nodes[chain[k]!]!;
    const d = ctx.s.devices[n.devId]!;
    b.p.resources.push(`cab:${n.cableId}`);
    if (k === chain.length - 1) return { dev: d, inPort: n.inPort, tag: n.tag };
    const next = seg.nodes[chain[k + 1]!]!;
    // outPort of this L2 hop = port toward the next node
    const out = otherEnd(ctx, next.cableId, d.id);
    if (d.kind === 'switch') {
      if (learning) {
        const dst = ctx.s.devices[seg.nodes[target]!.devId];
        const mac = dst ? macOf(dst, seg.nodes[target]!.inPort) : '';
        if (mac) d.macTable[mac] = out;
      }
      b.p.resources.push(`dev:${d.id}`);
      b.hop({
        deviceId: d.id, inPort: n.inPort, outPort: out, cableId: next.cableId,
        note: learning
          ? `forwards the frame out ${portLabel(d, out)} only (MAC table)`
          : `floods the frame out every port (no MAC learning yet), the copy on ${portLabel(d, out)} reaches the target`,
      });
    } else if (d.kind === 'ddos_scrubber') {
      b.p.resources.push(`dev:${d.id}`);
      const h = b.hop({ deviceId: d.id, inPort: n.inPort, outPort: out, cableId: next.cableId, note: 'inspects and passes the traffic' });
      const verdict = scrub(d, pkt, b);
      if (verdict) {
        h.cableId = null;
        h.note = verdict;
        b.block('scrubbed', `${d.name} ${verdict}.`);
        return null;
      }
    }
  }
  void how;
  return null;
}

function otherEnd(ctx: NetCtx, cableId: CableId, devId: DeviceId): number {
  const c = ctx.s.cables[cableId]!;
  return c.a.deviceId === devId ? c.a.port : c.b.port;
}

function macOf(d: Device, port: number): string {
  switch (d.kind) {
    case 'server': return d.mac;
    case 'desk': return d.mac;
    case 'tower': return d.mac;
    case 'badge': return d.mac;
    case 'router': return d.interfaces.find((i) => i.port === port)?.mac ?? '';
    case 'firewall': return d.interfaces.find((i) => i.port === port)?.mac ?? '';
    case 'uplink': return '00:00:5e:00:01:01';
    default: return '';
  }
}

/** Returns a drop reason or null if the scrubber lets the packet through. */
function scrub(d: DdosScrubberDevice, pkt: Pkt, b: PathBuilder): string | null {
  if (pkt.dir === 'ret') return null;
  if (d.synProtection && pkt.syn) return 'drops the half-open SYN flood (SYN cookies)';
  for (let i = 0; i < d.rateLimits.length; i++) {
    const rl = d.rateLimits[i]!;
    if (!rl.enabled || !srcMatches(pkt, rl.src)) continue;
    if (rl.action === 'drop') return `drops traffic from ${rl.src} (rule #${i + 1})`;
    b.p.resources.push(`rl:${d.id}:${rl.id}`);
    b.last()!.note = `rate-limits ${rl.src} to ${rl.maxMbps} Mbps (rule #${i + 1}, shared by everything that matches)`;
    break;
  }
  if (d.autoMitigation && !pkt.srcAny && pkt.mbps > d.autoThresholdMbps) {
    return `auto-mitigation drops a source sending ${pkt.mbps.toFixed(0)} Mbps (threshold ${d.autoThresholdMbps} Mbps)`;
  }
  return null;
}

// ─── Routing ────────────────────────────────────────────────────────────────

export interface RouteHit { port: number; nextHop: number | null; desc: string; kind: 'connected' | 'static' | 'ospf'; vlan: number | null; src: string }

const AD = { connected: 0, static: 1, ospf: 110 } as const;

export function lookupRoute(ctx: NetCtx, d: L3Device, dst: number): RouteHit | null {
  const ifs = l3Ifaces(ctx, d);
  let best: { prefix: number; ad: number; metric: number; hit: RouteHit } | null = null;
  const consider = (prefix: number, ad: number, metric: number, hit: RouteHit) => {
    if (!best || prefix > best.prefix || (prefix === best.prefix && (ad < best.ad || (ad === best.ad && metric < best.metric)))) {
      best = { prefix, ad, metric, hit };
    }
  };
  for (const i of ifs) {
    if (inCidr(dst, i.cidr)) consider(i.cidr.prefix, AD.connected, 0, { port: i.port, vlan: i.vlan, src: i.ipText, nextHop: null, kind: 'connected', desc: `${formatCidr(i.cidr)} is directly connected on ${i.name}` });
  }
  const viaStatic = (r: Route, kind: 'static' | 'ospf', ad: number, via?: string) => {
    const c = parseCidr(r.dest);
    const nh = parseIp(r.nextHop);
    if (!c || nh === null || !inCidr(dst, c)) return;
    const exit = ifs.find((i) => inCidr(nh, i.cidr));
    if (!exit) return; // next hop not on a connected subnet: route is unusable
    consider(c.prefix, ad, r.metric, {
      port: exit.port, vlan: exit.vlan, src: exit.ipText, nextHop: nh, kind,
      desc: `${kind === 'static' ? 'static route' : `OSPF route${via ? ` from ${via}` : ''}`} ${formatCidr(c)} via ${r.nextHop} out ${exit.name}`,
    });
  };
  for (const r of d.routes) viaStatic(r, 'static', AD.static);
  for (const r of ctx.learned[d.id] ?? []) viaStatic(r, 'ospf', AD.ospf, r.via);
  return best ? (best as { hit: RouteHit }).hit : null;
}

// ─── Firewall ACL ───────────────────────────────────────────────────────────

/** The firewall zone a frame belongs to: the port's interface, or its VLAN sub-interface. */
function fwIf(fw: FirewallDevice, port: number, tag: number | null): FirewallInterface | undefined {
  if (tag === null) return fw.interfaces.find((i) => i.port === port);
  const v = (fw.subifs ?? []).find((x) => x.port === port && x.vlan === tag);
  if (!v) return undefined;
  return { port, name: v.name || `vlan${v.vlan}`, securityLevel: v.securityLevel ?? 50, ip: v.ip, mask: v.mask, mac: '', dhcp: v.dhcp };
}

function aclEval(fw: FirewallDevice, inIf: FirewallInterface, outIf: FirewallInterface, pkt: Pkt, b: PathBuilder, devId: DeviceId) {
  for (let i = 0; i < fw.rules.length; i++) {
    const r = fw.rules[i]!;
    if (r.srcZone !== 'any' && r.srcZone !== inIf.name) continue;
    if (r.dstZone !== 'any' && r.dstZone !== outIf.name) continue;
    if (r.protocol !== 'any' && r.protocol !== pkt.proto) continue;
    if (!srcMatches(pkt, r.src)) continue;
    if (!isAny(r.dst)) { const c = parseCidr(r.dst); if (!c || !inCidr(pkt.dst, c)) continue; }
    if (r.protocol !== 'icmp' && pkt.proto !== 'icmp' && !isAny(r.ports)) {
      const pr = parsePortRange(r.ports);
      if (!pr || pkt.dport < pr[0] || pkt.dport > pr[1]) continue;
    }
    b.matches.push(`${devId}:${r.id}`);
    return { allowed: r.action === 'allow', ruleId: r.id, desc: `ACL rule #${i + 1} ${r.action}s it` };
  }
  if (inIf.securityLevel > outIf.securityLevel) return { allowed: true, ruleId: null, desc: `no rule matched; ${inIf.name} (${inIf.securityLevel}) → ${outIf.name} (${outIf.securityLevel}) is high→low, allowed by default` };
  return {
    allowed: fw.defaultPolicy === 'allow', ruleId: null,
    desc: `no rule matched; ${inIf.name} (${inIf.securityLevel}) → ${outIf.name} (${outIf.securityLevel}) needs an allow rule, default policy is ${fw.defaultPolicy}`,
  };
}

function natFor(d: L3Device, pred: (n: NatEntry) => boolean): NatEntry | undefined {
  // port forwards are more specific than whole-address entries
  return d.nat.find((n) => n.publicPort && pred(n)) ?? d.nat.find((n) => !n.publicPort && pred(n));
}
const portOk = (n: NatEntry, proto: string, port: number) => !n.publicPort || ((n.proto ?? 'tcp') === proto && n.publicPort === port);

// ─── Walk ───────────────────────────────────────────────────────────────────

const MAX_L3_HOPS = 16;

function routeOnward(ctx: NetCtx, b: PathBuilder, start: Device, outPort: number, nextHop: number, pkt: Pkt, outTag: number | null = null): ResolvedPath {
  let cur: Device = start;
  let port = outPort;
  let nh = nextHop;
  let tag = outTag;
  for (let ttl = MAX_L3_HOPS; ttl > 0; ttl--) {
    const arrived = l2Deliver(ctx, b, cur, port, nh, pkt, tag);
    if (!arrived) return b.done();
    const d = arrived.dev;
    const inPort = arrived.inPort;
    switch (d.kind) {
      case 'server':
      case 'desk':
      case 'tower':
      case 'badge': {
        const h = b.hop({ deviceId: d.id, inPort, outPort: null, note: '' });
        b.p.resources.push(`dev:${d.id}`);
        const primaryId = d.kind === 'server' ? ctx.standbyFor.get(d.id) : undefined;
        const primary = primaryId ? ctx.s.devices[primaryId] : undefined;
        const ownsDst = parseIp(d.ip) === pkt.dst || (d.kind === 'server' && d.extra.some((x) => parseIp(x.ip) === pkt.dst)) || (primary?.kind === 'server' && parseIp(primary.ip) === pkt.dst);
        if (!ownsDst) {
          h.note = 'is not a router and drops traffic meant for someone else';
          return b.block('not_for_me', `${d.name} received a packet for ${ipStr(pkt.dst)} but hosts do not forward traffic.`);
        }
        if (pkt.dir === 'ret') {
          // a reply to a connection this host opened (monitoring polls)
          b.p.reachedServer = d.id;
          h.note = 'receives the reply';
          return b.ok(`Reply delivered to ${d.name}.`);
        }
        b.p.reachedServer = d.id;
        b.p.srcSeen = pkt.src;
        b.p.dstSeen = pkt.dst;
        const mgmt = pkt.proto === 'tcp' && pkt.dport === MGMT_PORT;
        const snmp = pkt.proto === 'udp' && pkt.dport === SNMP_PORT && d.kind !== 'server';
        const agent = d.kind === 'server' && pkt.proto === 'tcp' && pkt.dport === MON_AGENT_PORT && !!d.agents.monitor?.enabled;
        if (agent) {
          const allowed = d.agents.monitor!.masterIp?.trim() ?? '';
          if (!allowed || parseIp(allowed) !== pkt.src) {
            h.note = `monitoring agent ignores the poll from ${ipStr(pkt.src)}`;
            return b.block('port_closed', allowed
              ? `${d.name}'s monitoring agent only answers its master ${allowed}, not ${ipStr(pkt.src)}.`
              : `${d.name}'s monitoring agent has no master IP set: type the master's address into the agent.`);
          }
        }
        if (d.kind === 'server' && pkt.proto === 'udp' && pkt.dport === SNMP_PORT) {
          h.note = 'servers do not answer SNMP';
          return b.block('port_closed', `${d.name} does not answer SNMP. Servers are polled through the monitoring agent (tcp/${MON_AGENT_PORT}).`);
        }
        // web, cloud and AI answer HTTP on 80, and HTTPS on 443 only with a certificate
        const httpRoles = d.kind === 'server' && pkt.proto === 'tcp' ? d.roles.filter((r) => HTTP_ROLES.has(r.role)) : [];
        const webby = httpRoles.length > 0;
        const httpPorts = new Set(httpRoles.flatMap((r) => (r.port === 80 ? [80, 443] : [r.port])));
        if (webby && pkt.dport === 443 && httpRoles.some((r) => r.port === 80) && !httpRoles.some((r) => r.port === 443) && !(d as ServerDevice).cert && !(d as ServerDevice).roles.some((r) => r.role === 'proxy')) {
          h.note = 'has no certificate, so nothing answers HTTPS';
          return b.block('port_closed', `${d.name} has no TLS certificate, so it does not answer HTTPS on tcp/443. Buy one, or let visitors use tcp/80.`);
        }
        const https = webby && httpPorts.has(pkt.dport);
        const listens = mgmt || snmp || agent || https || (d.kind === 'server' && d.roles.some((r) => ROLES[r.role].proto === pkt.proto && (ROLES[r.role].ports ?? [r.port]).includes(pkt.dport)));
        if (!listens) {
          h.note = `has nothing listening on ${pkt.proto}/${pkt.dport}`;
          return b.block('port_closed', `${d.name} has no service on ${pkt.proto}/${pkt.dport}. Install the matching role on it.`);
        }
        const via = primary ? ` (standing in for ${primary.name} via failover)` : '';
        const isProxy = d.kind === 'server' && d.roles.some((r) => r.role === 'proxy') && pkt.host && (pkt.dport === 80 || pkt.dport === 443);
        h.note = mgmt ? `accepts the SSH management session${via}` : snmp ? 'answers the SNMP poll' : agent ? 'monitoring agent answers the poll'
          : isProxy ? `reverse proxy reads the requested name "${pkt.host}" and looks up its back end${via}`
          : `accepts the connection on ${pkt.proto}/${pkt.dport}${via}`;
        return b.ok(`Delivered to ${d.name}${via}.`);
      }
      case 'uplink': {
        const h = b.hop({ deviceId: d.id, inPort, outPort: null, note: '' });
        const block = parseCidr(d.publicSubnet);
        if (pkt.dir === 'fwd' && b.p.hops[0]?.deviceId !== d.id) {
          // traffic from inside heading to the internet (e.g. phone-tower subscribers)
          if (PRIVATE_NETS.some((c) => inCidr(pkt.dst, c))) {
            h.note = `drops it: ${ipStr(pkt.dst)} is a private address, nobody routes it on the internet`;
            return b.block('no_route', `${ipStr(pkt.dst)} is a private address, so the internet can't deliver it. It has to be inside your network: add a route (or VLAN interface) for its subnet.`);
          }
          if (block && inCidr(pkt.dst, block)) {
            h.note = 'sends it back down: the destination is one of your own addresses';
            return b.block('ttl', `Traffic for ${ipStr(pkt.dst)} came back to the ISP. Check your routes.`);
          }
          if (!block || !inCidr(pkt.src, block)) {
            h.note = `drops it: source ${ipStr(pkt.src)} is not one of your public addresses`;
            return b.block('bogon_src', `Traffic reached the ISP with private source ${ipStr(pkt.src)}. Add a static NAT entry for it on your edge device${ctx.s.unlocks.dynamicNat ? ', or a dynamic NAT rule for its network' : ''}, or give it a public IP.`);
          }
          const other = uplinkFor(ctx.s, pkt.dst);
          if (other && other.id !== d.id) {
            // another of your buildings: across the internet and in through its own line
            b.p.resources.push(`dev:${d.id}`, `dev:${other.id}`);
            h.note = `carries it across the internet to ${other.name}`;
            h.outPort = null;
            b.hop({ deviceId: other.id, inPort: null, outPort: 0, note: `ISP delivers it to ${ipStr(pkt.dst)}` });
            return routeOnward(ctx, b, other, 0, pkt.dst, pkt);
          }
          b.p.reachedServer = d.id;
          b.p.srcSeen = pkt.src;
          b.p.resources.push(`dev:${d.id}`);
          h.note = `carries it out to the internet from ${ipStr(pkt.src)} over your ${d.bandwidthMbps} Mbps line`;
          return b.ok('Reaches the internet through your ISP uplink.');
        }
        if (pkt.dir === 'fwd') {
          h.note = 'got its own traffic back';
          return b.block('ttl', 'The request looped back to the ISP. Check your routes.');
        }
        if (!block || !inCidr(pkt.src, block)) {
          h.note = `drops the reply: source ${ipStr(pkt.src)} is not one of your public addresses`;
          return b.block('bogon_src', `The reply reached the ISP with source ${ipStr(pkt.src)}. The internet cannot answer a private address. Add a static NAT entry on your edge device, or give the server a public IP.`);
        }
        b.p.resources.push(`dev:${d.id}`);
        h.note = 'sends the reply out to the visitor';
        return b.ok('Reply reaches the internet.');
      }
      case 'router':
      case 'firewall': {
        const h = b.hop({ deviceId: d.id, inPort, outPort: null, note: '' });
        b.p.resources.push(`dev:${d.id}`);
        const notes: string[] = [];
        const inIf = d.kind === 'firewall' ? fwIf(d, inPort, arrived.tag) : undefined;
        if (inIf) notes.push(`in on ${inIf.name}`);
        let srcNatted = false;
        // static NAT
        if (pkt.dir === 'fwd') {
          const n = natFor(d, (x) => parseIp(x.publicIp) === pkt.dst && portOk(x, pkt.proto, pkt.dport));
          const priv = n ? parseIp(n.privateIp) : null;
          if (n && priv !== null) {
            const to = n.publicPort ? n.privatePort ?? n.publicPort : pkt.dport;
            notes.push(n.publicPort ? `port forward ${n.publicIp}:${n.publicPort} → ${n.privateIp}:${to}` : `NAT ${n.publicIp} → ${n.privateIp}`);
            pkt = { ...pkt, dst: priv, dport: to };
          }
          const sn = natFor(d, (x) => !x.publicPort && parseIp(x.privateIp) === pkt.src);
          const spub = sn ? parseIp(sn.publicIp) : null;
          if (sn && spub !== null) { notes.push(`NAT source ${sn.privateIp} → ${sn.publicIp}`); pkt = { ...pkt, src: spub }; srcNatted = true; }
        } else {
          const n = natFor(d, (x) => parseIp(x.privateIp) === pkt.src && (!x.publicPort || ((x.proto ?? 'tcp') === pkt.proto && (x.privatePort ?? x.publicPort) === pkt.sport)));
          const pub = n ? parseIp(n.publicIp) : null;
          if (n && pub !== null) { notes.push(`NAT source ${n.privateIp} → ${n.publicIp}`); pkt = { ...pkt, src: pub, sport: n.publicPort ?? pkt.sport }; }
        }
        // is it for this box?
        if (l3Ifaces(ctx, d).some((i) => i.ip === pkt.dst)) {
          if (d.kind === 'firewall' && pkt.dir === 'fwd' && pkt.proto === 'udp' && (pkt.dport === 500 || pkt.dport === 4500)) {
            const v = (d.vpns ?? []).find((x) => x.enabled && parseIp(x.peer) === pkt.src);
            if (v) {
              h.note = [...notes, `accepts IKE from its VPN peer ${v.peer}`].join(' · ');
              b.p.reachedServer = d.id; b.p.srcSeen = pkt.src; b.p.dstSeen = pkt.dst;
              return b.ok(`${d.name} answers its VPN peer.`);
            }
          }
          if (pkt.dir === 'ret') {
            // the answer to a connection the box opened itself (firmware download)
            h.note = [...notes, 'receives the reply'].join(' · ');
            b.p.reachedServer = d.id;
            return b.ok(`Reply delivered to ${d.name}.`);
          }
          if (((pkt.proto === 'tcp' && pkt.dport === MGMT_PORT) || (pkt.proto === 'udp' && pkt.dport === SNMP_PORT)) && pkt.dir === 'fwd') {
            h.note = [...notes, pkt.dport === SNMP_PORT ? 'answers the SNMP poll' : 'accepts the SSH management session'].join(' · ');
            b.p.reachedServer = d.id;
            b.p.srcSeen = pkt.src;
            b.p.dstSeen = pkt.dst;
            return b.ok(`Delivered to ${d.name}.`);
          }
          h.note = [...notes, 'traffic is addressed to the device itself'].join(' · ');
          return b.block('port_closed', `${d.name} owns ${ipStr(pkt.dst)} but runs no website. Add a static NAT entry that maps it to your server.`);
        }
        // a VPN that covers the destination: encrypt and send it to the peer
        if (d.kind === 'firewall') {
          const tun = (d.vpns ?? []).find((v) => v.enabled && ctx.vpnUp[`${d.id}:${v.id}`]?.up && (() => { const c = parseCidr(v.remote); return !!c && inCidr(pkt.dst, c); })());
          if (tun) {
            const st = ctx.vpnUp[`${d.id}:${tun.id}`]!;
            b.p.viaTunnel = true;
            const myUp = uplinkOfDevice(ctx.s, d.id);
            if (myUp) b.p.resources.push(`dev:${myUp}`);
            if (st.site) {
              const site = ctx.s.sites?.[st.site];
              h.note = [...notes, `encrypts it into the VPN to ${site?.name ?? tun.peer}`].join(' · ');
              b.p.reachedSite = st.site;
              return b.ok(`Delivered through the VPN to ${site?.name ?? tun.peer}.`);
            }
            const pf = st.peerFw ? ctx.s.devices[st.peerFw] : undefined;
            if (!pf || (pf.kind !== 'firewall')) return b.block('no_route', `${d.name}'s VPN peer is gone.`);
            const peerUp = uplinkOfDevice(ctx.s, pf.id);
            if (peerUp) b.p.resources.push(`dev:${peerUp}`);
            h.note = [...notes, `encrypts it into the VPN to ${pf.name}`].join(' · ');
            const rt2 = lookupRoute(ctx, pf, pkt.dst);
            const h2 = b.hop({ deviceId: pf.id, inPort: null, outPort: rt2?.port ?? null, note: rt2 ? `decrypts it from the VPN · ${rt2.desc}` : 'decrypts it from the VPN' });
            b.p.resources.push(`dev:${pf.id}`);
            if (!rt2) { h2.note += ` · no route to ${ipStr(pkt.dst)}`; return b.block('no_route', `${pf.name} has no route to ${ipStr(pkt.dst)} behind the VPN.`); }
            cur = pf; port = rt2.port; tag = rt2.vlan; nh = rt2.nextHop ?? pkt.dst;
            continue;
          }
        }
        const rt = lookupRoute(ctx, d, pkt.dst);
        if (!rt) {
          h.note = [...notes, `no route to ${ipStr(pkt.dst)}`].join(' · ');
          return b.block('no_route', `${d.name} has no route to ${ipStr(pkt.dst)}. Add a static route${pkt.dir === 'ret' ? ' (a default route 0.0.0.0/0 toward the internet)' : ''} or connect that subnet.`);
        }
        notes.push(rt.desc);
        if (d.kind === 'firewall') {
          const outIf = fwIf(d, rt.port, rt.vlan) ?? d.interfaces.find((i) => i.port === rt.port)!;
          if (pkt.dir === 'fwd' && inIf) {
            const v = aclEval(d, inIf, outIf, pkt, b, d.id);
            notes.push(v.desc);
            if (!v.allowed) {
              h.note = notes.join(' · ');
              return b.block('fw_deny', `${d.name} blocked ${pktDesc(pkt)}: ${v.desc}.`, v.ruleId);
            }
          } else if (pkt.dir === 'ret') {
            notes.push('reply of an allowed connection, passed (stateful)');
          }
        }
        // dynamic source NAT: inside hosts leaving this port share its address
        if (pkt.dir === 'fwd' && ctx.s.unlocks.dynamicNat && !srcNatted) {
          const outIp = rt.src;
          const rule = (d.pat ?? []).find((r) => r.outPort === rt.port && (() => { const c = parseCidr(r.src); return !!c && inCidr(pkt.src, c); })());
          const pub = outIp ? parseIp(outIp) : null;
          if (rule && pub !== null && pub !== pkt.src) { notes.push(`dynamic NAT source ${ipStr(pkt.src)} → ${outIp}`); pkt = { ...pkt, src: pub }; }
        }
        h.outPort = rt.port;
        h.note = notes.join(' · ');
        cur = d;
        port = rt.port;
        tag = rt.vlan;
        nh = rt.nextHop ?? pkt.dst;
        break;
      }
      default:
        return b.block('link_down', 'Unexpected device.');
    }
  }
  return b.block('ttl', 'The packet bounced between devices until its TTL ran out. Two routers probably point at each other.');
}

/** Inbound request from the internet toward a public IP. */
export function resolveInbound(ctx: NetCtx, pkt: Pkt): ResolvedPath {
  const b = new PathBuilder();
  const up = uplinkFor(ctx.s, pkt.dst) ?? Object.values(ctx.s.devices).find((d) => d.kind === 'uplink');
  if (!up || up.kind !== 'uplink') return b.block('link_down', 'No uplink.');
  const h = b.hop({ deviceId: up.id, inPort: null, outPort: 0, note: `ISP receives ${pktDesc(pkt)}` });
  if (ctx.s.unlocks.upstreamFiltering) {
    for (const f of up.upstreamFilters) {
      if (f.enabled && !pkt.srcAny && srcMatches(pkt, f.src)) {
        h.note = `ISP drops it upstream (filter ${f.src}), your pipe stays clear`;
        h.outPort = null;
        return b.block('upstream_filtered', `Dropped by the ISP before it reached your uplink (filter ${f.src}).`);
      }
    }
  }
  b.p.resources.push(`dev:${up.id}`);
  const block = parseCidr(up.publicSubnet);
  if (!block || !inCidr(pkt.dst, block)) return b.block('no_route', `${ipStr(pkt.dst)} is not in your public block.`);
  h.note = `ISP sends ${pktDesc(pkt)} down your ${up.bandwidthMbps} Mbps line and asks who has ${ipStr(pkt.dst)}`;
  return routeOnward(ctx, b, up, 0, pkt.dst, pkt);
}

/** Traffic that starts at a host (server or desk PC): replies, backups, management, lateral attacks. */
export function resolveFromHost(ctx: NetCtx, host: Device, dst: number, proto: Pkt['proto'], dport: number, dir: Pkt['dir'], mbps = 0, srcIp?: number): ResolvedPath {
  const b = new PathBuilder();
  if (host.kind !== 'server' && host.kind !== 'desk' && host.kind !== 'tower' && host.kind !== 'badge') return b.block('no_ip', 'Not a host');
  const pkt: Pkt = { src: srcIp ?? parseIp(host.ip) ?? 0, srcAny: false, dst, proto, sport: dir === 'ret' ? dport : 50000, dport: dir === 'ret' ? 50000 : dport, syn: false, mbps, dir };
  const h = b.hop({ deviceId: host.id, inPort: null, outPort: 0, note: '' });
  // loopback: a host talking to one of its own addresses never touches the wire
  const mine = [host.ip, ...(host.kind === 'server' ? host.extra.map((x) => x.ip) : [])].map((x) => parseIp(x)).filter((x): x is number => x !== null);
  if (dir === 'fwd' && mine.includes(dst)) {
    const listens = (proto === 'tcp' && dport === MGMT_PORT) || (host.kind === 'server' && host.roles.some((r) => ROLES[r.role].proto === proto && (ROLES[r.role].ports ?? [r.port]).includes(dport)));
    if (!listens) { h.note = `has nothing listening on ${proto}/${dport} locally`; return b.block('port_closed', `${host.name} has no role on ${proto}/${dport}.`); }
    h.note = `talks to itself on ${proto}/${dport} (same server, no network needed)`;
    b.p.reachedServer = host.id;
    return b.ok(`Handled locally on ${host.name}.`);
  }
  const what = dir === 'ret' ? 'the reply' : `${proto}/${dport} to ${ipStr(dst)}`;
  // an extra interface (server eth1…eth3) on the destination's subnet wins
  const own0 = subnetOf(host.ip, host.mask);
  if (host.kind === 'server' && !(own0 && inCidr(dst, own0))) {
    for (let i = 0; i < host.extra.length; i++) {
      const x = host.extra[i]!;
      const side = subnetOf(x.ip, x.mask);
      if (!side || !inCidr(dst, side) || parseIp(x.ip) === null) continue;
      if (host.health.state === 'failed') return b.block('device_failed', `${host.name} is down.`);
      h.outPort = i + 1;
      h.note = `sends ${what} out eth${i + 1} on its back-end network ${formatCidr(side)}`;
      return routeOnward(ctx, b, host, i + 1, dst, srcIp === undefined ? { ...pkt, src: parseIp(x.ip)! } : pkt);
    }
  }
  const own = own0;
  if (parseIp(host.ip) === null || !own) {
    h.note = 'has no IP address';
    return b.block('no_ip', `${host.name} has no valid address on eth0 (like 192.168.10.10/24).`);
  }
  if (host.health.state === 'failed') return b.block('device_failed', `${host.name} is down.`);
  let nh: number;
  if (inCidr(dst, own)) {
    nh = dst;
    h.note = `sends ${what} directly: it is on its own subnet`;
  } else {
    const gw = parseIp(host.gateway);
    if (gw === null) {
      h.note = 'has no default gateway';
      return b.block('no_gateway', `${host.name} has no default gateway, so it cannot reach ${ipStr(dst)} outside ${formatCidr(own)}.`);
    }
    if (!inCidr(gw, own)) {
      h.note = `gateway ${host.gateway} is outside its subnet`;
      return b.block('no_gateway', `${host.name}'s gateway ${host.gateway} is not on ${formatCidr(own)}, so it cannot be reached.`);
    }
    nh = gw;
    h.note = `sends ${what} to its gateway ${host.gateway}`;
  }
  return routeOnward(ctx, b, host, 0, nh, pkt);
}

/** Reply from a server back to the visitor. */
export function resolveReply(ctx: NetCtx, server: Device, visitor: number, sport: number): ResolvedPath {
  const primary = ctx.standbyFor.get(server.id);
  const pd = primary ? ctx.s.devices[primary] : undefined;
  const vip = pd?.kind === 'server' ? parseIp(pd.ip) ?? undefined : undefined;
  return resolveFromHost(ctx, server, visitor, 'tcp', sport, 'ret', 0, vip);
}

/** Traffic a router or firewall starts itself, e.g. fetching a firmware update.
 *  It leaves by its own routing table, from the address of the exit port. */
export function resolveFromL3(ctx: NetCtx, dev: L3Device, dst: number, proto: Pkt['proto'], dport: number, mbps = 0): ResolvedPath {
  const b = new PathBuilder();
  const rt = lookupRoute(ctx, dev, dst);
  if (!rt) { b.hop({ deviceId: dev.id, inPort: null, outPort: null, note: `no route to ${ipStr(dst)}` }); return b.block('no_route', `${dev.name} has no route to ${ipStr(dst)}. Add a default route.`); }
  const src = parseIp(rt.src) ?? 0;
  b.hop({ deviceId: dev.id, inPort: null, outPort: rt.port, note: `sends ${proto}/${dport} itself: ${rt.desc}` });
  const pkt: Pkt = { src, srcAny: false, dst, proto, sport: 50000, dport, syn: false, mbps, dir: 'fwd' };
  return routeOnward(ctx, b, dev, rt.port, rt.nextHop ?? dst, pkt, rt.vlan);
}

/** Replies that come back from the internet retrace the request: NAT and the firewalls
 *  keep state for the connection, so the way out is the way back. */
function retrace(p: ResolvedPath): ResolvedPath {
  const n = p.hops.length;
  const hops = p.hops.map((_, j) => {
    const h = p.hops[n - 1 - j]!;
    return { deviceId: h.deviceId, inPort: h.outPort, outPort: h.inPort, cableId: p.hops[n - 2 - j]?.cableId ?? null, note: j === 0 ? 'the internet answers' : 'passes the reply back (connection state)' };
  });
  return { ...p, hops, ret: null, floodCables: [...p.floodCables], resources: [...p.resources], reachedServer: p.hops[0]?.deviceId ?? null, explain: 'The reply comes back the same way.' };
}

/** Request and reply. The answer must make it back through real routes and firewalls,
 *  so a missing return route or gateway shows up as a broken connection. */
export function roundTrip(ctx: NetCtx, from: Device, dst: number, proto: Pkt['proto'], dport: number, mbps = 0): ResolvedPath {
  const p = from.kind === 'router' || from.kind === 'firewall'
    ? resolveFromL3(ctx, from, dst, proto, dport, mbps)
    : resolveFromHost(ctx, from, dst, proto, dport, 'fwd', mbps);
  if (p.blocked || !p.reachedServer || p.reachedServer === from.id) return p;
  const dev = ctx.s.devices[p.reachedServer];
  if (!dev) return p;
  if (dev.kind === 'uplink') p.ret = retrace(p);
  else if (dev.kind === 'router' || dev.kind === 'firewall') p.ret = resolvePollReply(ctx, dev, dst, p.srcSeen ?? 0, proto, dport);
  else p.ret = resolveFromHost(ctx, dev, p.srcSeen ?? 0, proto, dport, 'ret', 0, p.dstSeen ?? dst);
  if (p.ret.blocked) p.explain = `The request arrives, but the reply fails: ${p.ret.explain}`;
  return p;
}

/** A connection works only if the reply made it back too. */
export function tripOk(p: ResolvedPath | undefined, to?: DeviceId): boolean {
  return !!p && !p.blocked && !!p.reachedServer && (to === undefined || p.reachedServer === to) && !(p.ret && p.ret.blocked);
}

/** How a flow splits between request and reply. */
export function flowShape(s: WorldState, f: Flow): { req: number; resp: number } {
  switch (f.kind) {
    case 'http': return s.services[f.serviceId ?? '']?.kind === 'cloud' ? FLOW_SHAPE.upload : FLOW_SHAPE.page;
    case 'proxied': return s.services[f.serviceId ?? '']?.kind === 'cloud' ? FLOW_SHAPE.upload : FLOW_SHAPE.page;
    case 'transit': return FLOW_SHAPE.page;
    case 'backup': return FLOW_SHAPE.upload;
    case 'control': return /^(fetch|mirror|fwdproxy):/.test(f.tag ?? '') ? FLOW_SHAPE.download : FLOW_SHAPE.even;
    default: return FLOW_SHAPE.even;
  }
}

/** The uplink whose public block holds this address. */
export function uplinkFor(s: WorldState, ip: number): Device | undefined {
  return Object.values(s.devices).find((u) => u.kind === 'uplink' && (() => { const c = parseCidr(u.publicSubnet); return !!c && inCidr(ip, c); })());
}

/** The uplink of the building a device stands in. */
export function uplinkOfDevice(s: WorldState, id: DeviceId): DeviceId | null {
  const d = s.devices[id];
  if (!d) return null;
  const b = Object.values(s.buildings ?? {}).find((x) => x.rects.some((q) => d.gridPos.gx >= q.x0 && d.gridPos.gx <= q.x1 && (d.gridPos.gy % (STRIDE_NET)) >= q.y0 && (d.gridPos.gy % (STRIDE_NET)) <= q.y1));
  return b?.uplinkId ?? (Object.values(s.devices).find((u) => u.kind === 'uplink')?.id ?? null);
}

/** Traffic from a remote site's network into yours, decrypted at the firewall that terminates its VPN. */
export function resolveFromSite(ctx: NetCtx, siteId: string, dst: number, proto: Pkt['proto'], dport: number, mbps = 0): ResolvedPath {
  const b = new PathBuilder();
  const site = ctx.s.sites?.[siteId];
  const entry = Object.entries(ctx.vpnUp).find(([, v]) => v.up && v.site === siteId);
  if (!site || !entry) return b.block('no_route', site ? `No VPN to ${site.name} is up.` : 'Unknown site.');
  const fw = ctx.s.devices[entry[0].split(':')[0]!];
  if (!fw || fw.kind !== 'firewall') return b.block('no_route', 'The VPN firewall is gone.');
  const net = parseCidr(site.net);
  const src = net ? (net.net + 10) >>> 0 : 0;
  const pkt: Pkt = { src, srcAny: false, dst, proto, sport: 50000, dport, syn: false, mbps, dir: 'fwd' };
  const rt = lookupRoute(ctx, fw, dst);
  const myUp = uplinkOfDevice(ctx.s, fw.id);
  if (myUp) b.p.resources.push(`dev:${myUp}`);
  b.p.viaTunnel = true;
  b.hop({ deviceId: fw.id, inPort: null, outPort: rt?.port ?? null, note: `decrypts ${site.name}'s traffic from the VPN${rt ? ` · ${rt.desc}` : ''}` });
  if (!rt) return b.block('no_route', `${fw.name} has no route to ${ipStr(dst)}.`);
  const p = routeOnward(ctx, b, fw, rt.port, rt.nextHop ?? dst, pkt, rt.vlan);
  if (!p.blocked && p.reachedServer) {
    const dev = ctx.s.devices[p.reachedServer];
    if (dev && (dev.kind === 'server' || dev.kind === 'desk' || dev.kind === 'tower' || dev.kind === 'badge')) {
      p.ret = resolveFromHost(ctx, dev, src, proto, dport, 'ret', 0, p.dstSeen ?? dst);
      if (p.ret.blocked) p.explain = `${site.name} reaches it, but the reply fails: ${p.ret.explain}`;
    }
  }
  return p;
}

/** RFC 1918 and carrier-grade NAT space: never routed on the internet. */
const PRIVATE_NETS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'].map((c) => parseCidr(c)!);

/** Roles that speak HTTP: tcp/80, or tcp/443 with a certificate. */
const HTTP_ROLES = new Set(['web', 'cloud', 'ai_frontend']);

/** Port a reverse proxy uses toward the back end: TLS ends at the proxy, so plain HTTP. */
export function backendPort(svc: Service): number {
  return svc.port || 80;
}

/** The answer to a monitoring poll: from the polled device back to the master.
 *  Hosts reply like any host; routers and firewalls send it along their own routes. */
export function resolvePollReply(ctx: NetCtx, dev: Device, polledIp: number, master: number, proto: Pkt['proto'], port: number): ResolvedPath {
  if (dev.kind === 'server' || dev.kind === 'desk' || dev.kind === 'tower' || dev.kind === 'badge') return resolveFromHost(ctx, dev, master, proto, port, 'ret', 0, polledIp);
  const b = new PathBuilder();
  if (dev.kind !== 'router' && dev.kind !== 'firewall') return b.block('no_ip', `${dev.name} cannot answer polls.`);
  const rt = lookupRoute(ctx, dev, master);
  if (!rt) { b.hop({ deviceId: dev.id, inPort: null, outPort: null, note: `no route back to ${ipStr(master)}` }); return b.block('no_route', `${dev.name} has no route back to ${ipStr(master)} for the SNMP reply. Add a route toward the master's subnet.`); }
  b.hop({ deviceId: dev.id, inPort: null, outPort: rt.port, note: `sends the SNMP reply: ${rt.desc}` });
  const pkt: Pkt = { src: polledIp, srcAny: false, dst: master, proto, sport: port, dport: 50000, syn: false, mbps: 0, dir: 'ret' };
  return routeOnward(ctx, b, dev, rt.port, rt.nextHop ?? master, pkt, rt.vlan);
}

/** Representative visitor address used for the reply check. */
export const VISITOR_IP = parseIp('198.51.100.77')!;

export function packetFor(flow: Flow): Pkt {
  const c = parseCidr(flow.srcCidr);
  const any = !c || c.prefix === 0;
  return {
    src: any ? VISITOR_IP : ((c!.net + 37) >>> 0),
    srcAny: any,
    dst: parseIp(flow.dstIp) ?? 0,
    proto: flow.protocol,
    sport: flow.srcPort,
    dport: flow.dstPort,
    syn: flow.syn,
    mbps: flow.rateMbps,
    dir: 'fwd',
    host: flow.host,
  };
}

export function resolveFlow(ctx: NetCtx, flow: Flow): ResolvedPath {
  if (flow.origin !== 'external') {
    const host = ctx.s.devices[flow.origin];
    if (!host) { const b = new PathBuilder(); return b.block('link_down', 'Source is gone.'); }
    return roundTrip(ctx, host, parseIp(flow.dstIp) ?? 0, flow.protocol, flow.dstPort, flow.rateMbps);
  }
  const pkt = packetFor(flow);
  const p = resolveInbound(ctx, pkt);
  if (flow.kind === 'http' && !p.blocked && p.reachedServer) {
    const srv = ctx.s.devices[p.reachedServer]!;
    p.ret = resolveReply(ctx, srv, pkt.src, flow.dstPort);
    if (p.ret.blocked) p.explain = `Request arrives, but the reply fails: ${p.ret.explain}`;
  }
  return p;
}

// ─── Topology services: DHCP and OSPF ───────────────────────────────────────


/** Give DHCP servers' clients an address. Mutates server ip/mask/gateway. */
export function runDhcp(ctx: NetCtx): void {
  const s = ctx.s;
  const leases = new Map<string, number>(); // iface key → next offset
  const servers = Object.values(s.devices).filter((d) => d.kind === 'server' || d.kind === 'desk' || d.kind === 'tower' || d.kind === 'badge').sort((a, b) => a.id.localeCompare(b.id));
  for (const srv of servers) {
    if ((srv.kind !== 'server' && srv.kind !== 'desk' && srv.kind !== 'tower' && srv.kind !== 'badge') || srv.addressing !== 'dhcp') continue;
    let leased = false;
    if (s.unlocks.dhcp && devUp(srv) && srv.ports[0]?.up) {
      const seg = walkSegment(ctx, srv.id, 0);
      for (const i of seg.endpoints) {
        const n = seg.nodes[i]!;
        const d = s.devices[n.devId];
        if (!d || (d.kind !== 'router' && d.kind !== 'firewall')) continue;
        const itf = n.tag === null
          ? (d.interfaces as { port: number; ip: string; mask: string; dhcp: { enabled: boolean } }[]).find((x) => x.port === n.inPort)
          : (d.subifs ?? []).find((x) => x.port === n.inPort && x.vlan === n.tag);
        const net = itf ? subnetOf(itf.ip, itf.mask) : null;
        if (!itf || !itf.dhcp?.enabled || !net) continue;
        const key = `${d.id}:${n.inPort}:${n.tag ?? 0}`;
        const off = leases.get(key) ?? 100;
        leases.set(key, off + 1);
        srv.ip = ipStr((net.net + off) >>> 0);
        srv.mask = `/${net.prefix}`;
        srv.gateway = itf.ip.trim();
        leased = true;
        break;
      }
    }
    if (!leased) { srv.ip = ''; srv.gateway = ''; }
  }
}

/** Distance-vector stand-in for OSPF: share connected networks and static routes. */
export function runOspf(ctx: NetCtx): void {
  const s = ctx.s;
  for (const k of Object.keys(ctx.learned)) delete ctx.learned[k];
  if (!s.unlocks.dynamicRouting) return;
  const speakers = Object.values(s.devices).filter((d): d is L3Device => (d.kind === 'router' || d.kind === 'firewall') && d.ospf && devUp(d));
  if (speakers.length < 2) return;
  // adjacencies: A sees B on a shared subnet in the same broadcast domain
  const adj = new Map<DeviceId, { peer: L3Device; peerIp: string }[]>();
  for (const a of speakers) {
    const list: { peer: L3Device; peerIp: string }[] = [];
    for (const ai of l3Ifaces(ctx, a)) {
      const seg = walkSegment(ctx, a.id, ai.port, ai.vlan);
      for (const i of seg.endpoints) {
        const n = seg.nodes[i]!;
        const peer = speakers.find((x) => x.id === n.devId);
        if (!peer) continue;
        const pi = l3Ifaces(ctx, peer).find((x) => x.port === n.inPort && x.vlan === n.tag && inCidr(x.ip, ai.cidr));
        if (pi) list.push({ peer, peerIp: pi.ipText });
      }
    }
    adj.set(a.id, list);
  }
  type Entry = { dest: string; metric: number; nextHop: string; via: string; origin: DeviceId };
  const tables = new Map<DeviceId, Map<string, Entry>>();
  const own = new Map<DeviceId, Set<string>>();
  for (const d of speakers) {
    const t = new Map<string, Entry>();
    const mine = new Set<string>();
    for (const i of l3Ifaces(ctx, d)) { const k = formatCidr(i.cidr); mine.add(k); t.set(k, { dest: k, metric: 0, nextHop: '', via: '', origin: d.id }); }
    for (const r of d.routes) { const c = parseCidr(r.dest); if (c) { const k = formatCidr(c); mine.add(k); if (!t.has(k)) t.set(k, { dest: k, metric: 1, nextHop: '', via: '', origin: d.id }); } }
    tables.set(d.id, t);
    own.set(d.id, mine);
  }
  for (let iter = 0; iter < speakers.length + 1; iter++) {
    let changed = false;
    for (const a of speakers) {
      const ta = tables.get(a.id)!;
      for (const { peer, peerIp } of adj.get(a.id) ?? []) {
        for (const e of tables.get(peer.id)!.values()) {
          if (own.get(a.id)!.has(e.dest)) continue;
          if (e.origin === a.id) continue;            // split horizon
          if (e.nextHop && e.via === a.name) continue;
          const m = e.metric + 1;
          const cur = ta.get(e.dest);
          if (!cur || m < cur.metric) { ta.set(e.dest, { dest: e.dest, metric: m, nextHop: peerIp, via: peer.name, origin: e.origin }); changed = true; }
        }
      }
    }
    if (!changed) break;
  }
  for (const d of speakers) {
    ctx.learned[d.id] = [...tables.get(d.id)!.values()]
      .filter((e) => e.nextHop)
      .map((e, i) => ({ id: `ospf_${i}`, dest: e.dest, nextHop: e.nextHop, metric: e.metric, via: e.via }));
  }
}

export const REASON_LABEL: Record<BlockReason, string> = {
  link_down: 'link down',
  device_failed: 'device failed',
  arp_fail: 'nobody answered ARP',
  no_route: 'no route',
  no_ip: 'no IP',
  no_gateway: 'no gateway',
  fw_deny: 'denied by firewall',
  scrubbed: 'scrubbed',
  port_closed: 'port closed',
  ttl: 'routing loop',
  bogon_src: 'private source',
  upstream_filtered: 'dropped upstream',
  not_for_me: 'not a router',
  storm: 'broadcast storm',
};

// ─── Spanning tree ──────────────────────────────────────────────────────────

/**
 * RSTP stand-in. Switches joined in a loop elect the lowest bridge id as root
 * and block every redundant switch-to-switch link. When an active link dies the
 * next topology pass picks a blocked one instead (failover). If any switch in a
 * loop runs without STP, frames circle forever: a broadcast storm.
 */
export function runStp(s: WorldState, cache: RuntimeCache): { blocked: Record<CableId, DeviceId>; storm: Record<DeviceId, true> } {
  const blocked: Record<CableId, DeviceId> = {};
  const storm: Record<DeviceId, true> = {};
  const sw = Object.values(s.devices).filter((d) => d.kind === 'switch' && devUp(d));
  const isSw = new Set(sw.map((d) => d.id));
  const edges: { id: CableId; a: DeviceId; b: DeviceId }[] = [];
  for (const c of Object.values(s.cables)) {
    if (!isSw.has(c.a.deviceId) || !isSw.has(c.b.deviceId) || c.a.deviceId === c.b.deviceId) continue;
    if (!s.devices[c.a.deviceId]!.ports[c.a.port]?.up || !s.devices[c.b.deviceId]!.ports[c.b.port]?.up) continue;
    edges.push({ id: c.id, a: c.a.deviceId, b: c.b.deviceId });
  }
  const adj = new Map<DeviceId, { id: CableId; to: DeviceId }[]>();
  for (const e of edges) {
    (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)!).push({ id: e.id, to: e.b });
    (adj.get(e.b) ?? adj.set(e.b, []).get(e.b)!).push({ id: e.id, to: e.a });
  }
  const seen = new Set<DeviceId>();
  for (const start of [...isSw].sort()) {
    if (seen.has(start)) continue;
    const comp: DeviceId[] = [];
    const q = [start];
    seen.add(start);
    while (q.length) { const x = q.shift()!; comp.push(x); for (const n of adj.get(x) ?? []) if (!seen.has(n.to)) { seen.add(n.to); q.push(n.to); } }
    const compEdges = new Set(edges.filter((e) => comp.includes(e.a)).map((e) => e.id));
    if (compEdges.size < comp.length) continue; // a tree already, no loop
    if (comp.some((id) => { const d = s.devices[id]; return d?.kind === 'switch' && !d.stp; })) {
      for (const id of comp) storm[id] = true;
      continue;
    }
    const root = [...comp].sort()[0]!;
    const tree = new Set<CableId>();
    const vis = new Set([root]);
    const bq = [root];
    while (bq.length) {
      const x = bq.shift()!;
      for (const n of (adj.get(x) ?? []).sort((m, k) => m.id.localeCompare(k.id))) {
        if (vis.has(n.to)) continue;
        vis.add(n.to);
        tree.add(n.id);
        bq.push(n.to);
      }
    }
    for (const id of compEdges) if (!tree.has(id)) { const e = edges.find((x) => x.id === id)!; blocked[id] = e.b > e.a ? e.b : e.a; }
  }
  void cache;
  return { blocked, storm };
}
