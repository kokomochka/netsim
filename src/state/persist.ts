import { normMask } from './ip';
// Save / load (architecture v2, §11). Phase 2: migration from v1→v2.
import { rngState } from '../rng';
import { START_BALANCE, UPTIME_BUCKETS } from '../balance';
import { get, set } from '../lib/idb-keyval';
import { macFor } from './devices';
import { recomputeAllPaths } from './geometry';
import type { WorldState } from './types';
import { SCHEMA_VERSION, freshStaff, freshStats, freshUnlocks, makeEngineer, resetRuntime, world } from './world';
import { floorAround } from './floor';
import { BASE_PARTS, freshHw, normParts, peakWatts, specsFor } from './hardware';
import { freshAchievements } from '../progress';

const AUTOSAVE_KEY = 'netsim_autosave';
const SLOT_KEY = 'netsim_slot1';

/** MIGRATIONS[v] upgrades a save from version v to v+1. */
const MIGRATIONS: Record<number, (s: any) => any> = {
  // v1→v2: add Phase 2 fields, convert firewall from 2-port to 4-port with interfaces
  1: (s: any) => {
    // Add top-level Phase 2 fields
    s.speed ??= 1;
    s.economy ??= {
      balance: START_BALANCE, totalEarned: 0, totalSpent: 0,
      revenuePerSec: 0, upkeepPerSec: 0, repairsCount: 0, preventiveRepairs: 0,
    };
    s.grid ??= { width: 30, height: 20 };
    s.flows ??= {};
    s.services ??= {};
    s.events ??= [];
    s.activeIncidents ??= {};
    s.unlocks ??= {
      macLearning: false, connectedRoutes: false, serverM: false, serverL: false,
      advancedFwRules: false, upstreamFiltering: false, carrierUplink: false, monitoringAgent: false,
    };
    s.stats ??= {
      uptimeBuckets: new Array(UPTIME_BUCKETS).fill(1), currentBucket: 0,
      bucketTickCount: 0, bucketAvailSum: 0, ddosBlocked: 0, ddosTotal: 0,
      devicesRepaired: 0, preventiveRepairs: 0, totalDowntimeTicks: 0,
    };
    s.logs ??= [];
    s.time ??= { tick: 0 };
    s.meta.playTimeTicks ??= 0;

    // Migrate devices
    for (const d of Object.values(s.devices) as any[]) {
      // Uplink: add uplinkIp and uplinkTier
      if (d.kind === 'uplink') {
        d.uplinkIp ??= '203.0.113.1';
        d.uplinkTier ??= 'basic';
      }
      // Firewall: convert from 2-port simple to 4-port with interfaces
      if (d.kind === 'firewall') {
        if (!d.interfaces) {
          // Old firewalls had 2 ports: outside (0) and inside (1)
          // Add DMZ (2) and spare (3) ports
          while (d.ports.length < 4) {
            const idx = d.ports.length;
            const label = idx === 2 ? 'dmz' : 'spare';
            const portSide = idx === 2 ? 'S' : 'N';
            d.ports.push({ index: idx, side: portSide, offset: 0.5, label, up: true });
          }
          // Create interfaces from ports
          d.interfaces = [
            { port: 0, name: 'outside', securityLevel: 0, ip: '', mask: '255.255.255.0', mac: macFor(d.id, 100) },
            { port: 1, name: 'inside', securityLevel: 100, ip: '', mask: '255.255.255.0', mac: macFor(d.id, 101) },
            { port: 2, name: 'dmz', securityLevel: 50, ip: '', mask: '255.255.255.0', mac: macFor(d.id, 102) },
            { port: 3, name: 'spare', securityLevel: 50, ip: '', mask: '255.255.255.0', mac: macFor(d.id, 103) },
          ];
        }
        // Migrate old rules (no zones) to new format
        for (const r of d.rules ?? []) {
          r.srcZone ??= 'any';
          r.dstZone ??= 'any';
        }
      }
      // Router: add connected flag to routes
      if (d.kind === 'router') {
        for (const rt of d.routes ?? []) {
          rt.connected ??= false;
        }
      }
    }
    return s;
  },
  // v2→v3: hand-configured L3 model, NAT, DHCP/OSPF flags, achievements
  2: (s: any) => {
    const old = s.unlocks ?? {};
    s.unlocks = { ...freshUnlocks(), macLearning: !!old.macLearning, serverM: !!old.serverM, serverL: !!old.serverL,
      carrierUplink: !!old.carrierUplink, monitoring: !!old.monitoringAgent, upstreamFiltering: !!old.upstreamFiltering };
    s.achievements = freshAchievements();
    const st = s.stats ?? {};
    s.stats = { ...freshStats(), ddosBlocked: st.ddosBlocked ?? 0, ddosTotal: st.ddosTotal ?? 0, devicesRepaired: st.devicesRepaired ?? 0, preventiveRepairs: st.preventiveRepairs ?? 0 };
    s.events = [];
    s.activeIncidents = {};
    s.flows = {};
    for (const v of Object.values(s.services ?? {}) as any[]) {
      v.downPenalised = false; v.upTicks = 0; v.flowId = null; v.availability = 0;
    }
    const strip = (r: any) => ({ id: r.id, dest: r.dest, nextHop: r.nextHop ?? '', metric: r.metric ?? 1 });
    for (const d of Object.values(s.devices) as any[]) {
      if (d.kind === 'uplink') d.upstreamFilters ??= [];
      if (d.kind === 'server') d.addressing ??= 'static';
      if (d.kind === 'router') {
        for (const i of d.interfaces) i.dhcp ??= { enabled: false };
        d.routes = (d.routes ?? []).filter((r: any) => !r.connected).map(strip);
        d.nat ??= []; d.ospf ??= false;
      }
      if (d.kind === 'firewall') {
        for (const i of d.interfaces) i.dhcp ??= { enabled: false };
        d.routes = (d.routes ?? []).map(strip);
        d.nat ??= []; d.ospf ??= false;
      }
      if (d.kind === 'ddos_scrubber') { d.autoMitigation ??= false; d.autoThresholdMbps ??= 50; d.capacityMbps = Math.max(d.capacityMbps ?? 0, 4000); }
    }
    return s;
  },
  // v3→v4: building floor, staff, per-part hardware, multi-role servers, agents, patches
  3: (s: any) => {
    s.floor ??= floorAround(s);
    s.staff ??= freshStaff();
    s.stats.trespassersCaught ??= 0;
    s.stats.failoversSurvived ??= 0;
    const tierParts: Record<string, any> = {
      S: { ...BASE_PARTS }, M: { cpu: 2, ram: 2, disk: 1, diskType: 'ssd', gpu: 0, nic: 0 }, L: { cpu: 4, ram: 3, disk: 2, diskType: 'nvme', gpu: 0, nic: 1 },
    };
    for (const v of Object.values(s.services ?? {}) as any[]) { v.kind = 'web'; v.port = 80; }
    for (const d of Object.values(s.devices) as any[]) {
      if (['server', 'router', 'firewall'].includes(d.kind)) { d.sw ??= { patch: 0, outdatedSince: null }; d.compromised ??= null; }
      if (d.kind === 'server') {
        d.parts = tierParts[d.tier] ?? { ...BASE_PARTS };
        delete d.tier;
        d.specs = specsFor(d.parts);
        d.roles = (d.roles ?? []).map((r: any) => ({ role: 'web', serviceId: r.serviceId ?? null, port: 80 }));
        d.agents ??= { backup: { enabled: false, targetId: null }, failover: { enabled: false, partnerId: null, sanId: null } };
      }
      if (d.kind === 'firewall') d.ports.forEach((p: any, i: number) => { p.label = `eth${i}`; });
    }
    // one engineer to start with, standing in the middle of the building
    const xs = Object.values(s.devices).map((d: any) => d.gridPos.gx);
    const ys = Object.values(s.devices).map((d: any) => d.gridPos.gy);
    const e = makeEngineer(s, Math.round((Math.min(...xs) + Math.max(...xs)) / 2) + 0.5, Math.max(...ys) + 1.5);
    s.staff.engineers[e.id] = e;
    s.events = (s.events ?? []).filter((x: any) => x.kind === 'hardware_failure' || x.kind === 'ddos');
    return s;
  },
  // v9→v10: every smart door has its own controller device; free-standing readers go
  9: (s: any) => {
    const doorCells = Object.entries(s.floor.tiles).filter(([, t]) => t === 'smartdoor').map(([k]) => k);
    const readers = Object.values(s.devices).filter((d: any) => d.kind === 'badge') as any[];
    for (const r of readers) {
      const cell = `${r.gridPos.gx},${r.gridPos.gy}`;
      if (doorCells.includes(cell)) continue;
      // move it onto an adjacent smart door that has no controller yet, else remove it
      const free = doorCells.find((k) => { const [x, y] = k.split(',').map(Number); return Math.max(Math.abs(x! - r.gridPos.gx), Math.abs(y! - r.gridPos.gy)) <= 1 && !readers.some((o) => o !== r && `${o.gridPos.gx},${o.gridPos.gy}` === k); });
      if (free) { const [x, y] = free.split(',').map(Number); r.gridPos = { gx: x, gy: y }; r.name = r.name.replace('Reader', 'Door'); }
      else { delete s.devices[r.id]; for (const c of Object.values(s.cables) as any[]) if (c.a.deviceId === r.id || c.b.deviceId === r.id) delete s.cables[c.id]; }
    }
    let n = 1;
    for (const k of doorCells) {
      if (Object.values(s.devices).some((d: any) => d.kind === 'badge' && `${d.gridPos.gx},${d.gridPos.gy}` === k)) continue;
      const [x, y] = k.split(',').map(Number);
      const id = `dev_d${n}`;
      s.devices[id] = { kind: 'badge', id, name: `Door-${n++}`, gridPos: { gx: x, gy: y }, rotation: 0,
        ports: [{ index: 0, side: 'N', offset: 0.5, label: 'eth0', up: true, media: 'copper' }],
        health: { hp: 100, state: 'ok', fault: null, faultPort: null, degradeRatePerTick: 0, repairEndsAt: null, repairKind: null },
        addressing: 'static', ip: '', mask: '255.255.255.0', gateway: '', mac: `02:4e:d0:0${n}:00:01`, authIp: '', failMode: 'open', sw: { patch: 0, outdatedSince: null }, compromised: null };
    }
    return s;
  },
  // v8→v9: public IPs move to an Internet menu, badge readers for smart doors
  8: (s: any) => {
    s.publicAddrs ??= {};
    let n = 0;
    for (const v of Object.values(s.services ?? {}) as any[]) {
      v.flowIds = [];
      if (!v.publicIp) continue;
      let a: any = Object.values(s.publicAddrs).find((x: any) => x.ip === v.publicIp);
      if (!a) { const id = `pip_m${n++}`; a = s.publicAddrs[id] = { id, ip: v.publicIp, services: [] }; }
      a.services.push(v.id);
      v.publicIp = '';
    }
    return s;
  },
  // v7→v8: domains, DNS, proxies
  7: (s: any) => {
    s.domains ??= {};
    for (const v of Object.values(s.services ?? {}) as any[]) v.fqdn ??= null;
    for (const d of Object.values(s.devices) as any[]) {
      if (d.kind !== 'server') continue;
      d.dns ??= '';
      for (const r of d.roles) if (r.role === 'mirror') r.upstream ??= 'direct';
    }
    return s;
  },
  // v6→v7: port media, server ports/drives as parts, STP, climate
  6: (s: any) => {
    const cableOn = new Map<string, string>();
    for (const c of Object.values(s.cables) as any[]) { cableOn.set(`${c.a.deviceId}:${c.a.port}`, c.type); cableOn.set(`${c.b.deviceId}:${c.b.port}`, c.type); }
    for (const d of Object.values(s.devices) as any[]) {
      for (const p of d.ports) p.media ??= cableOn.get(`${d.id}:${p.index}`) === 'fibre' ? 'fibre' : 'copper';
      if (d.kind === 'server') {
        const usedEth1 = cableOn.has(`${d.id}:1`) || !!d.ip2;
        if (!usedEth1 && d.ports.length > 1) d.ports.length = 1;
        d.extra = d.ports.length > 1 ? [{ ip: d.ip2 ?? '', mask: d.mask2 ?? '255.255.255.0' }] : [];
        delete d.ip2; delete d.mask2;
        d.parts.ports = d.ports.length;
        d.parts.disks ??= 1;
      }
      if (d.kind === 'switch') d.stp ??= true;
    }
    s.climate ??= { rooms: {}, outside: 20 };
    return s;
  },
  // v5→v6: servers get eth1, roles get back-end links, GPU API becomes the AI chain, access uplinks indoors
  5: (s: any) => {
    for (const d of Object.values(s.devices) as any[]) {
      if (d.kind === 'server') {
        if (d.ports.length < 2) d.ports.push({ index: 1, side: 'E', offset: 0.5, label: 'eth1', up: true });
        d.ip2 ??= ''; d.mask2 ??= '255.255.255.0';
        for (const r of d.roles) r.links ??= [];
        const gpu = d.roles.find((r: any) => r.role === 'gpu');
        if (gpu?.serviceId) {
          // the old public GPU API becomes frontend + orchestrator + worker on the same box
          d.roles.push({ role: 'ai_frontend', serviceId: gpu.serviceId, port: 443, links: [d.id] });
          d.roles.push({ role: 'orchestrator', serviceId: null, port: 7000, links: [d.id] });
          gpu.serviceId = null; gpu.port = 7001;
        }
      }
      if (d.kind === 'tower') {
        d.access ??= 'cell';
        d.subs.spikeUntil ??= 0;
        const t = s.floor.tiles[`${d.gridPos.gx},${d.gridPos.gy}`];
        if (t !== 'floor' && t !== 'raised') s.floor.tiles[`${d.gridPos.gx},${d.gridPos.gy}`] = 'floor';
      }
    }
    for (const v of Object.values(s.services ?? {}) as any[]) {
      v.usedGB ??= 0;
      if (v.kind === 'gpu') v.kind = 'ai';
    }
    return s;
  },
  // v4→v5: parking lot below the building (towers and transit need no migration)
  4: (s: any) => {
    if (!s.floor.parking) {
      const ys = Object.keys(s.floor.tiles).map((k) => Number(k.split(',')[1]));
      const xs = Object.keys(s.floor.tiles).map((k) => Number(k.split(',')[0]));
      const bottom = Math.max(...ys);
      if (bottom + 4 < s.floor.h) s.floor.parking = { x0: Math.min(...xs), y0: bottom + 2, x1: Math.max(...xs), y1: Math.min(s.floor.h - 2, bottom + 7) };
    }
    return s;
  },
  // v10→v11: hardware v2 (chassis, RAID, components, power), monitoring, certificates
  10: (s: any) => {
    for (const d of Object.values(s.devices) as any[]) {
      if (d.kind === 'server') {
        const p = normParts(d.parts ?? {});
        if (p.gpus > 0 && p.chassis === 0 && peakWatts(p) > 500) p.chassis = 1;
        d.parts = p;
        d.specs = specsFor(p);
        d.hw = freshHw(p);
        for (const c of d.hw.comps) { c.age = 600; c.wear = Math.max(0, (100 - (d.health?.hp ?? 100)) / 100); }
        d.agents.monitor ??= { enabled: false, masterId: null }; // v11 shape, upgraded by v11→v12
        d.cert ??= false;
      } else {
        d.wear = Math.max(0, (100 - (d.health?.hp ?? 100)) / 100);
        d.age = 600;
      }
      if (d.health && d.health.state !== 'failed') { d.health.state = 'ok'; d.health.degradeRatePerTick = 0; if (d.health.fault !== 'nic') d.health.fault = null; }
    }
    s.events = (s.events ?? []).filter((e: any) => e.kind !== 'hardware_failure');
    s.known = {};
    s.unlocks.throttling ??= false;
    return s;
  },
  // v11→v12: monitoring polls typed addresses. Agents keep their master's IP,
  // masters get a target list matching what they watched before.
  11: (s: any) => {
    const devs = Object.values(s.devices) as any[];
    const ipOf = (d: any): string => d?.ip || (d?.interfaces ?? []).find((i: any) => i.ip)?.ip || '';
    let n = 0;
    const isMaster = (d: any) => d.kind === 'server' && (d.roles ?? []).some((r: any) => r.role === 'monitor');
    const firstMaster = devs.find((d) => isMaster(d) && d.ip);
    for (const m of devs.filter(isMaster)) {
      const role = m.roles.find((r: any) => r.role === 'monitor');
      role.port = 80;
      const targets: any[] = [];
      for (const d of devs) {
        if (d.kind === 'server' && d.id !== m.id && d.agents?.monitor?.enabled && d.agents.monitor.masterId === m.id && d.ip) targets.push({ id: `mt_m${n++}`, ip: d.ip, method: 'agent' });
        if (m === firstMaster && !['server', 'uplink', 'ac', 'switch', 'ddos_scrubber'].includes(d.kind) && ipOf(d)) targets.push({ id: `mt_m${n++}`, ip: ipOf(d), method: 'snmp' });
      }
      role.targets = targets;
    }
    for (const d of devs) {
      if (d.kind !== 'server' || !d.agents) continue;
      const old = d.agents.monitor ?? { enabled: false, masterId: null };
      d.agents.monitor = { enabled: !!old.enabled, masterIp: old.masterId ? s.devices[old.masterId]?.ip ?? '' : '' };
      for (const r of d.roles ?? []) if (r.role === 'cloud' || r.role === 'ai_frontend') r.port = 80;
    }
    for (const v of Object.values(s.services ?? {}) as any[]) if (v.kind === 'cloud' || v.kind === 'ai') v.port = 80;
    return s;
  },
};

