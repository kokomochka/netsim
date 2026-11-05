// The isometric view: the floor plan is tilted (see Renderer), and everything that
// stands up is drawn here at its projected position: devices as small boxes with
// their icon on top, half-height walls, trees, and people seen from the side.

import { Container, Graphics } from 'pixi.js';
import { BODY, CELL } from '../balance';
import type { Device, DeviceKind, Vec2, WorldState } from '../state/types';
import { glyphContext } from './icons';
import { COLORS, KIND_COLOR } from './palette';

const R = Math.SQRT1_2;
/** World floor point → camera-space point in the isometric view. */
export const isoProject = (x: number, y: number): Vec2 => ({ x: (x - y) * R, y: (x + y) * R * 0.5 });
/** Camera-space point → world floor point. */
export const isoUnproject = (x: number, y: number): Vec2 => {
  const a = x / R, b = (2 * y) / R;       // a = wx - wy, b = wx + wy
  return { x: (a + b) / 2, y: (b - a) / 2 };
};

const WALL_H = 18;        // half-height walls keep the rooms readable
const WALL_T = 10;
const HEIGHT: Record<DeviceKind, number> = {
  server: 30, router: 13, switch: 9, firewall: 16, ddos_scrubber: 14, uplink: 12,
  desk: 11, tower: 44, ac: 22, badge: 0,
};
const FOOT: Partial<Record<DeviceKind, number>> = { switch: 0.92, desk: 0.95, tower: 0.42, ac: 0.75 };

export function shade(c: number, f: number): number {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  const t = f < 0 ? 0 : 255, k = Math.abs(f);
  return (Math.round(r + (t - r) * k) << 16) | (Math.round(g + (t - g) * k) << 8) | Math.round(b + (t - b) * k);
}

/** A box standing on the floor rectangle [x0,x1]×[y0,y1], H tall. Returns its outline. */
function box(g: Graphics, x0: number, y0: number, x1: number, y1: number, H: number, top: number, left: number, right: number, line?: number): Vec2[] {
  const T = isoProject(x0, y0), Rr = isoProject(x1, y0), B = isoProject(x1, y1), L = isoProject(x0, y1);
  const up = (p: Vec2) => ({ x: p.x, y: p.y - H });
  const [tT, tR, tB, tL] = [up(T), up(Rr), up(B), up(L)];
  g.poly([L.x, L.y, B.x, B.y, tB.x, tB.y, tL.x, tL.y]).fill({ color: left });
  g.poly([B.x, B.y, Rr.x, Rr.y, tR.x, tR.y, tB.x, tB.y]).fill({ color: right });
  g.poly([tT.x, tT.y, tR.x, tR.y, tB.x, tB.y, tL.x, tL.y]).fill({ color: top });
  if (line !== undefined) g.poly([tT.x, tT.y, tR.x, tR.y, tB.x, tB.y, tL.x, tL.y]).stroke({ width: 1, color: line, alpha: 0.5 });
  return [tT, tR, Rr, B, L, tL];
}

/** Stable small integer from a string, for picking looks. */
const h32 = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

const SKIN = [0xf1d3b3, 0xe0b48f, 0xc68e63, 0x9a6440, 0x6e4529];
const HAIR = [0x2b211b, 0x5a3a22, 0xa36b2c, 0xd9b26a, 0x1c1c22, 0x8a8a8a];
const SHIRT = [0x1e88e5, 0x13a882, 0x7460ee, 0xe09a00, 0xe5484d, 0x03a9c7];
const PANTS = [0x2a3547, 0x3b4a63, 0x45526a, 0x24314a];

interface Look { skin: number; hair: number; shirt: number; pants: number; hood?: boolean }
const lookOf = (id: string, stranger: boolean): Look => {
  const h = h32(id);
  return stranger
    ? { skin: SKIN[h % SKIN.length]!, hair: 0x15151a, shirt: 0x26262e, pants: 0x1b1b22, hood: true }
    : { skin: SKIN[h % SKIN.length]!, hair: HAIR[(h >>> 4) % HAIR.length]!, shirt: SHIRT[(h >>> 8) % SHIRT.length]!, pants: PANTS[(h >>> 12) % PANTS.length]! };
};

