// People on the floor: engineers (desks, jobs, roaming, chasing) and trespassers.
//
// Rules:
//  • Repairs, replacements and reimaging need hands on the hardware: an
//    engineer walks (rushes) to the device. Engineers without a desk go first.
//  • Software updates can be pushed remotely by an engineer seated at a desk
//    whose PC reaches the target over the network (tcp/22). Otherwise someone
//    walks over and patches it at the console.
//  • A trespasser only goes for a device no engineer is watching (2 cells),
//    gets past smart doors only while no auth server runs, and is caught when
//    an engineer gets close.

import {
  DESK_MAX_ROOM_C, HACK_SECONDS, SWAP_SECONDS, MGMT_PORT, ROLES, RUSH_SPEED, SIGHT_RADIUS, SPOT_RADIUS, TICKS_PER_SEC, WALK_SPEED, WORK_SECONDS,
} from '../balance';
import { cheb, edgeSpawns, findPath, isIndoor, tileAt, walkable, watched, workSpots, type Mover, type PathEnv } from '../state/floor';
import { cellKey } from '../state/geometry';
import { parseIp } from '../state/ip';
import type { Device, DeviceId, Engineer, GridPos, Job, JobKind, RuntimeCache, Trespasser, Walker, WorldState } from '../state/types';
import { buildCtx, l3Ifaces, resolveFromHost } from './net';
import { deskTooHot } from './climate';

let cacheRef: RuntimeCache | null = null;

// set by engine.ts to avoid an import cycle
let hooks: {
  notify: (m: string, l: 'info' | 'warn' | 'alert' | 'good') => void;
  log: (s: WorldState, id: DeviceId, m: string, l: 'info' | 'warn' | 'alert') => void;
  finishJob: (s: WorldState, c: RuntimeCache, j: Job) => void;
} | null = null;
export function setStaffHooks(h: typeof hooks): void { hooks = h; }

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

// ─── Environment ────────────────────────────────────────────────────────────

/** Any smart door currently locked by a working badge reader? */
export function smartDoorsLocked(_s?: WorldState): boolean {
  return Object.values(cacheRef?.doors ?? {}).some((d) => d.state === 'locked');
}

export function doorStates(): RuntimeCache['doors'] { return cacheRef?.doors ?? {}; }

function env(s: WorldState, allow: GridPos[] = []): PathEnv {
  const blocked = new Set<string>();
  for (const d of Object.values(s.devices)) if (d.kind !== 'badge') blocked.add(cellKey(d.gridPos.gx, d.gridPos.gy));
  return { blocked, doors: cacheRef?.doors ?? {}, allow: new Set(allow.map((p) => cellKey(p.gx, p.gy))) };
}

const cellOf = (w: Walker): GridPos => ({ gx: Math.floor(w.x), gy: Math.floor(w.y) });

function routeTo(s: WorldState, w: Walker, who: Mover, goals: GridPos[], allow: GridPos[] = []): boolean {
  const p = findPath(s.floor, env(s, allow), who, cellOf(w), goals);
  if (!p) return false;
  w.path = p;
  return true;
}

/** Move along the path. Returns true when the path is finished. */
function step(w: Walker, speedCells: number): boolean {
  let budget = speedCells / TICKS_PER_SEC;
  while (budget > 0 && w.path.length) {
    const t = w.path[0]!;
    const tx = t.gx + 0.5, ty = t.gy + 0.5;
    const dx = tx - w.x, dy = ty - w.y;
    const d = Math.hypot(dx, dy);
    if (d <= budget) { w.x = tx; w.y = ty; w.path.shift(); budget -= d; }
    else { w.x += (dx / d) * budget; w.y += (dy / d) * budget; budget = 0; }
  }
  return w.path.length === 0;
}

// ─── Remote reach ───────────────────────────────────────────────────────────

/** Can this desk PC open an SSH session to the device? */
export function deskReaches(s: WorldState, c: RuntimeCache, desk: Device, target: Device): boolean {
  if (desk.kind !== 'desk' || desk.health.state === 'failed' || desk.compromised) return false;
  if (desk.id === target.id) return true;
  const ctx = buildCtx(s, c);
  for (const i of l3Ifaces(ctx, target, false)) {
    const p = resolveFromHost(ctx, desk, i.ip, 'tcp', MGMT_PORT, 'fwd');
    if (!p.blocked && p.reachedServer === target.id) return true;
  }
  return false;
}

