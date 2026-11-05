// The city: one street from end to end, packed with buildings on both sides.
//
// Every storey lives in its own horizontal band of one big grid: the city itself
// (street, pavements, every ground floor) is band 0, and a building's first floor
// is the same footprint STRIDE rows further down, and so on. That keeps cables,
// rooms, heat and walking flat 2D problems; lifts join the bands.

import { seeded } from '../rng';
import { cellKey } from './geometry';
import type { Building, Floor, GridPos, Rect, Tile } from './types';

export const CITY_W = 76;
export const CITY_H = 46;
export const STRIDE = CITY_H + 6;      // rows from one storey's band to the next
export const MAX_FLOORS = 4;
export const STREET_Y = 20;            // pavement, three lanes, pavement: rows 20–24

export const levelOf = (gy: number) => Math.max(0, Math.floor(gy / STRIDE));
export const localY = (gy: number) => gy - levelOf(gy) * STRIDE;
export const onLevel = (gy: number, level: number) => localY(gy) + level * STRIDE;

const NAMES = ['Aster', 'Birch', 'Cobalt', 'Delta', 'Elm', 'Fjord', 'Granite', 'Harbor', 'Iris', 'Juniper', 'Kestrel', 'Linden', 'Maple', 'Nimbus', 'Onyx', 'Pine', 'Quarry', 'Rowan', 'Slate', 'Tulip', 'Umber', 'Vale', 'Willow', 'Yarrow', 'Zinc'];
const KINDS = ['House', 'Works', 'Court', 'Point', 'Hall', 'Yard', 'Block', 'Lofts', 'Centre', 'Studios'];

export function inRects(rs: Rect[], x: number, y: number): boolean {
  return rs.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
}

/** Which building a cell (any storey) belongs to. */
export function buildingAt(buildings: Record<string, Building>, x: number, gy: number): Building | undefined {
  const lvl = levelOf(gy), y = localY(gy);
  return Object.values(buildings).find((b) => lvl < b.floors && inRects(b.rects, x, y));
}

/**
 * An ordinary footprint: mostly plain boxes, sometimes a small notch at a back
 * corner (a yard or a light well) or a slightly narrower back half. The street
 * front always stays one straight wall.
 */
function footprint(r: () => number, x0: number, x1: number, y0: number, y1: number, front: 'n' | 's'): Rect[] {
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const base: Rect = { x0, y0, x1, y1 };
  const roll = r();
  if (w < 9 || h < 9 || roll < 0.6) return [base];
  const back = front === 's' ? 'top' : 'bottom';
  if (roll < 0.85) {
    // a back corner notch, a quarter of the width, a third of the depth
    const nw = Math.max(3, Math.round(w * 0.28)), nh = Math.max(3, Math.round(h * 0.33));
    const left = r() < 0.5;
    const nx0 = left ? x0 : x1 - nw + 1, nx1 = left ? x0 + nw - 1 : x1;
    const main: Rect = left ? { x0: nx1 + 1, y0, x1, y1 } : { x0, y0, x1: nx0 - 1, y1 };
    const rest: Rect = back === 'top' ? { x0: nx0, x1: nx1, y0: y0 + nh, y1 } : { x0: nx0, x1: nx1, y0, y1: y1 - nh };
    return [main, rest];
  }
  // a back half set in by one cell on each side
  const half = Math.floor(h / 2);
  return back === 'top'
    ? [{ x0: x0 + 1, y0, x1: x1 - 1, y1: y0 + half - 1 }, { x0, y0: y0 + half, x1, y1 }]
    : [{ x0, y0, x1, y1: y0 + half }, { x0: x0 + 1, y0: y0 + half + 1, x1: x1 - 1, y1 }];
}

interface Lot { x0: number; x1: number; y0: number; y1: number; front: 'n' | 's' }

export interface CityPlan { floor: Floor; buildings: Record<string, Building>; starter: string }

