// Who knows that something is broken.
//
//  • A problem is unknown until someone notices it. Engineers see blinking
//    LEDs on anything within two cells of them.
//  • Monitoring polls. A server with the Monitoring master role polls each
//    address in its target list: server agents on tcp/10050 (the agent only
//    answers the master IP typed into it), network gear over SNMP (udp/161).
//    The request and the reply both have to make it through routes and
//    firewalls. Switches and scrubbers have no address; the master sees them
//    while answers cross them.
//  • A device that answered before and goes quiet raises a "stopped answering"
//    alert, which is how a dead box is found. Wear readings (SMART) only come
//    with a live answer.
//  • Staff act on an alert once one engineer has seen it: sitting at a desk
//    whose PC can open the master's web console (tcp/80), or standing next to
//    the device. Whoever is free then goes to fix it.

import { MON_AGENT_PORT, MON_CONSOLE_PORT, NOTICE_RADIUS, ROLES, SNMP_PORT, TICKS_PER_SEC, WORN } from '../balance';
import { cheb } from '../state/floor';
import { parseIp } from '../state/ip';
import type { Device, DeviceId, Flow, MonTarget, RuntimeCache, ServerDevice, WorldState } from '../state/types';
import { compName, OFF_LABEL } from './hw';
import { buildCtx, l3Ifaces, resolveFromHost, roundTrip, tripOk } from './net';

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

/** Which device owns an address (host IP, extra server IP, router / firewall interface). */
export function ownerOfIp(s: WorldState, ip: string): Device | undefined {
  const want = parseIp(ip.trim());
  if (want === null) return undefined;
  return Object.values(s.devices).find((d) => {
    if ('ip' in d && parseIp(d.ip) === want) return true;
    if (d.kind === 'server' && d.extra.some((x) => parseIp(x.ip) === want)) return true;
    if (d.kind === 'router' || d.kind === 'firewall') return d.interfaces.some((i) => parseIp(i.ip) === want);
    return false;
  });
}

export const targetsOf = (m: ServerDevice) => m.roles.find((r) => r.role === 'monitor')?.targets ?? [];
const pollTag = (m: ServerDevice, t: MonTarget) => `poll:${m.id}:${t.id}`;

/** Polling model: each master polls the addresses in its target list, and the
 *  device answers back. Server agents listen on tcp/10050, network gear on udp/161. */
export function monitorFlows(s: WorldState, want: Map<string, Omit<Flow, 'id'>>, add: (tag: string, origin: string, dstIp: string, protocol: 'tcp' | 'udp', dstPort: number, rateMbps: number) => void): void {
  void want;
  for (const m of masters(s)) {
    if (!upOk(m) || !m.ip) continue;
    for (const t of targetsOf(m)) {
      if (parseIp(t.ip.trim()) === null) continue;
      add(pollTag(m, t), m.id, t.ip.trim(), t.method === 'agent' ? 'tcp' : 'udp', t.method === 'agent' ? MON_AGENT_PORT : SNMP_PORT, 0.15);
    }
  }
}

