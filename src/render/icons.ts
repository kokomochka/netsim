// Procedural device icons (architecture v2, §2). Each kind builds one shared
// GraphicsContext that every instance reuses.
import { GraphicsContext } from 'pixi.js';
import { BODY } from '../balance';
import { assertNever, type DeviceKind } from '../state/types';
import { COLORS, KIND_COLOR } from './palette';

const cache = new Map<string, GraphicsContext>();

function card(ctx: GraphicsContext, color: number): void {
  const h = BODY / 2;
  ctx.roundRect(-h + 1, -h + 2.5, BODY - 2, BODY - 1, 8).fill({ color: 0x2a3547, alpha: 0.07 });
  ctx.roundRect(-h, -h, BODY, BODY, 8).fill({ color: COLORS.card }).stroke({ width: 1.5, color, alpha: 0.7 });
}

function arrowHead(ctx: GraphicsContext, x: number, y: number, dx: number, dy: number, size: number, color: number): void {
  const px = -dy;
  const py = dx;
  ctx.poly([x + dx * size, y + dy * size, x + px * size * 0.8, y + py * size * 0.8, x - px * size * 0.8, y - py * size * 0.8])
    .fill({ color });
}

function drawGlyph(ctx: GraphicsContext, kind: DeviceKind): void {
  const c = KIND_COLOR[kind];
  switch (kind) {
    case 'server': {
      ctx.roundRect(-11, -14, 22, 28, 2.5).fill({ color: c, alpha: 0.16 }).stroke({ width: 2, color: c });
      for (const y of [-7, -1, 5]) ctx.moveTo(-7, y).lineTo(3, y);
      ctx.stroke({ width: 1.6, color: c, alpha: 0.9 });
      ctx.circle(6.5, -7, 1.9).fill({ color: COLORS.led });
      return;
    }
    case 'router': {
      ctx.circle(0, 0, 15).fill({ color: c, alpha: 0.16 }).stroke({ width: 2, color: c });
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
        ctx.moveTo(dx * 3.5, dy * 3.5).lineTo(dx * 8.5, dy * 8.5).stroke({ width: 1.8, color: c });
        arrowHead(ctx, dx * 8.5, dy * 8.5, dx, dy, 3.6, c);
      }
      return;
    }
    case 'switch': {
      ctx.roundRect(-16, -9, 32, 18, 2.5).fill({ color: c, alpha: 0.16 }).stroke({ width: 2, color: c });
      for (let i = 0; i < 6; i++) {
        const x = -10 + i * 4;
        ctx.moveTo(x, -4).lineTo(x, 4);
      }
      ctx.stroke({ width: 1.6, color: c });
      return;
    }
    case 'firewall': {
      ctx.poly([0, -15, 12.5, -10, 11.5, 3, 0, 15, -11.5, 3, -12.5, -10])
        .fill({ color: c, alpha: 0.16 }).stroke({ width: 2, color: c, join: 'round' });
      ctx.moveTo(-11.5, -1).lineTo(11.5, -1).stroke({ width: 2, color: c });
      return;
    }
    case 'uplink':
    case 'tower': {
      // cloud: stroke the lobes, then cover the inner overlaps with the card colour
      const lobes: [number, number, number][] = [[-8, 1, 6], [0, -4, 8], [8, 1, 6]];
      for (const [x, y, r] of lobes) ctx.circle(x, y, r).stroke({ width: 2, color: c });
      ctx.roundRect(-14, 1, 28, 7, 3.5).stroke({ width: 2, color: c });
      for (const [x, y, r] of lobes) ctx.circle(x, y, r - 1).fill({ color: COLORS.card });
      ctx.roundRect(-13, 2, 26, 5, 2.5).fill({ color: COLORS.card });
      ctx.moveTo(0, -6).lineTo(0, 4).stroke({ width: 2, color: c });
      arrowHead(ctx, 0, 4, 0, 1, 4, c);
      return;
    }
    case 'ddos_scrubber': {
      // Box with filter slits and flow arrows
      ctx.roundRect(-14, -10, 28, 20, 3).fill({ color: c, alpha: 0.16 }).stroke({ width: 2, color: c });
      ctx.moveTo(-8, 0).lineTo(8, 0).stroke({ width: 2, color: c });
      // Vertical filter slits
      ctx.moveTo(-4, -5).lineTo(-4, 5).stroke({ width: 1.5, color: c, alpha: 0.6 });
      ctx.moveTo(4, -5).lineTo(4, 5).stroke({ width: 1.5, color: c, alpha: 0.6 });
      // Input/output dots
      ctx.circle(-8, 0, 2).fill({ color: c });
      ctx.circle(8, 0, 2).fill({ color: c });
      return;
    }
    case 'badge': {
      ctx.roundRect(-9, -13, 18, 26, 3).fill({ color: c, alpha: 0.14 }).stroke({ width: 2, color: c });
      ctx.roundRect(-5, -9, 10, 7, 1.5).fill({ color: 0x0a1c34 }).stroke({ width: 1.2, color: c });
      ctx.circle(0, 5, 3.5).stroke({ width: 1.6, color: c });
      ctx.circle(0, 5, 1.2).fill({ color: c });
      return;
    }
    case 'ac': {
      ctx.roundRect(-14, -14, 28, 28, 3).fill({ color: c, alpha: 0.12 }).stroke({ width: 2, color: c });
      ctx.circle(0, 0, 10).stroke({ width: 1.6, color: c });
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2;
        ctx.moveTo(0, 0).quadraticCurveTo(Math.cos(a + 0.6) * 9, Math.sin(a + 0.6) * 9, Math.cos(a + 1.2) * 9, Math.sin(a + 1.2) * 9).stroke({ width: 2.2, color: c });
      }
      ctx.circle(0, 0, 2).fill({ color: c });
      return;
    }
    case 'desk': {
      ctx.roundRect(-15, -9, 30, 16, 2).fill({ color: c, alpha: 0.22 }).stroke({ width: 1.8, color: c });
      ctx.roundRect(-8, -13, 16, 9, 1.5).fill({ color: 0x0a1c34 }).stroke({ width: 1.6, color: c });
      ctx.rect(-6, -11.5, 12, 6).fill({ color: 0x5fd0ff, alpha: 0.55 });
      ctx.roundRect(-9, 1, 18, 4, 1).fill({ color: c, alpha: 0.6 });
      ctx.circle(0, 12, 4).fill({ color: c, alpha: 0.35 }).stroke({ width: 1.2, color: c });
      return;
    }
    default:
      assertNever(kind);
  }
}

export function deviceContext(kind: DeviceKind): GraphicsContext {
  let ctx = cache.get(kind);
  if (!ctx) {
    ctx = new GraphicsContext();
    card(ctx, KIND_COLOR[kind]);
    drawGlyph(ctx, kind);
    cache.set(kind, ctx);
  }
  return ctx;
}
