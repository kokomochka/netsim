// The city seen from above, Factorio-style: everything that stands up shows its
// top face lifted by its height and its south face below it, with a soft shadow.
// Depth comes from drawing back to front (by the y of each thing's base).

import { Container, Graphics } from 'pixi.js';
import { BODY, CELL } from '../balance';
import { CITY_H, CITY_W, STREET_Y, STRIDE, buildingAt, inRects } from '../state/city';
import type { Building, Device, DeviceKind, Floor, Vec2, WorldState } from '../state/types';
import { deviceContext } from './icons';
import { COLORS, KIND_COLOR } from './palette';

const WALL_H = 12;
const WALL_T = 10;
const HEIGHT: Record<DeviceKind, number> = {
  server: 16, router: 8, switch: 5, firewall: 10, ddos_scrubber: 9, uplink: 8,
  desk: 7, tower: 30, ac: 14, badge: 0,
};

export function shade(c: number, f: number): number {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  const t = f < 0 ? 0 : 255, k = Math.abs(f);
  return (Math.round(r + (t - r) * k) << 16) | (Math.round(g + (t - g) * k) << 8) | Math.round(b + (t - b) * k);
}
function mixc(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}
const h32 = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

/** A block on [x0,x1]×[y0,y1], H tall: south face, then the lifted top. Returns its screen outline. */
export function block(g: Graphics, x0: number, y0: number, x1: number, y1: number, H: number, top: number, front: number, shadow = true): { x: number; y: number; w: number; h: number } {
  if (shadow) g.rect(x0 + 3, y0 + 3, x1 - x0, y1 - y0).fill({ color: 0x000000, alpha: 0.16 });
  g.rect(x0, y1 - H, x1 - x0, H).fill({ color: front });
  g.rect(x0, y0 - H, x1 - x0, y1 - y0).fill({ color: top });
  return { x: x0, y: y0 - H, w: x1 - x0, h: y1 - y0 + H };
}

// ── buildings ─────────────────────────────────────────────────────────────
const FACADE = [0xc9b9a0, 0xb7a58f, 0xd4c8b2, 0xa9a39a, 0xc2b6a6, 0xb59c84, 0xd1c4ae, 0x9fa6ab];
const FLAT_ROOF = [0x8a8d91, 0x7d8085, 0x93918a, 0x6f7479];
const TILE_ROOF = [0x9c5b45, 0x8a4f3c, 0x6d6f73, 0x7a5848, 0xa8674c];
export const STOREY_H = 18;

/**
 * A whole building seen from above, every storey from `level` up stacked:
 * a facade with a row of windows per floor, then a roof. Small low houses get a
 * pitched tiled roof; the rest a flat roof with a parapet, a stair hut and plant.
 * Returns the y the block stands on, for depth sorting.
 */
