// Simulation engine (Phase 3): 20 tps fixed-timestep pipeline.
//   topology (DHCP, OSPF) → events → incidents → flows → paths → congestion
//   → usage → availability → economy → health → stats → achievements

import { seedRng } from '../rng';
import { random } from '../rng';
import {
  DAY_TICKS, DDOS_FIRST_TICK, DDOS_FLOOD_S, DDOS_INTERVAL_FLOOR_S,
  DDOS_INTERVAL_MAX_S, DDOS_INTERVAL_MIN_S, DDOS_MITIGATED_FRACTION, DDOS_RECON_S, DDOS_REWARD_SECONDS,
  DEVICE_PRICE, DEVICE_UPKEEP, MINUTE, CERT_BONUS, CERT_UPKEEP, CHASSIS, COMP_PRICE, CPU_PARTS, GPU_PARTS, LATENCY_KNEE, LATENCY_LOSS, RAM_PARTS, SWAP_SECONDS, OUTAGE_GRACE_TICKS, REPAIR, REPUTATION_GAIN_PER_MIN,
  REPUTATION_OUTAGE_HIT, ROUTER_CAPACITY_MBPS, SITE_MBPS, SITE_REVENUE, SWITCH_CAPACITY_MBPS, TICKS_PER_SEC,
  UPLINK_TIER, UPTIME_BUCKETS, DISK_TYPES, ENGINEER_SALARY, GPU_REVENUE, INTRUSION_CHECK_S, LATERAL_MBPS,
  ACCESS, AI_MBPS, CLOUD_BASE_MBPS, INTERNET_IP, DNS_MBPS, DNS_REVENUE, DOMAIN_RENEWAL, NAMED_DEMAND_BONUS, REGISTRAR_DNS_FEE, CLOUD_GROWTH_GB_PER_S, CLOUD_PAY_PER_GB, FRONTEND_LINK_MBPS, GPU_LINK_MBPS,
  LATERAL_SECONDS, PATCH_FIRST_TICK, TRANSIT_DST, DEV_BUG_CHANCE, DEV_BUG_WINDOW_S, DEV_MAX_QUALITY, DEV_QUALITY_STEP, DEV_SECONDS_PER_RELEASE, PATCH_INTERVAL_S, ROLES, TRESPASS_FIRST_TICK, TRESPASS_INTERVAL_S, VULNERABLE_AFTER_S, PATCH_FETCH_MBPS, MIRROR_FETCH_S, MIRROR_FETCH_MBPS, DEMAND_SOFT_CAP } from '../balance';
import { carryComps, diskPrice, freshComps, roleUse, serverCaps, serverPrice, serverUpkeep, specsFor, wipesArray } from '../state/hardware';
import { compName, effTflops, failedComps, hwFastTick, serverDown, setHwHooks, syncHealth } from './hw';
import { knownProblems, monitorFlows, noticeTick, setMonitorHooks } from './monitor';
import { PLAYER_BLOCK_OCTETS } from '../balance';
import { backendPort, flowShape, roundTrip, tripOk } from './net';
import { cancelJob, compromise, createJob, deskReaches, setStaffHooks, spawnTrespasser, staffTick } from './staff';
import { checkAchievements } from '../progress';
import { parseIp } from '../state/ip';
import type {
  AttackType, Component, Device, DeviceId, FaultMode, Flow, Incident, Job, RuntimeCache, ServerDevice, ServerParts, Service,
  TalkerRow, WorldState,
} from '../state/types';
import { buildCtx, pathMatches, REASON_LABEL, resolveFlow, resolveFromHost, runDhcp, runOspf, runStp } from './net';
import { climateTick, setClimateHooks } from './climate';
import { refreshNames, servedOk } from './dns';

// ─── Notices (drained by main → toasts) ─────────────────────────────────────

export interface Notice { msg: string; level: 'info' | 'warn' | 'alert' | 'good' }
export const notices: Notice[] = [];
export function notify(msg: string, level: Notice['level'] = 'info'): void {
  notices.push({ msg, level });
  if (notices.length > 20) notices.shift();
}

const rand = (a: number, b: number) => a + random() * (b - a);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;

// ─── Main tick ──────────────────────────────────────────────────────────────

let resolveCountdown = 0;

export function tick(state: WorldState, cache: RuntimeCache): void {
  if (state.speed === 0) return;
  for (let i = 0; i < state.speed; i++) {
    state.time.tick++;
    state.meta.playTimeTicks++;
    if (cache.topologyDirty) topology(state, cache);
    fireEvents(state, cache);
    updateIncidents(state, cache);
    syncServiceFlows(state, cache);
    syncInternalFlows(state, cache);
    syncTowerFlows(state, cache);
    if (state.time.tick % 10 === 0) failover(state, cache);
    if (state.time.tick % 20 === 1) refreshRoleLinks(state, cache);
    if (state.time.tick % 20 === 2 || cache.topologyDirty) refreshNames(state, cache);
    if (cache.topologyDirty || --resolveCountdown <= 0) {
      resolveAll(state, cache);
      resolveCountdown = TICKS_PER_SEC;
    }
    applyLoad(state, cache);
    serviceAvailability(state, cache);
    towerAvailability(state, cache);
    accountIncidents(state, cache);
    economy(state);
    hwFastTick(state, cache);
    climateTick(state, cache);
    staffTick(state, cache);
    noticeTick(state, cache);
    mirrorTick(state, cache);
    if (state.time.tick % TICKS_PER_SEC === 7) backupStamp(state, cache);
    if (state.time.tick % TICKS_PER_SEC === 0) devWork(state, cache);
    if (state.time.tick % 20 === 0) autoJobs(state);
    security(state, cache);
    stats(state, cache);
    if (state.time.tick % 10 === 0) checkAchievements(state, cache);
  }
}

// ─── Topology services ──────────────────────────────────────────────────────

function topology(state: WorldState, cache: RuntimeCache): void {
  const stp = runStp(state, cache);
  const name = (id: string) => state.devices[id]?.name ?? id;
  for (const id of Object.keys(stp.storm)) if (!cache.storm[id]) {
    addLog(state, id, `Broadcast storm: ${name(id)} is in a switch loop without spanning tree`, 'alert');
    notify(`Broadcast storm! ${name(id)} sits in a switch loop and STP is off on at least one switch. Frames circle forever and the whole segment goes down.`, 'alert');
    break;
  }
  for (const c of Object.keys(cache.stpBlocked)) if (!stp.blocked[c] && state.cables[c] && !Object.keys(stp.storm).length) {
    const cab = state.cables[c]!;
    notify(`Spanning tree: the standby link ${name(cab.a.deviceId)} ↔ ${name(cab.b.deviceId)} is forwarding now.`, 'good');
    addLog(state, cab.a.deviceId, `STP failover: link ${name(cab.a.deviceId)} ↔ ${name(cab.b.deviceId)} unblocked`, 'warn');
  }
  cache.stpBlocked = stp.blocked;
  cache.storm = stp.storm;
  const ctx = buildCtx(state, cache);
  runDhcp(ctx);
  runOspf(ctx);
  cache.topologyVersion++;
}

function resolveAll(state: WorldState, cache: RuntimeCache): void {
  const ctx = buildCtx(state, cache);
  for (const k of Object.keys(cache.paths)) if (!state.flows[k]) delete cache.paths[k];
  for (const f of Object.values(state.flows)) cache.paths[f.id] = resolveFlow(ctx, f);
  cache.topologyDirty = false;
}

// ─── Services and their visitor flows ───────────────────────────────────────

/** Port visitors connect to. Websites, cloud storage and AI APIs are plain HTTP on
 *  tcp/80 until whoever answers them has a certificate (their own server, or a reverse
 *  proxy that maps their name): then HTTPS on tcp/443. Decided by configuration, not
 *  reachability, so a blocked 443 shows as blocked instead of flapping. */
export function visitorPort(state: WorldState, svc: Service): number {
  if (svc.kind === 'dns') return svc.port;
  const host = state.devices[svc.serverId];
  if (host?.kind === 'server' && host.cert) return 443;
  if (svc.fqdn) {
    for (const d of Object.values(state.devices)) {
      if (d.kind === 'server' && d.cert && d.roles.some((r) => r.role === 'proxy' && (r.rules ?? []).some((x) => x.fqdn === svc.fqdn))) return 443;
    }
  }
  return 80;
}

/** Demand multipliers stack, but visitors are finite: growth slows down and levels off. */
export function softCap(m: number): number {
  return m <= 1 ? m : 1 + (m - 1) / (1 + (m - 1) / DEMAND_SOFT_CAP);
}

/** Sites answering under the same name share its visitors (and what they pay). */
export function nameSharers(state: WorldState, svc: Service): number {
  if (!svc.fqdn) return 1;
  return Math.max(1, Object.values(state.services).filter((v) => v.fqdn === svc.fqdn && v.kind === svc.kind).length);
}

function syncServiceFlows(state: WorldState, cache: RuntimeCache): void {
  const curve = 1 + 0.2 * Math.sin((2 * Math.PI * state.time.tick) / DAY_TICKS);
  for (const svc of Object.values(state.services)) {
    svc.demand = Math.max(0.7, Math.min(1.3, svc.demand + (random() - 0.5) * 0.004));
    const base = svc.kind === 'ai' ? AI_MBPS : svc.kind === 'cloud' ? CLOUD_BASE_MBPS + svc.usedGB * 0.004 : svc.kind === 'dns' ? DNS_MBPS : SITE_MBPS;
    const named = !!svc.fqdn && !!cache.resolve[svc.id]?.ip;
    const rate = (base * svc.demand * curve * softCap(svc.reputation * (named ? NAMED_DEMAND_BONUS : 1) * (svc.quality ?? 1) * certMul(state, cache, svc))) / nameSharers(state, svc);
    const dsts = endpointsOf(state, cache, svc);
    const proto = svc.kind === 'dns' ? 'udp' as const : 'tcp' as const;
    const port = visitorPort(state, svc);
    // health-checked spreading: working endpoints share the load, broken ones get a trickle
    const prev = (svc.flowIds ?? []).map((id) => state.flows[id]).filter((f): f is Flow => !!f);
    const healthy = new Set(prev.filter((f) => flowWorks(state, cache, svc, f.id)).map((f) => f.dstIp));
    const nHealthy = dsts.filter((d) => healthy.has(d)).length;
    const keep: string[] = [];
    for (const dst of dsts) {
      let f = prev.find((x) => x.dstIp === dst && x.dstPort === port && x.protocol === proto && x.host === (svc.fqdn ?? undefined));
      const share = nHealthy ? (healthy.has(dst) ? rate / nHealthy : 0.5) : rate / dsts.length;
      if (!f) {
        const id = `flw_${state.nextId++}`;
        f = { id, kind: 'http', origin: 'external', srcCidr: '0.0.0.0/0', dstIp: dst, host: svc.fqdn ?? undefined, protocol: proto, srcPort: 50000, dstPort: port, syn: false, rateMbps: share, serviceId: svc.id, incidentId: null };
        state.flows[id] = f;
        cache.topologyDirty = true;
      }
      f.rateMbps = share;
      f.healthCheck = nHealthy > 0 && !healthy.has(dst);
      keep.push(f.id);
    }
    for (const f of prev) if (!keep.includes(f.id)) { delete state.flows[f.id]; cache.topologyDirty = true; }
    svc.flowIds = keep;
    svc.flowId = keep[0] ?? null;
  }
  // flows of deleted services, and flows no service owns any more
  for (const f of Object.values(state.flows)) {
    if (f.kind === 'http' && f.serviceId && state.services[f.serviceId] && !(state.services[f.serviceId]!.flowIds ?? []).includes(f.id)) { delete state.flows[f.id]; cache.topologyDirty = true; }
  }
  // flows of deleted services
  for (const f of Object.values(state.flows)) {
    if (f.kind === 'http' && (!f.serviceId || !state.services[f.serviceId])) { delete state.flows[f.id]; cache.topologyDirty = true; }
  }
}