/** A new city for a seed. The starter building is near the middle of the north side. */
export function generateCity(seed: number): CityPlan {
  const r = seeded(seed ^ 0xc17c);
  const f: Floor = { w: CITY_W, h: STRIDE * MAX_FLOORS, tiles: {} };
  const put = (x: number, y: number, t: Tile) => { f.tiles[cellKey(x, y)] = t; };
  // the street: pavement, three lanes, pavement
  for (let x = 0; x < CITY_W; x++) {
    put(x, STREET_Y, 'sidewalk');
    for (let y = STREET_Y + 1; y <= STREET_Y + 3; y++) put(x, y, 'street');
    put(x, STREET_Y + 4, 'sidewalk');
  }
  // lots on both sides, side by side with narrow gaps
  const lots: Lot[] = [];
  for (const front of ['s', 'n'] as const) {      // 's': north side, front faces south (the street)
    let x = 1 + Math.floor(r() * 2);
    while (x < CITY_W - 7) {
      const w = Math.min(CITY_W - 2 - x, 7 + Math.floor(r() * 7));
      if (w < 7) break;
      const depth = 8 + Math.floor(r() * 6);
      if (front === 's') {
        const y1 = STREET_Y - 2, y0 = Math.max(1, y1 - depth + 1);
        lots.push({ x0: x, x1: x + w - 1, y0, y1, front });
        // a back-row building behind it, across a one-cell alley
        if (y0 - 2 >= 7) lots.push({ x0: x, x1: x + w - 1 - Math.floor(r() * 2), y0: 1, y1: y0 - 2, front });
      } else {
        const y0 = STREET_Y + 6, y1 = Math.min(CITY_H - 2, y0 + depth - 1);
        lots.push({ x0: x, x1: x + w - 1, y0, y1, front });
        if (CITY_H - 2 - (y1 + 2) >= 6) lots.push({ x0: x, x1: x + w - 1 - Math.floor(r() * 2), y0: y1 + 2, y1: CITY_H - 2, front });
      }
      x += w + 1;
    }
  }
  // the starter: a north-side lot near the middle, made a tidy 12×10
  const mid = CITY_W / 2;
  const north = lots.filter((l) => l.front === 's' && l.y1 === STREET_Y - 2);
  const si = north.reduce((best, l, i) => (Math.abs((l.x0 + l.x1) / 2 - mid) < Math.abs((north[best]!.x0 + north[best]!.x1) / 2 - mid) ? i : best), 0);
  const starterLot = north[si]!;
  starterLot.x1 = Math.max(starterLot.x1, starterLot.x0 + 11);
  starterLot.y0 = STREET_Y - 11;
  // keep the lot's neighbours from overlapping the widened starter
  for (let i = lots.length - 1; i >= 0; i--) {
    const l = lots[i]!;
    if (l === starterLot || l.front !== 's' || l.x0 > starterLot.x1 + 1 || l.x1 < starterLot.x0) continue;
    if (l.y1 >= starterLot.y0 - 1 && l.y0 <= starterLot.y1) { if (l.x0 > starterLot.x0) l.x0 = starterLot.x1 + 2; else lots.splice(i, 1); }
    else if (l.y1 >= starterLot.y0 - 1) l.y1 = starterLot.y0 - 2;
  }
  const buildings: Record<string, Building> = {};
  let starter = '';
  let n = 0;
  const used = new Set<string>();
  const nameOf = () => {
    for (let i = 0; i < 50; i++) { const nm = `${NAMES[Math.floor(r() * NAMES.length)]} ${KINDS[Math.floor(r() * KINDS.length)]}`; if (!used.has(nm)) { used.add(nm); return nm; } }
    return `Building ${n}`;
  };
  for (const l of lots) {
    if (l.x1 - l.x0 < 6 || l.y1 - l.y0 < 6) continue;
    const isStarter = l === starterLot;
    const rects = isStarter ? [{ x0: l.x0, y0: l.y0, x1: l.x0 + 11, y1: l.y1 }] : footprint(r, l.x0, l.x1, l.y0, l.y1, l.front);
    const floors = isStarter ? 2 : 1 + Math.floor(r() * MAX_FLOORS);
    const id = `bld_${++n}`;
    const frontY = l.front === 's' ? l.y1 : l.y0;
    // entrance in the middle of the street-side wall
    const fxs = rects.filter((q) => (l.front === 's' ? q.y1 : q.y0) === frontY);
    const fr = fxs[0] ?? rects[0]!;
    const door: GridPos = { gx: Math.floor((fr.x0 + fr.x1) / 2), gy: frontY };
    // lift tucked in the back corner of the first rect
    const back = rects.reduce((a, q) => ((l.front === 's' ? q.y0 < a.y0 : q.y1 > a.y1) ? q : a), rects[0]!);
    const lift: GridPos = { gx: back.x0 + 1, gy: l.front === 's' ? back.y0 + 1 : back.y1 - 1 };
    const area = rects.reduce((a, q) => a + (q.x1 - q.x0 - 1) * (q.y1 - q.y0 - 1), 0);
    buildings[id] = {
      id, name: isStarter ? 'Your office' : nameOf(), rects, floors, front: l.front,
      owned: isStarter, forSale: isStarter, price: Math.round((area * floors * 65) / 500) * 500,
      door, lift, uplinkId: null,
    };
    if (isStarter) starter = id;
    // walls and floors on every storey
    for (let z = 0; z < floors; z++) {
      for (const q of rects) for (let x = q.x0; x <= q.x1; x++) for (let y = q.y0; y <= q.y1; y++) {
        const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !inRects(rects, x + dx!, y + dy!));
        put(x, y + z * STRIDE, edge ? 'xwall' : 'floor');
      }
      put(lift.gx, lift.gy + z * STRIDE, 'lift');
    }
    put(door.gx, door.gy, 'door');
  }
  // buildings next to yours are for sale, plus a few others
  const s0 = buildings[starter]!;
  for (const b of Object.values(buildings)) {
    if (b.owned) continue;
    const near = b.front === s0.front && b.rects.some((q) => s0.rects.some((p) => q.x0 <= p.x1 + 3 && q.x1 >= p.x0 - 3));
    b.forSale = near || r() < 0.25;
    if (near && b.floors < 3) {
      // a neighbour with a floor more than you: grow it, its footprint is already there
      const extra = 3 - b.floors;
      for (let z = b.floors; z < b.floors + extra; z++) {
        for (const q of b.rects) for (let x = q.x0; x <= q.x1; x++) for (let y = q.y0; y <= q.y1; y++) {
          const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !inRects(b.rects, x + dx!, y + dy!));
          put(x, y + z * STRIDE, edge ? 'xwall' : 'floor');
        }
        put(b.lift.gx, b.lift.gy + z * STRIDE, 'lift');
      }
      b.price = Math.round((b.price * (b.floors + extra)) / b.floors / 500) * 500;
      b.floors += extra;
    }
  }
  starterInterior(f, s0);
  return { floor: f, buildings, starter };
}

