// The two stores (saved world + transient UI) and every world mutation. Phase 2.
import { CERT_PRICE, CHASSIS, ACCESS, CABLE_BANDWIDTH, CABLE_PRICE, TLDS, MAX_DISKS, MAX_SERVER_PORTS, MEDIA_SWAP_PRICE, OUTSIDE_TEMP, ENGINEER_HIRE, ROLES, START_BALANCE, TILE_PRICE, UPLINK_TIER, UPTIME_BUCKETS } from '../balance';
import { freshAchievements } from '../progress';
import { DEVICE_DEFS, SERVER_PORT_LAYOUT, defOf } from './devices';
import { inMap, inParking, isIndoor, placementError, starterFloor, tileAt } from './floor';
import { carryComps, needsDowntime, partsProblem, roleBlocker, specsCarry, specsFor, swapCost } from './hardware';
import { cancelJob, createJob } from '../sim/staff';
import { cellKey, occupancy, portUsage, recomputeAllPaths, routeCable } from './geometry';
import { createStore } from './store';
import type {
  Cable, CableEnd, CableId, CableType, Device, DeviceId, DeviceKind,
  AccessKind, DiskType, RaidLevel, Domain, Economy, Engineer, Media, ServerRole, GridPos, PartSlot, RoleKind, Rotation, RuntimeCache, ServerParts, Staff, Stats, Tile,
  Unlocks, UplinkTier, WorldState,
} from './types';
import { formatIp, parseCidr, parseIp } from './ip';

export const SCHEMA_VERSION = 11;

export type Tool =
  | { mode: 'select' }
  | { mode: 'cable' }
  | { mode: 'place'; kind: DeviceKind; access?: AccessKind }
  | { mode: 'build'; tile: Tile };

export type Selection = { type: 'device'; id: DeviceId } | { type: 'cable'; id: CableId } | null;

export interface UiState {
  tool: Tool;
  cableType: CableType;
  selection: Selection;
  pendingCable: (CableEnd & { explicit: boolean }) | null;
}

/** High-frequency pointer state, kept apart so panels don't re-render on every mouse move. */
export interface PointerState {
  hoverCell: GridPos | null;
  hoverDevice: DeviceId | null;
  pointerWorld: { x: number; y: number } | null;
  dragGhost: { deviceId: DeviceId; cell: GridPos } | null;
}

export function freshEconomy(): Economy {
  return {
    balance: START_BALANCE,
    totalEarned: 0,
    totalSpent: 0,
    revenuePerSec: 0,
    upkeepPerSec: 0,
    repairsCount: 0,
    preventiveRepairs: 0,
  };
}

export function freshUnlocks(): Unlocks {
  return {
    macLearning: false, dhcp: false, dynamicRouting: false, serverM: false, serverL: false,
    carrierUplink: false, monitoring: false, autoMitigation: false, upstreamFiltering: false, throttling: false,
  };
}

export function freshStats(): Stats {
  return {
    uptimeBuckets: new Array(UPTIME_BUCKETS).fill(null),
    currentBucket: 0, bucketTickCount: 0, bucketAvailSum: 0,
    ddosBlocked: 0, ddosTotal: 0, devicesRepaired: 0, preventiveRepairs: 0,
    totalDowntimeTicks: 0, switchTicks: 0, trespassersCaught: 0, failoversSurvived: 0,
  };
}

export function freshRuntimeCache(): RuntimeCache {
  return {
    paths: {}, cableLoad: {}, cableCap: {}, delivery: {}, talkers: {}, ruleHits: {}, learned: {},
    carriers: [], topologyVersion: 0, topologyDirty: true, uplinkMbps: 0, takeover: {}, reach: {}, roleLinks: {},
    rooms: [], cellRoom: {}, stpBlocked: {}, storm: {}, resolve: {}, proxyChk: {}, mirrorOk: {}, doors: {},
  };
}

export function newWorld(): WorldState {
  const s: WorldState = {
    meta: { version: SCHEMA_VERSION, seed: (Math.random() * 2 ** 31) | 0, saveTimestamp: 0, playTimeTicks: 0 },
    camera: { x: 0, y: 0, scale: 1 },
    speed: 1,
    economy: freshEconomy(),
    grid: { width: 30, height: 20 },
    devices: {},
    cables: {},
    flows: {},
    services: {},
    events: [],
    activeIncidents: {},
    unlocks: freshUnlocks(),
    known: {},
    achievements: freshAchievements(),
    floor: starterFloor(),
    staff: freshStaff(),
    climate: { rooms: {}, outside: OUTSIDE_TEMP },
    domains: {},
    publicAddrs: {},
    stats: freshStats(),
    logs: [],
    time: { tick: 0 },
    nextId: 1,
  };
  const id = nextId(s, 'dev');
  s.devices[id] = DEVICE_DEFS.uplink.create(id, 'ISP Uplink', { gx: 2, gy: 6 });
  const sid = nextId(s, 'dev');
  s.devices[sid] = DEVICE_DEFS.server.create(sid, 'Server-1', { gx: 6, gy: 6 });
  const e = makeEngineer(s, 10.5, 8.5);
  s.staff.engineers[e.id] = e;
  return s;
}