/** Public IPs visitors use for a service: from its domain's DNS records, or the Internet tab. */
export function endpointsOf(state: WorldState, cache: RuntimeCache, svc: Service): string[] {
  if (svc.fqdn) return cache.resolve[svc.id]?.ips ?? [];
  return Object.values(state.publicAddrs).filter((a) => a.services.includes(svc.id)).map((a) => a.ip);
}

/** Request arrives at the right place, gets served, and the reply makes it out. */
export function flowWorks(state: WorldState, cache: RuntimeCache, svc: Service, flowId: string): boolean {
  const p = cache.paths[flowId];
  if (!p || p.blocked || !p.ret || p.ret.blocked || !p.reachedServer) return false;
  const host = state.devices[p.reachedServer];
  if (!host || host.compromised) return false;
  return servedOk(state, cache, svc, p.reachedServer).ok;
}

// ─── Certificates ──────────────────────────────────────────────────────────

/** Share of a service's visitors answered by a server with a TLS certificate (the proxy, or the server itself). */
export function certShare(state: WorldState, cache: RuntimeCache, svc: Service): number {
  if (svc.kind === 'dns') return 0;
  let tot = 0, got = 0;
  for (const id of svc.flowIds ?? []) {
    const f = state.flows[id];
    const p = cache.paths[id];
    if (!f) continue;
    tot += f.rateMbps;
    const h = p?.reachedServer ? state.devices[p.reachedServer] : undefined;
    if (h?.kind === 'server' && h.cert) got += f.rateMbps;
  }
  return tot > 0 ? got / tot : 0;
}
export const certMul = (state: WorldState, cache: RuntimeCache, svc: Service) => 1 + (CERT_BONUS - 1) * certShare(state, cache, svc);

// ─── Capacity and congestion ────────────────────────────────────────────────

export function deviceCapacity(d: Device): number {
  switch (d.kind) {
    case 'uplink': return d.bandwidthMbps;
    case 'server': return serverCaps(d).total;
    case 'desk': return 1000;
    case 'ac': return 1;
    case 'badge': return 100;
    case 'tower': return 1000;
    case 'router': return ROUTER_CAPACITY_MBPS;
    case 'firewall': return d.capacityMbps;
    case 'ddos_scrubber': return d.capacityMbps;
    case 'switch': return SWITCH_CAPACITY_MBPS;
  }
}

/** Responses slow down above 80 % utilisation: visitors give up on some of them. */
export function latencyFactor(d: Device | undefined): number {
  if (!d || !('usage' in d)) return 1;
  const rho = Math.min(1, d.usage.bandwidth);
  return rho > LATENCY_KNEE ? 1 - LATENCY_LOSS * ((rho - LATENCY_KNEE) / (1 - LATENCY_KNEE)) ** 2 : 1;
}

function capacityOf(state: WorldState, key: string): number {
  const [kind, a, b] = key.split(':');
  if (kind === 'cab') return state.cables[a!]?.bandwidthMbps ?? 1000;
  if (kind === 'dev') { const d = state.devices[a!]; return d ? deviceCapacity(d) : 1; }
  if (kind === 'rl') {
    const d = state.devices[a!];
    if (d?.kind === 'ddos_scrubber') return d.rateLimits.find((r) => r.id === b)?.maxMbps ?? 1e9;
  }
  return 1e9;
}

function applyLoad(state: WorldState, cache: RuntimeCache): void {
  const load = new Map<string, number>();
  const add = (k: string, v: number) => load.set(k, (load.get(k) ?? 0) + v);
  for (const f of Object.values(state.flows)) {
    const p = cache.paths[f.id];
    if (!p) continue;
    // requests and replies both load what they cross; a box or cable both legs use
    // carries the bigger of the two (links are full duplex)
    const sh = flowShape(state, f);
    const ret = p.ret && !p.blocked && !p.ret.blocked ? p.ret : null;
    const fwd = new Set(p.resources);
    // the device that opened the connection is not charged for its own replies (nor was it for sending)
    const back = new Set((ret?.resources ?? []).filter((r) => r !== `dev:${f.origin}`));
    for (const r of new Set([...fwd, ...back])) add(r, f.rateMbps * (fwd.has(r) && back.has(r) ? Math.max(sh.req, sh.resp) : fwd.has(r) ? (ret ? sh.req : 1) : sh.resp));
    for (const c of p.floodCables) add(`cab:${c}`, f.rateMbps * (ret ? sh.req : 1));
    for (const c of ret?.floodCables ?? []) add(`cab:${c}`, f.rateMbps * sh.resp);
  }
  const factor = new Map<string, number>();
  for (const [k, v] of load) factor.set(k, Math.min(1, capacityOf(state, k) / Math.max(v, 1e-9)));

  cache.cableLoad = {};
  cache.cableCap = {};
  for (const c of Object.values(state.cables)) {
    cache.cableLoad[c.id] = load.get(`cab:${c.id}`) ?? 0;
    cache.cableCap[c.id] = c.bandwidthMbps;
  }
  cache.delivery = {};
  cache.talkers = {};
  cache.ruleHits = {};
  for (const f of Object.values(state.flows)) {
    const p = cache.paths[f.id];
    if (!p) continue;
    let fac = 1;
    for (const r of p.resources) fac = Math.min(fac, factor.get(r) ?? 1);
    if (p.ret && !p.ret.blocked) for (const r of p.ret.resources) fac = Math.min(fac, factor.get(r) ?? 1);
    cache.delivery[f.id] = fac;
    for (const m of pathMatches(p)) {
      cache.ruleHits[m] = (cache.ruleHits[m] ?? 0) + f.rateMbps;
      // keep a running count, so short sessions (SSH pushes, polls) still leave a trace
      const seen = (cache.ruleSeen ??= {});
      const cnt = (cache.ruleHitCount ??= {});
      (cache.ruleLastHit ??= {})[m] = state.time.tick;
      const k = `${f.id}|${m}`;
      if (!seen[k]) { seen[k] = true; cnt[m] = (cnt[m] ?? 0) + 1; }
    }
    // talkers: every device the flow touched
    p.hops.forEach((h, i) => {
      const blockedHere = p.blocked && p.blockedAt === i;
      const row: TalkerRow = {
        flowId: f.id, kind: f.kind,
        src: f.srcCidr === '0.0.0.0/0' ? 'visitors (any)' : f.origin !== 'external' ? (state.devices[f.origin]?.name ?? f.srcCidr) : f.srcCidr,
        dst: f.dstIp, proto: f.protocol === 'icmp' ? 'icmp' : `${f.protocol}/${f.dstPort}${f.syn ? ' SYN' : ''}`,
        mbps: f.rateMbps,
        verdict: blockedHere ? REASON_LABEL[p.reason!] : 'passed',
        ok: !blockedHere,
      };
      (cache.talkers[h.deviceId] ??= []).push(row);
    });
  }
  for (const rows of Object.values(cache.talkers)) rows.sort((a, b) => b.mbps - a.mbps);

  // device usage
  for (const d of Object.values(state.devices)) {
    if (!('usage' in d)) continue;
    const l = load.get(`dev:${d.id}`) ?? 0;
    // a device can never do more than 100 %: whatever is offered beyond that is dropped
    d.usage.offered = l;
    if (d.kind === 'server') { serverUsage(state, d, l); continue; }
    const cap = deviceCapacity(d);
    d.usage.bandwidth = Math.min(1, l / Math.max(cap, 1));
    d.usage.cpu = d.usage.bandwidth;
    d.usage.ram = d.usage.bandwidth * 0.5;
  }
  const up = Object.values(state.devices).find((d) => d.kind === 'uplink');
  cache.uplinkMbps = up ? load.get(`dev:${up.id}`) ?? 0 : 0;   // offered to the line
}

/** Per-resource load of a server: CPU, memory, disk array, network card, GPU. */
function serverUsage(state: WorldState, d: ServerDevice, offered: number): void {
  const u = d.usage;
  if (serverDown(d, state.time.tick)) { u.cpu = u.ram = u.bandwidth = u.storage = 0; u.io = u.nic = u.gpu = 0; u.capMbps = 0; u.bottleneck = 'off'; return; }
  const c = serverCaps(d);
  const served = Math.min(offered, c.total);
  const roles = roleUse(d.roles.map((r) => r.role));
  // every role keeps a base load on its reserved cores
  const idle = Math.min(0.6, roles.cores / Math.max(1, d.specs.cpuCores) * 0.25);
  u.capMbps = c.total;
  u.bottleneck = c.bottleneck;
  u.bandwidth = Math.min(1, offered / Math.max(c.total, 1));
  u.cpu = Math.min(1, idle + served / Math.max(c.cpu, 1) * (1 - idle));
  u.io = Math.min(1, served / Math.max(c.io, 1) + (d.hw.array === 'rebuilding' ? 0.3 : 0));
  u.nic = Math.min(1, served / Math.max(c.nic, 1));
  u.ram = Math.min(1, (roles.ramGB + 0.5 + served * 0.02) / Math.max(1, d.specs.ramGB));
  u.storage = Math.min(1, roles.diskGB / Math.max(1, d.specs.storageGB));
  const gpuBusy = d.roles.some((r) => r.role === 'gpu') && Object.values(state.flows).some((f) => f.kind === 'backend' && f.dstPort === ROLES.gpu.port && runtimeRef?.paths[f.id]?.reachedServer === d.id && !runtimeRef.paths[f.id]!.blocked);
  u.gpu = d.parts.gpus ? (gpuBusy ? 0.9 : 0.03) : 0;
}

// ─── Availability, reputation ───────────────────────────────────────────────