export function drawBuilding(g: Graphics, b: Building, level: number, dy: number, mark?: number): number {
  const h = h32(b.id);
  const floors = b.floors - level;
  const H = 6 + floors * STOREY_H;
  const facade = FACADE[h % FACADE.length]!;
  const xs = b.rects.flatMap((q) => [q.x0, q.x1]), ys = b.rects.flatMap((q) => [q.y0, q.y1]);
  const bw = Math.max(...xs) - Math.min(...xs) + 1, bd = Math.max(...ys) - Math.min(...ys) + 1;
  const pitched = b.floors <= 2 && b.rects.length === 1 && Math.min(bw, bd) <= 12;
  const rects = [...b.rects].sort((a, c) => a.y1 - c.y1);
  let maxY = 0;
  // shadows first, so one wing never darkens the other
  for (const q of rects) g.rect(q.x0 * CELL + 6, (q.y0 + dy) * CELL + 4, (q.x1 - q.x0 + 1) * CELL, (q.y1 - q.y0 + 1) * CELL).fill({ color: 0x000000, alpha: 0.2 });
  for (const q of rects) {
    const x0 = q.x0 * CELL, x1 = (q.x1 + 1) * CELL, y1 = (q.y1 + 1 + dy) * CELL;
    // the south face: a band per storey, a ledge between floors, windows
    g.rect(x0, y1 - H, x1 - x0, H).fill({ color: shade(facade, -0.18) });
    for (let fl = 0; fl < floors; fl++) {
      const fy = y1 - (fl + 1) * STOREY_H;
      g.rect(x0, fy, x1 - x0, 2).fill({ color: shade(facade, -0.34) });
      for (let wx = x0 + 8; wx + 12 <= x1 - 6; wx += 20) {
        const lit = (h32(`${b.id}${fl}${wx}`) & 7) === 0;
        g.rect(wx, fy + 5, 12, 9).fill({ color: lit ? 0xf3e2a6 : 0x9fb6c6 });
        g.rect(wx, fy + 5, 12, 2).fill({ color: 0xffffff, alpha: 0.35 });
      }
    }
    // the front door, on the street side
    if (level === 0 && b.front === 's' && q.y1 === Math.max(...ys) && b.door.gx >= q.x0 && b.door.gx <= q.x1) {
      const dx = b.door.gx * CELL + CELL / 2;
      g.rect(dx - 9, y1 - 16, 18, 16).fill({ color: 0x4a3a2c });
      g.rect(dx - 12, y1 - 19, 24, 3).fill({ color: shade(facade, -0.45) });
    }
    maxY = Math.max(maxY, y1);
  }
  // roofs, lifted by the building's height
  for (const q of rects) {
    const x0 = q.x0 * CELL, y0 = (q.y0 + dy) * CELL - H, x1 = (q.x1 + 1) * CELL, y1 = (q.y1 + 1 + dy) * CELL - H;
    if (pitched) {
      const tile = TILE_ROOF[(h >>> 5) % TILE_ROOF.length]!;
      if (x1 - x0 >= y1 - y0) {
        // ridge east–west: the south slope faces you, the north one is foreshortened
        const ridge = y0 + (y1 - y0) * 0.42;
        g.rect(x0 - 3, y0 - 2, x1 - x0 + 6, ridge - y0 + 2).fill({ color: shade(tile, -0.22) });
        g.rect(x0 - 3, ridge, x1 - x0 + 6, y1 - ridge + 3).fill({ color: tile });
        for (let ty = ridge + 6; ty < y1; ty += 6) g.rect(x0 - 3, ty, x1 - x0 + 6, 1).fill({ color: shade(tile, -0.12), alpha: 0.6 });
        g.rect(x0 - 3, ridge - 1.5, x1 - x0 + 6, 3).fill({ color: shade(tile, -0.35) });
      } else {
        // ridge north–south: a lit west slope and a shaded east one
        const mid = (x0 + x1) / 2;
        g.rect(x0 - 3, y0 - 2, mid - x0 + 3, y1 - y0 + 5).fill({ color: tile });
        g.rect(mid, y0 - 2, x1 - mid + 3, y1 - y0 + 5).fill({ color: shade(tile, -0.22) });
        for (let tx = x0 + 3; tx < mid; tx += 6) g.rect(tx, y0 - 2, 1, y1 - y0 + 5).fill({ color: shade(tile, -0.12), alpha: 0.6 });
        g.rect(mid - 1.5, y0 - 2, 3, y1 - y0 + 5).fill({ color: shade(tile, -0.35) });
      }
    } else {
      const roof = FLAT_ROOF[(h >>> 7) % FLAT_ROOF.length]!;
      // parapet, then gravel with a little texture
      g.rect(x0, y0, x1 - x0, y1 - y0).fill({ color: shade(facade, -0.05) });
      g.rect(x0 + 7, y0 + 7, x1 - x0 - 14, y1 - y0 - 14).fill({ color: roof });
      g.rect(x0 + 7, y0 + 7, x1 - x0 - 14, 3).fill({ color: shade(roof, -0.25) });
      for (let k = 0; k < ((x1 - x0) * (y1 - y0)) / 900; k++) {
        const hh = h32(`${b.id}g${k}`);
        g.rect(x0 + 10 + (hh % Math.max(1, x1 - x0 - 22)), y0 + 12 + ((hh >>> 12) % Math.max(1, y1 - y0 - 24)), 2, 2).fill({ color: shade(roof, (hh & 1) ? 0.12 : -0.12) });
      }
    }
  }
  if (!pitched) {
    // a stair hut over the lift, and an AC unit on some roofs
    const lx = b.lift.gx * CELL, ly = (b.lift.gy + dy) * CELL - H;
    block(g, lx + 4, ly + 6, lx + CELL - 4, ly + CELL + 2, 10, shade(facade, -0.08), shade(facade, -0.3), false);
    const q = rects[rects.length - 1]!;
    if ((h & 1) === 0 && q.x1 - q.x0 >= 5) {
      const ax = (q.x1 - 1) * CELL - 8, ay = (q.y0 + dy + 2) * CELL - H;
      block(g, ax, ay, ax + 26, ay + 18, 8, 0xc9ccd0, 0x8d9298, false);
      g.circle(ax + 13, ay + 1, 6).stroke({ width: 1.5, color: 0x6f757c });
    }
  }
  if (mark !== undefined) {
    for (const q of rects) g.rect(q.x0 * CELL, (q.y0 + dy) * CELL - H, (q.x1 - q.x0 + 1) * CELL, (q.y1 - q.y0 + 1) * CELL + H).stroke({ width: 5, color: mark, alpha: 0.9 });
  }
  if (b.owned) {
    // yours fly a blue flag
    const q = rects[0]!;
    const fx = q.x0 * CELL + 14, fy = (q.y0 + dy) * CELL - H + 18;
    g.ellipse(fx + 1, fy, 6, 3).fill({ color: 0x000000, alpha: 0.25 });
    g.rect(fx, fy - 44, 3, 44).fill({ color: 0x5b6168 });
    g.poly([fx + 3, fy - 44, fx + 36, fy - 36, fx + 3, fy - 27]).fill({ color: 0x2f6db5 });
  }
  return maxY;
}