function mirrorOnline(s: WorldState): boolean {
  return Object.values(s.devices).some((d) => d.kind === 'server' && d.roles.some((r) => r.role === 'mirror') && d.health.state !== 'failed' && !d.compromised && !!cacheRef?.mirrorOk[d.id]?.ok);
}

// ─── Jobs ───────────────────────────────────────────────────────────────────

const PRIORITY: Record<JobKind, number> = { reimage: 0, full: 1, replace: 1, swap: 1, preventive: 2, upgrade: 2, inspect: 2, update: 3 };

export function workTicks(kind: JobKind, remote: boolean, s: WorldState, job?: Job): number {
  const sec = kind === 'update' ? (remote ? WORK_SECONDS.updateRemote * (mirrorOnline(s) ? 0.5 : 1) : WORK_SECONDS.update)
    : kind === 'swap' || kind === 'upgrade' ? (job?.cold ? SWAP_SECONDS.cold : SWAP_SECONDS.hot) * (kind === 'upgrade' ? 1.3 : 1)
    : kind === 'inspect' ? 2 : WORK_SECONDS[kind];
  return Math.round(sec * TICKS_PER_SEC);
}

export function createJob(s: WorldState, kind: JobKind, deviceId: DeviceId, auto: boolean): Job | null {
  if (Object.values(s.staff.jobs).some((j) => j.deviceId === deviceId && (j.kind === kind || PRIORITY[j.kind] <= PRIORITY[kind]))) return null;
  // a more urgent job replaces a lesser one on the same device
  for (const j of Object.values(s.staff.jobs)) if (j.deviceId === deviceId && PRIORITY[j.kind] > PRIORITY[kind]) cancelJob(s, j.id);
  const job: Job = { id: `job_${s.nextId++}`, kind, deviceId, engineerId: null, remote: false, workLeft: 0, started: false, createdAt: s.time.tick, auto };
  s.staff.jobs[job.id] = job;
  return job;
}

export function cancelJob(s: WorldState, id: string): void {
  const j = s.staff.jobs[id];
  if (!j) return;
  const e = j.engineerId ? s.staff.engineers[j.engineerId] : undefined;
  if (e) { e.jobId = null; e.path = []; e.state = 'idle'; }
  const d = s.devices[j.deviceId];
  if (d && j.started && d.health.state === 'repairing') {
    d.health.state = d.kind === 'server' ? 'ok' : d.health.fault === 'board' ? 'failed' : 'ok';
    d.health.repairKind = null;
    if (cacheRef) cacheRef.topologyDirty = true;
  }
  if (!j.started && j.paid) { s.economy.balance += j.paid; s.economy.totalSpent -= j.paid; }
  delete s.staff.jobs[id];
}

function dispatch(s: WorldState, c: RuntimeCache): void {
  const open = Object.values(s.staff.jobs).filter((j) => !j.engineerId).sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.createdAt - b.createdAt);
  for (const job of open) {
    const dev = s.devices[job.deviceId];
    if (!dev) { delete s.staff.jobs[job.id]; continue; }
    const free = Object.values(s.staff.engineers).filter((e) => !e.jobId && e.state !== 'chasing');
    if (!free.length) return;
    // remote update from a desk
    if (job.kind === 'update') {
      const seated = free.find((e) => e.state === 'seated' && e.deskId && deskReaches(s, c, s.devices[e.deskId]!, dev));
      if (seated) {
        job.engineerId = seated.id; job.remote = true; job.started = true; job.workLeft = workTicks('update', true, s);
        seated.jobId = job.id;
        continue;
      }
    }
    // hands-on: deskless engineers first, then the nearest
    const spots = workSpots(s.floor, env(s), 'engineer', dev.gridPos);
    if (!spots.length) continue;
    const ranked = [...free].sort((a, b) => (a.deskId ? 1 : 0) - (b.deskId ? 1 : 0)
      || cheb(a.x, a.y, dev.gridPos.gx, dev.gridPos.gy) - cheb(b.x, b.y, dev.gridPos.gx, dev.gridPos.gy));
    for (const e of ranked) {
      if (!routeTo(s, e, 'engineer', spots, e.deskId ? [s.devices[e.deskId]!.gridPos] : [])) continue;
      e.jobId = job.id;
      e.state = 'walking';
      job.engineerId = e.id;
      job.remote = false;
      break;
    }
  }
}