/** A little side-view person, feet at (0,0), facing right when dir = 1. Pixel-art blocks. */
function person(g: Graphics, look: Look, dir: 1 | -1, walking: boolean, seated: boolean, t: number): void {
  const u = 1.7;
  const px = (x: number, y: number, w: number, h: number, color: number) => {
    const ax = dir === 1 ? x : -x - w;
    g.rect(ax * u, y * u, w * u, h * u).fill({ color });
  };
  const swing = walking ? Math.sin(t * 0.012) : 0;
  g.ellipse(0, 0.5, 5.5, 2).fill({ color: 0x000000, alpha: 0.18 });
  if (seated) {
    px(-2, -4, 6, 2, look.pants);                 // thighs forward
    px(3, -4, 2, 4, look.pants);                  // shins down
    px(-2, -11, 5, 7, look.shirt);                // back straight
    px(1, -9, 3, 2, shade(look.shirt, -0.2));     // arm on the desk
    px(-2, -16, 5, 5, look.skin);
    px(-2, -17, 5, 2, look.hair); px(-2, -15, 1, 3, look.hair);
    px(2, -14, 1, 1, 0x1a1a1a);
    return;
  }
  const leg = Math.round(swing * 1.4);
  px(-2 + leg, -6, 2, 6, look.pants);             // back leg
  px(0 - leg, -6, 2, 6, shade(look.pants, 0.12)); // front leg
  px(-1 + leg, 0, 2, 0.6, 0x1a1a1a);
  px(-2.5, -13, 5, 7, look.shirt);                // torso
  px(-1 - Math.round(swing), -12, 1.6, 5, shade(look.shirt, -0.25)); // arm
  if (look.hood) {
    px(-3, -19, 6, 6.5, look.shirt);              // hood
    px(0.5, -17, 2.5, 3.5, look.skin);            // face in the hood's shadow
    px(2, -16, 1, 1, 0xff4b4b);
  } else {
    px(-2.5, -18, 5, 5, look.skin);               // head
    px(-2.5, -19, 5, 2, look.hair);
    px(-2.5, -17.5, 1.5, 3, look.hair);
    px(1.5, -16, 1, 1, 0x1a1a1a);                 // eye
  }
}

interface BoxView { g: Graphics; glyph: Graphics; leds: Graphics; hull: Vec2[]; z: number; led: Vec2[]; kind: DeviceKind; born: number; glyphY: number; lift: number; fan?: Vec2 }

export class IsoScene {
  readonly stand = new Container({ sortableChildren: true });
  private statics: Graphics[] = [];
  private boxes = new Map<string, BoxView>();
  private people = new Map<string, Graphics>();
  private facing = new Map<string, { x: number; dir: 1 | -1 }>();
  private built = false;       // after the first sync, new boxes drop in