// ── people ────────────────────────────────────────────────────────────────
const SKIN = [0xf1d3b3, 0xe0b48f, 0xc68e63, 0x9a6440, 0x6e4529];
const HAIR = [0x2b211b, 0x5a3a22, 0xa36b2c, 0xd9b26a, 0x1c1c22, 0x8a8a8a];
const SHIRT = [0x2f6db5, 0x2e8b6a, 0x6a55c9, 0xc98a1a, 0xc0473f, 0x2a95ad, 0x7a7a7a, 0x8d5a3b];
const PANTS = [0x2a3547, 0x3b4a63, 0x45526a, 0x24314a, 0x4a3b2e];
export interface Look { skin: number; hair: number; shirt: number; pants: number; hood?: boolean }
export const lookOf = (id: string, stranger = false): Look => {
  const h = h32(id);
  return stranger
    ? { skin: SKIN[h % SKIN.length]!, hair: 0x15151a, shirt: 0x26262e, pants: 0x1b1b22, hood: true }
    : { skin: SKIN[h % SKIN.length]!, hair: HAIR[(h >>> 4) % HAIR.length]!, shirt: SHIRT[(h >>> 8) % SHIRT.length]!, pants: PANTS[(h >>> 12) % PANTS.length]! };
};

/** A little side-view person, feet at (0,0), facing right when dir = 1. */
export function person(g: Graphics, look: Look, dir: 1 | -1, walking: boolean, seated: boolean, t: number, u = 1.7): void {
  const px = (x: number, y: number, w: number, h: number, color: number) => {
    const ax = dir === 1 ? x : -x - w;
    g.rect(ax * u, y * u, w * u, h * u).fill({ color });
  };
  const swing = walking ? Math.sin(t * 0.012) : 0;
  g.ellipse(0, 0.5, 5.5 * u / 1.7, 2 * u / 1.7).fill({ color: 0x000000, alpha: 0.2 });
  if (seated) {
    px(-2, -4, 6, 2, look.pants); px(3, -4, 2, 4, look.pants);
    px(-2, -11, 5, 7, look.shirt); px(1, -9, 3, 2, shade(look.shirt, -0.2));
    px(-2, -16, 5, 5, look.skin); px(-2, -17, 5, 2, look.hair); px(-2, -15, 1, 3, look.hair);
    px(2, -14, 1, 1, 0x1a1a1a);
    return;
  }
  const leg = Math.round(swing * 1.4);
  px(-2 + leg, -6, 2, 6, look.pants);
  px(0 - leg, -6, 2, 6, shade(look.pants, 0.12));
  px(-2.5, -13, 5, 7, look.shirt);
  px(-1 - Math.round(swing), -12, 1.6, 5, shade(look.shirt, -0.25));
  if (look.hood) {
    px(-3, -19, 6, 6.5, look.shirt); px(0.5, -17, 2.5, 3.5, look.skin); px(2, -16, 1, 1, 0xff4b4b);
  } else {
    px(-2.5, -18, 5, 5, look.skin); px(-2.5, -19, 5, 2, look.hair); px(-2.5, -17.5, 1.5, 3, look.hair); px(1.5, -16, 1, 1, 0x1a1a1a);
  }
}