function serviceAvailability(state: WorldState, cache: RuntimeCache): void {
  for (const svc of Object.values(state.services)) {
    let a = 0;
    const ids = svc.flowIds ?? [];
    const work = ids.filter((id) => flowWorks(state, cache, svc, id));
    if (work.length && chain(state, cache, svc).ok) {
      let tot = 0, got = 0;
      for (const id of ids) {
        const f = state.flows[id];
        // a dead endpoint's health-check trickle is not lost visitors: failover already moved them
        if (!f || f.healthCheck) continue;
        tot += f.rateMbps;
        if (!work.includes(id)) continue;
        const host = state.devices[cache.paths[id]!.reachedServer!];
        const d = (cache.delivery[id] ?? 1) * latencyFactor(host);
        got += f.rateMbps * d;
      }
      a = tot > 0 ? got / tot : 0;
      // back-end legs behind a reverse proxy: a congested back end slows the whole service
      const legs = Object.values(state.flows).filter((f) => f.kind === 'proxied' && f.serviceId === svc.id);
      if (legs.length) {
        let lt = 0, lg = 0;
        for (const f of legs) { const lp = cache.paths[f.id]; lt += f.rateMbps; if (lp && tripOk(lp)) lg += f.rateMbps * (cache.delivery[f.id] ?? 1) * latencyFactor(lp.reachedServer ? state.devices[lp.reachedServer] : undefined); }
        if (lt > 0) a *= lg / lt;
      }
    }
    svc.availability = a;
    if (a >= 0.5) svc.live = true;
    if (a >= 0.99) {
      svc.upTicks++;
      svc.reputation = Math.min(2.5, svc.reputation + REPUTATION_GAIN_PER_MIN / MINUTE);
    } else svc.upTicks = 0;
    if (a <= 0.01) {
      svc.downSinceTick ??= state.time.tick;
      if (svc.live && !svc.downPenalised && state.time.tick - svc.downSinceTick > OUTAGE_GRACE_TICKS && svc.reputation > 0.5) {
        svc.downPenalised = true;
        svc.reputation = Math.max(0.5, svc.reputation - REPUTATION_OUTAGE_HIT);
        const name = state.devices[svc.serverId]?.name ?? 'A site';
        notify(`${name} has been down for 10 s. Reputation −${REPUTATION_OUTAGE_HIT}.`, 'warn');
      }
    } else {
      svc.downSinceTick = null;
      svc.downPenalised = false;
    }
  }
}

// ─── Economy ────────────────────────────────────────────────────────────────

export function upkeepOf(d: Device): number {
  if (d.kind === 'server') return serverUpkeep(d.parts) + (d.cert ? CERT_UPKEEP : 0);
  if (d.kind === 'uplink') return UPLINK_TIER[d.uplinkTier].costPerSec;
  if (d.kind === 'tower') return ACCESS[d.access].upkeep;
  if (d.kind === 'ac') return d.on ? DEVICE_UPKEEP.ac : 0.005;
  return DEVICE_UPKEEP[d.kind];
}

export function priceOf(d: Device): number {
  if (d.kind === 'tower') return ACCESS[d.access].price;
  return d.kind === 'server' ? serverPrice(d) : DEVICE_PRICE[d.kind];
}

function economy(state: WorldState): void {
  let rev = 0;
  for (const svc of Object.values(state.services)) rev += serviceRevenue(state, svc);
  for (const d of Object.values(state.devices)) if (d.kind === 'tower') rev += towerRevenue(state, d);
  let upkeep = 0;
  for (const d of Object.values(state.devices)) upkeep += upkeepOf(d);
  upkeep += Object.keys(state.staff.engineers).length * ENGINEER_SALARY;
  for (const d of Object.values(state.domains)) upkeep += DOMAIN_RENEWAL + (d.hosting === 'registrar' ? REGISTRAR_DNS_FEE : 0);
  for (const d of Object.values(state.devices)) if (d.kind === 'tower') upkeep += towerPenalty(d);
  state.economy.balance += (rev - upkeep) / TICKS_PER_SEC;
  state.economy.totalEarned += rev / TICKS_PER_SEC;
  state.economy.totalSpent += upkeep / TICKS_PER_SEC;
  state.economy.revenuePerSec = rev;
  state.economy.upkeepPerSec = upkeep;
}

// ─── Phone towers: you carry subscribers' traffic to the ISP ────────────────

function syncTowerFlows(state: WorldState, cache: RuntimeCache): void {
  const curve = 1 + 0.35 * Math.sin((2 * Math.PI * (state.time.tick + DAY_TICKS / 3)) / DAY_TICKS);
  for (const d of Object.values(state.devices)) {
    if (d.kind !== 'tower') continue;
    const sb = d.subs;
    const def = ACCESS[d.access];
    sb.demand = Math.max(0.7, Math.min(1.3, sb.demand + (random() - 0.5) * 0.004));
    if (def.spikes && state.time.tick > sb.spikeUntil && random() < 1 / (TICKS_PER_SEC * 300)) {
      sb.spikeUntil = state.time.tick + 60 * TICKS_PER_SEC;
      const why = pick(['a concert nearby', 'a football match', 'a big software release', 'a breaking news story']);
      notify(`${d.name}: traffic spike from ${why}. Expect almost double the load for a minute.`, 'warn');
      addLog(state, d.id, `${d.name}: traffic spike (${why})`, 'warn');
    }
    const spike = state.time.tick < sb.spikeUntil ? 1.8 : 1;
    const rate = def.mbps * sb.demand * curve * sb.reputation * spike;
    let f = sb.flowId ? state.flows[sb.flowId] : undefined;
    if (!f) {
      const id = `flw_${state.nextId++}`;
      f = { id, kind: 'transit', origin: d.id, srcCidr: d.ip, dstIp: TRANSIT_DST, protocol: 'tcp', srcPort: 50003, dstPort: 443, syn: false, rateMbps: rate, serviceId: null, incidentId: null };
      state.flows[id] = f;
      sb.flowId = id;
      cache.topologyDirty = true;
    }
    f.rateMbps = rate;
  }
  for (const f of Object.values(state.flows)) {
    if (f.kind === 'transit' && state.devices[f.origin]?.kind !== 'tower') { delete state.flows[f.id]; cache.topologyDirty = true; }
  }
}

function towerAvailability(state: WorldState, cache: RuntimeCache): void {
  for (const d of Object.values(state.devices)) {
    if (d.kind !== 'tower') continue;
    const sb = d.subs;
    const p = sb.flowId ? cache.paths[sb.flowId] : undefined;
    const up = Object.values(state.devices).find((x) => x.kind === 'uplink');
    let a = 0;
    if (up && tripOk(p, up.id) && !d.compromised && !isOffline(d)) a = cache.delivery[sb.flowId!] ?? 1;
    sb.availability = a;
    if (a >= 0.5) sb.live = true;
    if (a >= 0.99) { sb.upTicks++; sb.reputation = Math.min(2.5, sb.reputation + REPUTATION_GAIN_PER_MIN / MINUTE); }
    else sb.upTicks = 0;
    if (a <= 0.01) {
      sb.downSinceTick ??= state.time.tick;
      if (sb.live && state.time.tick - sb.downSinceTick === OUTAGE_GRACE_TICKS) {
        sb.reputation = Math.max(0.5, sb.reputation - REPUTATION_OUTAGE_HIT);
        notify(`${d.name}: customers have had no internet for 10 s. SLA penalty $${ACCESS[d.access].penalty}/s until it is back.`, 'alert');
      }
    } else sb.downSinceTick = null;
  }
}

/** $/s an access uplink earns: per Mbps carried to the ISP, plus a bonus for clean uptime. */
export function towerRevenue(state: WorldState, d: Device): number {
  if (d.kind !== 'tower') return 0;
  const def = ACCESS[d.access];
  const f = d.subs.flowId ? state.flows[d.subs.flowId] : undefined;
  const carried = (f?.rateMbps ?? 0) * d.subs.availability;
  const bonus = d.subs.availability >= 0.99 ? def.bonus * d.subs.reputation : 0;
  return carried * def.payPerMbps + bonus;
}

/** SLA penalty while customers are mostly offline (after the 10 s grace). */
export function towerPenalty(d: Device): number {
  if (d.kind !== 'tower') return 0;
  const sb = d.subs;
  return sb.live && sb.availability < 0.5 && sb.downSinceTick !== null ? ACCESS[d.access].penalty : 0;
}

// ─── Role chains: AI frontend → orchestrator → GPU workers, cloud → storage ─

/** Address to use for a back end: its eth1 if we share that network, otherwise eth0. */
export function linkIp(src: Device, dst: Device): string {
  if (src.kind !== 'server' || dst.kind !== 'server') return '';
  const n = (ip: string, mask: string) => { const c = subnetOf(ip, mask); return c ? `${c.net}/${c.prefix}` : null; };
  const mine = [n(src.ip, src.mask), ...src.extra.map((x) => n(x.ip, x.mask))].filter(Boolean);
  for (const x of dst.extra) { const k = n(x.ip, x.mask); if (k && mine.includes(k)) return x.ip; }
  return dst.ip;
}

function refreshRoleLinks(state: WorldState, cache: RuntimeCache): void {
  const ctx = buildCtx(state, cache);
  const out: RuntimeCache['roleLinks'] = {};
  for (const d of Object.values(state.devices)) {
    if (d.kind !== 'server') continue;
    for (const r of d.roles) {
      const def = ROLES[r.role];
      if (!def.linksTo) continue;
      const res = { ok: [] as string[], bad: [] as { id: string; why: string }[] };
      for (const id of r.links) {
        const t = state.devices[id];
        const tRole = t?.kind === 'server' ? t.roles.find((x) => def.linksTo!.includes(x.role)) : undefined;
        if (!t || t.kind !== 'server' || !tRole) { res.bad.push({ id, why: `${t?.name ?? 'That server'} does not run ${def.linksTo.map((k) => ROLES[k].label).join(' or ')}` }); continue; }
        if (isOffline(t) || t.compromised) { res.bad.push({ id, why: `${t.name} is down` }); continue; }
        if (t.id === d.id) { res.ok.push(id); continue; }
        const ip = linkIp(d, t);
        const p = roundTrip(ctx, d, parseIpLocal(ip) ?? 0, 'tcp', tRole.port);
        if (tripOk(p, t.id)) res.ok.push(id);
        else res.bad.push({ id, why: `cannot reach ${t.name} on tcp/${tRole.port}: ${p.explain}` });
      }
      out[`${d.id}:${r.role}`] = res;
    }
  }
  cache.roleLinks = out;
}