  /** Walls and trees: rebuilt only when the floor changes. */
  buildStatic(s: WorldState, isPath: (x: number, y: number) => boolean, tileAt: (x: number, y: number) => string, inParking: (x: number, y: number) => boolean): void {
    for (const g of this.statics) g.destroy();
    this.statics = [];
    const f = s.floor;
    const wallish = (x: number, y: number) => { const t = f.tiles[`${x},${y}`]; return t === 'wall' || t === 'door' || t === 'smartdoor' || t === 'vent'; };
    const top = shade(COLORS.wall, 0.18), left = COLORS.wall, right = shade(COLORS.wall, -0.18);
    for (const [k, t] of Object.entries(f.tiles)) {
      if (t !== 'wall' && t !== 'vent') continue;
      const [x, y] = k.split(',').map(Number) as [number, number];
      const cx = x * CELL + CELL / 2, cy = y * CELL + CELL / 2, hT = WALL_T / 2;
      const g = new Graphics();
      // the post, then arms toward wall-ish neighbours; draw back-to-front
      const parts: [number, number, number, number][] = [];
      if (wallish(x, y - 1)) parts.push([cx - hT, cy - CELL / 2, cx + hT, cy]);
      if (wallish(x - 1, y)) parts.push([cx - CELL / 2, cy - hT, cx, cy + hT]);
      parts.push([cx - hT, cy - hT, cx + hT, cy + hT]);
      if (wallish(x + 1, y)) parts.push([cx, cy - hT, cx + CELL / 2, cy + hT]);
      if (wallish(x, y + 1)) parts.push([cx - hT, cy, cx + hT, cy + CELL / 2]);
      for (const [a, b, c, d] of parts) box(g, a, b, c, d, WALL_H, top, left, right);
      if (t === 'vent') {
        const p = isoProject(cx, cy);
        g.roundRect(p.x - 5, p.y - WALL_H - 3, 10, 5, 1.5).fill({ color: KIND_COLOR.ac, alpha: 0.9 });
      }
      g.zIndex = isoProject(cx + CELL / 2, cy + CELL / 2).y - 1;
      this.stand.addChild(g);
      this.statics.push(g);
    }
    // trees: a trunk and a round crown, standing up
    const B = 8;
    for (let x = -B; x < f.w + B; x++) {
      for (let y = -B; y < f.h + B; y++) {
        if (tileAt(x, y) !== 'ground' || inParking(x, y) || isPath(x, y)) continue;
        const hh = treeHash(x, y);
        if (hh % 100 >= 22) continue;
        const ox = x * CELL + 12 + (hh >>> 8) % 24, oy = y * CELL + 12 + (hh >>> 12) % 24, r = 8 + (hh >>> 16) % 6;
        const p = isoProject(ox, oy);
        const g = new Graphics();
        g.ellipse(p.x, p.y, r * 0.9, r * 0.45).fill({ color: COLORS.trunkShadow, alpha: 0.35 });
        g.rect(p.x - 1.5, p.y - r * 1.1, 3, r * 1.1).fill({ color: 0x7a5a3a });
        g.circle(p.x, p.y - r * 1.5, r).fill({ color: COLORS.tree });
        g.circle(p.x - r * 0.3, p.y - r * 1.8, r * 0.5).fill({ color: COLORS.treeLight, alpha: 0.7 });
        g.zIndex = p.y;
        this.stand.addChild(g);
        this.statics.push(g);
      }
    }
  }

  /** Device boxes: positions, colours, selection outline. */
  syncDevices(s: WorldState, selected: string | null, hovered: string | null): void {
    const seen = new Set<string>();
    for (const d of Object.values(s.devices)) {
      if (d.kind === 'badge') continue;
      seen.add(d.id);
      let v = this.boxes.get(d.id);
      if (v && v.kind !== d.kind) { v.g.destroy(); v.glyph.destroy(); v.leds.destroy(); this.boxes.delete(d.id); v = undefined; }
      if (!v) {
        const g = new Graphics(), glyph = new Graphics(glyphContext(d.kind)), leds = new Graphics();
        this.stand.addChild(g, glyph, leds);
        v = { g, glyph, leds, hull: [], z: 0, led: [], kind: d.kind, born: this.built ? performance.now() : 0, glyphY: 0, lift: 0 };
        this.boxes.set(d.id, v);
      }
      this.drawBox(d, v, selected === d.id, hovered === d.id);
    }
    for (const [id, v] of this.boxes) if (!seen.has(id)) { v.g.destroy(); v.glyph.destroy(); v.leds.destroy(); this.boxes.delete(id); }
    this.built = true;
  }

