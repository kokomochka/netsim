// Port positions, occupancy and L-bend cable routing (architecture v2, §2).
import { BODY, CELL, PORT_STUB } from '../balance';
import type { Cable, Device, DeviceId, Rotation, Side, Vec2, WorldState } from './types';

const SIDES: Side[] = ['N', 'E', 'S', 'W'];
const DIR: Record<Side, Vec2> = { N: { x: 0, y: -1 }, E: { x: 1, y: 0 }, S: { x: 0, y: 1 }, W: { x: -1, y: 0 } };

export const cellKey = (gx: number, gy: number) => `${gx},${gy}`;

export function rotateSide(s: Side, r: Rotation): Side {
  return SIDES[(SIDES.indexOf(s) + r) % 4]!;
}

export function deviceCenter(d: Device): Vec2 {
  return { x: (d.gridPos.gx + 0.5) * CELL, y: (d.gridPos.gy + 0.5) * CELL };
}

export function portSide(d: Device, portIndex: number): Side {
  return rotateSide(d.ports[portIndex]!.side, d.rotation);
}

export function portDir(d: Device, portIndex: number): Vec2 {
  return DIR[portSide(d, portIndex)];
}

export function portPos(d: Device, portIndex: number): Vec2 {
  const p = d.ports[portIndex]!;
  const dir = portDir(d, portIndex);
  const along = { x: -dir.y, y: dir.x };
  const c = deviceCenter(d);
  const t = (p.offset - 0.5) * BODY;
  return { x: c.x + dir.x * (BODY / 2) + along.x * t, y: c.y + dir.y * (BODY / 2) + along.y * t };
}

export function occupancy(state: WorldState): Map<string, DeviceId> {
  const m = new Map<string, DeviceId>();
  for (const d of Object.values(state.devices)) m.set(cellKey(d.gridPos.gx, d.gridPos.gy), d.id);
  return m;
}

/** Map of "deviceId:port" → cableId for every connected port. */
export function portUsage(state: WorldState): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of Object.values(state.cables)) {
    m.set(`${c.a.deviceId}:${c.a.port}`, c.id);
    m.set(`${c.b.deviceId}:${c.b.port}`, c.id);
  }
  return m;
}

export function freePorts(state: WorldState, d: Device, used = portUsage(state)): number[] {
  return d.ports.filter((p) => !used.has(`${d.id}:${p.index}`)).map((p) => p.index);
}

/** Free port of d whose attachment point is nearest to target. */
export function nearestFreePort(state: WorldState, d: Device, target: Vec2): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const i of freePorts(state, d)) {
    const p = portPos(d, i);
    const dist = Math.hypot(p.x - target.x, p.y - target.y);
    if (dist < bestDist) { bestDist = dist; best = i; }
  }
  return best;
}

/** Port index whose dot is within `radius` world px of point, or null. */
export function portAtPoint(d: Device, pt: Vec2, radius: number): number | null {
  let best: number | null = null;
  let bestDist = radius;
  for (const p of d.ports) {
    const pos = portPos(d, p.index);
    const dist = Math.hypot(pos.x - pt.x, pos.y - pt.y);
    if (dist < bestDist) { bestDist = dist; best = p.index; }
  }
  return best;
}

function cellsOnSegment(a: Vec2, b: Vec2): string[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(len / (CELL / 4)));
  const out: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const x = a.x + ((b.x - a.x) * i) / steps;
    const y = a.y + ((b.y - a.y) * i) / steps;
    out.push(cellKey(Math.floor(x / CELL), Math.floor(y / CELL)));
  }
  return out;
}

function dedupe(points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    // drop the middle point of three collinear points
    const prev = out[out.length - 2];
    if (prev && last) {
      const collinear = (Math.abs(prev.x - last.x) < 0.01 && Math.abs(last.x - p.x) < 0.01)
        || (Math.abs(prev.y - last.y) < 0.01 && Math.abs(last.y - p.y) < 0.01);
      if (collinear) out.pop();
    }
    out.push(p);
  }
  return out;
}

/**
 * L-bend route: port → short stub → one horizontal + one vertical leg → stub → port.
 * Of the two possible corners, picks the one crossing fewer other devices.
 */
export function routeCable(state: WorldState, cable: Pick<Cable, 'a' | 'b'>, occ = occupancy(state)): Vec2[] {
  const da = state.devices[cable.a.deviceId];
  const db = state.devices[cable.b.deviceId];
  if (!da || !db) return [];
  const a = portPos(da, cable.a.port);
  const b = portPos(db, cable.b.port);
  const dirA = portDir(da, cable.a.port);
  const dirB = portDir(db, cable.b.port);
  const sa = { x: a.x + dirA.x * PORT_STUB, y: a.y + dirA.y * PORT_STUB };
  const sb = { x: b.x + dirB.x * PORT_STUB, y: b.y + dirB.y * PORT_STUB };
  const ends = new Set([cellKey(da.gridPos.gx, da.gridPos.gy), cellKey(db.gridPos.gx, db.gridPos.gy)]);

  const score = (corner: Vec2) => {
    const hit = new Set<string>();
    for (const k of [...cellsOnSegment(sa, corner), ...cellsOnSegment(corner, sb)]) {
      if (occ.has(k) && !ends.has(k)) hit.add(k);
    }
    let s = hit.size * 10;
    // prefer leaving each port in the direction it faces
    const legA = { x: corner.x - sa.x, y: corner.y - sa.y };
    if (legA.x * dirA.x + legA.y * dirA.y < 0) s += 1;
    const legB = { x: corner.x - sb.x, y: corner.y - sb.y };
    if (legB.x * dirB.x + legB.y * dirB.y < 0) s += 1;
    return s;
  };

  const c1 = { x: sb.x, y: sa.y }; // horizontal first
  const c2 = { x: sa.x, y: sb.y }; // vertical first
  const corner = score(c1) <= score(c2) ? c1 : c2;
  return dedupe([a, sa, corner, sb, b]);
}

export function recomputeAllPaths(state: WorldState): void {
  const occ = occupancy(state);
  for (const c of Object.values(state.cables)) c.path = routeCable(state, c, occ);
}

export function distToPolyline(pt: Vec2, path: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2));
    best = Math.min(best, Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy)));
  }
  return best;
}