export const world = createStore<WorldState>(newWorld());
export const ui = createStore<UiState>({
  tool: { mode: 'select' },
  cableType: 'ethernet',
  selection: null,
  pendingCable: null,
});
export const pointer = createStore<PointerState>({ hoverCell: null, hoverDevice: null, pointerWorld: null, dragGhost: null });

/** Runtime cache lives outside the saved store — rebuilt on load, not serialized. */
export const runtime: RuntimeCache = freshRuntimeCache();
/** Reset the cache in place so every importer keeps the same object. */
export function resetRuntime(): void { Object.assign(runtime, freshRuntimeCache()); }

// ---------- toasts ----------
export type ToastKind = 'info' | 'error' | 'warn' | 'alert' | 'good';
type ToastFn = (msg: string, kind: ToastKind) => void;
const toastListeners = new Set<ToastFn>();
export const onToast = (fn: ToastFn) => { toastListeners.add(fn); return () => toastListeners.delete(fn); };
export const toast = (msg: string, kind: ToastKind = 'info') => toastListeners.forEach((fn) => fn(msg, kind));

// ---------- helpers ----------
function nextId(s: WorldState, prefix: 'dev' | 'cab' | 'rt' | 'fw' | 'flw' | 'svc' | 'inc' | 'rl' | 'nat' | 'uf' | 'dom' | 'rec' | 'rule' | 'pip'): string {
  return `${prefix}_${s.nextId++}`;
}

