// The two stores (saved world + transient UI) and every world mutation. Phase 2.
import { random, seeded } from '../rng';
import { STRIDE, buildingAt, generateCity, levelOf, localY } from './city';
import { CERT_PRICE, CHASSIS, ACCESS, CABLE_BANDWIDTH, CABLE_PRICE, TLDS, MAX_DISKS, MAX_SERVER_PORTS, MEDIA_SWAP_PRICE, OUTSIDE_TEMP, ENGINEER_HIRE, ROLES, START_BALANCE, TILE_PRICE, UPLINK_TIER, UPTIME_BUCKETS, PLAYER_BLOCK_OCTETS, PUBLIC_BLOCK_UPGRADES, UPLINK_START, MAP_W, MAP_H, MULTIFLOOR_SWITCH_PRICE, ENGINEER_SALARY, LEASED_LINE, FAR_PLACES } from '../balance';
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
  Unlocks, UplinkTier, WorldState, Trait } from './types';
import { formatIp, parseCidr, parseIp } from './ip';

export const SCHEMA_VERSION = 13;
/** Test hooks: instant part deliveries, the documentation block instead of a random one. */
export const testFlags = { instantParts: false, fixedPublicBlock: false, legacyMap: false };

export type Tool =
  | { mode: 'select' }
  | { mode: 'cable' }
  | { mode: 'place'; kind: DeviceKind; access?: AccessKind; stack?: boolean }
  | { mode: 'build'; tile: Tile };

export type Selection = { type: 'device'; id: DeviceId } | { type: 'cable'; id: CableId } | null;

export interface UiState {
  view?: 'top' | 'iso';
  level?: number;              // the storey on show (0 = street level)
  focus?: string;              // the building opened up; '' = the city with every roof on; unset = your first building
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
    carrierUplink: false, monitoring: false, autoMitigation: false, upstreamFiltering: false, throttling: false, dynamicNat: false,
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

/** A new game: a fresh random city with your office in it. `legacy` keeps the old single-room plot (examples, tests). */
export function newWorld(legacy = testFlags.legacyMap): WorldState {
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
    buildings: {},
    staff: freshStaff(),
    climate: { rooms: {}, outside: OUTSIDE_TEMP },
    domains: {},
    publicAddrs: {},
    stats: freshStats(),
    logs: [],
    time: { tick: 0 },
    nextId: 1,
  };
  const blk = testFlags.fixedPublicBlock ? { subnet: UPLINK_START.publicSubnet, gateway: UPLINK_START.uplinkIp } : randomPublicBlock(s.meta.seed);
  if (legacy) {
    // the old plot, wrapped in one building you own
    s.buildings = { bld_0: { id: 'bld_0', name: 'Your office', rects: [{ x0: 0, y0: 0, x1: MAP_W - 1, y1: MAP_H - 1 }], floors: 1, front: 's', owned: true, forSale: true, price: 0, door: { gx: 8, gy: 11 }, lift: { gx: -1, gy: -1 }, uplinkId: null } };
    const id = nextId(s, 'dev');
    s.devices[id] = DEVICE_DEFS.uplink.create(id, 'ISP Uplink', { gx: 2, gy: 6 });
    const up = s.devices[id]!;
    if (up.kind === 'uplink') { up.publicSubnet = blk.subnet; up.uplinkIp = blk.gateway; }
    s.buildings.bld_0!.uplinkId = id;
    const sid = nextId(s, 'dev');
    s.devices[sid] = DEVICE_DEFS.server.create(sid, 'Server-1', { gx: 6, gy: 6 });
    const e = makeEngineer(s, 10.5, 8.5);
    s.staff.engineers[e.id] = e;
    return s;
  }
  const plan = generateCity(s.meta.seed);
  s.floor = plan.floor;
  s.buildings = plan.buildings;
  const b = plan.buildings[plan.starter]!;
  const q = b.rects[0]!;
  // ground floor: the ISP's box by the front wall, the front desk, a first server at the back
  const id = nextId(s, 'dev');
  s.devices[id] = DEVICE_DEFS.uplink.create(id, 'ISP Uplink', { gx: q.x1 - 1, gy: q.y1 - 1 });
  const up = s.devices[id]!;
  if (up.kind === 'uplink') { up.publicSubnet = blk.subnet; up.uplinkIp = blk.gateway; }
  b.uplinkId = id;
  const rid = nextId(s, 'dev');
  const desk = DEVICE_DEFS.desk.create(rid, 'Reception', { gx: Math.min(q.x1 - 3, b.door.gx + 2), gy: q.y1 - 2 });
  if (desk.kind === 'desk') desk.reception = true;
  s.devices[rid] = desk;
  const sid = nextId(s, 'dev');
  s.devices[sid] = DEVICE_DEFS.server.create(sid, 'Server-1', { gx: q.x0 + 4, gy: q.y0 + 3 });
  const e = makeEngineer(s, b.door.gx + 0.5, q.y1 - 1.5);
  s.staff.engineers[e.id] = e;
  return s;
}