/** Is the back-end chain behind a public service working? */
export function chain(state: WorldState, cache: RuntimeCache, svc: Service): { ok: boolean; why: string; tflops: number; gpus: string[] } {
  const srv = state.devices[svc.serverId];
  if (srv?.kind !== 'server') return { ok: false, why: 'No server', tflops: 0, gpus: [] };
  if (svc.kind === 'web' || svc.kind === 'dns') return { ok: true, why: '', tflops: 0, gpus: [] };
  if (svc.kind === 'cloud') {
    const l = cache.roleLinks[`${srv.id}:cloud`];
    if (!l?.ok.length) return { ok: false, why: l?.bad[0]?.why ?? 'Link cloud storage to a NAS or SAN server', tflops: 0, gpus: [] };
    return { ok: true, why: '', tflops: 0, gpus: [] };
  }
  const fl = cache.roleLinks[`${srv.id}:ai_frontend`];
  if (!fl?.ok.length) return { ok: false, why: fl?.bad[0]?.why ?? 'Link the AI frontend to an orchestrator', tflops: 0, gpus: [] };
  let tflops = 0;
  const gpus: string[] = [];
  let why = '';
  for (const oid of fl.ok) {
    const ol = cache.roleLinks[`${oid}:orchestrator`];
    if (!ol?.ok.length) { why = ol?.bad[0]?.why ?? `Link the orchestrator on ${state.devices[oid]?.name} to GPU compute servers`; continue; }
    for (const gid of ol.ok) {
      const g = state.devices[gid];
      if (g?.kind === 'server' && !gpus.includes(gid)) { gpus.push(gid); tflops += effTflops(g); }
    }
  }
  if (!gpus.length) return { ok: false, why: why || 'No GPU workers reachable', tflops: 0, gpus };
  return { ok: true, why: '', tflops, gpus };
}

function cloudCapacityGB(state: WorldState, cache: RuntimeCache, svc: Service): number {
  const l = cache.roleLinks[`${svc.serverId}:cloud`];
  let cap = 0;
  for (const id of l?.ok ?? []) {
    const t = state.devices[id];
    if (t?.kind === 'server') cap += Math.max(0, t.specs.storageGB - roleUse(t.roles.map((r) => r.role)).diskGB);
  }
  return cap;
}

/** $/s a service earns right now. */
export function serviceRevenue(state: WorldState, svc: Service): number {
  if (svc.kind === 'ai') {
    const c = runtimeRef ? chain(state, runtimeRef, svc) : null;
    let rev = 0;
    for (const id of c?.gpus ?? []) { const g = state.devices[id]; if (g?.kind === 'server') rev += GPU_REVENUE(effTflops(g)); }
    return rev * svc.demand * svc.availability * softCap(svc.reputation * (svc.quality ?? 1) * (runtimeRef ? certMul(state, runtimeRef, svc) : 1)) / nameSharers(state, svc);
  }
  const cert = runtimeRef ? certMul(state, runtimeRef, svc) : 1;
  const named = (svc.fqdn && runtimeRef?.resolve[svc.id]?.ip ? NAMED_DEMAND_BONUS : 1) * (svc.quality ?? 1) * cert;
  if (svc.kind === 'cloud') return svc.usedGB * CLOUD_PAY_PER_GB * svc.availability * (svc.quality ?? 1) * cert;
  if (svc.kind === 'dns') return (DNS_REVENUE * svc.demand * svc.availability * softCap(svc.reputation * named)) / nameSharers(state, svc);
  return (SITE_REVENUE * svc.demand * svc.availability * softCap(svc.reputation * named)) / nameSharers(state, svc);
}

// ─── Events ─────────────────────────────────────────────────────────────────

function schedule(state: WorldState, kind: ScheduledKind, at: number): void {
  state.events = state.events.filter((e) => e.kind !== kind);
  state.events.push({ kind, triggerAt: Math.round(at) });
  state.events.sort((a, b) => a.triggerAt - b.triggerAt);
}

function ddosInterval(state: WorldState): number {
  const s = rand(DDOS_INTERVAL_MIN_S, DDOS_INTERVAL_MAX_S) * Math.max(0, 1 - 0.01 * state.economy.revenuePerSec);
  return Math.max(DDOS_INTERVAL_FLOOR_S, s) * TICKS_PER_SEC;
}

type ScheduledKind = 'ddos' | 'trespass' | 'intrusion' | 'patch_release';

export function ensureSchedule(state: WorldState): void {
  const has = (k: ScheduledKind) => state.events.some((e) => e.kind === k);
  if (!has('patch_release')) schedule(state, 'patch_release', Math.max(PATCH_FIRST_TICK, state.time.tick + rand(...PATCH_INTERVAL_S) * TICKS_PER_SEC * 0.5));
  if (!has('trespass')) schedule(state, 'trespass', Math.max(TRESPASS_FIRST_TICK, state.time.tick + rand(...TRESPASS_INTERVAL_S) * TICKS_PER_SEC * 0.5));
  if (!has('intrusion')) schedule(state, 'intrusion', state.time.tick + INTRUSION_CHECK_S * TICKS_PER_SEC);
  // hardware no longer fails on a timer: parts wear out (hw.ts)
  state.events = state.events.filter((e) => e.kind !== 'hardware_failure');
  if (!state.events.some((e) => e.kind === 'ddos')) {
    schedule(state, 'ddos', Math.max(DDOS_FIRST_TICK, state.time.tick + ddosInterval(state) * 0.5));
  }
}

function fireEvents(state: WorldState, cache: RuntimeCache): void {
  while (state.events.length && state.events[0]!.triggerAt <= state.time.tick) {
    const e = state.events.shift()!;
    if (e.kind === 'hardware_failure') {
      continue;
    } else if (e.kind === 'ddos') {
      const started = startDdos(state);
      schedule(state, 'ddos', state.time.tick + (started ? ddosInterval(state) : 60 * TICKS_PER_SEC));
    } else if (e.kind === 'patch_release') {
      state.staff.release++;
      for (const d of Object.values(state.devices)) if (d.sw && d.sw.patch < state.staff.release && d.sw.outdatedSince === null) d.sw.outdatedSince = state.time.tick;
      addLog(state, '', `Security release #${state.staff.release} published. Patch servers, PCs, routers and firewalls.`, 'warn');
      notify(`Security update #${state.staff.release} is out. Unpatched machines become vulnerable in ${VULNERABLE_AFTER_S / 60} minutes.`, 'warn');
      schedule(state, 'patch_release', state.time.tick + rand(...PATCH_INTERVAL_S) * TICKS_PER_SEC);
    } else if (e.kind === 'trespass') {
      const msg = spawnTrespasser(state);
      if (msg) { addLog(state, '', msg, msg.includes('heading') ? 'alert' : 'info'); notify(msg, msg.includes('heading') ? 'alert' : 'info'); }
      schedule(state, 'trespass', state.time.tick + rand(...TRESPASS_INTERVAL_S) * TICKS_PER_SEC);
    } else if (e.kind === 'intrusion') {
      intrusionCheck(state, cache);
      schedule(state, 'intrusion', state.time.tick + INTRUSION_CHECK_S * TICKS_PER_SEC);
    }
  }
}

// ─── Hardware failures (see hw.ts for wear) ─────────────────────────────────

export const FAULT_LABEL: Record<FaultMode, string> = {
  disk: 'disk wear', nic: 'network card fault', overheat: 'overheating', board: 'mainboard fault',
};

/** A device counts as offline while failed, or while a full repair is running. */
export function isOffline(d: Device): boolean {
  return d.health.state === 'failed' || (d.health.state === 'repairing' && d.health.repairKind === 'full');
}

function finishRepair(d: Device): void {
  const h = d.health;
  h.hp = 100;
  h.state = 'ok';
  h.fault = null;
  h.faultPort = null;
  h.degradeRatePerTick = 0;
  h.repairEndsAt = null;
  h.repairKind = null;
  for (const p of d.ports) p.up = true;
}

export type RepairKind = 'preventive' | 'full' | 'replace';

/** Repairs for routers, switches, firewalls, desks… (servers swap individual parts). */
export function repairOptions(d: Device): { kind: RepairKind; cost: number; seconds: number; label: string; why: string; allowed: boolean }[] {
  const price = priceOf(d);
  const h = d.health;
  const failed = h.state === 'failed' && h.fault !== 'overheat';
  const busy = h.state === 'repairing';
  const broken = failed || h.fault === 'nic';
  return [
    { kind: 'preventive', label: 'Preventive maintenance', cost: Math.round(price * REPAIR.preventive.costFrac), seconds: REPAIR.preventive.seconds, why: 'Clean, re-seat and replace tired parts while it runs. Resets its wear.', allowed: !broken && !busy && h.state !== 'failed' },
    { kind: 'full', label: 'Repair', cost: Math.round(price * REPAIR.full.costFrac), seconds: REPAIR.full.seconds, why: 'Fix the dead board or port. Offline until done, on site.', allowed: broken && !busy },
    { kind: 'replace', label: 'Replace unit', cost: Math.round(price * REPAIR.replace.costFrac), seconds: 6, why: 'Swap in a brand-new unit (new parts fail a little more often at first).', allowed: !busy },
  ];
}

/** Order a repair: pays now, an engineer goes to the device. */
export function startRepair(state: WorldState, _cache: RuntimeCache, id: DeviceId, kind: RepairKind, auto = false): string | null {
  const d = state.devices[id];
  if (!d) return 'No such device';
  if (d.kind === 'server' && kind !== 'replace') return 'Servers are repaired part by part';
  if (!Object.keys(state.staff.engineers).length) return 'Hire an engineer first: repairs need hands on the hardware';
  const opt = d.kind === 'server' ? { cost: priceOf(d), label: 'Replace unit', allowed: true } : repairOptions(d).find((o) => o.kind === kind)!;
  if (!opt.allowed) return 'Not available right now';
  if (Object.values(state.staff.jobs).some((j) => j.deviceId === id && j.kind !== 'update' && j.kind !== 'inspect')) return 'An engineer is already on it';
  if (state.economy.balance < opt.cost) return `Not enough money ($${opt.cost} needed)`;
  const job = createJob(state, kind, id, auto);
  if (!job) return 'Already queued';
  job.paid = opt.cost;
  if (d.kind === 'server') { job.kind = 'swap'; job.comps = d.hw.comps.map((c) => c.id); job.cold = true; }
  state.economy.balance -= opt.cost;
  state.economy.totalSpent += opt.cost;
  state.economy.repairsCount++;
  if (kind === 'preventive') { state.stats.preventiveRepairs++; state.economy.preventiveRepairs++; }
  addLog(state, id, `${d.name}: ${opt.label.toLowerCase()} ordered`, 'info');
  return null;
}

// ─── Server parts: swap, upgrade, inspect ──────────────────────────────────

/** What a spare part costs, fitted. */
export function compCost(d: ServerDevice, c: Component): number {
  const p = d.parts;
  switch (c.kind) {
    case 'disk': return Math.max(30, diskPrice(p.disk, p.diskType));
    case 'ram': return Math.max(40, Math.round(RAM_PARTS[p.ram]!.price * 0.6));
    case 'cpu': return Math.max(60, Math.round(CPU_PARTS[p.cpu]!.price * 0.6));
    case 'gpu': return Math.round(GPU_PARTS[p.gpu]!.price * 0.6);
    default: return COMP_PRICE[c.kind];
  }
}

/** Can this part be swapped while the server keeps running? */
export function hotSwap(d: ServerDevice, c: Component): boolean {
  if (c.kind === 'disk') return true;
  if (c.kind === 'psu') return d.hw.comps.filter((x) => x.kind === 'psu' && !x.failed && x.id !== c.id).length > 0;
  if (c.kind === 'fan') return CHASSIS[d.parts.chassis]?.hotFans ?? false;
  return false;
}