// ── cars ──────────────────────────────────────────────────────────────────
const CAR = [0xb8423a, 0x2e6fb0, 0xe8e6e1, 0x2f8a5c, 0xd9a521, 0x7d848c, 0x5b4a8a, 0x1f2328];
function car(g: Graphics, x: number, y: number, dir: 1 | -1, color: number): void {
  const L = 40, W = 20, H = 9;
  const x0 = x - L / 2, y0 = y - W / 2;
  g.roundRect(x0 + 3, y0 + 4, L, W, 6).fill({ color: 0x000000, alpha: 0.25 });
  g.roundRect(x0, y0 + W - H, L, H, 5).fill({ color: shade(color, -0.3) });       // side
  g.roundRect(x0, y0 - H + 4, L, W, 6).fill({ color });                             // body top
  // cabin: windscreen toward the front, then the roof
  const cx0 = x0 + (dir === 1 ? 9 : 7), cw = L - 16;
  g.roundRect(cx0, y0 - H + 7, cw, W - 6, 4).fill({ color: 0x24303d, alpha: 0.85 });
  g.roundRect(cx0 + (dir === 1 ? 3 : 4), y0 - H + 8, cw - 9, W - 8, 3).fill({ color: shade(color, 0.12) });
  // lights
  const fx = dir === 1 ? x0 + L - 3 : x0 + 1;
  g.rect(fx, y0 - H + 6, 2, 3).fill({ color: 0xfff2b0 }); g.rect(fx, y0 - H + W - 1, 2, 3).fill({ color: 0xfff2b0 });
  const bx = dir === 1 ? x0 + 1 : x0 + L - 3;
  g.rect(bx, y0 - H + 6, 2, 3).fill({ color: 0xd83a30 }); g.rect(bx, y0 - H + W - 1, 2, 3).fill({ color: 0xd83a30 });
}

interface BoxView { g: Graphics; icon: Graphics; leds: Graphics; hull: { x: number; y: number; w: number; h: number }; z: number; led: Vec2[]; kind: DeviceKind; born: number; iconY: number; lift: number; fan?: Vec2 }
interface Mover { x: number; y: number; v: number; dir: 1 | -1; color: number; id: string }

export class VolumeScene {
  readonly stand = new Container({ sortableChildren: true });
  private statics: Graphics[] = [];
  private boxes = new Map<string, BoxView>();
  private people = new Map<string, Graphics>();
  private facing = new Map<string, { x: number; dir: 1 | -1 }>();
  private built = false;
  private traffic = new Graphics();
  private cars: Mover[] = [];
  private walkers: Mover[] = [];
  private walkerG = new Map<string, Graphics>();
  private lastT = 0;
  level = 0;
  /** The building opened up for you to see inside; '' shows the whole city with roofs on. */
  focus = '';

  /** Is this cell's inside on show? Cells outside buildings always are. */
  cellVisible(s: WorldState, gx: number, gy: number): boolean {
    if (gx < -20) return false;      // sites across town live off the map
    const b = buildingAt(s.buildings, gx, gy);
    return !b || (b.owned && b.id === this.focus);
  }

