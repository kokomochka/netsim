// Floor plan: tiles, walls, doors, and grid pathfinding for people.
import { MAP_H, MAP_W, SIGHT_RADIUS } from '../balance';
import { cellKey } from './geometry';
import type { DeviceKind, Floor, GridPos, Rect, Tile, WorldState } from './types';

export const tileAt = (f: Floor, x: number, y: number): Tile => f.tiles[cellKey(x, y)] ?? 'ground';
export const inMap = (f: Floor, x: number, y: number) => x >= 0 && y >= 0 && x < f.w && y < f.h;
export const isIndoor = (t: Tile) => t === 'floor' || t === 'raised';
export const isDoor = (t: Tile) => t === 'door' || t === 'smartdoor';

/** A rectangular room: walls on the border, floor inside. */
export function addRoom(f: Floor, x0: number, y0: number, x1: number, y1: number, inner: Tile = 'floor'): void {
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const edge = x === x0 || x === x1 || y === y0 || y === y1;
      const cur = tileAt(f, x, y);
      if (edge) { if (!isIndoor(cur) && !isDoor(cur)) f.tiles[cellKey(x, y)] = 'wall'; }
      else f.tiles[cellKey(x, y)] = inner;
    }
  }
}

export function starterFloor(): Floor {
  const f: Floor = { w: MAP_W, h: MAP_H, tiles: {} };
  addRoom(f, 1, 1, 14, 11);
  f.tiles[cellKey(8, 11)] = 'door';
  f.parking = { x0: 1, y0: 13, x1: 14, y1: 18 };
  return f;
}

export const inRect = (r: Rect | undefined, x: number, y: number) => !!r && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
export const inParking = (f: Floor, x: number, y: number) => inRect(f.parking, x, y);

/** Outdoor cell next to the building: drawn as a paved footpath. */
export function isPath(f: Floor, x: number, y: number): boolean {
  if (tileAt(f, x, y) !== 'ground' || inParking(f, x, y)) return false;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if ((dx || dy) && tileAt(f, x + dx, y + dy) !== 'ground') return true;
  return false;
}

/** Can this kind of device stand on this cell? Everything goes indoors. */
export function placementError(f: Floor, kind: DeviceKind, x: number, y: number): string | null {
  if (!inMap(f, x, y)) return 'Outside the plot.';
  if (inParking(f, x, y)) return 'The parking lot is a no-build zone.';
  const t = tileAt(f, x, y);
  return isIndoor(t) ? null : 'Devices go on a floor tile inside the building. Lay floor with the Build tools first.';
}

/** Wrap an existing layout (old saves, the example) in a building. */
export function floorAround(s: Pick<WorldState, 'devices'>): Floor {
  const f: Floor = { w: MAP_W, h: MAP_H, tiles: {} };
  const ds = Object.values(s.devices);
  if (!ds.length) return starterFloor();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const d of ds) { x0 = Math.min(x0, d.gridPos.gx); y0 = Math.min(y0, d.gridPos.gy); x1 = Math.max(x1, d.gridPos.gx); y1 = Math.max(y1, d.gridPos.gy); }
  x0 = Math.max(0, x0 - 2); y0 = Math.max(0, y0 - 2); x1 = Math.min(MAP_W - 1, x1 + 3); y1 = Math.min(MAP_H - 1, y1 + 3);
  addRoom(f, x0, y0, x1, y1);
  f.tiles[cellKey(Math.round((x0 + x1) / 2), y1)] = 'door';
  if (y1 + 3 < MAP_H) f.parking = { x0, y0: y1 + 2, x1, y1: Math.min(MAP_H - 2, y1 + 7) };
  return f;
}

export type Mover = 'engineer' | 'trespasser';

export interface PathEnv {
  blocked: Set<string>;          // cells with devices
  doors: Record<string, { state: 'locked' | 'open' | 'sealed' }>;   // smart door states
  allow?: Set<string>;           // cells that are walkable for this trip (own desk, target)
}