function nextNamed(s: WorldState, prefix: string): string {
  let n = 1;
  const names = new Set(Object.values(s.devices).map((d) => d.name));
  while (names.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

function nextName(s: WorldState, kind: DeviceKind): string {
  const prefix = DEVICE_DEFS[kind].namePrefix;
  let n = 1;
  const names = new Set(Object.values(s.devices).map((d) => d.name));
  while (names.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

export function deviceAtCell(s: WorldState, gx: number, gy: number): Device | null {
  const id = occupancy(s).get(cellKey(gx, gy));
  return id ? s.devices[id] ?? null : null;
}

// ---------- mutations ----------
export function placeDevice(kind: DeviceKind, pos: GridPos, access: AccessKind = 'cell'): DeviceId | null {
  const s = world.get();
  if (!DEVICE_DEFS[kind].placeable) return null;
  if (deviceAtCell(s, pos.gx, pos.gy)) {
    toast('That cell is taken. Pick an empty one.', 'error');
    return null;
  }
  const where = placementError(s.floor, kind, pos.gx, pos.gy);
  if (where) {
    toast(where, 'error');
    return null;
  }
  // Economy check
  const price = kind === 'tower' ? ACCESS[access].price : DEVICE_DEFS[kind].price;
  if (s.economy.balance < price) {
    toast(`Not enough funds ($${s.economy.balance.toFixed(0)} < $${price}).`, 'error');
    return null;
  }
  let created: DeviceId | null = null;
  world.update((w) => {
    const id = nextId(w, 'dev');
    const d = defOf(kind).create(id, kind === 'tower' ? nextNamed(w, ACCESS[access].namePrefix) : nextName(w, kind), { ...pos });
    if (d.kind === 'tower') { d.access = access; if (access === 'cell') for (const p of d.ports) p.media = 'fibre'; }
    if (d.sw) d.sw.patch = w.staff.release;
    w.devices[id] = d;
    w.economy.balance -= price;
    w.economy.totalSpent += price;
    created = id;
    recomputeAllPaths(w);
    runtime.topologyDirty = true;
  });
  return created;
}

export function deleteDevice(id: DeviceId, keepTile = false): void {
  const d = world.get().devices[id];
  if (!d) return;
  if (d.kind === 'badge' && !keepTile) {
    // removing a door's controller turns it back into a plain door
    world.update((w) => { w.floor.tiles[cellKey(d.gridPos.gx, d.gridPos.gy)] = 'door'; });
  }
  if (d.kind === 'uplink') {
    toast('The uplink is your internet connection and cannot be removed.', 'error');
    return;
  }
  world.update((w) => {
    // Remove any services on this device
    for (const [sid, svc] of Object.entries(w.services)) {
      if (svc.serverId === id) {
        // Remove associated flow
        if (svc.flowId && w.flows[svc.flowId]) delete w.flows[svc.flowId];
        delete w.services[sid];
      }
    }
    delete w.devices[id];
    for (const e of Object.values(w.staff.engineers)) if (e.deskId === id) { e.deskId = null; if (e.state === 'seated') e.state = 'idle'; }
    for (const j of Object.values(w.staff.jobs)) if (j.deviceId === id) {
      const e = j.engineerId ? w.staff.engineers[j.engineerId] : undefined;
      if (e) { e.jobId = null; e.state = 'idle'; e.path = []; }
      delete w.staff.jobs[j.id];
    }
    for (const t of Object.values(w.staff.trespassers)) if (t.targetId === id) t.state = 'leaving';
    for (const x of Object.values(w.devices)) if (x.kind === 'server') {
      if (x.agents.backup.targetId === id) x.agents.backup.targetId = null;
      if (x.agents.failover.partnerId === id) x.agents.failover.partnerId = null;
      if (x.agents.failover.sanId === id) x.agents.failover.sanId = null;
    }
    for (const c of Object.values(w.cables)) {
      if (c.a.deviceId === id || c.b.deviceId === id) delete w.cables[c.id];
    }
    recomputeAllPaths(w);
    runtime.topologyDirty = true;
  });
  clearSelectionIf(id);
}

export function moveDevice(id: DeviceId, pos: GridPos): boolean {
  const s = world.get();
  if (s.devices[id]?.kind === 'badge') { toast('A smart door\'s controller is built into the door.', 'error'); return false; }
  const other = deviceAtCell(s, pos.gx, pos.gy);
  if (other && other.id !== id) {
    toast('That cell is taken.', 'error');
    return false;
  }
  const mv = s.devices[id];
  const where = mv ? placementError(s.floor, mv.kind, pos.gx, pos.gy) : null;
  if (where) {
    toast(where, 'error');
    return false;
  }
  world.update((w) => {
    const d = w.devices[id];
    if (!d) return;
    d.gridPos = { ...pos };
    recomputeAllPaths(w);
    runtime.topologyDirty = true;
  });
  return true;
}

export function rotateDevice(id: DeviceId): void {
  world.update((w) => {
    const d = w.devices[id];
    if (!d) return;
    d.rotation = ((d.rotation + 1) % 4) as Rotation;
    recomputeAllPaths(w);
    runtime.topologyDirty = true;
  });
}

export function connect(a: CableEnd, b: CableEnd, type: CableType): CableId | null {
  const s = world.get();
  if (a.deviceId === b.deviceId) {
    toast('A cable needs two different devices.', 'error');
    return null;
  }
  const used = portUsage(s);
  for (const end of [a, b]) {
    if (used.has(`${end.deviceId}:${end.port}`)) {
      const d = s.devices[end.deviceId];
      toast(`${d?.name ?? 'Device'} ${d?.ports[end.port]?.label ?? ''} already has a cable.`, 'error');
      return null;
    }
  }
  for (const end of [a, b]) {
    const d = s.devices[end.deviceId];
    const p = d?.ports[end.port];
    if (d && p && p.media !== cableMedia(type)) {
      toast(`${d.name} ${p.label} is a ${p.media} port and cannot take a ${type} cable. Use ${p.media === 'fibre' ? 'fibre' : 'ethernet'}, or swap the port's transceiver in the device panel.`, 'error');
      return null;
    }
  }
  const price = CABLE_PRICE[type];
  if (s.economy.balance < price) {
    toast(`Not enough funds for cable ($${s.economy.balance.toFixed(0)} < $${price}).`, 'error');
    return null;
  }
  let created: CableId | null = null;
  world.update((w) => {
    const id = nextId(w, 'cab');
    const cable: Cable = { id, a: { ...a }, b: { ...b }, type, bandwidthMbps: CABLE_BANDWIDTH[type], path: [] };
    cable.path = routeCable(w, cable);
    w.cables[id] = cable;
    w.economy.balance -= price;
    w.economy.totalSpent += price;
    created = id;
    runtime.topologyDirty = true;
  });
  return created;
}

export function deleteCable(id: CableId): void {
  world.update((w) => {
    delete w.cables[id];
    runtime.topologyDirty = true;
  });
  clearSelectionIf(id);
}

export function setCableType(id: CableId, type: CableType): void {
  const s = world.get();
  const c = s.cables[id];
  if (c) for (const end of [c.a, c.b]) {
    const p = s.devices[end.deviceId]?.ports[end.port];
    if (p && p.media !== cableMedia(type)) { toast(`${s.devices[end.deviceId]!.name} ${p.label} is ${p.media}: a ${type} cable does not fit.`, 'error'); return; }
  }
  world.update((w) => {
    const c = w.cables[id];
    if (!c) return;
    c.type = type;
    c.bandwidthMbps = CABLE_BANDWIDTH[type];
    runtime.topologyDirty = true;
  });
}

/** Edit a device in place with its narrowed type. */
export function editDevice<K extends DeviceKind>(id: DeviceId, kind: K, fn: (d: Extract<Device, { kind: K }>) => void): void {
  world.update((w) => {
    const d = w.devices[id];
    if (d && d.kind === kind) {
      fn(d as Extract<Device, { kind: K }>);
      runtime.topologyDirty = true;
    }
  });
}

/** Allocate an id for a route, rule, or rate limit. Call inside editDevice(). */
export function genId(prefix: 'rt' | 'fw' | 'rl' | 'nat' | 'uf' | 'rec' | 'rule'): string {
  return nextId(world.get(), prefix);
}

export function resetWorld(): void {
  resetRuntime();
  world.replace(newWorld(), 'load');
  ui.update((u) => { u.selection = null; u.pendingCable = null; }, 'ui');
}


// ---------- services, roles, hardware ----------

/** Usable addresses of the public block, minus the ISP gateway. */
export function publicIps(s: WorldState): string[] {
  const up = Object.values(s.devices).find((d) => d.kind === 'uplink');
  if (!up || up.kind !== 'uplink') return [];
  const c = parseCidr(up.publicSubnet);
  if (!c) return [];
  const size = 2 ** (32 - c.prefix);
  const out: string[] = [];
  for (let i = 1; i < size - 1; i++) {
    const ip = formatIp((c.net + i) >>> 0);
    if (ip !== up.uplinkIp) out.push(ip);
  }
  return out;
}

/** Install a role. Public roles (web, GPU) also create a service on a public IP. */
export function addRole(serverId: DeviceId, role: RoleKind, publicIp = ''): string | null {
  const s = world.get();
  const d = s.devices[serverId];
  if (!d || d.kind !== 'server') return 'Not a server';
  const why = roleBlocker(d, role);
  if (why) return why;
  const def = ROLES[role];
  if (def.service && publicIp && parseIp(publicIp) === null) return 'That is not an IP address';
  world.update((w) => {
    const x = w.devices[serverId];
    if (x?.kind !== 'server') return;
    let sid: string | null = null;
    if (def.service) {
      sid = nextId(w, 'svc');
      w.services[sid] = {
        id: sid, serverId, kind: def.service, port: def.port, publicIp: '', flowIds: [], fqdn: null, usedGB: 0, demand: 1, reputation: 1, availability: 0,
        downSinceTick: null, downPenalised: false, upTicks: 0, flowId: null,
      };
    }
    x.roles.push({
      role, serviceId: sid, port: def.port, links: [],
      ...(role === 'proxy' ? { rules: [] } : role === 'dns_local' ? { records: [] } : role === 'mirror' ? { upstream: 'direct' as const } : {}),
    });
    // a back end added to a server that already has the front end links up locally
    for (const r of x.roles) {
      const rd = ROLES[r.role];
      if (rd.linksTo?.includes(role) && !r.links.includes(serverId) && (rd.multiLink || !r.links.length)) r.links.push(serverId);
      if (def.linksTo?.includes(r.role) && !x.roles[x.roles.length - 1]!.links.includes(serverId)) x.roles[x.roles.length - 1]!.links.push(serverId);
    }
    runtime.topologyDirty = true;
    if (sid && publicIp) publish(w, publicIp, sid);
  });
  return null;
}

/** Point a role at its back-end servers. */
export function setRoleLinks(serverId: DeviceId, role: RoleKind, links: DeviceId[]): void {
  world.update((w) => {
    const x = w.devices[serverId];
    if (x?.kind !== 'server') return;
    const r = x.roles.find((y) => y.role === role);
    if (r) r.links = [...new Set(links)];
    runtime.topologyDirty = true;
  });
}

export function removeRole(serverId: DeviceId, role: RoleKind): void {
  world.update((w) => {
    const x = w.devices[serverId];
    if (x?.kind !== 'server') return;
    const r = x.roles.find((y) => y.role === role);
    if (r?.serviceId) {
      for (const a of Object.values(w.publicAddrs)) a.services = a.services.filter((y) => y !== r.serviceId);
      const v = w.services[r.serviceId];
      if (v?.flowId) delete w.flows[v.flowId];
      delete w.services[r.serviceId];
    }
    x.roles = x.roles.filter((y) => y.role !== role);
    runtime.topologyDirty = true;
  });
}

/** Publish a service on exactly this public IP (replaces its other bare-IP entries). */
export function setServicePublicIp(serviceId: string, publicIp: string): string | null {
  const s = world.get();
  if (!s.services[serviceId]) return 'No such service';
  world.update((w) => {
    for (const a of Object.values(w.publicAddrs)) a.services = a.services.filter((x) => x !== serviceId);
    if (publicIp) publish(w, publicIp, serviceId);
    runtime.topologyDirty = true;
  });
  return null;
}

function publish(w: WorldState, ip: string, serviceId: string): void {
  let a = Object.values(w.publicAddrs).find((x) => x.ip === ip);
  if (!a) { const id = nextId(w, 'pip'); a = w.publicAddrs[id] = { id, ip, services: [] }; }
  if (!a.services.includes(serviceId)) a.services.push(serviceId);
}

// ---------- public IPs from the ISP block ----------

export function publicIpCheck(s: WorldState, ip: string): string | null {
  const up = Object.values(s.devices).find((d) => d.kind === 'uplink');
  if (parseIp(ip) === null) return 'Type an IP address like 203.0.113.5';
  if (up?.kind !== 'uplink') return 'No uplink';
  if (!publicIps(s).includes(ip.trim())) return `${ip} is not a usable address of your ISP block ${up.publicSubnet} (the ISP gateway ${up.uplinkIp} is taken)`;
  if (Object.values(s.publicAddrs).some((a) => a.ip === ip.trim())) return `${ip} is already on the list`;
  return null;
}

export function addPublicAddr(ip: string): string | null {
  const s = world.get();
  const e = publicIpCheck(s, ip);
  if (e) return e;
  world.update((w) => { const id = nextId(w, 'pip'); w.publicAddrs[id] = { id, ip: ip.trim(), services: [] }; runtime.topologyDirty = true; });
  return null;
}

export function removePublicAddr(id: string): void {
  world.update((w) => { delete w.publicAddrs[id]; runtime.topologyDirty = true; });
}

export function togglePublicService(addrId: string, serviceId: string, on: boolean): void {
  world.update((w) => {
    const a = w.publicAddrs[addrId];
    if (!a) return;
    a.services = a.services.filter((x) => x !== serviceId);
    if (on) a.services.push(serviceId);
    runtime.topologyDirty = true;
  });
}

/** Public IPs visitors are sent to for a service without a domain name. */
export function bareEndpoints(s: WorldState, serviceId: string): string[] {
  return Object.values(s.publicAddrs).filter((a) => a.services.includes(serviceId)).map((a) => a.ip);
}

export function setUplinkTier(tier: UplinkTier): string | null {
  const s = world.get();
  if (tier === 'carrier' && !s.unlocks.carrierUplink) return 'Carrier tier is locked';
  world.update((w) => {
    const up = Object.values(w.devices).find((d) => d.kind === 'uplink');
    if (up?.kind !== 'uplink') return;
    up.uplinkTier = tier;
    up.bandwidthMbps = UPLINK_TIER[tier].bandwidthMbps;
    runtime.topologyDirty = true;
  });
  return null;
}

/** The configuration a server is heading for: its pending upgrade, or what it has. */
export function pendingParts(s: WorldState, id: DeviceId): ServerParts | null {
  const d = s.devices[id];
  if (d?.kind !== 'server') return null;
  const j = Object.values(s.staff.jobs).find((x) => x.deviceId === id && x.kind === 'upgrade');
  return j?.parts ?? d.parts;
}

/** Is the server still on the bench (no cables)? Then parts are fitted straight away. */
export const testFlags = { instantParts: false };
export function onBench(s: WorldState, id: DeviceId): boolean {
  return testFlags.instantParts || !Object.values(s.cables).some((c) => c.a.deviceId === id || c.b.deviceId === id);
}

/**
 * Change the part in one slot. Charges the difference after trade-in. A server
 * on the bench is changed at once; a cabled one gets an engineer job: hot-swap
 * parts (drives, a second PSU) keep it running, everything else needs downtime.
 */
export function buyPart(id: DeviceId, slot: PartSlot, value: number | DiskType | RaidLevel | boolean): string | null {
  const s = world.get();
  const d = s.devices[id];
  if (d?.kind !== 'server') return 'Not a server';
  const job = Object.values(s.staff.jobs).find((x) => x.deviceId === id && x.kind === 'upgrade');
  if (job?.started) return 'An engineer is fitting the last upgrade right now';
  if (Object.values(s.staff.jobs).some((x) => x.deviceId === id && x.kind === 'swap')) return 'Finish the part swap on this server first';
  const from = job?.parts ?? d.parts;
  const next: ServerParts = { ...from, [slot]: value } as ServerParts;
  if (slot === 'gpu') next.gpus = Number(value) === 0 ? 0 : Math.max(1, from.gpus);
  if (slot === 'gpus' && next.gpu === 0) return 'Pick a GPU model first';
  if (slot === 'chassis') {
    const ch = CHASSIS[Number(value)]!;
    if (!ch.redundantOk) next.psu2 = false;
    if (next.gpus > ch.gpuSlots) return `A ${ch.label} chassis has ${ch.gpuSlots} GPU slot${ch.gpuSlots === 1 ? '' : 's'}: remove GPUs first`;
    if (next.disks > ch.bays) return `A ${ch.label} chassis has ${ch.bays} drive bays: remove drives first`;
  }
  if (slot === 'ports') {
    const n = Number(value);
    if (n < 1 || n > MAX_SERVER_PORTS) return 'A server has 1 to 4 ports';
    const used = Object.values(s.cables).some((c) => [c.a, c.b].some((e) => e.deviceId === id && e.port >= n));
    if (used) return 'Unplug the cables from the ports you want to remove first';
  }
  if (slot === 'disks' && (Number(value) < 1 || Number(value) > MAX_DISKS)) return `A server holds 1 to ${MAX_DISKS} drives`;
  const bad = partsProblem(next);
  if (bad) return bad;
  const why = specsCarry(d, specsFor(next));
  if (why) return `${why}. Remove a role first.`;
  const cost = swapCost(from, next);
  if (s.economy.balance < cost) return `Not enough money ($${cost} needed)`;
  const bench = onBench(s, id);
  if (!bench && !Object.keys(s.staff.engineers).length) return 'Hire an engineer first: someone has to open the case';
  world.update((w) => {
    const x = w.devices[id];
    if (x?.kind !== 'server') return;
    w.economy.balance -= cost;
    w.economy.totalSpent += cost;
    if (bench) {
      x.hw.comps = carryComps(x.hw.comps, x.parts, next);
      x.parts = next;
      x.specs = specsFor(next);
      x.hw.array = 'ok';
      syncServerPorts(x);
      runtime.topologyDirty = true;
      return;
    }
    const same = JSON.stringify(next) === JSON.stringify(x.parts);
    let j = Object.values(w.staff.jobs).find((y) => y.deviceId === id && y.kind === 'upgrade');
    if (same) { if (j) cancelJob(w, j.id); return; }
    j ??= createJob(w, 'upgrade', id, false) ?? undefined;
    if (!j) return;
    j.parts = next;
    j.cold = needsDowntime(x.parts, next);
    j.paid = (j.paid ?? 0) + cost;
  });
  return null;
}

/** Drop a queued upgrade and get the money back. */
export function cancelUpgrade(id: DeviceId): void {
  world.update((w) => {
    const j = Object.values(w.staff.jobs).find((y) => y.deviceId === id && y.kind === 'upgrade' && !y.started);
    if (j) cancelJob(w, j.id);
  });
}

/** Buy and install a TLS certificate on a server (one per device). */
export function setCert(id: DeviceId, on: boolean): string | null {
  const s = world.get();
  const d = s.devices[id];
  if (d?.kind !== 'server') return 'Not a server';
  if (!!d.cert === on) return null;
  if (on && s.economy.balance < CERT_PRICE) return `A certificate costs $${CERT_PRICE}`;
  world.update((w) => {
    const x = w.devices[id];
    if (x?.kind !== 'server') return;
    x.cert = on;
    if (on) { w.economy.balance -= CERT_PRICE; w.economy.totalSpent += CERT_PRICE; }
  });
  return null;
}

/** Ports and extra interfaces follow the bought port count. */
export function syncServerPorts(x: Extract<Device, { kind: 'server' }>): void {
  const n = x.parts.ports ?? 1;
  while (x.ports.length < n) {
    const i = x.ports.length;
    const l = SERVER_PORT_LAYOUT[i]!;
    x.ports.push({ index: i, side: l.side, offset: 0.5, label: l.label, up: true, media: 'copper' });
  }
  x.ports.length = n;
  while (x.extra.length < n - 1) x.extra.push({ ip: '', mask: '255.255.255.0' });
  x.extra.length = n - 1;
  recomputeAllPaths(world.get());
}

export const cableMedia = (t: CableType): Media => (t === 'fibre' ? 'fibre' : 'copper');

/** Swap a port's transceiver between copper and fibre. */
export function setPortMedia(id: DeviceId, port: number, media: Media): string | null {
  const s = world.get();
  const d = s.devices[id];
  const p = d?.ports[port];
  if (!d || !p) return 'No such port';
  if (p.media === media) return null;
  const c = Object.values(s.cables).find((x) => (x.a.deviceId === id && x.a.port === port) || (x.b.deviceId === id && x.b.port === port));
  if (c) return `Unplug the ${c.type} cable from ${p.label} first`;
  if (s.economy.balance < MEDIA_SWAP_PRICE) return `A transceiver costs $${MEDIA_SWAP_PRICE}`;
  world.update((w) => {
    const x = w.devices[id];
    if (!x?.ports[port]) return;
    x.ports[port]!.media = media;
    w.economy.balance -= MEDIA_SWAP_PRICE;
    w.economy.totalSpent += MEDIA_SWAP_PRICE;
  });
  return null;
}

// ---------- domains ----------

export function domainCheck(name: string): string | null {
  const n = name.trim().toLowerCase();
  const m = /^([a-z0-9][a-z0-9-]{1,30})\.([a-z]+)$/.exec(n);
  if (!m) return 'Use a name like acme.net: letters, digits and dashes, then a dot and the ending';
  if (TLDS[m[2]!] === undefined) return `Pick one of: ${Object.keys(TLDS).map((t) => '.' + t).join(' ')}`;
  return null;
}

export function buyDomain(name: string): string | null {
  const s = world.get();
  const n = name.trim().toLowerCase();
  const bad = domainCheck(n);
  if (bad) return bad;
  if (Object.values(s.domains).some((d) => d.name === n)) return 'You already own it';
  if (['google.com', 'example.com', 'netsim.io'].includes(n)) return 'Someone else owns that one';
  const price = TLDS[n.split('.').pop()!]!;
  if (s.economy.balance < price) return `It costs $${price}`;
  world.update((w) => {
    const id = nextId(w, 'dom');
    w.domains[id] = { id, name: n, hosting: 'registrar', nsIp: '', records: [] };
    w.economy.balance -= price;
    w.economy.totalSpent += price;
    runtime.topologyDirty = true;
  });
  return null;
}

export function editDomain(id: string, fn: (d: Domain) => void): void {
  world.update((w) => { const d = w.domains[id]; if (d) fn(d); runtime.topologyDirty = true; });
}

export function dropDomain(id: string): void {
  world.update((w) => {
    const d = w.domains[id];
    if (!d) return;
    for (const v of Object.values(w.services)) if (v.fqdn && (v.fqdn === d.name || v.fqdn.endsWith('.' + d.name))) v.fqdn = null;
    delete w.domains[id];
    runtime.topologyDirty = true;
  });
}

/** Every name your domains currently define. */
export function allFqdns(s: WorldState): string[] {
  const out: string[] = [];
  for (const d of Object.values(s.domains)) for (const r of d.records) out.push(r.name === '@' || !r.name ? d.name : `${r.name}.${d.name}`);
  return [...new Set(out)];
}

/** Change role settings (proxy rules, local DNS records, mirror upstream). */
export function editRole(serverId: DeviceId, role: RoleKind, fn: (r: ServerRole) => void): void {
  world.update((w) => {
    const x = w.devices[serverId];
    const r = x?.kind === 'server' ? x.roles.find((y) => y.role === role) : undefined;
    if (r) fn(r);
    runtime.topologyDirty = true;
  });
}

export function setServiceFqdn(serviceId: string, fqdn: string | null): void {
  world.update((w) => { const v = w.services[serviceId]; if (v) v.fqdn = fqdn; runtime.topologyDirty = true; });
}

// ---------- building ----------

export function paintTile(x: number, y: number, tile: Tile): string | null {
  const s = world.get();
  const f = s.floor;
  if (!inMap(f, x, y)) return 'Outside the plot';
  if (inParking(f, x, y)) return 'The parking lot is a no-build zone.';
  const cur = tileAt(f, x, y);
  if (cur === tile) return null;
  const dev0 = deviceAtCell(s, x, y);
  const dev = dev0?.kind === 'badge' ? null : dev0;   // a door's own controller goes with the door
  if (dev && dev.kind !== 'tower' && !isIndoor(tile)) return `${dev.name} stands there. Move it first.`;
  if (tile === 'vent' && cur !== 'wall') return 'Vents go into walls. Paint a wall first.';
  if (dev && dev.kind === 'tower' && tile !== 'ground') return `${dev.name} stands there. Move it first.`;
  const people = [...Object.values(s.staff.engineers), ...Object.values(s.staff.trespassers)];
  if (tile === 'wall' && people.some((p) => Math.floor(p.x) === x && Math.floor(p.y) === y)) return 'Someone is standing there';
  const price = TILE_PRICE[tile];
  if (s.economy.balance < price) return `Not enough money ($${price})`;
  if (dev0?.kind === 'badge' && tile !== 'smartdoor') deleteDevice(dev0.id, true);
  world.update((w) => {
    if (tile === 'ground') delete w.floor.tiles[cellKey(x, y)];
    else w.floor.tiles[cellKey(x, y)] = tile;
    w.economy.balance -= price;
    w.economy.totalSpent += price;
    if (tile === 'smartdoor' && !Object.values(w.devices).some((d) => d.kind === 'badge' && d.gridPos.gx === x && d.gridPos.gy === y)) {
      const id = nextId(w, 'dev');
      w.devices[id] = DEVICE_DEFS.badge.create(id, nextName(w, 'badge'), { gx: x, gy: y });
      recomputeAllPaths(w);
      runtime.topologyDirty = true;
    }
  }, 'world');
  return null;
}

// ---------- staff ----------

function firstNames(): string[] { return ['Ada', 'Linus', 'Grace', 'Ken', 'Radia', 'Vint', 'Barbara', 'Dennis', 'Hedy', 'Jon', 'Margaret', 'Tim', 'Frances', 'Bjarne', 'Sophie', 'Alan']; }

export function makeEngineer(s: WorldState, x: number, y: number): Engineer {
  const used = new Set(Object.values(s.staff.engineers).map((e) => e.name));
  const name = firstNames().find((n) => !used.has(n)) ?? `Engineer ${Object.keys(s.staff.engineers).length + 1}`;
  return { id: `eng_${s.nextId++}`, name, x, y, path: [], state: 'idle', deskId: null, jobId: null, idleUntil: 0, chaseId: null };
}

export function hireEngineer(): string | null {
  const s = world.get();
  if (s.economy.balance < ENGINEER_HIRE) return `Hiring costs $${ENGINEER_HIRE}`;
  const door = Object.entries(s.floor.tiles).find(([, t]) => t === 'door' || t === 'smartdoor');
  const [dx, dy] = door ? door[0].split(',').map(Number) as [number, number] : [5, 5];
  world.update((w) => {
    const e = makeEngineer(w, dx + 0.5, dy + 0.5);
    w.staff.engineers[e.id] = e;
    w.economy.balance -= ENGINEER_HIRE;
    w.economy.totalSpent += ENGINEER_HIRE;
  });
  return null;
}

export function fireEngineer(id: string): void {
  world.update((w) => {
    const e = w.staff.engineers[id];
    if (!e) return;
    if (e.deskId) { const d = w.devices[e.deskId]; if (d?.kind === 'desk') d.ownerId = null; }
    if (e.jobId) { const j = w.staff.jobs[e.jobId]; if (j) { j.engineerId = null; j.started = false; } }
    delete w.staff.engineers[id];
  });
}

export function freshStaff(): Staff {
  return { engineers: {}, jobs: {}, trespassers: {}, autoMaintain: true, autoPatch: true, release: 0 };
}

// ---------- ui helpers ----------
export function setTool(tool: Tool): void {
  ui.update((u) => {
    u.tool = tool;
    u.pendingCable = null;
    if (tool.mode !== 'select') u.selection = null;
  }, 'ui');
}

export function select(sel: Selection): void {
  ui.update((u) => { u.selection = sel; }, 'ui');
}

function clearSelectionIf(id: string): void {
  const sel = ui.get().selection;
  const pend = ui.get().pendingCable;
  if (sel?.id === id || pend?.deviceId === id) {
    ui.update((u) => {
      if (u.selection?.id === id) u.selection = null;
      if (u.pendingCable?.deviceId === id) u.pendingCable = null;
    }, 'ui');
  }
}
