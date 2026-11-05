// Undo / redo for the player's changes: devices, addresses, rules, cables, floor,
// domains, public IPs. It never rewinds time: hardware wear, failures, patches,
// reputation and the money earned since stay as they are. Only what the change
// itself cost (or refunded) is given back.

import type { WorldState } from './types';
import { runtime, world } from './world';

type Sections = Pick<WorldState, 'devices' | 'cables' | 'floor' | 'domains' | 'publicAddrs' | 'services'>;
interface Entry { before: string; after: string; delta: number }

const LIMIT = 40;
const BURST_MS = 600;          // painting a wall or dragging counts as one change
const undoStack: Entry[] = [];
const redoStack: Entry[] = [];
let applying = false;
let lastAt = 0;
const listeners = new Set<() => void>();

// things the simulation owns: they are not part of "what you configured"
const DEVICE_LIVE = ['health', 'hw', 'temp', 'wear', 'age', 'sw', 'compromised', 'usage', 'specs', 'parts', 'macTable'] as const;
const SERVICE_LIVE = ['demand', 'reputation', 'availability', 'downSinceTick', 'downPenalised', 'upTicks', 'live', 'usedGB', 'appVersion', 'quality', 'devProgress', 'flowIds', 'flowId'] as const;

function sections(s: WorldState): Sections {
  return { devices: s.devices, cables: s.cables, floor: s.floor, domains: s.domains, publicAddrs: s.publicAddrs, services: s.services };
}

/** The configuration only, to tell whether a change touched it. */
function configKey(s: WorldState): string {
  return JSON.stringify(sections(s), (k, v) => {
    if ((DEVICE_LIVE as readonly string[]).includes(k) || (SERVICE_LIVE as readonly string[]).includes(k)) return undefined;
    if (k === 'up' || k === 'path') return undefined;   // NIC state, derived cable routes
    return v;
  });
}

function emit(): void { for (const fn of listeners) fn(); }
export function onUndoChange(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

/** Put a snapshot's configuration back, keeping everything that lives and ages. */
function restore(snapJson: string, money: number): void {
  const snap = JSON.parse(snapJson) as Sections;
  applying = true;
  try {
    world.update((w) => {
      const devices: WorldState['devices'] = {};
      for (const [id, d] of Object.entries(snap.devices)) {
        const cur = w.devices[id] as unknown as Record<string, unknown> | undefined;
        if (!cur) { devices[id] = d; continue; }
        const merged = { ...d } as unknown as Record<string, unknown>;
        for (const k of DEVICE_LIVE) if (k in cur) merged[k] = cur[k];
        // ports follow the hardware; their cable media is configuration
        const cp = cur.ports as { media?: string }[] | undefined;
        const sp = (d as unknown as { ports: { media?: string }[] }).ports;
        merged.ports = cp && cp.length === sp.length ? cp.map((p, i) => ({ ...p, media: sp[i]!.media })) : cp ?? sp;
        if ('extra' in cur && Array.isArray(cur.extra) && Array.isArray(merged.extra) && (merged.extra as unknown[]).length !== cur.extra.length) merged.extra = cur.extra;
        devices[id] = merged as unknown as WorldState['devices'][string];
      }
      w.devices = devices;
      w.cables = Object.fromEntries(Object.entries(snap.cables).filter(([, c]) => devices[c.a.deviceId] && devices[c.b.deviceId]));
      w.floor = snap.floor;
      w.domains = snap.domains;
      w.publicAddrs = snap.publicAddrs;
      const services: WorldState['services'] = {};
      for (const [id, v] of Object.entries(snap.services)) {
        if (!devices[v.serverId]) continue;
        const cur = w.services[id] as unknown as Record<string, unknown> | undefined;
        const merged = { ...v } as unknown as Record<string, unknown>;
        if (cur) for (const k of SERVICE_LIVE) if (k in cur) merged[k] = cur[k];
        services[id] = merged as unknown as WorldState['services'][string];
      }
      w.services = services;
      for (const j of Object.values(w.staff.jobs)) if (!devices[j.deviceId]) delete w.staff.jobs[j.id];
      w.economy.balance += money;
      if (money < 0) w.economy.totalSpent -= money;
      runtime.topologyDirty = true;
    });
  } finally {
    applying = false;
  }
}

export function undo(): { ok: boolean; money: number } {
  const e = undoStack.pop();
  if (!e) return { ok: false, money: 0 };
  restore(e.before, -e.delta);
  redoStack.push(e);
  emit();
  return { ok: true, money: -e.delta };
}

export function redo(): { ok: boolean; money: number } {
  const e = redoStack.pop();
  if (!e) return { ok: false, money: 0 };
  restore(e.after, e.delta);
  undoStack.push(e);
  emit();
  return { ok: true, money: e.delta };
}

/** Watch every player edit (reason 'world'); start over on new game or load. */
export function installUndo(): void {
  const update = world.update.bind(world);
  const replace = world.replace.bind(world);
  world.update = (mutate, reason = 'world') => {
    if (reason !== 'world' || applying) { update(mutate, reason); return; }
    const s0 = world.get();
    const keyBefore = configKey(s0);
    const before = JSON.stringify(sections(s0));
    const bal = s0.economy.balance;
    update(mutate, reason);
    const s1 = world.get();
    if (configKey(s1) === keyBefore) return;     // speed, toggles: nothing to undo
    const after = JSON.stringify(sections(s1));
    const delta = s1.economy.balance - bal;
    const now = performance.now();
    const top = undoStack[undoStack.length - 1];
    if (top && now - lastAt < BURST_MS) { top.after = after; top.delta += delta; }
    else { undoStack.push({ before, after, delta }); if (undoStack.length > LIMIT) undoStack.shift(); }
    lastAt = now;
    redoStack.length = 0;
    emit();
  };
  world.replace = (next, reason = 'load') => {
    if (reason === 'load') { undoStack.length = 0; redoStack.length = 0; emit(); }
    replace(next, reason);
  };
}
