// Who knows that something is broken.
//
//  • A problem is unknown until someone notices it. Engineers see blinking
//    LEDs on anything within two cells of them.
//  • Monitoring needs a server with the Monitoring master role. Servers report
//    to it through a monitoring agent (tcp/10051); network devices with an IP
//    are polled over SNMP (udp/161); switches and scrubbers are covered when a
//    monitoring flow passes through them. A monitored problem raises an alert.
//  • Staff act on an alert once one engineer has seen it: sitting at a desk
//    whose PC can open the master's web console (tcp/80), or standing next to
//    the device. Whoever is free then goes to fix it.
//  • With the "Predictive alerts" unlock, monitored parts report wear before
//    they fail (SMART).

import { MON_AGENT_PORT, MON_CONSOLE_PORT, NOTICE_RADIUS, ROLES, SNMP_PORT, TICKS_PER_SEC, WORN } from '../balance';
import { cheb } from '../state/floor';
import { parseIp } from '../state/ip';
import type { Device, DeviceId, Flow, RuntimeCache, ServerDevice, WorldState } from '../state/types';
import { compName, OFF_LABEL } from './hw';
import { buildCtx, l3Ifaces, resolveFromHost } from './net';

type Hooks = {
  notify: (m: string, l: 'info' | 'warn' | 'alert' | 'good') => void;
  log: (s: WorldState, id: DeviceId, m: string, l: 'info' | 'warn' | 'alert') => void;
};
let hooks: Hooks | null = null;
export function setMonitorHooks(h: Hooks): void { hooks = h; }

export interface Problem {
  key: string;
  deviceId: DeviceId;
  msg: string;
  level: 'warn' | 'alert';
  fix: 'swap' | 'full' | 'preventive' | 'cool';
  comps?: string[];
  smart?: boolean;               // only monitoring can see it (wear)
}

const EFFECT: Record<string, string> = {
  disk: 'the array is degraded until the drive is swapped and rebuilt',
  psu: 'running on the second power supply',
  fan: 'cooling is gone: it will run hot and throttle',
  ram: 'it crashes and reboots every half minute',
  cpu: 'the server is off',
  gpu: 'AI jobs run on fewer GPUs',
  nic: 'that port is dead',
  board: 'the server is off',
};

export function problemsOf(s: WorldState, d: Device): Problem[] {
  const out: Problem[] = [];
  if (d.kind === 'uplink') return out;
  if (d.kind === 'server') {
    for (const c of d.hw.comps) {
      if (c.failed) {
        let eff = EFFECT[c.kind]!;
        if (c.kind === 'psu' && !d.hw.comps.some((x) => x.kind === 'psu' && !x.failed)) eff = 'no power: the server is off';
        if (c.kind === 'disk' && d.hw.array === 'lost') eff = 'the array is lost: the server cannot boot';
        out.push({ key: `${d.id}:c:${c.id}`, deviceId: d.id, msg: `${compName(d, c)} failed: ${eff}`, level: 'alert', fix: 'swap', comps: [c.id] });
      } else if (s.unlocks.monitoring && c.wear >= WORN) {
        out.push({ key: `${d.id}:w:${c.id}`, deviceId: d.id, msg: `${compName(d, c)} is worn (${Math.round(c.wear * 100)} % of rated life): it may fail soon`, level: 'warn', fix: 'swap', comps: [c.id], smart: true });
      }
    }
    if (d.hw.off === 'thermal') out.push({ key: `${d.id}:hot`, deviceId: d.id, msg: OFF_LABEL.thermal, level: 'alert', fix: 'cool' });
    else if ((d.temp ?? 0) > 92) out.push({ key: `${d.id}:warm`, deviceId: d.id, msg: `Running at ${Math.round(d.temp ?? 0)} °C and throttling`, level: 'warn', fix: 'cool' });
    return out;
  }
  const h = d.health;
  if (h.state === 'failed') {
    const over = h.fault === 'overheat';
    out.push({ key: `${d.id}:down`, deviceId: d.id, msg: over ? 'Overheated and shut down' : 'Hardware failure: the device is dead', level: 'alert', fix: over ? 'cool' : 'full' });
  } else if (h.fault === 'nic') {
    out.push({ key: `${d.id}:nic`, deviceId: d.id, msg: `Port ${d.ports[h.faultPort ?? 0]?.label ?? '?'} died`, level: 'alert', fix: 'full' });
  } else if (s.unlocks.monitoring && (d.wear ?? 0) >= WORN) {
    out.push({ key: `${d.id}:wear`, deviceId: d.id, msg: `Worn (${Math.round((d.wear ?? 0) * 100)} % of rated life): it may fail soon`, level: 'warn', fix: 'preventive', smart: true });
  }
  return out;
}