const hasJob = (state: WorldState, id: DeviceId, kinds: Job['kind'][]) => Object.values(state.staff.jobs).find((j) => j.deviceId === id && kinds.includes(j.kind));

/** Order new parts fitted by an engineer. Hot-swap parts keep the server running. */
export function orderSwap(state: WorldState, id: DeviceId, compIds: string[], auto = false): string | null {
  const d = state.devices[id];
  if (d?.kind !== 'server') return 'Not a server';
  if (!Object.keys(state.staff.engineers).length) return 'Hire an engineer first: parts need hands on the hardware';
  const comps = d.hw.comps.filter((c) => compIds.includes(c.id));
  if (!comps.length) return 'Nothing to replace';
  const existing = hasJob(state, id, ['swap']);
  if (existing?.started) return 'An engineer is already working on it';
  if (hasJob(state, id, ['upgrade'])) return 'An upgrade is already queued: it fits new parts anyway';
  const add = comps.filter((c) => !existing?.comps?.includes(c.id));
  if (!add.length) return 'Already ordered';
  const cost = add.reduce((a, c) => a + compCost(d, c), 0);
  if (state.economy.balance < cost) return `Not enough money ($${cost} needed)`;
  const job = existing ?? createJob(state, 'swap', id, auto);
  if (!job) return 'Already queued';
  job.comps = [...(job.comps ?? []), ...add.map((c) => c.id)];
  job.cold = d.hw.comps.filter((c) => job.comps!.includes(c.id)).some((c) => !hotSwap(d, c));
  job.paid = (job.paid ?? 0) + cost;
  job.auto = job.auto && auto;
  state.economy.balance -= cost;
  state.economy.totalSpent += cost;
  state.economy.repairsCount++;
  addLog(state, id, `${d.name}: ${add.map((c) => compName(d, c).toLowerCase()).join(', ')} ordered ($${cost}${job.cold ? ', needs downtime' : ', hot-swap'})`, 'info');
  return null;
}

/** Send someone to look at a device that is acting up. */
export function orderInspect(state: WorldState, id: DeviceId): string | null {
  if (!state.devices[id]) return 'No such device';
  if (!Object.keys(state.staff.engineers).length) return 'Hire an engineer first';
  return createJob(state, 'inspect', id, false) ? null : 'Someone is already on the way';
}

/** Fit a new configuration (pending upgrade job). */
export function applyParts(state: WorldState, cache: RuntimeCache, d: ServerDevice, next: ServerParts): void {
  const from = d.parts;
  const wipe = wipesArray(from, next);
  const grow = !wipe && next.disks > from.disks;
  d.hw.comps = carryComps(d.hw.comps, from, next);
  d.parts = next;
  d.specs = specsFor(next);
  syncServerPortsSim(state, d);
  if (wipe) {
    d.hw.array = 'ok';
    d.hw.rebuild = 0;
    if (d.roles.length) dataRestore(state, cache, d, 'The disk array was rebuilt from scratch');
  } else if (grow && next.raid !== 'single' && next.raid !== 'raid0') { d.hw.array = 'rebuilding'; d.hw.rebuild = 0; }
  d.hw.off = null;
  d.hw.clock = 1;
  cache.topologyDirty = true;
}

/** The data on a server is gone: restore it from the last backup, or lose it. */
function dataRestore(state: WorldState, cache: RuntimeCache, d: ServerDevice, why: string): void {
  void cache;
  const b = d.agents.backup;
  const nas = roleHost(state, b.targetId, 'nas');
  const saved = b.enabled && !!b.lastOk && !!nas && nas.id !== d.id && nas.health.state !== 'failed';
  if (saved) {
    addLog(state, d.id, `${d.name}: ${why.toLowerCase()}. Restored from the backup on ${nas!.name}.`, 'info');
    notify(`${d.name}: ${why.toLowerCase()}, then restored from the backup on ${nas!.name}. No data lost.`, 'good');
    return;
  }
  for (const r of d.roles) if (r.serviceId) { const v = state.services[r.serviceId]; if (v) { v.reputation = Math.max(0.5, v.reputation - 0.3); if (v.kind === 'cloud') v.usedGB = 0; } }
  if (d.roles.some((r) => r.role === 'nas' || r.role === 'san')) {
    for (const v of Object.values(state.services)) {
      const host = state.devices[v.serverId];
      if (v.kind === 'cloud' && host?.kind === 'server' && host.roles.some((r) => r.role === 'cloud' && r.links.includes(d.id))) { v.usedGB = 0; v.reputation = Math.max(0.5, v.reputation - 0.4); }
    }
  }
  addLog(state, d.id, `${d.name}: ${why.toLowerCase()}. No backup: data lost, reputation hit`, 'alert');
  notify(`${d.name}: ${why.toLowerCase()} and there was no backup. The data is gone and customers noticed (reputation −0.3).`, 'alert');
}

/** Remember when each backup agent last got through. */
function backupStamp(state: WorldState, cache: RuntimeCache): void {
  for (const d of Object.values(state.devices)) if (d.kind === 'server' && d.agents.backup.enabled && backupOk(state, cache, d.id)) d.agents.backup.lastOk = state.time.tick;
}

function syncServerPortsSim(state: WorldState, x: ServerDevice): void {
  const n = x.parts.ports ?? 1;
  const layout = [{ side: 'W', label: 'eth0' }, { side: 'E', label: 'eth1' }, { side: 'N', label: 'eth2' }, { side: 'S', label: 'eth3' }] as const;
  while (x.ports.length < n) {
    const i = x.ports.length;
    x.ports.push({ index: i, side: layout[i]!.side, offset: 0.5, label: layout[i]!.label, up: true, media: 'copper' });
  }
  x.ports.length = n;
  while (x.extra.length < n - 1) x.extra.push({ ip: '', mask: '/24' });
  x.extra.length = n - 1;
  for (const c of x.hw.comps) if (c.kind === 'nic') { const p = x.ports[c.slot]; if (p) p.up = !c.failed; }
  void state;
}

export function orderUpdate(state: WorldState, id: DeviceId, auto = false): string | null {
  const d = state.devices[id];
  if (!d?.sw) return 'Nothing to update';
  if (d.sw.patch >= state.staff.release) return 'Already up to date';
  if (!Object.keys(state.staff.engineers).length) return 'Hire an engineer first';
  return createJob(state, 'update', id, auto) ? null : 'Already queued';
}

export function orderReimage(state: WorldState, id: DeviceId, auto = false): string | null {
  const d = state.devices[id];
  if (!d?.compromised) return 'Not compromised';
  if (!Object.keys(state.staff.engineers).length) return 'Hire an engineer first';
  return createJob(state, 'reimage', id, auto) ? null : 'Already queued';
}

/**
 * Engineers act by themselves on what they know about: a problem one of them
 * has seen (on the monitoring console, or standing next to it). Patching is
 * routine and needs no alert.
 */
function autoJobs(state: WorldState): void {
  const st = state.staff;
  if (!Object.keys(st.engineers).length) return;
  for (const d of Object.values(state.devices)) {
    if (d.kind === 'uplink') continue;
    const busy = Object.values(st.jobs).some((j) => j.deviceId === d.id && j.kind !== 'update' && j.kind !== 'inspect');
    if (st.autoMaintain && !busy) {
      if (d.compromised) orderReimage(state, d.id, true);
      const acked = knownProblems(state, d).filter((p) => p.ack);
      if (d.kind === 'server') {
        const comps = acked.filter((p) => p.fix === 'swap').flatMap((p) => p.comps ?? []);
        if (comps.length) orderSwap(state, d.id, comps, true);
      } else if (acked.some((p) => p.fix === 'full')) startRepair(state, runtimeRef!, d.id, 'full', true);
      else if (acked.some((p) => p.fix === 'preventive')) startRepair(state, runtimeRef!, d.id, 'preventive', true);
    }
    if (st.autoPatch && d.sw && d.sw.patch < st.release && !d.compromised) orderUpdate(state, d.id, true);
  }
}

let runtimeRef: RuntimeCache | null = null;

function finishJob(state: WorldState, cache: RuntimeCache, j: Job): void {
  const d = state.devices[j.deviceId];
  if (!d) return;
  switch (j.kind) {
    case 'preventive': case 'full': case 'replace':
      finishRepair(d);
      d.wear = 0;
      if (j.kind === 'replace') d.age = 0;
      if (j.kind === 'preventive') d.wear = 0.05;
      state.stats.devicesRepaired++;
      addLog(state, d.id, `${d.name}: ${j.kind === 'replace' ? 'unit replaced' : j.kind === 'preventive' ? 'maintenance done' : 'repair complete'}`, 'info');
      notify(`${d.name} is healthy again.`, 'good');
      break;
    case 'swap': {
      if (d.kind !== 'server') break;
      const wasUp = !serverDown(d, state.time.tick);
      const lostBefore = d.hw.array === 'lost';
      const ids = new Set(j.comps ?? []);
      const fixed: string[] = [];
      let broke = false;
      d.hw.comps = d.hw.comps.map((c) => {
        if (!ids.has(c.id)) return c;
        fixed.push(compName(d, c).toLowerCase());
        if (c.failed) broke = true;
        return { ...c, wear: 0, age: 0, failed: false };
      });
      for (const c of d.hw.comps) if (c.kind === 'nic') { const p = d.ports[c.slot]; if (p) p.up = !c.failed; }
      finishRepair(d);
      if (lostBefore && !d.hw.comps.some((c) => c.kind === 'disk' && c.failed)) {
        d.hw.array = 'ok';
        d.hw.off = null;
        dataRestore(state, cache, d, 'The lost array was rebuilt on new drives');
      }
      if (d.hw.off && d.hw.off !== 'thermal') d.hw.off = null;   // recomputed next second
      syncHealth(state, cache, d);
      state.stats.devicesRepaired++;
      if (broke && wasUp && !j.cold) { state.stats.preventiveRepairs++; state.economy.preventiveRepairs++; }
      const hot = !j.cold && wasUp;
      addLog(state, d.id, `${d.name}: replaced ${fixed.join(', ')}${hot ? ' (hot-swap, no downtime)' : ''}`, 'info');
      notify(`${d.name}: new ${fixed.join(', ')} fitted${hot ? ' without downtime' : ''}.`, 'good');
      break;
    }
    case 'upgrade':
      if (d.kind === 'server' && j.parts) {
        applyParts(state, cache, d, j.parts);
        finishRepair(d);
        syncHealth(state, cache, d);
        addLog(state, d.id, `${d.name}: upgrade fitted`, 'info');
        notify(`${d.name}: upgrade fitted and running.`, 'good');
      }
      break;
    case 'inspect':
      addLog(state, d.id, `${d.name} checked`, 'info');
      break;
    case 'update':
      if (d.sw) { d.sw.patch = state.staff.release; d.sw.outdatedSince = null; }
      addLog(state, d.id, `${d.name}: patched to release #${state.staff.release}${j.remote ? ' (remotely)' : ' (at the console)'}`, 'info');
      break;
    case 'reimage': {
      const saved = d.kind === 'server' && backupOk(state, cache, d.id);
      d.compromised = null;
      if (d.sw) { d.sw.patch = state.staff.release; d.sw.outdatedSince = null; }
      if (d.kind === 'server' && !saved && d.roles.length) {
        for (const r of d.roles) if (r.serviceId) { const v = state.services[r.serviceId]; if (v) v.reputation = Math.max(0.5, v.reputation - 0.3); }
        addLog(state, d.id, `${d.name} reimaged. No backup: data lost, reputation −0.3`, 'warn');
        notify(`${d.name} reimaged, but without a working backup its data was lost (reputation −0.3).`, 'warn');
      } else {
        addLog(state, d.id, `${d.name} reimaged${saved ? ' and restored from backup' : ''}`, 'info');
        notify(`${d.name} is clean again${saved ? ', restored from backup' : ''}.`, 'good');
      }
      break;
    }
  }
  cache.topologyDirty = true;
}