/** Who answers a working master's polls, and which desks can open its console. Every 2 s. */
export function refreshMonitoring(s: WorldState, c: RuntimeCache): void {
  const mon: Record<DeviceId, string> = {};
  const why: Record<DeviceId, string> = {};
  const seen = (c.monSeen ??= {});
  const wasSilent = c.monSilent ?? {};
  const silent: Record<DeviceId, true> = {};
  const tstat: Record<string, { ok: boolean; msg: string }> = {};
  const ms = masters(s).filter(upOk);
  for (const m of ms) mon[m.id] = m.id;
  const flowFor = (tag: string) => Object.values(s.flows).find((f) => f.kind === 'control' && f.tag === tag);
  const l2 = (id: string) => { const d = s.devices[id]; return d?.kind === 'switch' || d?.kind === 'ddos_scrubber'; };
  const failed: { m: ServerDevice; owner: Device; msg: string }[] = [];
  for (const m of ms) {
    for (const t of targetsOf(m)) {
      const key = `${m.id}:${t.id}`;
      if (parseIp(t.ip.trim()) === null) { tstat[key] = { ok: false, msg: t.ip.trim() ? 'Not a valid IP address' : 'Type the address to poll' }; continue; }
      const owner = ownerOfIp(s, t.ip);
      const f = flowFor(pollTag(m, t));
      const p = f ? c.paths[f.id] : undefined;
      const dev = p?.reachedServer ? s.devices[p.reachedServer] : undefined;
      if (p && !p.blocked && dev && p.ret && !p.ret.blocked) {
        mon[dev.id] = m.id;
        seen[dev.id] = m.id;
        delete why[dev.id];
        // switches and scrubbers have no address: the master sees them while answers cross them
        for (const h of [...p.hops, ...p.ret.hops]) if (l2(h.deviceId)) { mon[h.deviceId] = m.id; seen[h.deviceId] = m.id; }
        tstat[key] = { ok: true, msg: `${dev.name} answers (${t.method === 'agent' ? `agent tcp/${MON_AGENT_PORT}` : `SNMP udp/${SNMP_PORT}`})` };
        continue;
      }
      const msg = !m.ip ? `${m.name} has no IP` : !owner ? `Nothing owns ${t.ip.trim()}` : !p ? 'Waiting for the first poll' : p.blocked ? `No answer: ${p.explain}` : !p.ret ? 'No answer' : `No answer: ${p.explain}`;
      tstat[key] = { ok: false, msg };
      if (owner) failed.push({ m, owner, msg });
    }
  }
  for (const { m, owner, msg } of failed) {
    if (mon[owner.id]) continue;
    why[owner.id] = `${m.name}: ${msg}`;
    // it answered before and went quiet: that is what the master alerts on
    if (seen[owner.id] === m.id) { mon[owner.id] = m.id; silent[owner.id] = true; }
  }
  // switches and scrubbers that answers used to cross: a dead one is noticed by what went quiet behind it
  for (const [id, m] of Object.entries(seen)) {
    if (mon[id] || !l2(id) || !ms.some((x) => x.id === m)) continue;
    mon[id] = m; silent[id] = true;
  }
  for (const d of Object.values(s.devices)) {
    if (mon[d.id] || why[d.id] || d.kind === 'uplink' || d.kind === 'ac') continue;
    why[d.id] = !ms.length ? 'No working Monitoring master'
      : d.kind === 'switch' || d.kind === 'ddos_scrubber' ? 'No answered poll crosses it yet (it has no address of its own)'
      : d.kind === 'server' && !d.agents.monitor?.enabled ? `No monitoring agent: turn it on and add ${d.ip || 'its IP'} to a master's targets`
      : !firstIp(d) ? 'No IP address to poll'
      : `Not in any master's target list: add ${firstIp(d)} to the Monitoring master`;
  }
  for (const id of Object.keys(silent)) {
    if (wasSilent[id]) continue;
    const d = s.devices[id]; const m = s.devices[mon[id] ?? ''];
    if (!d || !m) continue;
    hooks?.log(s, d.id, `Monitoring: ${d.name} stopped answering ${m.name}`, 'warn');
    hooks?.notify(`Monitoring: ${d.name} stopped answering ${m.name}'s polls.`, 'warn');
  }
  c.monSilent = silent;
  c.monTargets = tstat;
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
          return tripOk(roundTrip(ctx, desk, i.ip, 'tcp', MON_CONSOLE_PORT), m.id);
        }) || (parseIp(m.ip) !== null && tripOk(roundTrip(ctx, desk, parseIp(m.ip)!, 'tcp', MON_CONSOLE_PORT), m.id));
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
    const monitored = !!c.monitored?.[d.id] && !(p.smart && c.monSilent?.[d.id]);
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