const FIRST = ['Ada', 'Linus', 'Grace', 'Ken', 'Radia', 'Vint', 'Barbara', 'Dennis', 'Hedy', 'Margaret', 'Frances', 'Sophie', 'Alan', 'Priya', 'Mateo', 'Yuki', 'Amara', 'Lars', 'Noor', 'Tomás', 'Ines', 'Kofi', 'Mei', 'Oskar', 'Leila', 'Ravi', 'Zofia', 'Diego', 'Aiko', 'Femi', 'Hana', 'Jonas', 'Elif', 'Marek', 'Sana', 'Theo', 'Nadia', 'Bo', 'Carmen', 'Idris'];
const LAST = ['Novak', 'Okafor', 'Lindqvist', 'Moreau', 'Tanaka', 'Silva', 'Kowalski', 'Haddad', 'Brennan', 'Iyer', 'Petrov', 'Nakamura', 'Fischer', 'Mensah', 'Rossi', 'Varga', 'Larsen', 'Duarte', 'Kim', 'Abebe'];
const TRAIT_KEYS: Trait[] = ['fastHands', 'scripter', 'sharpEyes', 'quickFeet', 'tidy'];
export const world = createStore<WorldState>(newWorld());
export const ui = createStore<UiState>({
  level: 0,
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
function nextId(s: WorldState, prefix: 'dev' | 'cab' | 'rt' | 'fw' | 'flw' | 'svc' | 'inc' | 'rl' | 'nat' | 'uf' | 'dom' | 'rec' | 'rule' | 'pip' | 'mt' | 'pat' | 'si' | 'vpn'): string {
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
export function placeDevice(kind: DeviceKind, pos: GridPos, access: AccessKind = 'cell', stack = false): DeviceId | null {
  const s = world.get();
  if (!DEVICE_DEFS[kind].placeable) return null;
  if (stack && kind === 'switch') return placeStack(pos);
  if (deviceAtCell(s, pos.gx, pos.gy)) {
    toast('That cell is taken. Pick an empty one.', 'error');
    return null;
  }
  const where = placementError(s, kind, pos.gx, pos.gy);
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

/** A multi-floor switch: the same switch on every storey of the building, joined by a backplane. */
function placeStack(pos: GridPos): DeviceId | null {
  const s = world.get();
  const b = buildingAt(s.buildings, pos.gx, pos.gy);
  if (!b || !b.owned) { toast('A multi-floor switch goes inside a building you own.', 'error'); return null; }
  const base = localY(pos.gy);
  const cells: GridPos[] = [];
  for (let z = 0; z < b.floors; z++) {
    const c = { gx: pos.gx, gy: base + z * STRIDE };
    if (deviceAtCell(s, c.gx, c.gy)) { toast(`Something already stands there on floor ${z === 0 ? 'G' : z}.`, 'error'); return null; }
    const e = placementError(s, 'switch', c.gx, c.gy);
    if (e) { toast(`Floor ${z === 0 ? 'G' : z}: ${e}`, 'error'); return null; }
    cells.push(c);
  }
  const price = MULTIFLOOR_SWITCH_PRICE * b.floors;
  if (s.economy.balance < price) { toast(`A multi-floor switch for ${b.floors} floors costs $${price}.`, 'error'); return null; }
  let first: DeviceId | null = null;
  world.update((w) => {
    const stack = `stk_${w.nextId++}`;
    const n = Object.values(w.devices).filter((x) => x.kind === 'switch' && x.stack).map((x) => x.kind === 'switch' ? x.stack : '').filter((v, i, arr) => arr.indexOf(v) === i).length + 1;
    const name = `Riser-${n}`;
    cells.forEach((c, z) => {
      const id = nextId(w, 'dev');
      const d = defOf('switch').create(id, `${name}/${z === 0 ? 'G' : z}`, { ...c });
      if (d.kind === 'switch') d.stack = stack;
      w.devices[id] = d;
      first ??= id;
    });
    w.economy.balance -= price;
    w.economy.totalSpent += price;
    recomputeAllPaths(w);
    runtime.topologyDirty = true;
  });
  return first;
}

/** Move a device to another storey of its building, same spot. Its cables come off. */
export function moveToFloor(id: DeviceId, level: number): string | null {
  const s = world.get();
  const d = s.devices[id];
  if (!d) return 'Gone.';
  if (d.kind === 'uplink' || d.kind === 'badge') return 'That one stays where it is.';
  if (d.kind === 'switch' && d.stack) return 'A multi-floor switch is already on every floor.';
  const b = buildingAt(s.buildings, d.gridPos.gx, d.gridPos.gy);
  if (!b || level < 0 || level >= b.floors) return 'There is no such floor.';
  const to = { gx: d.gridPos.gx, gy: localY(d.gridPos.gy) + level * STRIDE };
  if (deviceAtCell(s, to.gx, to.gy)) return 'That spot is taken on the other floor.';
  const e = placementError(s, d.kind, to.gx, to.gy);
  if (e) return e;
  world.update((w) => {
    for (const c of Object.values(w.cables)) if (c.a.deviceId === id || c.b.deviceId === id) delete w.cables[c.id];
    w.devices[id]!.gridPos = to;
    recomputeAllPaths(w);
    runtime.topologyDirty = true;
  });
  return null;
}

export function deleteDevice(id: DeviceId, keepTile = false): void {
  const d = world.get().devices[id];
  if (!d) return;
  // a multi-floor switch goes as a whole
  if (d.kind === 'switch' && d.stack) {
    const others = Object.values(world.get().devices).filter((x) => x.kind === 'switch' && x.stack === d.stack && x.id !== id);
    for (const o of others) deleteDevice(o.id, keepTile);
  }
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
  const md = s.devices[id];
  if (md?.kind === 'switch' && md.stack) { toast('A multi-floor switch is built into the building. Delete it and place a new one instead.', 'error'); return false; }
  if (md && levelOf(pos.gy) !== levelOf(md.gridPos.gy)) { toast('Use "Move to floor" in its panel to change floors.', 'error'); return false; }
  if (s.devices[id]?.kind === 'badge') { toast('A smart door\'s controller is built into the door.', 'error'); return false; }
  const other = deviceAtCell(s, pos.gx, pos.gy);
  if (other && other.id !== id) {
    toast('That cell is taken.', 'error');
    return false;
  }
  const mv = s.devices[id];
  const where = mv ? placementError(s, mv.kind, pos.gx, pos.gy) : null;
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
  const da = s.devices[a.deviceId], db = s.devices[b.deviceId];
  if (da && db && levelOf(da.gridPos.gy) !== levelOf(db.gridPos.gy)) {
    toast('Cables stay on one floor. Use a multi-floor switch to go between floors.', 'error');
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

/** A cell site or a street of homes across town: off the map, so a leased line instead of a cable. */
export function buildFarTower(access: AccessKind): DeviceId | null {
  const s = world.get();
  const price = ACCESS[access].price + LEASED_LINE.price;
  if (s.economy.balance < price) { toast(`It costs $${price} with the line: $${ACCESS[access].price} for the site, $${LEASED_LINE.price} to set up the leased line.`, 'error'); return null; }
  let created: DeviceId | null = null;
  world.update((w) => {
    const id = nextId(w, 'dev');
    const n = Object.values(w.devices).filter((d) => d.kind === 'tower' && d.far).length;
    const d = defOf('tower').create(id, nextNamed(w, ACCESS[access].namePrefix), { gx: -100 - n * 3, gy: 22 });
    if (d.kind !== 'tower') return;
    d.access = access;
    for (const p of d.ports) p.media = 'fibre';
    const used = new Set(Object.values(w.devices).flatMap((x) => (x.kind === 'tower' && x.far ? [x.far.place] : [])));
    const place = FAR_PLACES.find((p) => !used.has(p)) ?? FAR_PLACES[n % FAR_PLACES.length]!;
    d.far = { place, travelS: 40 + Math.round(random() * 50) };
    if (d.sw) d.sw.patch = w.staff.release;
    w.devices[id] = d;
    w.economy.balance -= price;
    w.economy.totalSpent += price;
    created = id;
    runtime.topologyDirty = true;
  });
  return created;
}

/** Rent the line from a far site to a fibre port in one of your buildings. */
export function leaseLine(towerId: DeviceId, to: CableEnd): CableId | null {
  const s = world.get();
  const t = s.devices[towerId];
  if (t?.kind !== 'tower' || !t.far) return null;
  const used = portUsage(s);
  if (used.has(`${towerId}:0`)) { toast(`${t.name} already has its line.`, 'error'); return null; }
  if (used.has(`${to.deviceId}:${to.port}`)) { toast('That port already has a cable.', 'error'); return null; }
  const d = s.devices[to.deviceId];
  if (d?.ports[to.port]?.media !== 'fibre') { toast('A leased line arrives on fibre: pick a fibre port, or fit a fibre transceiver first.', 'error'); return null; }
  let created: CableId | null = null;
  world.update((w) => {
    const id = nextId(w, 'cab');
    w.cables[id] = { id, a: { deviceId: towerId, port: 0 }, b: { ...to }, type: 'fibre', bandwidthMbps: LEASED_LINE.mbps, path: [], leased: true };
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
export function genId(prefix: 'rt' | 'fw' | 'rl' | 'nat' | 'uf' | 'rec' | 'rule' | 'mt' | 'pat' | 'si' | 'vpn'): string {
  return nextId(world.get(), prefix);
}

export function resetWorld(): void {
  resetRuntime();
  world.replace(newWorld(), 'load');
  ui.update((u) => { u.selection = null; u.pendingCable = null; }, 'ui');
}


// ---------- services, roles, hardware ----------

/** A random /28 out of the ISP's ranges; the ISP router takes the first address. */
export function randomPublicBlock(seed = (Math.random() * 2 ** 31) | 0): { subnet: string; gateway: string } {
  const r = seeded(seed ^ 0x5eed);
  const a = PLAYER_BLOCK_OCTETS[Math.floor(r() * PLAYER_BLOCK_OCTETS.length)]!;
  const b = 1 + Math.floor(r() * 254);
  const c = Math.floor(r() * 256);
  const d = Math.floor(r() * 16) * 16;
  return { subnet: `${a}.${b}.${c}.${d}/28`, gateway: `${a}.${b}.${c}.${d + 1}` };
}

/** Buy a building: it becomes yours, with its own ISP line and public addresses. */
export function buyBuilding(id: string): string | null {
  const s = world.get();
  const b = s.buildings[id];
  if (!b || b.owned) return 'That one is already yours.';
  if (!b.forSale) return `${b.name} is not for sale.`;
  if (s.economy.balance < b.price) return `${b.name} costs $${b.price.toLocaleString()}.`;
  world.update((w) => {
    const x = w.buildings[id]!;
    x.owned = true;
    w.economy.balance -= x.price;
    w.economy.totalSpent += x.price;
    // the ISP's box goes inside the street wall, next to the door
    const q = x.rects.find((r) => (x.front === 's' ? r.y1 : r.y0) === x.door.gy) ?? x.rects[0]!;
    const gy = x.front === 's' ? q.y1 - 1 : q.y0 + 1;
    let gx = x.door.gx + 1;
    if (gx >= q.x1) gx = x.door.gx - 1;
    const uid = nextId(w, 'dev');
    const up = DEVICE_DEFS.uplink.create(uid, `${x.name} uplink`, { gx, gy });
    const blk = randomPublicBlock((w.meta.seed ^ uid.length * 7919) + Object.keys(w.devices).length * 131);
    if (up.kind === 'uplink') { up.publicSubnet = blk.subnet; up.uplinkIp = blk.gateway; }
    w.devices[uid] = up;
    x.uplinkId = uid;
    recomputeAllPaths(w);
    runtime.topologyDirty = true;
  });
  return null;
}

/** Next bigger public block, or null at the largest. */
export function nextBlockUpgrade(s: WorldState): { prefix: number; price: number; subnet: string } | null {
  const up = Object.values(s.devices).find((d) => d.kind === 'uplink');
  const c = up?.kind === 'uplink' ? parseCidr(up.publicSubnet) : null;
  if (!c) return null;
  const next = PUBLIC_BLOCK_UPGRADES.find((u) => u.prefix === c.prefix - 1);
  if (!next) return null;
  const mask = (0xffffffff << (32 - next.prefix)) >>> 0;
  return { ...next, subnet: `${formatIp((c.net & mask) >>> 0)}/${next.prefix}` };
}

/** Buy the next bigger block. It contains the old one, so every address in use keeps working. */
export function buyBiggerBlock(): string | null {
  const s = world.get();
  const u = nextBlockUpgrade(s);
  if (!u) return 'You already have the biggest block your ISP offers.';
  if (s.economy.balance < u.price) return `A /${u.prefix} costs $${u.price.toLocaleString()}.`;
  world.update((w) => {
    const up = Object.values(w.devices).find((d) => d.kind === 'uplink');
    if (up?.kind !== 'uplink') return;
    up.publicSubnet = u.subnet;
    w.economy.balance -= u.price;
    w.economy.totalSpent += u.price;
    runtime.topologyDirty = true;
  });
  return null;
}

/** Usable addresses of the public block, minus the ISP gateway. */
export function publicIps(s: WorldState): string[] {
  // every building you own brings its own block
  const out: string[] = [];
  for (const up of Object.values(s.devices)) {
    if (up.kind !== 'uplink') continue;
    const c = parseCidr(up.publicSubnet);
    if (!c) continue;
    const size = 2 ** (32 - c.prefix);
    for (let i = 1; i < size - 1; i++) {
      const ip = formatIp((c.net + i) >>> 0);
      if (ip !== up.uplinkIp) out.push(ip);
    }
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

export function setUplinkTier(tier: UplinkTier, id?: string): string | null {
  const s = world.get();
  if (tier === 'carrier' && !s.unlocks.carrierUplink) return 'Carrier tier is locked';
  world.update((w) => {
    const up = (id ? w.devices[id] : undefined) ?? Object.values(w.devices).find((d) => d.kind === 'uplink');
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
  while (x.extra.length < n - 1) x.extra.push({ ip: '', mask: '/24' });
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


/** A new engineer: a name nobody on staff has, and the traits and pay given (or a mild random pair). */
export function makeEngineer(s: WorldState, x: number, y: number, opts: { traits?: Trait[]; salary?: number; name?: string } = {}): Engineer {
  const r = seeded((s.meta.seed ^ 0x5eed5) + s.nextId * 7919);
  const used = new Set(Object.values(s.staff.engineers).map((e) => e.name.split(' ')[0]));
  let name = opts.name;
  for (let i = 0; !name && i < 60; i++) { const f = FIRST[Math.floor(r() * FIRST.length)]!; if (!used.has(f)) name = f; }
  name ??= `Engineer ${Object.keys(s.staff.engineers).length + 1}`;
  const traits = opts.traits ?? (r() < 0.5 ? [TRAIT_KEYS[Math.floor(r() * TRAIT_KEYS.length)]!] : []);
  const salary = opts.salary ?? Math.round(ENGINEER_SALARY * (0.9 + r() * 0.2) * 1000) / 1000;
  return { id: `eng_${s.nextId++}`, name, x, y, path: [], state: 'idle', deskId: null, jobId: null, idleUntil: 0, chaseId: null, traits, salary };
}

/** Someone asking for a job at reception: either cheap, or strong and pricey. */
export function applicantOffer(s: WorldState): { name: string; traits: Trait[]; salary: number; pitch: string } {
  const r = seeded((s.meta.seed ^ 0xa991) + s.time.tick);
  const cheap = r() < 0.5;
  const pickTraits = (n: number) => { const pool = [...TRAIT_KEYS]; const out: Trait[] = []; while (out.length < n && pool.length) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]!); return out; };
  const first = FIRST[Math.floor(r() * FIRST.length)]!, last = LAST[Math.floor(r() * LAST.length)]!;
  return cheap
    ? { name: `${first} ${last}`, traits: [], salary: Math.round(ENGINEER_SALARY * (0.55 + r() * 0.1) * 1000) / 1000, pitch: 'Fresh out of school, happy to learn. Asks for little.' }
    : { name: `${first} ${last}`, traits: pickTraits(2), salary: Math.round(ENGINEER_SALARY * (1.7 + r() * 0.5) * 1000) / 1000, pitch: 'Ten years in data centres. Knows their stuff, and knows what it is worth.' };
}

export function hireEngineer(): string | null {
  const s = world.get();
  if (s.economy.balance < ENGINEER_HIRE) return `Hiring costs $${ENGINEER_HIRE}`;
  const home = Object.values(s.buildings).find((b) => b.owned);
  const door = Object.entries(s.floor.tiles).find(([, t]) => t === 'door' || t === 'smartdoor');
  const [dx, dy] = home && home.lift.gx >= 0 ? [home.door.gx, home.door.gy + (home.front === 's' ? 1 : -1)] : door ? door[0].split(',').map(Number) as [number, number] : [5, 5];
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

/** The building whose inside is on show, or '' for the whole city. */
export function focusOf(s: WorldState, u: UiState): string {
  if (u.focus === '') return '';
  if (u.focus && s.buildings[u.focus]) return u.focus;
  return Object.values(s.buildings).find((b) => b.owned)?.id ?? '';
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