// ─── Agents: backup, failover ───────────────────────────────────────────────

const roleHost = (state: WorldState, id: DeviceId | null, role: string) => {
  const d = id ? state.devices[id] : undefined;
  return d?.kind === 'server' && d.roles.some((r) => r.role === role) ? d : undefined;
};

/** Backup agent is healthy when its NAS is up and the backup flow gets through. */
/** Can this update job download the release right now? Sets job.waitWhy when not. */
export function fetchReady(state: WorldState, cache: RuntimeCache, j: Job): boolean {
  const d = state.devices[j.deviceId];
  const f = Object.values(state.flows).find((x) => x.kind === 'control' && x.tag === `fetch:${j.id}`);
  const p = f ? cache.paths[f.id] : undefined;
  const rel = state.staff.release;
  const name = d?.name ?? 'It';
  let why: string | undefined;
  if (!d) why = 'The device is gone.';
  else if (!p) why = 'Starting the download…';
  else if (!tripOk(p)) why = `${name} cannot download release #${rel}: ${p.explain}`;
  else {
    const src = d.updateSrc?.trim();
    const at = p.reachedServer ? state.devices[p.reachedServer] : undefined;
    if (src) {
      const role = at?.kind === 'server' ? at.roles.find((r) => r.role === 'mirror') : undefined;
      if (!role || isOffline(at!) || at!.compromised) why = `${src} is not a working update mirror.`;
      else if ((role.cachedRelease ?? 0) < rel) why = `${at!.name} has not downloaded release #${rel} yet.`;
    } else if (at?.kind !== 'uplink') why = `${name} cannot reach the internet to download release #${rel}.`;
  }
  if (why !== j.waitWhy) {
    if (why && !j.waitWhy && d && why !== 'Starting the download…') addLog(state, d.id, `${d.name}: patch waiting: ${why}`, 'warn');
    j.waitWhy = why;
  }
  return !why;
}

/** Mirrors pull each new release once, while their internet path works. */
function mirrorTick(state: WorldState, cache: RuntimeCache): void {
  const rel = state.staff.release;
  for (const d of Object.values(state.devices)) {
    if (d.kind !== 'server' || isOffline(d) || d.compromised) continue;
    const r = d.roles.find((x) => x.role === 'mirror');
    if (!r || (r.cachedRelease ?? 0) >= rel) continue;
    if (!cache.mirrorOk?.[d.id]?.ok) continue;
    r.fetchLeft = (r.fetchLeft ?? MIRROR_FETCH_S * TICKS_PER_SEC) - 1;
    if (r.fetchLeft > 0) continue;
    r.cachedRelease = rel;
    r.fetchLeft = undefined;
    addLog(state, d.id, `${d.name}: downloaded release #${rel}; devices that use it as update source can patch`, 'info');
  }
}

export function backupOk(state: WorldState, cache: RuntimeCache, id: DeviceId): boolean {
  const d = state.devices[id];
  if (d?.kind !== 'server' || !d.agents.backup.enabled) return false;
  const nas = roleHost(state, d.agents.backup.targetId, 'nas');
  if (!nas || nas.health.state === 'failed' || nas.compromised) return false;
  if (nas.id === d.id) return true; // local copy: quick restore, but it dies with the server
  const f = Object.values(state.flows).find((x) => x.kind === 'backup' && x.origin === id);
  const p = f ? cache.paths[f.id] : undefined;
  return tripOk(p, nas.id);
}

function syncInternalFlows(state: WorldState, cache: RuntimeCache): void {
  const want = new Map<string, Omit<Flow, 'id'>>();
  for (const d of Object.values(state.devices)) {
    if (d.kind === 'server' && d.agents.backup.enabled && !isOffline(d)) {
      const nas = roleHost(state, d.agents.backup.targetId, 'nas');
      if (nas && nas.id !== d.id) want.set(`backup:${d.id}`, {
        kind: 'backup', origin: d.id, srcCidr: d.ip, dstIp: nas.ip, protocol: 'tcp', srcPort: 50001, dstPort: ROLES.nas.port,
        syn: false, rateMbps: 3, serviceId: null, incidentId: null,
      });
    }
    // a hijacked desk PC probes servers over SMB (lateral movement)
    if ((d.kind === 'desk' || d.kind === 'server') && d.compromised && !isOffline(d)) {
      const servers = Object.values(state.devices).filter((x) => x.kind === 'server' && x.id !== d.id && !x.compromised);
      const tgt = servers.sort((a, b) => a.id.localeCompare(b.id))[0];
      if (tgt?.kind === 'server') want.set(`lateral:${d.id}`, {
        kind: 'attack', origin: d.id, srcCidr: 'host', dstIp: tgt.ip, protocol: 'tcp', srcPort: 50002, dstPort: 445,
        syn: false, rateMbps: LATERAL_MBPS, serviceId: null, incidentId: `lateral:${d.id}`,
      });
    }
  }
  // back-end traffic between linked roles on different servers
  for (const d of Object.values(state.devices)) {
    if (d.kind !== 'server' || isOffline(d)) continue;
    for (const r of d.roles) {
      const def = ROLES[r.role];
      if (!def.linksTo) continue;
      for (const id of cache.roleLinks[`${d.id}:${r.role}`]?.ok ?? []) {
        const t = state.devices[id];
        if (!t || t.id === d.id || t.kind !== 'server') continue;
        const tRole = t.roles.find((x) => def.linksTo!.includes(x.role));
        const svc = r.serviceId ? state.services[r.serviceId] : undefined;
        const fl = svc?.flowId ? state.flows[svc.flowId] : undefined;
        const rate = r.role === 'orchestrator' ? GPU_LINK_MBPS : r.role === 'ai_frontend' ? FRONTEND_LINK_MBPS : Math.max(2, (fl?.rateMbps ?? 10) * 0.5);
        want.set(`backend:${d.id}>${t.id}`, {
          kind: 'backend', origin: d.id, srcCidr: d.ip, dstIp: linkIp(d, t), protocol: 'tcp', srcPort: 50004, dstPort: tRole?.port ?? 0,
          syn: false, rateMbps: rate, serviceId: null, incidentId: null,
        });
      }
    }
  }
  // reverse proxies forward each visitor flow to their healthy back ends (shared evenly)
  for (const svc of Object.values(state.services)) {
    for (const fid of svc.flowIds ?? []) {
      const vf = state.flows[fid];
      const p = cache.paths[fid];
      if (!vf || !p || p.blocked || !p.reachedServer) continue;
      const px = state.devices[p.reachedServer];
      if (px?.kind !== 'server' || !px.roles.some((r) => r.role === 'proxy')) continue;
      const bes = (cache.proxyChk[`${svc.id}@${px.id}`]?.backends ?? []).filter((b) => b.id !== px.id);
      const local = (cache.proxyChk[`${svc.id}@${px.id}`]?.backends ?? []).some((b) => b.id === px.id) ? 1 : 0;
      const n = bes.length + local;
      for (const b of bes) {
        want.set(`proxied:${svc.id}>${px.id}>${b.id}`, {
          kind: 'proxied', origin: px.id, srcCidr: px.ip, dstIp: b.ip, protocol: 'tcp', srcPort: 50005, dstPort: backendPort(svc),
          syn: false, rateMbps: (vf.rateMbps * (cache.delivery[fid] ?? 1)) / n, serviceId: svc.id, incidentId: null,
        });
      }
    }
  }
  controlFlows(state, cache, want);
  const have = new Map<string, Flow>();
  for (const f of Object.values(state.flows)) {
    if (f.origin === 'external' || f.kind === 'transit') continue;
    if (f.kind === 'control') {
      const w = f.tag ? want.get(f.tag) : undefined;
      if (!w || w.dstIp !== f.dstIp || w.dstPort !== f.dstPort) { delete state.flows[f.id]; cache.topologyDirty = true; continue; }
      f.rateMbps = w.rateMbps;
      have.set(f.tag!, f);
      continue;
    }
    if (f.kind === 'proxied') {
      const k = [...want.keys()].find((x) => { const w = want.get(x)!; return w.kind === 'proxied' && w.origin === f.origin && w.dstIp === f.dstIp && w.serviceId === f.serviceId; });
      if (!k) { delete state.flows[f.id]; cache.topologyDirty = true; continue; }
      f.rateMbps = want.get(k)!.rateMbps;
      have.set(k, f);
      continue;
    }
    const key = f.kind === 'backend' ? `backend:${f.origin}>${backendTarget(state, f)}` : `${f.kind === 'backup' ? 'backup' : 'lateral'}:${f.origin}`;
    const w = want.get(key);
    if (!w || w.dstIp !== f.dstIp) { delete state.flows[f.id]; cache.topologyDirty = true; continue; }
    f.rateMbps = w.rateMbps;
    have.set(key, f);
  }
  for (const [key, w] of want) {
    if (have.has(key)) continue;
    const id = `flw_${state.nextId++}`;
    state.flows[id] = { id, ...w };
    cache.topologyDirty = true;
  }
}

function backendTarget(state: WorldState, f: Flow): string {
  for (const d of Object.values(state.devices)) if (d.kind === 'server' && (d.ip === f.dstIp || d.extra.some((x) => x.ip === f.dstIp)) && d.id !== f.origin) return d.id;
  return '?';
}

const lateralTicks: Record<string, number> = {};

function security(state: WorldState, cache: RuntimeCache): void {
  for (const f of Object.values(state.flows)) {
    if (f.kind !== 'attack' || f.origin === 'external') continue;
    const p = cache.paths[f.id];
    const tgt = p?.reachedServer ? state.devices[p.reachedServer] : undefined;
    if (!tgt) { lateralTicks[f.id] = 0; continue; }
    lateralTicks[f.id] = (lateralTicks[f.id] ?? 0) + 1;
    if (lateralTicks[f.id]! >= LATERAL_SECONDS * TICKS_PER_SEC) {
      const src = state.devices[f.origin];
      compromise(state, cache, tgt, 'lateral', `infected from ${src?.name ?? 'a hijacked machine'} over SMB (tcp/445)`);
      lateralTicks[f.id] = 0;
    }
  }
}