// ─── Engineers ──────────────────────────────────────────────────────────────

function assignDesks(s: WorldState, c: RuntimeCache): void {
  // nobody works in a sauna
  for (const e of Object.values(s.staff.engineers)) {
    const desk = e.deskId ? s.devices[e.deskId] : undefined;
    if (desk?.kind === 'desk' && deskTooHot(s, c, desk)) {
      desk.ownerId = null;
      e.deskId = null;
      if (e.state === 'seated' || e.state === 'walking') { e.state = 'idle'; e.path = []; }
      hooks?.notify(`${e.name} left ${desk.name}: the room is over ${DESK_MAX_ROOM_C} °C.`, 'warn');
    }
  }
  const freeDesks = Object.values(s.devices).filter((d) => d.kind === 'desk' && !d.ownerId && !deskTooHot(s, c, d));
  for (const desk of freeDesks) {
    if (desk.kind !== 'desk') continue;
    const e = Object.values(s.staff.engineers).filter((x) => !x.deskId).sort((a, b) => cheb(a.x, a.y, desk.gridPos.gx, desk.gridPos.gy) - cheb(b.x, b.y, desk.gridPos.gx, desk.gridPos.gy))[0];
    if (!e) return;
    desk.ownerId = e.id;
    e.deskId = desk.id;
    if (!e.jobId && e.state !== 'chasing') goHome(s, e);
  }
  // owners that vanished
  for (const d of Object.values(s.devices)) if (d.kind === 'desk' && d.ownerId && !s.staff.engineers[d.ownerId]) d.ownerId = null;
}

function goHome(s: WorldState, e: Engineer): void {
  const desk = e.deskId ? s.devices[e.deskId] : undefined;
  if (!desk) { e.state = 'idle'; e.path = []; return; }
  if (cellOf(e).gx === desk.gridPos.gx && cellOf(e).gy === desk.gridPos.gy) { e.state = 'seated'; e.path = []; return; }
  if (routeTo(s, e, 'engineer', [desk.gridPos], [desk.gridPos])) e.state = 'walking';
  else e.state = 'idle';
}