  private drawBox(d: Device, v: BoxView, selected: boolean, hovered: boolean): void {
    const cx = (d.gridPos.gx + 0.5) * CELL, cy = (d.gridPos.gy + 0.5) * CELL;
    const hs = (BODY / 2) * (FOOT[d.kind] ?? 0.85);
    const H = HEIGHT[d.kind];
    const kc = KIND_COLOR[d.kind];
    const failed = d.health.state === 'failed' || (d.kind === 'server' && d.hw.off !== null);
    const body = failed ? shade(kc, -0.45) : kc;
    const g = v.g;
    g.clear();
    if (d.kind === 'tower') {
      // a mast with a dish
      const p = isoProject(cx, cy);
      g.ellipse(p.x, p.y, 10, 5).fill({ color: 0x000000, alpha: 0.15 });
      g.moveTo(p.x - 6, p.y).lineTo(p.x, p.y - H).lineTo(p.x + 6, p.y).stroke({ width: 2, color: shade(body, -0.2) });
      g.moveTo(p.x - 4, p.y - H * 0.35).lineTo(p.x + 4, p.y - H * 0.35).moveTo(p.x - 2.5, p.y - H * 0.65).lineTo(p.x + 2.5, p.y - H * 0.65).stroke({ width: 1.4, color: shade(body, -0.2) });
      g.circle(p.x, p.y - H, 3).fill({ color: body });
      v.hull = [{ x: p.x - 10, y: p.y - H - 4 }, { x: p.x + 10, y: p.y - H - 4 }, { x: p.x + 10, y: p.y + 4 }, { x: p.x - 10, y: p.y + 4 }];
      v.led = [{ x: p.x, y: p.y - H }];
    } else {
      const base = isoProject(cx, cy);
      g.ellipse(base.x, base.y + 2, hs * 1.15, hs * 0.55).fill({ color: 0x000000, alpha: 0.12 });
      const top = mixc(COLORS.card, body, 0.18);
      v.hull = box(g, cx - hs, cy - hs, cx + hs, cy + hs, H, top, shade(body, -0.15), shade(body, 0.12), body);
      if (d.kind === 'desk') {
        // a slim monitor near the front, facing whoever sits behind the desk
        box(g, cx - hs * 0.55, cy + hs * 0.25, cx + hs * 0.15, cy + hs * 0.38, H + 10, 0x2a3547, 0x1b2230, 0x3b4a63);
        const sc = isoProject(cx - hs * 0.2, cy + hs * 0.38);
        g.poly([sc.x - 7, sc.y - H - 8, sc.x + 5, sc.y - H - 2, sc.x + 5, sc.y - H - 8, sc.x - 7, sc.y - H - 14]).fill({ color: 0x5fd0ff, alpha: 0.55 });
      }
      // where the blinking lights sit: along the right face
      const rB = isoProject(cx + hs, cy + hs), rR = isoProject(cx + hs, cy - hs);
      const n = d.kind === 'switch' ? 6 : d.kind === 'server' ? 3 : 2;
      v.led = Array.from({ length: n }, (_, i) => {
        const t = (i + 1) / (n + 1);
        return { x: rB.x + (rR.x - rB.x) * t, y: rB.y + (rR.y - rB.y) * t - H * (d.kind === 'server' ? 0.75 : 0.55) };
      });
      if (selected || hovered) {
        const [tT, tR, , , , tL] = v.hull;
        const tB = { x: isoProject(cx + hs, cy + hs).x, y: isoProject(cx + hs, cy + hs).y - H };
        g.poly([tT!.x, tT!.y, tR!.x, tR!.y, tB.x, tB.y, tL!.x, tL!.y]).stroke({ width: selected ? 2.5 : 1.5, color: selected ? COLORS.selection : COLORS.hover, alpha: selected ? 1 : 0.7 });
      }
    }
    const p = isoProject(cx, cy);
    v.glyphY = p.y - H - 13;
    v.lift = hovered && !selected ? 2 : 0;
    v.fan = d.kind === 'ac' && d.on ? { x: p.x, y: p.y - H } : undefined;
    v.glyph.position.set(p.x, v.glyphY);
    v.glyph.scale.set(0.52);
    v.glyph.alpha = failed ? 0.45 : 1;
    v.z = isoProject(cx + hs, cy + hs).y;
    g.zIndex = v.z;
    v.glyph.zIndex = v.z + 0.1;
    v.leds.zIndex = v.z + 0.2;
  }