export function isVulnerable(state: WorldState, d: Device): boolean {
  return !!d.sw && d.sw.outdatedSince !== null && state.time.tick - d.sw.outdatedSince > VULNERABLE_AFTER_S * TICKS_PER_SEC;
}

function intrusionCheck(state: WorldState, cache: RuntimeCache): void {
  for (const d of Object.values(state.devices)) {
    if (d.compromised || isOffline(d) || !isVulnerable(state, d)) continue;
    if (d.kind === 'server') {
      const exposed = Object.values(state.services).some((v) => v.serverId === d.id && v.availability > 0);
      if (exposed && random() < 0.3) compromise(state, cache, d, 'remote', 'exploited through an unpatched service');
    } else if (d.kind === 'desk' && random() < 0.2) {
      compromise(state, cache, d, 'remote', 'phishing mail opened on an unpatched PC');
    }
  }
}

/** Standby servers answer for failed primaries (VRRP-style virtual IP). */
function failover(state: WorldState, cache: RuntimeCache): void {
  const next: Record<string, string> = {};
  const ctx = buildCtx(state, cache);
  for (const p of Object.values(state.devices)) {
    if (p.kind !== 'server' || !p.agents.failover.enabled || !p.agents.failover.partnerId) continue;
    if (!isOffline(p)) continue;
    const b = state.devices[p.agents.failover.partnerId];
    if (b?.kind !== 'server' || isOffline(b) || b.compromised) continue;
    if (!failoverReady(state, ctx, p, b).ok) continue;
    next[p.id] = b.id;
  }
  const before = JSON.stringify(cache.takeover);
  if (JSON.stringify(next) !== before) {
    for (const [pid, bid] of Object.entries(next)) {
      if (!cache.takeover[pid]) {
        const pn = state.devices[pid]?.name, bn = state.devices[bid]?.name;
        addLog(state, bid, `Failover: ${bn} took over ${pn}'s address`, 'warn');
        notify(`Failover: ${bn} took over for ${pn}.`, 'good');
        if (Object.values(state.services).some((v) => v.serverId === pid)) state.stats.failoversSurvived++;
      }
    }
    cache.takeover = next;
    cache.topologyDirty = true;
  }
}

/** Is a failover pair ready? Explains the first problem it finds. */
export function failoverReady(state: WorldState, ctx: ReturnType<typeof buildCtx>, p: Device, b: Device): { ok: boolean; why: string } {
  if (p.kind !== 'server' || b.kind !== 'server') return { ok: false, why: 'Pick a standby server' };
  const missing = p.roles.filter((r) => !b.roles.some((x) => x.role === r.role)).map((r) => ROLES[r.role].label);
  if (missing.length) return { ok: false, why: `Standby lacks: ${missing.join(', ')}` };
  const np = parseIpLocal(p.ip), nb = parseIpLocal(b.ip);
  const pn = subnetLocal(p.ip, p.mask), bn = subnetLocal(b.ip, b.mask);
  if (np === null || nb === null || !pn || !bn || pn !== bn) return { ok: false, why: 'Both servers must sit on the same subnet to share the address' };
  if (p.roles.some((r) => ROLES[r.role].stateful)) {
    const san = roleHost(state, p.agents.failover.sanId, 'san');
    if (!san || san.health.state === 'failed') return { ok: false, why: 'Stateful roles need shared SAN storage that is up' };
    const r = roundTrip(ctx, b, parseIpLocal(san.ip) ?? 0, 'tcp', ROLES.san.port);
    if (!tripOk(r)) return { ok: false, why: `Standby cannot reach the SAN: ${r.explain}` };
  }
  return { ok: true, why: 'Ready: the standby answers for this server\'s IP if it goes down' };
}

import { parseIp as parseIpLocal, subnetOf } from '../state/ip';
const subnetLocal = (ip: string, mask: string) => { const c = subnetOf(ip, mask); return c ? `${c.net}/${c.prefix}` : null; };

// ─── DDoS ───────────────────────────────────────────────────────────────────

function randomRange24(): string {
  // public-looking /24 that is not RFC1918, not our documentation block, not multicast
  for (;;) {
    const a = 11 + Math.floor(random() * 212);
    if ([127, 169, 172, 192, 198, 203, 100, 10, ...PLAYER_BLOCK_OCTETS].includes(a)) continue;
    return `${a}.${Math.floor(random() * 256)}.${Math.floor(random() * 256)}.0/24`;
  }
}

function startDdos(state: WorldState): boolean {
  if (Object.values(state.activeIncidents).some((i) => i.phase !== 'resolved')) return false;
  const live = Object.values(state.services).filter((s) => s.availability > 0.5);
  if (!live.length) return false;
  const live2 = live.filter((v) => endpointsOf(state, runtimeRef!, v).length);
  if (!live2.length) return false;
  const target = pick(live2);
  const targetIp = endpointsOf(state, runtimeRef!, target)[0]!;
  const n = state.stats.ddosTotal;
  let type: AttackType = 'http_flood';
  let ranges = 1;
  if (n === 1) ranges = 2;
  if (n >= 2) { type = pick(['http_flood', 'syn_flood', 'udp_amp'] as const); ranges = 2 + Math.floor(random() * 3); }
  const up = Object.values(state.devices).find((d) => d.kind === 'uplink');
  const bw = up?.kind === 'uplink' ? up.bandwidthMbps : 100;
  const cap = 600 * (1 + Math.max(0, n - 1) * 0.6);
  const volume = Math.min(bw * rand(1.5, 3), cap);
  const now = state.time.tick;
  const recon = rand(...DDOS_RECON_S) * TICKS_PER_SEC;
  const flood = rand(...DDOS_FLOOD_S) * TICKS_PER_SEC;
  const srcRanges = Array.from({ length: ranges }, randomRange24);
  const inc: Incident = {
    id: `inc_${state.nextId++}`, kind: 'ddos', attackType: type, phase: 'recon',
    startTick: now, floodAt: Math.round(now + recon), endAt: Math.round(now + recon + flood), endTick: null,
    targetServiceId: target.id, targetIp, probeFlowId: null, attackFlowIds: [],
    srcRanges, totalVolumeMbps: volume, offeredSum: 0, deliveredSum: 0, mitigated: null,
  };
  const pid = `flw_${state.nextId++}`;
  state.flows[pid] = {
    id: pid, kind: 'probe', origin: 'external', srcCidr: srcRanges[0]!, dstIp: targetIp,
    protocol: 'tcp', srcPort: 40000, dstPort: 22, syn: true, rateMbps: 0.5, serviceId: null, incidentId: inc.id,
  };
  inc.probeFlowId = pid;
  state.activeIncidents[inc.id] = inc;
  state.stats.ddosTotal++;
  const srv = state.devices[target.serverId];
  addLog(state, target.serverId, `Recon: port scan of ${targetIp} from ${srcRanges[0]}`, 'warn');
  notify(`Port scan against ${targetIp}${srv ? ` (${srv.name})` : ''} from ${srcRanges[0]}. Something bigger may follow.`, 'warn');
  return true;
}

const ATTACK_LABEL: Record<AttackType, string> = {
  http_flood: 'HTTP flood (tcp/80)',
  syn_flood: 'SYN flood (half-open tcp/80)',
  udp_amp: 'UDP amplification',
};

function updateIncidents(state: WorldState, cache: RuntimeCache): void {
  const now = state.time.tick;
  for (const inc of Object.values(state.activeIncidents)) {
    if (inc.phase === 'recon' && now >= inc.floodAt) {
      inc.phase = 'flood';
      if (inc.probeFlowId) delete state.flows[inc.probeFlowId];
      const per = inc.totalVolumeMbps / inc.srcRanges.length;
      for (const src of inc.srcRanges) {
        const id = `flw_${state.nextId++}`;
        const f: Flow = {
          id, kind: 'attack', origin: 'external', srcCidr: src, dstIp: inc.targetIp,
          protocol: inc.attackType === 'udp_amp' ? 'udp' : 'tcp',
          srcPort: inc.attackType === 'udp_amp' ? pick([53, 123, 1900]) : 40000 + Math.floor(random() * 20000),
          dstPort: inc.attackType === 'udp_amp' ? 1024 + Math.floor(random() * 60000) : 80,
          syn: inc.attackType === 'syn_flood', rateMbps: per, serviceId: null, incidentId: inc.id,
        };
        state.flows[id] = f;
        inc.attackFlowIds.push(id);
      }
      cache.topologyDirty = true;
      addLog(state, '', `DDoS: ${ATTACK_LABEL[inc.attackType]}, ${inc.totalVolumeMbps.toFixed(0)} Mbps from ${inc.srcRanges.join(', ')} → ${inc.targetIp}`, 'alert');
      notify(`DDoS! ${ATTACK_LABEL[inc.attackType]} at ${inc.totalVolumeMbps.toFixed(0)} Mbps against ${inc.targetIp}. Check your firewall's top talkers.`, 'alert');
    } else if (inc.phase === 'flood' && now >= inc.endAt) {
      inc.phase = 'resolved';
      inc.endTick = now;
      for (const id of inc.attackFlowIds) delete state.flows[id];
      cache.topologyDirty = true;
      const frac = inc.offeredSum > 0 ? inc.deliveredSum / inc.offeredSum : 0;
      inc.mitigated = frac < DDOS_MITIGATED_FRACTION;
      if (inc.mitigated) {
        state.stats.ddosBlocked++;
        const bonus = Math.max(50, Math.round(state.economy.revenuePerSec * DDOS_REWARD_SECONDS));
        state.economy.balance += bonus;
        state.economy.totalEarned += bonus;
        addLog(state, '', `DDoS mitigated: only ${(frac * 100).toFixed(0)} % reached the target. Bonus $${bonus}.`, 'info');
        notify(`Attack over and mitigated: ${(frac * 100).toFixed(0)} % reached the server. Bonus $${bonus}.`, 'good');
      } else {
        addLog(state, '', `DDoS ended. ${(frac * 100).toFixed(0)} % of the attack reached the target.`, 'warn');
        notify(`Attack over. ${(frac * 100).toFixed(0)} % of it reached the server, which is not mitigated (needs < 20 %).`, 'warn');
      }
    } else if (inc.phase === 'resolved' && inc.endTick !== null && now - inc.endTick > 60 * TICKS_PER_SEC) {
      delete state.activeIncidents[inc.id];
    }
  }
}

function accountIncidents(state: WorldState, cache: RuntimeCache): void {
  for (const inc of Object.values(state.activeIncidents)) {
    if (inc.phase !== 'flood') continue;
    for (const id of inc.attackFlowIds) {
      const f = state.flows[id];
      const p = cache.paths[id];
      if (!f || !p) continue;
      inc.offeredSum += f.rateMbps;
      if (p.reachedServer) inc.deliveredSum += f.rateMbps * (cache.delivery[id] ?? 1);
    }
  }
}

