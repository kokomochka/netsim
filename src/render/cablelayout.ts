// How cables are drawn (not how they are routed): runs that share a line are spread
// into side-by-side lanes so each one can be followed, and where a horizontal run
// crosses a vertical one it hops over it with a small П.

import type { Cable, Vec2 } from '../state/types';

const LANE = 6;        // px between neighbouring cables in a shared run
const HOP = 6;         // half-width and height of the П over a crossing
const EPS = 0.75;

interface Seg { cable: string; i: number; horiz: boolean; at: number; lo: number; hi: number }

/** Display polylines per cable id. */
export function layoutCables(cables: Cable[]): Map<string, Vec2[]> {
  const segs: Seg[] = [];
  for (const c of cables) {
    const p = c.path;
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i]!, b = p[i + 1]!;
      if (Math.abs(a.y - b.y) < EPS && Math.abs(a.x - b.x) >= EPS) segs.push({ cable: c.id, i, horiz: true, at: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) });
      else if (Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) >= EPS) segs.push({ cable: c.id, i, horiz: false, at: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
    }
  }

  // 1. lanes: segments on the same line whose ranges overlap form a bundle
  const offset = new Map<string, number>();   // `${cable}:${i}` → perpendicular offset
  const lines = new Map<string, Seg[]>();
  for (const s of segs) {
    const k = `${s.horiz ? 'h' : 'v'}${Math.round(s.at * 2) / 2}`;
    (lines.get(k) ?? lines.set(k, []).get(k)!).push(s);
  }
  for (const group of lines.values()) {
    group.sort((a, b) => a.lo - b.lo);
    let bundle: Seg[] = [];
    let end = -Infinity;
    const flush = () => {
      const ids = [...new Set(bundle.map((s) => s.cable))].sort();
      if (ids.length > 1) for (const s of bundle) offset.set(`${s.cable}:${s.i}`, (ids.indexOf(s.cable) - (ids.length - 1) / 2) * LANE);
      bundle = [];
    };
    for (const s of group) {
      if (bundle.length && s.lo > end - EPS) { flush(); end = -Infinity; }
      bundle.push(s);
      end = Math.max(end, s.hi);
    }
    if (bundle.length) flush();
  }

  // 2. move each cable onto its lanes; corners join where the shifted runs meet
  const shifted = new Map<string, Vec2[]>();
  for (const c of cables) {
    const p = c.path;
    if (p.length < 2) { shifted.set(c.id, p); continue; }
    const off = (i: number) => offset.get(`${c.id}:${i}`) ?? 0;
    const horiz = (i: number) => Math.abs(p[i]!.y - p[i + 1]!.y) < EPS;
    const out: Vec2[] = [];
    const n = p.length;
    for (let v = 0; v < n; v++) {
      const before = v - 1, after = v;          // segments meeting at vertex v
      let x = p[v]!.x, y = p[v]!.y;
      for (const si of [before, after]) {
        if (si < 0 || si >= n - 1) continue;
        if (horiz(si)) y = p[v]!.y + off(si); else x = p[v]!.x + off(si);
      }
      out.push({ x, y });
    }
    // keep the ends on the ports: a short stub out to the lane
    const first = p[0]!, last = p[n - 1]!;
    if (Math.hypot(out[0]!.x - first.x, out[0]!.y - first.y) > EPS) out.unshift({ ...first });
    if (Math.hypot(out[out.length - 1]!.x - last.x, out[out.length - 1]!.y - last.y) > EPS) out.push({ ...last });
    shifted.set(c.id, out);
  }

  // 3. crossings: horizontal runs hop over vertical ones
  const vert: { cable: string; x: number; lo: number; hi: number }[] = [];
  for (const [id, p] of shifted) for (let i = 0; i < p.length - 1; i++) {
    const a = p[i]!, b = p[i + 1]!;
    if (Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) >= EPS) vert.push({ cable: id, x: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
  }
  const result = new Map<string, Vec2[]>();
  for (const [id, p] of shifted) {
    const out: Vec2[] = [p[0]!];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i]!, b = p[i + 1]!;
      if (Math.abs(a.y - b.y) < EPS && Math.abs(a.x - b.x) > 4 * HOP) {
        const dir = Math.sign(b.x - a.x);
        const xs = vert
          .filter((v) => v.cable !== id && v.x > Math.min(a.x, b.x) + 2 * HOP && v.x < Math.max(a.x, b.x) - 2 * HOP && a.y > v.lo + EPS && a.y < v.hi - EPS)
          .map((v) => v.x)
          .sort((m, n) => (m - n) * dir);
        let lastX = -Infinity;
        for (const x of xs) {
          if (Math.abs(x - lastX) < 2 * HOP + 2) continue;   // neighbours in a bundle share one hop
          // one П can span a whole bundle of parallel verticals
          let x2 = x;
          for (const y2 of xs) if ((y2 - x2) * dir > 0 && (y2 - x2) * dir <= LANE + EPS) x2 = y2;
          const s = x - dir * HOP, e = x2 + dir * HOP;
          out.push({ x: s, y: a.y }, { x: s, y: a.y - HOP }, { x: e, y: a.y - HOP }, { x: e, y: a.y });
          lastX = x2;
        }
      }
      out.push(b);
    }
    result.set(id, out);
  }
  return result;
}