/** A save file: the world plus a small header so we can recognise it on upload. */
export function exportJson(state: WorldState): string {
  return JSON.stringify({ format: 'netsim-save', savedAt: new Date().toISOString(), world: JSON.parse(serialize(state)) }, null, 0);
}

export function importJson(text: string): WorldState | null {
  try {
    const j = JSON.parse(text);
    const w = j && j.format === 'netsim-save' ? j.world : j;
    return deserialize(JSON.stringify(w));
  } catch {
    return null;
  }
}

/** Older saves listed several reverse-proxy back ends in one rule, comma-separated.
 *  Each back end is now its own rule; rules sharing a name balance and fail over. */
export function splitProxyRules(state: WorldState): void {
  for (const d of Object.values(state.devices)) {
    if (d.kind !== 'server') continue;
    for (const r of d.roles) {
      if (r.role !== 'proxy' || !r.rules) continue;
      r.rules = r.rules.flatMap((rule) => {
        const parts = rule.backend.split(/[\s,]+/).filter(Boolean);
        if (parts.length <= 1) return [rule];
        return parts.map((b, i) => ({ id: i === 0 ? rule.id : `${rule.id}_${i}`, fqdn: rule.fqdn, backend: b }));
      });
    }
  }
}

export function serialize(state: WorldState): string {
  return JSON.stringify({ ...state, meta: { ...state.meta, saveTimestamp: Date.now(), rng: rngState() } });
}