function tickEngineer(s: WorldState, c: RuntimeCache, e: Engineer): void {
  const job = e.jobId ? s.staff.jobs[e.jobId] : undefined;
  if (e.jobId && !job) e.jobId = null;

  if (e.state === 'chasing') {
    const t = e.chaseId ? s.staff.trespassers[e.chaseId] : undefined;
    if (!t) { e.chaseId = null; goHome(s, e); return; }
    if (Math.hypot(t.x - e.x, t.y - e.y) <= 1.3) {
      delete s.staff.trespassers[t.id];
      s.stats.trespassersCaught++;
      hooks?.log(s, t.targetId, `${e.name} caught a trespasser`, 'info');
      hooks?.notify(`${e.name} caught the trespasser and walked them out.`, 'good');
      e.chaseId = null;
      goHome(s, e);
      return;
    }
    if (!e.path.length || s.time.tick % 10 === 0) routeTo(s, e, 'engineer', [cellOf(t)]);
    step(e, RUSH_SPEED);
    return;
  }

  if (job && !job.remote) {
    if (!job.started) {
      const arrived = step(e, RUSH_SPEED);
      if (arrived) {
        const dev = s.devices[job.deviceId];
        if (!dev) { cancelJob(s, job.id); return; }
        job.started = true;
        job.workLeft = workTicks(job.kind, false, s, job);
        e.state = 'working';
        if (job.kind === 'preventive' || job.kind === 'full' || job.kind === 'replace' || job.kind === 'swap' || job.kind === 'upgrade') {
          dev.health.state = 'repairing';
          dev.health.repairKind = job.kind === 'preventive' || ((job.kind === 'swap' || job.kind === 'upgrade') && !job.cold) ? 'preventive' : 'full';
          dev.health.degradeRatePerTick = 0;
          dev.health.repairEndsAt = s.time.tick + job.workLeft;
          c.topologyDirty = true;
        }
      }
      return;
    }
    if (--job.workLeft <= 0) {
      hooks?.finishJob(s, c, job);
      delete s.staff.jobs[job.id];
      e.jobId = null;
      goHome(s, e);
    }
    return;
  }

  if (job && job.remote) {
    if (--job.workLeft <= 0) {
      hooks?.finishJob(s, c, job);
      delete s.staff.jobs[job.id];
      e.jobId = null;
    }
    return;
  }

  // no job
  if (e.state === 'walking' || e.state === 'roaming') {
    if (step(e, e.state === 'walking' ? WALK_SPEED : WALK_SPEED * 0.6)) {
      const desk = e.deskId ? s.devices[e.deskId] : undefined;
      if (desk && cellOf(e).gx === desk.gridPos.gx && cellOf(e).gy === desk.gridPos.gy) e.state = 'seated';
      else { e.state = 'idle'; e.idleUntil = s.time.tick + Math.round(rnd(3, 9) * TICKS_PER_SEC); }
    }
    return;
  }
  if (e.state === 'seated') return;
  if (e.state === 'working') { goHome(s, e); return; }
  // idle without a desk: stand a while, then wander a few cells
  if (e.deskId) { goHome(s, e); return; }
  if (s.time.tick < e.idleUntil) return;
  if (Math.random() < 0.35) { e.idleUntil = s.time.tick + Math.round(rnd(4, 10) * TICKS_PER_SEC); return; }
  const here = cellOf(e);
  const ev = env(s);
  for (let tries = 0; tries < 12; tries++) {
    const g = { gx: here.gx + Math.round(rnd(-5, 5)), gy: here.gy + Math.round(rnd(-4, 4)) };
    if (!isIndoor(tileAt(s.floor, g.gx, g.gy)) || !walkable(s.floor, ev, 'engineer', g.gx, g.gy)) continue;
    if (routeTo(s, e, 'engineer', [g])) { e.state = 'roaming'; return; }
  }
  e.idleUntil = s.time.tick + 3 * TICKS_PER_SEC;
}

// ─── Trespassers ────────────────────────────────────────────────────────────

/** Try to send a stranger in. Returns a log message. */
export function spawnTrespasser(s: WorldState): string {
  const targets = Object.values(s.devices).filter((d) => (d.kind === 'server' || d.kind === 'desk') && !d.compromised && d.health.state !== 'failed');
  const open = targets.filter((d) => !watched(s, d.gridPos));
  if (!targets.length) return '';
  if (!open.length) return 'A stranger walked past the building, saw staff watching every machine and left.';
  const spawns = edgeSpawns(s.floor);
  if (!spawns.length) return '';
  const target = open[Math.floor(Math.random() * open.length)]!;
  const start = spawns[Math.floor(Math.random() * spawns.length)]!;
  const t: Trespasser = { id: `tre_${s.nextId++}`, x: start.gx + 0.5, y: start.gy + 0.5, path: [], targetId: target.id, state: 'approach', progress: 0, spotted: false };
  const spots = workSpots(s.floor, env(s), 'trespasser', target.gridPos);
  if (!routeTo(s, t, 'trespasser', spots)) {
    return smartDoorsLocked(s) ? 'Someone tried a smart door, but the badge reader refused them.' : 'Someone circled the building but found no way in.';
  }
  s.staff.trespassers[t.id] = t;
  return `A stranger is heading into the building toward ${target.name}.`;
}