  constructor() {
    this.traffic.zIndex = (STREET_Y + 3) * CELL;
    this.stand.addChild(this.traffic);
    // a few cars and pedestrians to begin with
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 7; i++) this.cars.push({ x: rnd() * CITY_W * CELL, y: 0, v: 70 + rnd() * 60, dir: rnd() < 0.5 ? 1 : -1, color: CAR[Math.floor(rnd() * CAR.length)]!, id: `car${i}` });
    for (let i = 0; i < 12; i++) this.walkers.push({ x: rnd() * CITY_W * CELL, y: 0, v: 18 + rnd() * 14, dir: rnd() < 0.5 ? 1 : -1, color: 0, id: `ped${i}` });
  }

  /** Walls, roofs and trees for the storey on show. */
  buildStatic(s: WorldState, tileAt: (x: number, y: number) => string): void {
    for (const g of this.statics) g.destroy();
    this.statics = [];
    const L = this.level;
    const dy = L * STRIDE;
    const f = s.floor;
    const add = (g: Graphics, z: number) => { g.zIndex = z; this.stand.addChild(g); this.statics.push(g); };
    const shown = (b: Building) => b.owned && b.floors > L && b.id === this.focus;
    // other buildings: solid blocks, as tall as they are; windows on the street face
    for (const b of Object.values(s.buildings)) {
      if (shown(b)) continue;
      if (L > 0 && b.floors <= L) continue;      // lower buildings stay below you, in the dimmed ground
      const g = new Graphics();
      const maxY = drawBuilding(g, b, L, dy, b.id === this.focus ? 0xf2c230 : b.owned ? 0x2f6db5 : undefined);
      // Sims-style: a building standing in front of the one you opened goes see-through
      const open = s.buildings[this.focus];
      if (open?.owned) {
        const H = 6 + (b.floors - L) * STOREY_H;
        const covers = b.rects.some((q) => open.rects.some((o) => q.x0 <= o.x1 && q.x1 >= o.x0 && (q.y1 + 1) * CELL > o.y0 * CELL && (q.y0 * CELL - H) < (o.y1 + 1) * CELL && q.y1 > o.y1));
        if (covers) g.alpha = 0.3;
      }
      if (L === 0 && b.forSale && !b.owned) {
        const fr = b.rects.reduce((a, q) => ((b.front === 's' ? q.y1 > a.y1 : q.y0 < a.y0) ? q : a), b.rects[0]!);
        const p = { x: ((fr.x0 + fr.x1 + 1) / 2) * CELL + 40, y: ((b.front === 's' ? fr.y1 + 1 : fr.y0) + dy) * CELL - 12 };
        g.roundRect(p.x - 22, p.y - 9, 44, 18, 4).fill({ color: 0xffffff }).stroke({ width: 1.5, color: 0xc0392b });
        g.rect(p.x - 14, p.y - 2, 28, 4).fill({ color: 0xc0392b });
      }
      add(g, maxY);
    }
    // walls of your storey: inner walls light, outer walls darker
    for (const [k, t] of Object.entries(f.tiles)) {
      if (t !== 'wall' && t !== 'xwall' && t !== 'vent') continue;
      const [x, y] = k.split(',').map(Number) as [number, number];
      if (y < dy || y >= dy + STRIDE) continue;
      const own = Object.values(s.buildings).find((b) => shown(b) && inRects(b.rects, x, y - dy));
      if (!own) continue;
      const wallish = (ax: number, ay: number) => { const w = tileAt(ax, ay); return w === 'wall' || w === 'xwall' || w === 'door' || w === 'smartdoor' || w === 'vent'; };
      const outer = t === 'xwall';
      const top = outer ? 0x8b8f96 : 0xebe7df, front = outer ? 0x60656d : 0xbab3a5;
      const cx = x * CELL + CELL / 2, cy = y * CELL + CELL / 2, hT = WALL_T / 2;
      const g = new Graphics();
      const parts: [number, number, number, number][] = [];
      if (wallish(x, y - 1)) parts.push([cx - hT, cy - CELL / 2, cx + hT, cy]);
      if (wallish(x - 1, y)) parts.push([cx - CELL / 2, cy - hT, cx, cy + hT]);
      parts.push([cx - hT, cy - hT, cx + hT, cy + hT]);
      if (wallish(x + 1, y)) parts.push([cx, cy - hT, cx + CELL / 2, cy + hT]);
      if (wallish(x, y + 1)) parts.push([cx - hT, cy, cx + hT, cy + CELL / 2]);
      for (const [a, b2, c, d] of parts) block(g, a, b2, c, d, WALL_H, top, front, false);
      if (t === 'vent') g.roundRect(cx - 6, cy - WALL_H - 4, 12, 8, 2).fill({ color: KIND_COLOR.ac });
      add(g, cy + hT);
    }
    // trees on open ground (ground level only)
    if (L === 0) {
      for (let x = -6; x < CITY_W + 6; x++) for (let y = -6; y < CITY_H + 6; y++) {
        if (tileAt(x, y) !== 'ground') continue;
        const hh = treeHash(x, y);
        if (hh % 100 >= 16) continue;
        const ox = x * CELL + 10 + (hh >>> 8) % 28, oy = y * CELL + 10 + (hh >>> 12) % 28, r = 9 + (hh >>> 16) % 6;
        const g = new Graphics();
        g.ellipse(ox + 6, oy + 2, r, r * 0.45).fill({ color: 0x000000, alpha: 0.18 });
        g.rect(ox - 2, oy - r, 4, r).fill({ color: 0x6b4d31 });
        g.circle(ox, oy - r * 1.4, r).fill({ color: COLORS.tree });
        g.circle(ox - r * 0.35, oy - r * 1.75, r * 0.5).fill({ color: COLORS.treeLight, alpha: 0.75 });
        add(g, oy);
      }
    }
    void f;
  }

  /** Device boxes on the storey on show. */
  syncDevices(s: WorldState, selected: string | null, hovered: string | null): void {
    const seen = new Set<string>();
    const dy0 = this.level * STRIDE, dy1 = dy0 + STRIDE;
    for (const d of Object.values(s.devices)) {
      if (d.kind === 'badge' || d.gridPos.gy < dy0 || d.gridPos.gy >= dy1 || !this.cellVisible(s, d.gridPos.gx, d.gridPos.gy)) continue;
      seen.add(d.id);
      let v = this.boxes.get(d.id);
      if (v && v.kind !== d.kind) { this.drop(d.id); v = undefined; }
      if (!v) {
        const g = new Graphics(), icon = new Graphics(deviceContext(d.kind)), leds = new Graphics();
        this.stand.addChild(g, icon, leds);
        v = { g, icon, leds, hull: { x: 0, y: 0, w: 0, h: 0 }, z: 0, led: [], kind: d.kind, born: this.built ? performance.now() : 0, iconY: 0, lift: 0 };
        this.boxes.set(d.id, v);
      }
      this.drawBox(d, v, selected === d.id, hovered === d.id);
    }
    for (const id of [...this.boxes.keys()]) if (!seen.has(id)) this.drop(id);
    this.built = true;
  }

  private drop(id: string): void {
    const v = this.boxes.get(id);
    if (!v) return;
    v.g.destroy(); v.icon.destroy(); v.leds.destroy();
    this.boxes.delete(id);
  }

  private drawBox(d: Device, v: BoxView, selected: boolean, hovered: boolean): void {
    const cx = (d.gridPos.gx + 0.5) * CELL, cy = (d.gridPos.gy + 0.5) * CELL;
    const hs = BODY / 2;
    const H = HEIGHT[d.kind];
    const kc = KIND_COLOR[d.kind];
    const failed = d.health.state === 'failed' || (d.kind === 'server' && d.hw.off !== null);
    const g = v.g;
    g.clear();
    if (d.kind === 'tower') {
      g.ellipse(cx + 8, cy + 4, 14, 6).fill({ color: 0x000000, alpha: 0.18 });
      g.moveTo(cx - 8, cy + 4).lineTo(cx, cy - H).lineTo(cx + 8, cy + 4).stroke({ width: 2.5, color: 0x5d636b });
      g.moveTo(cx - 5, cy - H * 0.3).lineTo(cx + 5, cy - H * 0.3).moveTo(cx - 3, cy - H * 0.65).lineTo(cx + 3, cy - H * 0.65).stroke({ width: 1.6, color: 0x5d636b });
      g.circle(cx, cy - H, 4).fill({ color: kc });
      v.hull = { x: cx - 14, y: cy - H - 6, w: 28, h: H + 12 };
      v.led = [{ x: cx, y: cy - H - 6 }];
      v.icon.visible = false;
    } else {
      const front = failed ? shade(kc, -0.55) : shade(kc, -0.25);
      v.hull = block(g, cx - hs, cy - hs, cx + hs, cy + hs, H, COLORS.card, front);
      const n = d.kind === 'switch' ? 6 : d.kind === 'server' ? 3 : 2;
      v.led = Array.from({ length: n }, (_, i) => ({ x: cx - hs + 8 + i * ((BODY - 16) / Math.max(1, n - 1)), y: cy + hs - H / 2 }));
      v.icon.visible = true;
      if (selected || hovered) g.roundRect(cx - hs - 2, cy - hs - H - 2, BODY + 4, BODY + 4, 8).stroke({ width: selected ? 2.5 : 1.5, color: selected ? COLORS.selection : COLORS.hover, alpha: selected ? 1 : 0.7 });
    }
    v.iconY = cy - H;
    v.icon.position.set(cx, v.iconY);
    v.icon.alpha = failed ? 0.5 : 1;
    v.lift = hovered && !selected ? 2 : 0;
    v.fan = d.kind === 'ac' && d.on ? { x: cx + hs - 9, y: cy - H - hs + 9 } : undefined;
    v.z = cy + hs;
    g.zIndex = v.z; v.icon.zIndex = v.z + 0.1; v.leds.zIndex = v.z + 0.2;
  }

  /** Blinking lights, spinning fans, drop-in animation, street life. Every frame. */
  animate(s: WorldState, now: number): void {
    for (const [id, v] of this.boxes) {
      const d = s.devices[id];
      const g = v.leds;
      g.clear();
      if (!d) continue;
      const t = v.born ? Math.min(1, (now - v.born) / 380) : 1;
      const drop = t < 1 ? -(1 - t) * (1 - t) * 24 + Math.sin(t * Math.PI) * 2 : 0;
      const dy = drop - v.lift;
      v.g.position.y = dy; v.leds.position.y = dy; v.icon.position.y = v.iconY + dy;
      v.g.alpha = 0.3 + 0.7 * t;
      if (v.fan) {
        const a0 = now * 0.012;
        for (let k = 0; k < 3; k++) {
          const a = a0 + (k * Math.PI * 2) / 3;
          g.moveTo(v.fan.x, v.fan.y).lineTo(v.fan.x + Math.cos(a) * 6, v.fan.y + Math.sin(a) * 6).stroke({ width: 2, color: 0x2a95ad, alpha: 0.9 });
        }
      }
      const failed = d.health.state === 'failed' || (d.kind === 'server' && d.hw.off !== null);
      const busy = 'usage' in d ? Math.min(1, d.usage.bandwidth) : 0.2;
      v.led.forEach((p, i) => {
        if (failed) { if (i === 0) g.rect(p.x - 1.5, p.y - 1.5, 3, 3).fill({ color: 0xff4b3e, alpha: 0.5 + 0.5 * Math.sin(now * 0.008) }); return; }
        const on = Math.sin(now * (0.004 + busy * 0.03) + i * 1.7 + (h32(id) % 7)) > (busy > 0.05 ? 0.1 : 0.85);
        g.rect(p.x - 1.5, p.y - 1.5, 3, 3).fill({ color: i === 0 ? 0x3ddc84 : on ? 0xffc94a : 0x2d4a36, alpha: i === 0 || on ? 1 : 0.6 });
      });
    }
    this.animateStreet(now);
  }

  private animateStreet(now: number): void {
    const dt = this.lastT ? Math.min(0.1, (now - this.lastT) / 1000) : 0;
    this.lastT = now;
    const g = this.traffic;
    g.clear();
    const show = this.level === 0;
    g.visible = show;
    const W = CITY_W * CELL;
    // cars: eastbound in the south lane, westbound in the north lane
    for (const c of this.cars) {
      c.x += c.v * c.dir * dt;
      if (c.x > W + 80) c.x = -80; if (c.x < -80) c.x = W + 80;
      c.y = (c.dir === 1 ? STREET_Y + 3 : STREET_Y + 1) * CELL + CELL / 2 + 4;
      if (show) car(g, c.x, c.y, c.dir, c.color);
    }
    // pedestrians on both pavements
    for (const p of this.walkers) {
      p.x += p.v * p.dir * dt;
      if (p.x > W + 30) p.x = -30; if (p.x < -30) p.x = W + 30;
      p.y = ((h32(p.id) & 1) ? STREET_Y : STREET_Y + 4) * CELL + CELL * 0.75;
      let pg = this.walkerG.get(p.id);
      if (!pg) { pg = new Graphics(); this.stand.addChild(pg); this.walkerG.set(p.id, pg); }
      pg.visible = show;
      if (!show) continue;
      pg.clear();
      person(pg, lookOf(p.id), p.dir, true, false, now + (h32(p.id) % 1000), 1.5);
      pg.position.set(p.x, p.y);
      pg.zIndex = p.y;
    }
  }

  /** Staff and strangers on the storey on show. */
  drawPeople(s: WorldState, now: number): void {
    const seen = new Set<string>();
    const dy0 = this.level * STRIDE, dy1 = dy0 + STRIDE;
    const draw = (id: string, wx: number, wy: number, look: Look, walking: boolean, seated: boolean, faceX?: number) => {
      if (wy < dy0 * CELL || wy >= dy1 * CELL || !this.cellVisible(s, Math.floor(wx / CELL), Math.floor(wy / CELL - 0.3))) return;
      seen.add(id);
      let g = this.people.get(id);
      if (!g) { g = new Graphics(); this.stand.addChild(g); this.people.set(id, g); }
      const f = this.facing.get(id);
      let dir: 1 | -1 = f?.dir ?? 1;
      if (faceX !== undefined) dir = faceX >= wx ? 1 : -1;
      else if (f && Math.abs(wx - f.x) > 0.05) dir = wx > f.x ? 1 : -1;
      this.facing.set(id, { x: wx, dir });
      g.clear();
      person(g, look, dir, walking, seated, now);
      g.position.set(wx, wy);
      g.zIndex = wy + 0.5;
    };
    for (const e of Object.values(s.staff.engineers)) {
      if (e.away) continue;
      const seated = e.state === 'seated';
      const desk = seated && e.deskId ? s.devices[e.deskId] : undefined;
      const dx = desk ? (desk.gridPos.gx + 0.5) * CELL : 0, dyy = desk ? (desk.gridPos.gy + 0.5) * CELL : 0;
      // seated: just behind the desk, which hides the legs
      draw(e.id, desk ? dx - 4 : e.x * CELL, desk ? dyy - BODY / 2 - 2 : e.y * CELL, lookOf(e.id), e.state === 'walking' || e.state === 'roaming' || e.state === 'chasing', seated, desk ? dx : undefined);
    }
    for (const t of Object.values(s.staff.trespassers)) draw(t.id, t.x * CELL, t.y * CELL, lookOf(t.id, true), t.state !== 'hacking', false);
    for (const v of Object.values(s.deals?.visitors ?? {})) draw(v.id, v.x * CELL, v.y * CELL, lookOf(v.id), v.state !== 'waiting', false);
    for (const [id, g] of this.people) if (!seen.has(id)) { g.destroy(); this.people.delete(id); this.facing.delete(id); }
  }

  /** The closed building drawn under a world point (its roof or its facade), front-most first. */
  pickBuilding(s: WorldState, x: number, y: number): Building | null {
    const L = this.level, dy = L * STRIDE;
    let best: Building | null = null, by = -Infinity;
    for (const b of Object.values(s.buildings)) {
      if (b.floors <= L || (b.owned && b.id === this.focus)) continue;
      const H = 6 + (b.floors - L) * STOREY_H;
      for (const q of b.rects) {
        const x0 = q.x0 * CELL, x1 = (q.x1 + 1) * CELL, y0 = (q.y0 + dy) * CELL - H, y1 = (q.y1 + 1 + dy) * CELL;
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && y1 > by) { best = b; by = y1; }
      }
    }
    return best;
  }

  /** Front-most box under a world point. */
  pick(x: number, y: number): string | null {
    let best: string | null = null, bz = -Infinity;
    for (const [id, v] of this.boxes) {
      const h = v.hull;
      if (v.z > bz && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) { best = id; bz = v.z; }
    }
    return best;
  }

  heightOf(kind: DeviceKind): number { return HEIGHT[kind]; }

  clear(): void {
    for (const id of [...this.boxes.keys()]) this.drop(id);
    for (const g of this.people.values()) g.destroy();
    this.people.clear();
    for (const g of this.statics) g.destroy();
    this.statics = [];
  }
}