/** Your office: reception at the door, a server room at the back, an office upstairs. */
function starterInterior(f: Floor, b: Building): void {
  const q = b.rects[0]!;
  const put = (x: number, y: number, t: Tile) => { f.tiles[cellKey(x, y)] = t; };
  // ground floor: a wall splits the reception (front) from the server room (back)
  const split = q.y1 - 4;
  for (let x = q.x0 + 1; x < q.x1; x++) put(x, split, 'wall');
  put(q.x0 + 3, split, 'door');
  for (let x = q.x0 + 1; x < q.x1; x++) for (let y = q.y0 + 1; y < split; y++) if (f.tiles[cellKey(x, y)] !== 'lift') put(x, y, 'raised');
  // first floor: a small office at the front, the rest unused for now
  const up = STRIDE;
  const wallY = q.y1 - 4;
  for (let x = q.x0 + 1; x < q.x1; x++) put(x, wallY + up, 'wall');
  put(q.x0 + 2, wallY + up, 'door');
}

/** Cells of a building's storey (band-shifted). */
export function cellsOf(b: Building, level: number): GridPos[] {
  const out: GridPos[] = [];
  for (const q of b.rects) for (let x = q.x0; x <= q.x1; x++) for (let y = q.y0; y <= q.y1; y++) out.push({ gx: x, gy: y + level * STRIDE });
  return out;
}