// ─── Stats ──────────────────────────────────────────────────────────────────

function stats(state: WorldState, cache: RuntimeCache): void {
  const s = state.stats;
  const svcs = Object.values(state.services);
  const towers = Object.values(state.devices).filter((d) => d.kind === 'tower');
  // only what has been live counts: a site or cell site still being set up is not an outage
  const avails = [
    ...svcs.filter((v) => v.live).map((v) => v.availability),
    ...towers.flatMap((t) => (t.kind === 'tower' && t.subs.live ? [t.subs.availability] : [])),
  ];
  if (avails.length) {
    const avg = avails.reduce((a, b) => a + b, 0) / avails.length;
    s.bucketTickCount++;
    s.bucketAvailSum += avg;
    if (avg < 0.99) s.totalDowntimeTicks++;
    if (s.bucketTickCount >= MINUTE) {
      s.uptimeBuckets[s.currentBucket] = s.bucketAvailSum / s.bucketTickCount;
      s.currentBucket = (s.currentBucket + 1) % UPTIME_BUCKETS;
      s.bucketTickCount = 0;
      s.bucketAvailSum = 0;
    }
  }
  // a switch with ≥3 hosts that is carrying a working site's traffic
  const busy = new Set<DeviceId>();
  for (const svc of svcs) {
    if (svc.availability <= 0) continue;
    // any working entry point of the site counts, not only the first public address
    for (const id of svc.flowIds ?? []) {
      const p = cache.paths[id];
      if (!tripOk(p)) continue;
      for (const h of p!.hops) {
        const d = state.devices[h.deviceId];
        if (d?.kind === 'switch') busy.add(d.id);
      }
    }
  }
  for (const id of busy) {
    const n = Object.values(state.cables).filter((c) => c.a.deviceId === id || c.b.deviceId === id).length;
    if (n >= 3) { s.switchTicks++; break; }
  }
}

/** Uptime over the recorded minutes plus the current partial one, weighted by time:
 *  a few seconds into a new minute count as a few seconds, not as a whole minute. */
export function uptimePercent(state: WorldState): number | null {
  const s = state.stats;
  const vals = s.uptimeBuckets.filter((v): v is number => v !== null);
  const sum = vals.reduce((a, b) => a + b, 0) * MINUTE + s.bucketAvailSum;
  const ticks = vals.length * MINUTE + s.bucketTickCount;
  return ticks ? (sum / ticks) * 100 : null;
}

// ─── Logs ───────────────────────────────────────────────────────────────────

export function addLog(state: WorldState, deviceId: DeviceId, msg: string, level: 'info' | 'warn' | 'alert'): void {
  state.logs.push({ tick: state.time.tick, deviceId, msg, level });
  if (state.logs.length > 100) state.logs.splice(0, state.logs.length - 100);
}

// ─── Carriers (visual only) ─────────────────────────────────────────────────


// ─── Init ───────────────────────────────────────────────────────────────────

export function initSimulation(state: WorldState, cache: RuntimeCache): void {
  seedRng(state.meta.rng ?? state.meta.seed);
  runtimeRef = cache;
  setStaffHooks({ notify, log: addLog, finishJob, fetchReady });
  setClimateHooks({ notify, log: addLog });
  setHwHooks({ notify, log: addLog });
  setMonitorHooks({ notify, log: addLog });
  ensureSchedule(state);
  for (const j of Object.values(state.staff.jobs)) if (!state.devices[j.deviceId]) cancelJob(state, j.id);
  cache.topologyDirty = true;
}

export function servicesOn(state: WorldState, id: DeviceId): Service[] {
  return Object.values(state.services).filter((s) => s.serverId === id);
}

export { parseIp };

/** One line on why a service is not earning, beyond what the path check says. */
export function serviceProblem(state: WorldState, cache: RuntimeCache, svc: Service): string | null {
  if (svc.fqdn && !cache.resolve[svc.id]?.ip) return cache.resolve[svc.id]?.why ?? `Looking up ${svc.fqdn}…`;
  if (!endpointsOf(state, cache, svc).length) return svc.fqdn ? `${svc.fqdn} has no record with an IP.` : 'Visitors do not know where to find it yet. In the Internet tab, put it on one of your public IPs, or give it a domain name.';
  const p = svc.flowId ? cache.paths[svc.flowId] : undefined;
  if (p && !p.blocked) {
    const so = servedOk(state, cache, svc, p.reachedServer);
    if (!so.ok && so.why) return so.why;
  }
  const c = chain(state, cache, svc);
  if (!c.ok) return c.why;
  return null;
}

// ─── App development by idle engineers ──────────────────────────────────────

/** Engineers at their desk with nothing to fix improve your apps. Deploys need SSH to the server. */
function devWork(state: WorldState, cache: RuntimeCache): void {
  const svcs = Object.values(state.services).filter((v) => v.kind !== 'dns');
  if (!svcs.length) return;
  const devs = Object.values(state.staff.engineers).filter((e) => e.state === 'seated' && !e.jobId && e.deskId);
  for (const e of devs) {
    const desk = state.devices[e.deskId!];
    if (!desk) continue;
    // work on the service that needs it most and that this desk can deploy to
    const ok = svcs.filter((v) => { const srv = state.devices[v.serverId]; return srv && (v.quality ?? 1) < DEV_MAX_QUALITY && deskReaches(state, cache, desk, srv); })
      .sort((a, b) => (a.quality ?? 1) - (b.quality ?? 1));
    const v = ok[0];
    if (!v) { e.devOn = null; continue; }
    e.devOn = v.id;
    v.devProgress = (v.devProgress ?? 0) + 1 / DEV_SECONDS_PER_RELEASE;
    if (v.devProgress < 1) continue;
    v.devProgress = 0;
    v.appVersion = (v.appVersion ?? 1) + 1;
    v.quality = Math.min(DEV_MAX_QUALITY, (v.quality ?? 1) + DEV_QUALITY_STEP);
    const srv = state.devices[v.serverId];
    const label = `${srv?.name ?? '?'} ${v.kind}${v.fqdn ? ` (${v.fqdn})` : ''}`;
    if (random() < DEV_BUG_CHANCE && srv?.sw) {
      // a bad rollout: the server is exploitable soon unless someone patches it
      srv.sw.patch = Math.min(srv.sw.patch, state.staff.release - 1);
      srv.sw.outdatedSince = state.time.tick - (VULNERABLE_AFTER_S - DEV_BUG_WINDOW_S) * TICKS_PER_SEC;
      addLog(state, srv.id, `${e.name} shipped v${v.appVersion} of ${label} with a security bug`, 'alert');
      notify(`${e.name} rolled out v${v.appVersion} of ${label}, but it has a security hole. Patch ${srv.name} within ${DEV_BUG_WINDOW_S} s or it can be hacked.`, 'alert');
    } else {
      addLog(state, v.serverId, `${e.name} released v${v.appVersion} of ${label}: quality ×${v.quality.toFixed(2)}`, 'info');
      notify(`${e.name} released v${v.appVersion} of ${label}. Quality ×${v.quality.toFixed(2)}: more visitors.`, 'good');
    }
  }
}

// ─── Control traffic: the small flows that keep everything running ──────────

function firstIp(d: Device | undefined): string {
  if (!d) return '';
  if ('ip' in d && d.ip) return d.ip;
  if (d.kind === 'router' || d.kind === 'firewall') return d.interfaces.find((i) => i.ip)?.ip ?? '';
  return '';
}

/** SSH for remote patches and deploys, LDAP for doors, DNS lookups, mirror downloads. */
function controlFlows(state: WorldState, cache: RuntimeCache, want: Map<string, Omit<Flow, 'id'>>): void {
  const add = (tag: string, origin: string, dstIp: string, protocol: 'tcp' | 'udp', dstPort: number, rateMbps: number) => {
    if (!dstIp || !state.devices[origin] || isOffline(state.devices[origin]!)) return;
    want.set(tag, { kind: 'control', tag, origin, srcCidr: 'host', dstIp, protocol, srcPort: 50010, dstPort, syn: false, rateMbps, serviceId: null, incidentId: null });
  };
  for (const e of Object.values(state.staff.engineers)) {
    const desk = e.deskId ? state.devices[e.deskId] : undefined;
    if (!desk || e.state !== 'seated') continue;
    const job = e.jobId ? state.staff.jobs[e.jobId] : undefined;
    if (job?.remote) add(`ssh:${job.id}`, desk.id, firstIp(state.devices[job.deviceId]), 'tcp', 22, 4);
    else if (e.devOn) { const v = state.services[e.devOn]; if (v) add(`deploy:${e.id}`, desk.id, firstIp(state.devices[v.serverId]), 'tcp', 22, 1); }
  }
  monitorFlows(state, want, add);
  // patch downloads: the device being updated fetches the release itself
  for (const j of Object.values(state.staff.jobs)) {
    if (j.kind !== 'update' || !j.started) continue;
    const d = state.devices[j.deviceId];
    if (!d) continue;
    const src = d.updateSrc?.trim();
    if (src) add(`fetch:${j.id}`, d.id, src, 'tcp', ROLES.mirror.port, PATCH_FETCH_MBPS);
    else add(`fetch:${j.id}`, d.id, INTERNET_IP, 'tcp', 443, PATCH_FETCH_MBPS);
  }
  for (const d of Object.values(state.devices)) {
    if (d.kind === 'badge' && d.authIp) add(`ldap:${d.id}`, d.id, d.authIp, 'tcp', ROLES.auth.port, 0.2);
    if (d.kind !== 'server') continue;
    const needsNames = d.roles.some((r) => r.role === 'proxy' && (r.rules ?? []).some((x) => x.backend.split(/[\s,]+/).some((b) => b && parseIpLocal(b) === null)));
    if (d.dns && needsNames) add(`dns:${d.id}`, d.id, d.dns, 'udp', 53, 0.2);
    if (d.roles.some((r) => r.role === 'dns_local')) add(`dnsfwd:${d.id}`, d.id, INTERNET_IP, 'udp', 53, 0.3);
    const m = d.roles.find((r) => r.role === 'mirror');
    // a mirror only talks to the internet while it pulls a release it does not have
    if (m && (m.cachedRelease ?? 0) < state.staff.release) {
      if (!m.upstream || m.upstream === 'direct') add(`mirror:${d.id}`, d.id, INTERNET_IP, 'tcp', 443, MIRROR_FETCH_MBPS);
      else {
        const px = state.devices[m.upstream];
        add(`mirror:${d.id}`, d.id, firstIp(px), 'tcp', ROLES.fwd_proxy.port, MIRROR_FETCH_MBPS);
        if (px) add(`fwdproxy:${px.id}`, px.id, INTERNET_IP, 'tcp', 443, MIRROR_FETCH_MBPS);
      }
    }
  }
}