export function deserialize(json: string): WorldState | null {
  try {
    let s = JSON.parse(json);
    if (!s || typeof s !== 'object' || !s.meta || !s.devices) return null;
    let v: number = s.meta.version ?? 0;
    while (v < SCHEMA_VERSION) {
      const m = MIGRATIONS[v];
      if (!m) return null;
      s = m(s);
      v++;
      s.meta.version = v;
    }
    if (v > SCHEMA_VERSION) return null; // save from a newer build
    const state = s as WorldState;
    // drop cables that point at missing devices or ports
    for (const c of Object.values(state.cables ?? {})) {
      const ok = [c.a, c.b].every((e) => state.devices[e.deviceId]?.ports[e.port] !== undefined);
      if (!ok) delete state.cables[c.id];
    }
    state.cables ??= {} as any;
    state.camera ??= { x: 0, y: 0, scale: 1 };
    splitProxyRules(state);
    for (const d of Object.values(state.devices) as any[]) {
      if (typeof d.mask === 'string') d.mask = normMask(d.mask);
      for (const i of d.interfaces ?? []) if (typeof i.mask === 'string') i.mask = normMask(i.mask);
      for (const x of d.extra ?? []) if (typeof x.mask === 'string') x.mask = normMask(x.mask);
    }
    // older saves: a site that is serving (or has been) counts toward uptime
    for (const v of Object.values(state.services ?? {})) v.live ??= v.upTicks > 0 || v.availability >= 0.5 || v.reputation !== 1;
    recomputeAllPaths(state);
    resetRuntime();
    return state;
  } catch {
    return null;
  }
}