export function allProblems(s: WorldState): Problem[] {
  return Object.values(s.devices).flatMap((d) => problemsOf(s, d));
}

/** Known problems of one device (what the player and the staff can act on). */
export function knownProblems(s: WorldState, d: Device): (Problem & { via: string; ack: boolean; by?: string })[] {
  const k = s.known ?? {};
  return problemsOf(s, d).filter((p) => k[p.key]).map((p) => ({ ...p, via: k[p.key]!.via, ack: k[p.key]!.ack, by: k[p.key]!.by }));
}

// ─── Monitoring reach ───────────────────────────────────────────────────────

const isMaster = (d: Device | undefined): d is ServerDevice => d?.kind === 'server' && d.roles.some((r) => r.role === 'monitor');
const upOk = (d: Device) => d.health.state !== 'failed' && !(d.health.state === 'repairing' && d.health.repairKind === 'full') && !d.compromised;

export function masters(s: WorldState): ServerDevice[] {
  return Object.values(s.devices).filter(isMaster);
}

function firstIp(d: Device): string {
  if ('ip' in d && d.ip) return d.ip;
  if (d.kind === 'router' || d.kind === 'firewall') return d.interfaces.find((i) => i.ip)?.ip ?? '';
  return '';
}

/** Monitoring control flows: agents report in, the master polls network gear. */
export function monitorFlows(s: WorldState, want: Map<string, Omit<Flow, 'id'>>, add: (tag: string, origin: string, dstIp: string, protocol: 'tcp' | 'udp', dstPort: number, rateMbps: number) => void): void {
  void want;
  const ms = masters(s);
  if (!ms.length) return;
  for (const d of Object.values(s.devices)) {
    if (d.kind === 'server') {
      const a = d.agents.monitor;
      const m = a?.enabled && a.masterId ? s.devices[a.masterId] : undefined;
      if (isMaster(m) && m.id !== d.id && m.ip) add(`mon:${d.id}`, d.id, m.ip, 'tcp', MON_AGENT_PORT, 0.3);
    }
  }
  // the first master polls every network device that has an address
  const m = ms.find((x) => upOk(x) && x.ip);
  if (!m) return;
  for (const d of Object.values(s.devices)) {
    if (d.kind === 'server' || d.kind === 'uplink' || d.kind === 'ac') continue;
    const ip = firstIp(d);
    if (ip) add(`snmp:${d.id}`, m.id, ip, 'udp', SNMP_PORT, 0.1);
  }
}

