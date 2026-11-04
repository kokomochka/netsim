// Air temperature. Rooms are walled areas of floor. Every device turns the
// watts it draws into heat in its room; rooms lose heat through their walls,
// swap air through vents (with each other, or a little with the outside), and
// AC units pump heat out. Each device's own temperature is worked out in hw.ts
// from its inlet air (the room) and the power it draws.

import {
  AC_COOLING_KW, DAY_TICKS, DESK_MAX_ROOM_C, OUTSIDE_TEMP, ROOM_HEAT_CAPACITY, TICKS_PER_SEC, VENT_OUTSIDE_K, VENT_ROOM_K, WALL_LEAK,
} from '../balance';
import { deviceSecond, serverSecond, wattsOf } from './hw';
import { isIndoor, tileAt } from '../state/floor';
import { cellKey } from '../state/geometry';
import type { Device, GridPos, Room, RuntimeCache, Tile, WorldState } from '../state/types';

let hooks: { notify: (m: string, l: 'info' | 'warn' | 'alert' | 'good') => void; log: (s: WorldState, id: string, m: string, l: 'info' | 'warn' | 'alert') => void } | null = null;
export function setClimateHooks(h: typeof hooks): void { hooks = h; }

const DOOR_K = 0.04;
const OUTSIDE = 'outside';
let roomsKey = '';

const solid = (t: Tile) => t === 'wall' || t === 'vent' || t === 'door' || t === 'smartdoor';

/** Flood-fill walled areas of indoor floor. */
export function computeRooms(s: WorldState, cache: RuntimeCache): void {
  const f = s.floor;
  const key = JSON.stringify(f.tiles);
  if (key === roomsKey && cache.rooms.length) return;
  roomsKey = key;
  const cellRoom: Record<string, string> = {};
  const rooms: Room[] = [];
  for (const k of Object.keys(f.tiles).sort()) {
    if (cellRoom[k] || !isIndoor(f.tiles[k]!)) continue;
    const cells: string[] = [];
    const q = [k];
    cellRoom[k] = k;
    while (q.length) {
      const c = q.shift()!;
      cells.push(c);
      const [x, y] = c.split(',').map(Number) as [number, number];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = cellKey(x + dx!, y + dy!);
        if (cellRoom[n] || !isIndoor(tileAt(f, x + dx!, y + dy!))) continue;
        cellRoom[n] = k;
        q.push(n);
      }
    }
    rooms.push({ key: k, cells, size: cells.length });
  }
  // carry temperatures over to the new layout
  const old = s.climate.rooms;
  const next: Record<string, number> = {};
  for (const r of rooms) {
    const temps = r.cells.map((c) => old[cache.cellRoom[c] ?? ''] ).filter((t): t is number => t !== undefined);
    next[r.key] = old[r.key] ?? (temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : s.climate.outside);
  }
  s.climate.rooms = next;
  cache.rooms = rooms;
  cache.cellRoom = cellRoom;
}

const sideOf = (s: WorldState, cache: RuntimeCache, x: number, y: number): string | null => {
  const t = tileAt(s.floor, x, y);
  if (isIndoor(t)) return cache.cellRoom[cellKey(x, y)] ?? null;
  if (t === 'ground') return OUTSIDE;
  return null;
};

/** What a vent or door connects: the two cells across it. */
export function across(s: WorldState, cache: RuntimeCache, x: number, y: number): [string, string] | null {
  const h = [sideOf(s, cache, x - 1, y), sideOf(s, cache, x + 1, y)];
  if (h[0] && h[1]) return [h[0], h[1]];
  const v = [sideOf(s, cache, x, y - 1), sideOf(s, cache, x, y + 1)];
  if (v[0] && v[1]) return [v[0], v[1]];
  return null;
}

export function roomAt(cache: RuntimeCache, at: GridPos): string | null {
  return cache.cellRoom[cellKey(at.gx, at.gy)] ?? null;
}

export function roomTemp(s: WorldState, cache: RuntimeCache, at: GridPos): number {
  const r = roomAt(cache, at);
  return r ? s.climate.rooms[r] ?? s.climate.outside : s.climate.outside;
}

/** kW a device is putting into the room right now. */
export function heatOf(d: Device): number {
  return wattsOf(d) / 1000;
}

export function climateTick(s: WorldState, cache: RuntimeCache): void {
  if (s.time.tick % TICKS_PER_SEC !== 0) return;
  computeRooms(s, cache);
  const dt = 1;
  s.climate.outside = OUTSIDE_TEMP + 4 * Math.sin((2 * Math.PI * s.time.tick) / DAY_TICKS);
  const T = s.climate.rooms;
  const tOf = (k: string) => (k === OUTSIDE ? s.climate.outside : T[k] ?? s.climate.outside);
  const q: Record<string, number> = {};
  for (const r of cache.rooms) q[r.key] = 0;
  // devices and people
  for (const d of Object.values(s.devices)) {
    const r = roomAt(cache, d.gridPos);
    if (!r) continue;
    if (d.kind === 'ac') {
      if (d.on && d.health.state !== 'failed') q[r]! -= AC_COOLING_KW * Math.max(0, Math.min(1, (tOf(r) - 16) / 4));
      continue;
    }
    q[r]! += heatOf(d);
  }
  for (const e of Object.values(s.staff.engineers)) {
    const r = roomAt(cache, { gx: Math.floor(e.x), gy: Math.floor(e.y) });
    if (r) q[r]! += 0.1;
  }
  // walls leak toward the outside
  for (const r of cache.rooms) q[r.key]! -= WALL_LEAK * Math.sqrt(r.size) * (tOf(r.key) - s.climate.outside);
  // vents and (closed) doors exchange air between the spaces they join
  for (const [k, t] of Object.entries(s.floor.tiles)) {
    if (t !== 'vent' && t !== 'door' && t !== 'smartdoor') continue;
    const [x, y] = k.split(',').map(Number) as [number, number];
    const pair = across(s, cache, x, y);
    if (!pair || pair[0] === pair[1]) continue;
    const kk = t === 'vent' ? (pair.includes(OUTSIDE) ? VENT_OUTSIDE_K : VENT_ROOM_K) : DOOR_K;
    const flow = kk * (tOf(pair[0]) - tOf(pair[1]));
    if (pair[0] !== OUTSIDE) q[pair[0]]! -= flow;
    if (pair[1] !== OUTSIDE) q[pair[1]]! += flow;
  }
  for (const r of cache.rooms) {
    T[r.key] = tOf(r.key) + (q[r.key]! / (ROOM_HEAT_CAPACITY * r.size)) * dt;
    T[r.key] = Math.max(-10, Math.min(120, T[r.key]!));
  }
  // every device: temperature from its inlet air and its own watts, then wear
  for (const d of Object.values(s.devices)) {
    const air = roomTemp(s, cache, d.gridPos);
    if (d.kind === 'server') serverSecond(s, cache, d, air);
    else deviceSecond(s, cache, d, air);
  }
}

/** Engineers will not work at a desk in a room this hot. */
export function deskTooHot(s: WorldState, cache: RuntimeCache, d: Device): boolean {
  return roomTemp(s, cache, d.gridPos) > DESK_MAX_ROOM_C;
}