function tickTrespasser(s: WorldState, c: RuntimeCache, t: Trespasser): void {
  // spotted by staff?
  if (!t.spotted && isIndoor(tileAt(s.floor, Math.floor(t.x), Math.floor(t.y)))) {
    const seer = Object.values(s.staff.engineers).find((e) => Math.hypot(e.x - t.x, e.y - t.y) <= SPOT_RADIUS);
    if (seer) {
      t.spotted = true;
      hooks?.notify(`${seer.name} spotted a stranger inside!`, 'warn');
      const chaser = Object.values(s.staff.engineers)
        .filter((e) => e.state !== 'chasing' && !(e.jobId && s.staff.jobs[e.jobId]?.started && !s.staff.jobs[e.jobId]?.remote))
        .sort((a, b) => Math.hypot(a.x - t.x, a.y - t.y) - Math.hypot(b.x - t.x, b.y - t.y))[0];
      if (chaser) {
        if (chaser.jobId) { const j = s.staff.jobs[chaser.jobId]; if (j) { j.engineerId = null; j.started = false; j.remote = false; } chaser.jobId = null; }
        chaser.state = 'chasing';
        chaser.chaseId = t.id;
        chaser.path = [];
      }
      if (t.state !== 'hacking') leave(s, t);
    }
  }
  const target = s.devices[t.targetId];
  if (!target && t.state !== 'leaving') leave(s, t);
  if (t.state === 'approach') {
    if (step(t, WALK_SPEED * 0.9)) t.state = 'hacking';
    return;
  }
  if (t.state === 'hacking') {
    if (!target) { leave(s, t); return; }
    if (watched(s, target.gridPos, SIGHT_RADIUS)) { hooks?.notify(`The stranger at ${target.name} saw staff nearby and backed off.`, 'info'); leave(s, t); return; }
    if (++t.progress >= HACK_SECONDS * TICKS_PER_SEC) {
      compromise(s, c, target, 'trespasser', target.kind === 'desk' ? 'Taken over at the keyboard: malware installed' : 'Tampered with at the console: backdoor installed');
      leave(s, t);
    }
    return;
  }
  if (step(t, WALK_SPEED * (t.spotted ? 1.15 : 1))) {
    if (!isIndoor(tileAt(s.floor, Math.floor(t.x), Math.floor(t.y))) && edgeSpawns(s.floor).some((p) => p.gx === Math.floor(t.x) && p.gy === Math.floor(t.y))) delete s.staff.trespassers[t.id];
    else leave(s, t);
  }
}

function leave(s: WorldState, t: Trespasser): void {
  t.state = 'leaving';
  const exits = edgeSpawns(s.floor);
  if (!routeTo(s, t, 'trespasser', exits)) delete s.staff.trespassers[t.id];
}

export function compromise(s: WorldState, c: RuntimeCache, d: Device, by: 'trespasser' | 'remote' | 'lateral', label: string): void {
  if (d.compromised) return;
  d.compromised = { since: s.time.tick, by, label };
  hooks?.log(s, d.id, `${d.name} COMPROMISED: ${label}`, 'alert');
  hooks?.notify(`${d.name} is compromised (${label}). An engineer must reimage it on site.`, 'alert');
  c.topologyDirty = true;
}

// ─── Tick ───────────────────────────────────────────────────────────────────

export function staffTick(s: WorldState, c: RuntimeCache): void {
  cacheRef = c;
  if (s.time.tick % 10 === 0) { assignDesks(s, c); dispatch(s, c); }
  for (const e of Object.values(s.staff.engineers)) tickEngineer(s, c, e);
  for (const t of Object.values(s.staff.trespassers)) tickTrespasser(s, c, t);
}

export function engineerActivity(s: WorldState, e: Engineer): string {
  const j = e.jobId ? s.staff.jobs[e.jobId] : undefined;
  const dn = j ? s.devices[j.deviceId]?.name ?? '?' : '';
  const verb: Record<JobKind, string> = { preventive: 'preventive maintenance on', full: 'repairing', replace: 'replacing', update: 'patching', reimage: 'reimaging', swap: 'fitting new parts in', upgrade: 'upgrading', inspect: 'checking' };
  if (e.state === 'chasing') return 'chasing a trespasser';
  if (j && j.remote) return `${verb[j.kind]} ${dn} remotely`;
  if (j && !j.started) return `rushing to ${dn}`;
  if (j) return `${verb[j.kind]} ${dn}`;
  if (e.state === 'seated') {
    const v = e.devOn ? s.services[e.devOn] : undefined;
    if (v) return `developing ${s.devices[v.serverId]?.name ?? ''} ${v.kind} v${(v.appVersion ?? 1) + 1} (${Math.round((v.devProgress ?? 0) * 100)} %)`;
    return `at ${s.devices[e.deskId ?? '']?.name ?? 'desk'} (cannot reach any server to deploy to)`;
  }
  if (e.state === 'walking') return e.deskId ? 'walking back to the desk' : 'walking';
  if (e.state === 'roaming') return 'wandering (no desk)';
  return e.deskId ? 'idle' : 'standing around (no desk)';
}

export { ROLES, parseIp };