/** Ground for the storey on show: the city street level, dimmed under upper storeys. */
export function drawGround(g: Graphics, s: WorldState, level: number, tile: (x: number, y: number) => string, drawTile: (x: number, y: number, t: string) => void): void {
  const dy = level * STRIDE;
  const later: [number, number, string][] = [];
  g.rect(-8 * CELL, (dy - 8) * CELL, (CITY_W + 16) * CELL, (CITY_H + 16) * CELL).fill({ color: 0x6f9150 });
  for (let x = -6; x < CITY_W + 6; x++) for (let y = -6; y < CITY_H + 6; y++) {
    const px = x * CELL, py = (y + dy) * CELL;
    const t = tile(x, y);
    if (t === 'street') {
      g.rect(px, py, CELL, CELL).fill({ color: 0x4a4f56 });
      if (y === STREET_Y + 2 && x % 2 === 0) g.rect(px + 8, py + CELL / 2 - 1.5, CELL - 16, 3).fill({ color: 0xe9e3c9 });
      if (y === STREET_Y + 1 || y === STREET_Y + 3) g.rect(px, py + (y === STREET_Y + 1 ? 0 : CELL - 2), CELL, 2).fill({ color: 0x3c4047 });
    } else if (t === 'sidewalk') {
      g.rect(px, py, CELL, CELL).fill({ color: 0xbdb7ac });
      g.rect(px + 0.5, py + 0.5, CELL / 2 - 1, CELL - 1).stroke({ width: 1, color: 0xaaa498 });
      g.rect(px + CELL / 2 + 0.5, py + 0.5, CELL / 2 - 1, CELL - 1).stroke({ width: 1, color: 0xaaa498 });
    } else if (t === 'ground') {
      const hh = treeHash(x, y);
      g.rect(px, py, CELL, CELL).fill({ color: hh % 3 === 0 ? 0x77994f : 0x7da259 });
    } else {
      later.push([x, y + dy, t]);
    }
  }
  if (level > 0) g.rect(-8 * CELL, (dy - 8) * CELL, (CITY_W + 16) * CELL, (CITY_H + 16) * CELL).fill({ color: 0x0c1220, alpha: 0.38 });
  // building floors after the dimming: yours are drawn by the caller, others sit under roofs
  for (const [x, gy, t] of later) drawTile(x, gy, t);
  void s;
}

export function treeHash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export function floorTileColor(t: string): { fill: number; seam: number; dots?: number } | null {
  switch (t) {
    case 'floor': return { fill: 0xd9d3c6, seam: 0xc9c2b3 };
    case 'raised': return { fill: 0xb4bcc6, seam: 0x9fa9b5, dots: 0x86919f };
    case 'lift': return { fill: 0x8e949c, seam: 0x6f757d };
    case 'door': case 'smartdoor': case 'wall': case 'vent': return { fill: 0xd9d3c6, seam: 0xc9c2b3 };
    default: return null;
  }
}
export type { Floor };