export function walkable(f: Floor, env: PathEnv, who: Mover, x: number, y: number): boolean {
  if (!inMap(f, x, y)) return false;
  const k = cellKey(x, y);
  if (env.allow?.has(k)) return true;
  if (env.blocked.has(k)) return false;
  const t = tileAt(f, x, y);
  if (t === 'wall') return false;
  if (t === 'smartdoor') {
    const st = env.doors[k]?.state ?? 'open';
    if (st === 'sealed') return false;
    if (st === 'locked' && who === 'trespasser') return false;
  }
  return true;
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

/** A* over the grid. Diagonals may not cut wall corners. Returns waypoints after the start. */
export function findPath(f: Floor, env: PathEnv, who: Mover, from: GridPos, goals: GridPos[]): GridPos[] | null {
  if (!goals.length) return null;
  const goalSet = new Set(goals.map((g) => cellKey(g.gx, g.gy)));
  const startK = cellKey(from.gx, from.gy);
  if (goalSet.has(startK)) return [];
  const h = (x: number, y: number) => Math.min(...goals.map((g) => Math.max(Math.abs(g.gx - x), Math.abs(g.gy - y))));
  const open: { k: string; x: number; y: number; g: number; f: number }[] = [{ k: startK, x: from.gx, y: from.gy, g: 0, f: h(from.gx, from.gy) }];
  const came = new Map<string, string>();
  const gScore = new Map<string, number>([[startK, 0]]);
  let guard = 0;
  while (open.length && guard++ < 4000) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i]!.f < open[bi]!.f) bi = i;
    const cur = open.splice(bi, 1)[0]!;
    if (goalSet.has(cur.k)) {
      const out: GridPos[] = [];
      let k: string | undefined = cur.k;
      while (k && k !== startK) { const [x, y] = k.split(',').map(Number); out.unshift({ gx: x!, gy: y! }); k = came.get(k); }
      return out;
    }
    for (const [dx, dy] of DIRS) {
      const nx = cur.x + dx, ny = cur.y + dy;
      const nk = cellKey(nx, ny);
      const isGoal = goalSet.has(nk);
      if (!isGoal && !walkable(f, env, who, nx, ny)) continue;
      if (isGoal && !walkable(f, { ...env, allow: new Set([...(env.allow ?? []), nk]) }, who, nx, ny)) continue;
      if (dx && dy && (!walkable(f, env, who, cur.x + dx, cur.y) || !walkable(f, env, who, cur.x, cur.y + dy))) continue;
      const g = cur.g + (dx && dy ? 1.414 : 1);
      if (g >= (gScore.get(nk) ?? Infinity)) continue;
      gScore.set(nk, g);
      came.set(nk, cur.k);
      open.push({ k: nk, x: nx, y: ny, g, f: g + h(nx, ny) });
    }
  }
  return null;
}

/** Free cells next to a device where a person can stand to work on it. */
export function workSpots(f: Floor, env: PathEnv, who: Mover, at: GridPos): GridPos[] {
  const out: GridPos[] = [];
  for (const [dx, dy] of DIRS) {
    const x = at.gx + dx, y = at.gy + dy;
    if (walkable(f, env, who, x, y)) out.push({ gx: x, gy: y });
  }
  return out;
}

export const cheb = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

/** Is this cell inside some engineer's watch radius? */
export function watched(s: WorldState, at: GridPos, radius = SIGHT_RADIUS): boolean {
  return Object.values(s.staff.engineers).some((e) => cheb(Math.round(e.x - 0.5), Math.round(e.y - 0.5), at.gx, at.gy) <= radius);
}

/** Outside cells on the map edge where strangers can appear. */
export function edgeSpawns(f: Floor): GridPos[] {
  const out: GridPos[] = [];
  for (let x = 0; x < f.w; x++) for (const y of [0, f.h - 1]) if (tileAt(f, x, y) === 'ground') out.push({ gx: x, gy: y });
  for (let y = 0; y < f.h; y++) for (const x of [0, f.w - 1]) if (tileAt(f, x, y) === 'ground') out.push({ gx: x, gy: y });
  return out;
}