export async function saveSlot(): Promise<boolean> {
  try { await set(SLOT_KEY, serialize(world.get())); return true; } catch { return false; }
}

export async function loadSlot(): Promise<WorldState | null> {
  try { const raw = await get<string>(SLOT_KEY); return raw ? deserialize(raw) : null; } catch { return null; }
}

export async function slotInfo(): Promise<{ savedAt: number; balance: number } | null> {
  try {
    const raw = await get<string>(SLOT_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    return { savedAt: j.meta?.saveTimestamp ?? 0, balance: j.economy?.balance ?? 0 };
  } catch { return null; }
}

export async function loadAutosave(): Promise<WorldState | null> {
  try {
    const raw = await get<string>(AUTOSAVE_KEY);
    return raw ? deserialize(raw) : null;
  } catch {
    return null;
  }
}

let saving = false;
export async function saveNow(): Promise<void> {
  if (saving) return;
  saving = true;
  try {
    await set(AUTOSAVE_KEY, serialize(world.get()));
  } catch {
    // storage blocked (private window, preview); the game keeps working without it
  } finally {
    saving = false;
  }
}

/** Save 1 s after the last world change, and every 30 s regardless. */
export function startAutosave(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  world.subscribe((_s, reason) => {
    if (reason === 'ui' || reason === 'sim' || reason === 'camera') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void saveNow(), 1000);
  });
  setInterval(() => void saveNow(), 30_000);
  window.addEventListener('pagehide', () => void saveNow());
}