/** Who reports to a working master, and which desks can open its console. Every 2 s. */
export function refreshMonitoring(s: WorldState, c: RuntimeCache): void {
  const mon: Record<DeviceId, string> = {};
  const why: Record<DeviceId, string> = {};
  const ms = masters(s).filter(upOk);
  for (const m of ms) mon[m.id] = m.id;
  const flowFor = (tag: string) => Object.values(s.flows).find((f) => f.kind === 'control' && f.tag === tag);
  for (const d of Object.values(s.devices)) {
    if (mon[d.id]) continue;
    if (d.kind === 'server') {
      const a = d.agents.monitor;
      if (!a?.enabled) { why[d.id] = 'No monitoring agent'; continue; }
      const m = a.masterId ? s.devices[a.masterId] : undefined;
      if (!isMaster(m)) { why[d.id] = 'Pick a server running the Monitoring master role'; continue; }
      if (!upOk(m)) { why[d.id] = `${m.name} is down`; continue; }
      const f = flowFor(`mon:${d.id}`);
      const p = f ? c.paths[f.id] : undefined;
      if (p && !p.blocked && p.reachedServer === m.id) mon[d.id] = m.id;
      else why[d.id] = p ? `Agent cannot reach ${m.name} on tcp/${MON_AGENT_PORT}: ${p.explain}` : 'Waiting for the agent to report';
    } else if (d.kind !== 'uplink') {
      const f = flowFor(`snmp:${d.id}`);
      const p = f ? c.paths[f.id] : undefined;
      if (p && !p.blocked && p.reachedServer === d.id) mon[d.id] = f!.origin;
      else why[d.id] = !ms.length ? 'No Monitoring master' : !firstIp(d) && d.kind !== 'switch' && d.kind !== 'ddos_scrubber' ? 'No IP address to poll' : p ? `SNMP poll fails: ${p.explain}` : 'Not polled';
    }
  }
  // L2 boxes (no IP) are covered when a working monitoring flow passes through them
  for (const f of Object.values(s.flows)) {
    if (f.kind !== 'control' || !(f.tag?.startsWith('mon:') || f.tag?.startsWith('snmp:'))) continue;
    const p = c.paths[f.id];
    if (!p || p.blocked) continue;
    for (const h of p.hops) {
      const d = s.devices[h.deviceId];
      if ((d?.kind === 'switch' || d?.kind === 'ddos_scrubber') && !mon[d.id]) { mon[d.id] = f.tag!.startsWith('mon:') ? s.devices[f.origin]?.kind === 'server' ? (s.devices[f.origin] as ServerDevice).agents.monitor?.masterId ?? '' : '' : f.origin; delete why[d.id]; }
    }
  }
  c.monitored = mon;
  c.monWhy = why;
  // consoles: desks that can open a master's web page
  const cons: Record<DeviceId, DeviceId> = {};
  if (ms.length) {
    const ctx = buildCtx(s, c);
    for (const desk of Object.values(s.devices)) {
      if (desk.kind !== 'desk' || desk.health.state === 'failed' || desk.compromised) continue;
      for (const m of ms) {
        const ok = l3Ifaces(ctx, m, false).some((i) => {
          const p = resolveFromHost(ctx, desk, i.ip, 'tcp', MON_CONSOLE_PORT, 'fwd');
          return !p.blocked && p.reachedServer === m.id;
        }) || (parseIp(m.ip) !== null && (() => { const p = resolveFromHost(ctx, desk, parseIp(m.ip)!, 'tcp', MON_CONSOLE_PORT, 'fwd'); return !p.blocked && p.reachedServer === m.id; })());
        if (ok) { cons[desk.id] = m.id; break; }
      }
    }
  }
  c.consoles = cons;
}

// ─── Noticing ───────────────────────────────────────────────────────────────

/** Once a second: monitoring raises alerts, engineers notice, solved problems drop off. */
export function noticeTick(s: WorldState, c: RuntimeCache): void {
  if (s.time.tick % TICKS_PER_SEC !== 5) return;
  if (s.time.tick % (2 * TICKS_PER_SEC) === 5) refreshMonitoring(s, c);
  const known = (s.known ??= {});
  const probs = allProblems(s);
  const live = new Set(probs.map((p) => p.key));
  for (const k of Object.keys(known)) if (!live.has(k)) delete known[k];
  const engineers = Object.values(s.staff.engineers);
  const watcher = engineers.find((e) => e.state === 'seated' && e.deskId && c.consoles?.[e.deskId]);
  for (const p of probs) {
    const d = s.devices[p.deviceId]!;
    const near = engineers.find((e) => cheb(e.x, e.y, d.gridPos.gx + 0.5, d.gridPos.gy + 0.5) <= NOTICE_RADIUS + 0.5);
    const monitored = !!c.monitored?.[d.id];
    const k = known[p.key];
    if (!k) {
      if (monitored) {
        known[p.key] = { at: s.time.tick, via: 'monitoring', ack: !!watcher, by: watcher?.name };
        hooks?.log(s, d.id, `Monitoring alert: ${d.name}: ${p.msg}`, p.level === 'alert' ? 'alert' : 'warn');
        hooks?.notify(`Monitoring alert: ${d.name}: ${p.msg}.${watcher ? ` ${watcher.name} saw it on the console.` : ' Nobody is at a desk watching the monitoring console.'}`, p.level === 'alert' ? 'alert' : 'warn');
      } else if (near && !p.smart) {
        known[p.key] = { at: s.time.tick, via: 'engineer', ack: true, by: near.name };
        hooks?.log(s, d.id, `${near.name} noticed: ${d.name}: ${p.msg}`, p.level === 'alert' ? 'alert' : 'warn');
        hooks?.notify(`${near.name} noticed a problem on ${d.name}: ${p.msg}.`, p.level === 'alert' ? 'alert' : 'warn');
      }
    } else if (!k.ack) {
      const e = watcher ?? (p.smart ? undefined : near);
      if (e) {
        k.ack = true;
        k.by = e.name;
        hooks?.notify(`${e.name} ${e === watcher ? 'saw the alert on the monitoring console' : 'is standing next to it'}: ${d.name}: ${p.msg}.`, 'info');
      }
    }
  }
}

export function isMonitored(c: RuntimeCache, id: DeviceId): boolean {
  return !!c.monitored?.[id];
}

export { ROLES };