  /** Blinking lights: busier boxes blink faster. Every frame. */
  animate(s: WorldState, now: number): void {
    for (const [id, v] of this.boxes) {
      const d = s.devices[id];
      const g = v.leds;
      g.clear();
      if (!d) continue;
      // a new box drops into place with a little bounce; hovered ones lift a touch
      const t = v.born ? Math.min(1, (now - v.born) / 380) : 1;
      const drop = t < 1 ? -(1 - t) * (1 - t) * 26 + Math.sin(t * Math.PI) * 2 : 0;
      const dy = drop - v.lift;
      v.g.position.y = dy; v.leds.position.y = dy; v.glyph.position.y = v.glyphY + dy - (t < 1 ? 0 : Math.sin(now * 0.002 + v.z) * 0.8);
      v.g.alpha = v.glyph.alpha = 0.3 + 0.7 * t;
      if (v.fan) {
        // the AC's fan turning on its top
        const a0 = now * 0.01;
        for (let k = 0; k < 3; k++) {
          const a = a0 + (k * Math.PI * 2) / 3;
          g.moveTo(v.fan.x, v.fan.y).lineTo(v.fan.x + Math.cos(a) * 7, v.fan.y + Math.sin(a) * 3.5).stroke({ width: 2, color: KIND_COLOR.ac, alpha: 0.85 });
        }
      }
      const failed = d.health.state === 'failed' || (d.kind === 'server' && d.hw.off !== null);
      const busy = 'usage' in d ? Math.min(1, d.usage.bandwidth) : 0.2;
      v.led.forEach((p, i) => {
        if (failed) { if (i === 0) g.rect(p.x - 1, p.y - 1, 2.2, 2.2).fill({ color: COLORS.healthBad, alpha: 0.5 + 0.5 * Math.sin(now * 0.008) }); return; }
        const rate = 0.004 + busy * 0.03;
        const on = Math.sin(now * rate + i * 1.7 + h32(id) % 7) > (busy > 0.05 ? 0.1 : 0.85);
        g.rect(p.x - 1, p.y - 1, 2.2, 2.2).fill({ color: i === 0 ? COLORS.led : on ? 0xffd27a : shade(COLORS.led, -0.6), alpha: i === 0 ? 0.95 : on ? 0.95 : 0.35 });
      });
    }
  }

  /** People: side-view sprites, depth-sorted with everything else. */
  drawPeople(s: WorldState, now: number): void {
    const seen = new Set<string>();
    const draw = (id: string, wx: number, wy: number, look: Look, walking: boolean, seated: boolean, faceX?: number) => {
      seen.add(id);
      let g = this.people.get(id);
      if (!g) { g = new Graphics(); this.stand.addChild(g); this.people.set(id, g); }
      const p = isoProject(wx, wy);
      const f = this.facing.get(id);
      let dir: 1 | -1 = f?.dir ?? 1;
      if (faceX !== undefined) dir = faceX >= p.x ? 1 : -1;
      else if (f && Math.abs(p.x - f.x) > 0.05) dir = p.x > f.x ? 1 : -1;
      this.facing.set(id, { x: p.x, dir });
      g.clear();
      person(g, look, dir, walking, seated, now);
      g.position.set(p.x, p.y);
      g.zIndex = p.y + 0.5;
    };
    for (const e of Object.values(s.staff.engineers)) {
      const seated = e.state === 'seated';
      const desk = seated && e.deskId ? s.devices[e.deskId] : undefined;
      // seated people sit in front of their desk, facing it
      const dx = desk ? (desk.gridPos.gx + 0.5) * CELL : 0, dy = desk ? (desk.gridPos.gy + 0.5) * CELL : 0;
      // behind the desk: it hides their legs, as it would
      const wx = desk ? dx - 2 : e.x * CELL;
      const wy = desk ? dy - 22 : e.y * CELL;
      draw(e.id, wx, wy, lookOf(e.id, false), e.state === 'walking' || e.state === 'roaming' || e.state === 'chasing', seated, desk ? isoProject(dx, dy).x : undefined);
    }
    for (const t of Object.values(s.staff.trespassers)) draw(t.id, t.x * CELL, t.y * CELL, lookOf(t.id, true), t.state !== 'hacking', false);
    for (const [id, g] of this.people) if (!seen.has(id)) { g.destroy(); this.people.delete(id); this.facing.delete(id); }
  }

  /** Front-most box under a camera-space point. */
  pick(x: number, y: number): string | null {
    let best: string | null = null, bz = -Infinity;
    for (const [id, v] of this.boxes) if (v.z > bz && inPoly({ x, y }, v.hull)) { best = id; bz = v.z; }
    return best;
  }

  /** How high a device's box is, for labels and badges. */
  heightOf(kind: DeviceKind): number { return HEIGHT[kind]; }

  clear(): void {
    for (const v of this.boxes.values()) { v.g.destroy(); v.glyph.destroy(); v.leds.destroy(); }
    this.boxes.clear();
    for (const g of this.people.values()) g.destroy();
    this.people.clear();
    for (const g of this.statics) g.destroy();
    this.statics = [];
  }
}

function mixc(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}

function inPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function treeHash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}
