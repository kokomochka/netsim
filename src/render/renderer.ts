// Pixi scene (architecture v2, §2): screen-space grid, then a camera-transformed
// world container holding cables, devices, ports, overlay and placement ghost.
import { Application, Container, Graphics, Text } from 'pixi.js';
import { BODY, CELL, HP_CRITICAL, HP_WARNING } from '../balance';
import { portPos, portUsage } from '../state/geometry';
import { assertNever, type Cable, type Device, type Vec2 } from '../state/types';
import { pointer, runtime, ui, world, deviceAtCell } from '../state/world';
import { doorStates, smartDoorsLocked } from '../sim/staff';
import { inParking, isIndoor, isPath, placementError, tileAt } from '../state/floor';
import { clearIconCache, deviceContext } from './icons';
import { CABLE_COLOR, COLORS, KIND_COLOR } from './palette';

interface DeviceView {
  kind: string;
  root: Container;
  icon: Graphics;
  plate: Graphics; // background behind labels so cables pass under them
  name: Text;
  sub: Text;
}

const LABEL_FONT = '"Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", sans-serif';

function subLabel(d: Device, usedPorts: Map<string, string>): string {
  switch (d.kind) {
    case 'uplink': return d.publicSubnet;
    case 'server': return `${d.temp && d.temp > 45 ? `${Math.round(d.temp)}° · ` : ''}${d.ip || 'no IP'}${d.roles.length ? ` · ${d.roles.map((r) => ROLE_SHORT[r.role]).join('+')}` : ''}`;
    case 'router': {
      const n = d.interfaces.filter((i) => i.ip).length;
      return `${n}/${d.interfaces.length} IPs`;
    }
    case 'switch': {
      const n = d.ports.filter((p) => usedPorts.has(`${d.id}:${p.index}`)).length;
      return `${n}/${d.ports.length} ports`;
    }
    case 'firewall': return `${d.rules.length} rule${d.rules.length === 1 ? '' : 's'} · ${d.nat.length} NAT`;
    case 'ddos_scrubber': return d.synProtection ? `SYN · ${d.rateLimits.length} rules` : `${d.rateLimits.length} rule${d.rateLimits.length === 1 ? '' : 's'}`;
    case 'desk': return d.ip || 'no IP';
    case 'tower': return `${d.access === 'cell' ? 'cell' : 'homes'} · ${d.ip || 'no IP'}`;
    case 'ac': return d.on ? 'cooling' : 'off';
    case 'badge': return d.ip || 'no IP';
    default: return assertNever(d);
  }
}

const ROLE_SHORT: Record<string, string> = { web: 'web', gpu: 'gpu', nas: 'nas', san: 'san', auth: 'auth', mirror: 'mirror' };

export class Renderer {
  readonly app = new Application();
  private grid = new Graphics();
  private worldLayer = new Container();
  private floorG = new Graphics();
  private doorG = new Graphics();
  private roomTint = new Graphics();
  private roomLabels = new Container();
  private roomLabelViews = new Map<string, Text>();
  private lastRoomDraw = 0;
  private people = new Graphics();
  private peopleLabels = new Container();
  private labelViews = new Map<string, Text>();
  private lastFloorDraw = 0;
  private lastDoorState: boolean | null = null;
  private cables = new Graphics();
  private devices = new Container();
  private ports = new Graphics();
  private carriers = new Graphics();
  private healthBadges = new Graphics();
  private overlay = new Graphics();
  private ghost = new Container();
  private ghostIcon = new Graphics();
  private ghostMark = new Graphics();
  private views = new Map<string, DeviceView>();

  async init(host: HTMLElement): Promise<void> {
    await this.app.init({
      resizeTo: host,
      background: COLORS.background,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      preference: 'webgl',
    });
    host.appendChild(this.app.canvas);
    this.app.canvas.style.touchAction = 'none';
    this.app.stage.addChild(this.grid, this.worldLayer);
    this.worldLayer.addChild(this.floorG, this.roomTint, this.doorG, this.cables, this.devices, this.ports, this.carriers, this.healthBadges, this.people, this.peopleLabels, this.roomLabels, this.overlay, this.ghost);
    this.ghost.addChild(this.ghostIcon, this.ghostMark);
    this.ghost.alpha = 0.55;
    this.ghost.visible = false;

    world.subscribe((_s, reason) => {
      if (reason === 'sim') {
        this.redrawSim();
        return;
      }
      this.applyCamera();
      if (reason !== 'camera') this.redrawWorld();
    });
    ui.subscribe(() => this.redrawInteractive());
    pointer.subscribe(() => this.redrawInteractive());
    this.app.renderer.on('resize', () => this.drawGrid());

    this.applyCamera();
    this.redrawWorld();

    // labels were measured with a fallback font; redo them once web fonts arrive
    document.fonts?.ready.then(() => {
      for (const v of this.views.values()) { v.name.text = ''; v.sub.text = ''; }
      this.redrawWorld();
    }).catch(() => {});
  }

  /** Rebuild everything that baked in palette colours, after applyCanvasTheme(). */
  retheme(): void {
    clearIconCache();
    for (const v of this.views.values()) v.root.destroy({ children: true });
    this.views.clear();
    for (const t of this.labelViews.values()) t.destroy();
    this.labelViews.clear();
    for (const t of this.roomLabelViews.values()) t.destroy();
    this.roomLabelViews.clear();
    this.floorKey = '';
    this.app.renderer.background.color = COLORS.background;
    this.applyCamera();
    this.redrawWorld();
  }

  /** Put the pre-placed uplink a little left of centre at 100 % zoom. */
  centerOnUplink(): void {
    const up = Object.values(world.get().devices).find((d) => d.kind === 'uplink');
    if (!up) return;
    const { w, h } = this.screenSize;
    const scale = w < 760 ? 1 : 1.25;
    const x = (up.gridPos.gx + 0.5) * CELL * scale;
    const y = (up.gridPos.gy + 0.5) * CELL * scale;
    world.update((wd) => { wd.camera = { scale, x: Math.min(w * 0.25, 160) - x, y: h * 0.42 - y }; }, 'camera');
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  screenToWorld(sx: number, sy: number): Vec2 {
    const c = world.get().camera;
    return { x: (sx - c.x) / c.scale, y: (sy - c.y) / c.scale };
  }

  get screenSize(): { w: number; h: number } {
    return { w: this.app.screen.width, h: this.app.screen.height };
  }

  private applyCamera(): void {
    const c = world.get().camera;
    this.worldLayer.position.set(c.x, c.y);
    this.worldLayer.scale.set(c.scale);
    const showLabels = c.scale >= 0.45;
    for (const [id, v] of this.views) {
      const door = world.get().devices[id]?.kind === 'badge';
      v.name.visible = showLabels && !door;
      v.sub.visible = showLabels && !door;
      v.plate.visible = showLabels && !door;
    }
    this.drawGrid();
  }

  private drawGrid(): void {
    const g = this.grid;
    const { width: w, height: h } = this.app.screen;
    const cam = world.get().camera;
    const cs = CELL * cam.scale;
    g.clear();
    const line = (k: number, vertical: boolean) => {
      if (vertical) {
        const x = Math.round(k * cs + cam.x) + 0.5;
        g.moveTo(x, 0).lineTo(x, h);
      } else {
        const y = Math.round(k * cs + cam.y) + 0.5;
        g.moveTo(0, y).lineTo(w, y);
      }
    };
    const kx0 = Math.ceil(-cam.x / cs);
    const kx1 = Math.floor((w - cam.x) / cs);
    const ky0 = Math.ceil(-cam.y / cs);
    const ky1 = Math.floor((h - cam.y) / cs);
    if (cs >= 9) {
      for (let k = kx0; k <= kx1; k++) if (k % 5 !== 0) line(k, true);
      for (let k = ky0; k <= ky1; k++) if (k % 5 !== 0) line(k, false);
      g.stroke({ width: 1, color: COLORS.gridMinor, alpha: 0.05 });
    }
    if (cs * 5 >= 9) {
      for (let k = Math.ceil(kx0 / 5) * 5; k <= kx1; k += 5) line(k, true);
      for (let k = Math.ceil(ky0 / 5) * 5; k <= ky1; k += 5) line(k, false);
      g.stroke({ width: 1, color: COLORS.gridMajor, alpha: 0.1 });
    }
  }

  /** Building floor plan: ground, office carpet, raised server floor, walls, doors. */
  private floorKey = '';

  private drawFloor(): void {
    const s = world.get();
    const f = s.floor;
    const towers = Object.values(s.devices).filter((d) => d.kind === 'tower').map((d) => `${d.gridPos.gx},${d.gridPos.gy}`).join(';');
    const key = `${JSON.stringify(f.tiles)}|${JSON.stringify(f.parking ?? null)}|${towers}|${JSON.stringify(doorStates())}`;
    if (key === this.floorKey) return;
    this.floorKey = key;
    const g = this.floorG;
    g.clear();
    const towerCells = new Set(towers.split(';'));
    // outdoors: a paved footpath right around the building, grass with trees further out
    const B = 8; // decorative grounds beyond the plot on every side
    for (let x = -B; x < f.w + B; x++) {
      for (let y = -B; y < f.h + B; y++) {
        if (tileAt(f, x, y) !== 'ground' || inParking(f, x, y)) continue;
        const px = x * CELL, py = y * CELL;
        if (isPath(f, x, y)) {
          g.rect(px, py, CELL, CELL).fill({ color: COLORS.path });
          g.rect(px + 0.5, py + 0.5, CELL / 2, CELL / 2).stroke({ width: 1, color: COLORS.pathSeam });
          g.rect(px + CELL / 2 + 0.5, py + CELL / 2 + 0.5, CELL / 2 - 1, CELL / 2 - 1).stroke({ width: 1, color: COLORS.pathSeam });
          continue;
        }
        const h = hash(x, y);
        g.rect(px, py, CELL, CELL).fill({ color: h % 3 === 0 ? COLORS.grassDark : COLORS.grass });
        if (towerCells.has(`${x},${y}`)) continue;
        if (h % 100 < 22) {
          const ox = px + 12 + (h >> 8) % 24, oy = py + 12 + (h >> 12) % 24, r = 9 + (h >> 16) % 6;
          g.circle(ox + 3, oy + 4, r).fill({ color: COLORS.trunkShadow, alpha: 0.45 });
          g.circle(ox, oy, r).fill({ color: COLORS.tree });
          g.circle(ox - r * 0.3, oy - r * 0.3, r * 0.55).fill({ color: COLORS.treeLight, alpha: 0.6 });
        } else if (h % 100 < 30) {
          g.circle(px + 10 + (h >> 9) % 28, py + 10 + (h >> 13) % 28, 2.2).fill({ color: COLORS.treeLight, alpha: 0.5 });
        }
      }
    }
    // parking lot: decoration, nothing can be built here
    const pk = f.parking;
    if (pk) {
      const px0 = pk.x0 * CELL, py0 = pk.y0 * CELL, pw = (pk.x1 - pk.x0 + 1) * CELL, ph = (pk.y1 - pk.y0 + 1) * CELL;
      g.rect(px0, py0, pw, ph).fill({ color: COLORS.asphalt });
      g.rect(px0 + 2, py0 + 2, pw - 4, ph - 4).stroke({ width: 2, color: COLORS.stall, alpha: 0.5 });
      const rows = [pk.y0 + 0.15, pk.y1 - 1.35].filter((r, i, a) => a.indexOf(r) === i && r >= pk.y0);
      const carColors = [0xfa896b, 0x5d87ff, 0xffffff, 0x49beff, 0xffae1f, 0xa6b4c8, 0x9b8cf5];
      for (const row of rows) {
        const top = row * CELL;
        for (let x = pk.x0; x <= pk.x1; x++) {
          const sx = x * CELL;
          g.moveTo(sx + 1, top).lineTo(sx + 1, top + CELL * 1.2).stroke({ width: 2, color: COLORS.stall, alpha: 0.7 });
          const h = hash(x, Math.round(row * 10));
          if (h % 100 < 55) {
            const c = carColors[h % carColors.length]!;
            g.roundRect(sx + 9, top + 6, CELL - 18, CELL * 1.2 - 12, 7).fill({ color: COLORS.carShadow, alpha: 0.12 });
            g.roundRect(sx + 7, top + 4, CELL - 18, CELL * 1.2 - 12, 7).fill({ color: c });
            g.roundRect(sx + 11, top + 14, CELL - 26, 12, 3).fill({ color: 0x3b4a63, alpha: 0.55 });
            g.roundRect(sx + 11, top + CELL * 1.2 - 26, CELL - 26, 8, 3).fill({ color: 0x3b4a63, alpha: 0.45 });
          }
        }
        g.moveTo((pk.x1 + 1) * CELL - 1, top).lineTo((pk.x1 + 1) * CELL - 1, top + CELL * 1.2).stroke({ width: 2, color: COLORS.stall, alpha: 0.7 });
      }
      const midY = py0 + ph / 2;
      for (let x = px0 + 12; x < px0 + pw - 24; x += 36) g.rect(x, midY - 1.5, 18, 3).fill({ color: COLORS.stall, alpha: 0.55 });
      g.poly([px0 + pw - 30, midY - 8, px0 + pw - 14, midY, px0 + pw - 30, midY + 8]).fill({ color: COLORS.stall, alpha: 0.55 });
    }
    // plot fence
    const fence = (x0: number, y0: number, x1: number, y1: number) => {
      const len = Math.hypot(x1 - x0, y1 - y0);
      for (let t = 0; t < len; t += 14) {
        const a0 = t / len, a1 = Math.min(1, (t + 8) / len);
        g.moveTo(x0 + (x1 - x0) * a0, y0 + (y1 - y0) * a0).lineTo(x0 + (x1 - x0) * a1, y0 + (y1 - y0) * a1);
      }
    };
    const W = f.w * CELL, H = f.h * CELL;
    fence(0, 0, W, 0); fence(W, 0, W, H); fence(W, H, 0, H); fence(0, H, 0, 0);
    g.stroke({ width: 2, color: COLORS.fence, alpha: 0.6 });
    const locked = smartDoorsLocked(s);
    this.lastDoorState = locked;
    const tiles = Object.entries(f.tiles).map(([k, t]) => { const [x, y] = k.split(',').map(Number); return { x: x!, y: y!, t }; });
    // floors first
    for (const { x, y, t } of tiles) {
      const px = x * CELL, py = y * CELL;
      if (t === 'wall' || t === 'vent') {
        g.rect(px, py, CELL, CELL).fill({ color: COLORS.floor });
      } else if (t === 'floor' || t === 'door' || t === 'smartdoor') {
        g.rect(px, py, CELL, CELL).fill({ color: COLORS.floor });
        g.rect(px + 0.5, py + 0.5, CELL - 1, CELL - 1).stroke({ width: 1, color: COLORS.floorSeam });
      } else if (t === 'raised') {
        g.rect(px, py, CELL, CELL).fill({ color: COLORS.raised });
        g.rect(px + 1, py + 1, CELL - 2, CELL - 2).stroke({ width: 1.5, color: COLORS.raisedSeam });
        for (const a of [12, 24, 36]) for (const b of [12, 24, 36]) g.circle(px + a, py + b, 1).fill({ color: COLORS.raisedDot, alpha: 0.7 });
      }
    }
    // walls join their neighbours so rooms read as solid outlines
    const isWallish = (x: number, y: number) => { const t = f.tiles[`${x},${y}`]; return t === 'wall' || t === 'door' || t === 'smartdoor' || t === 'vent'; };
    const T = 10;
    for (const { x, y, t } of tiles) {
      if (t !== 'wall' && t !== 'vent') continue;
      const cx = x * CELL + CELL / 2, cy = y * CELL + CELL / 2;
      g.rect(cx - T / 2, cy - T / 2, T, T).fill({ color: COLORS.wall });
      if (isWallish(x + 1, y)) g.rect(cx, cy - T / 2, CELL / 2 + 0.5, T).fill({ color: COLORS.wall });
      if (isWallish(x - 1, y)) g.rect(cx - CELL / 2 - 0.5, cy - T / 2, CELL / 2 + 0.5, T).fill({ color: COLORS.wall });
      if (isWallish(x, y + 1)) g.rect(cx - T / 2, cy, T, CELL / 2 + 0.5).fill({ color: COLORS.wall });
      if (isWallish(x, y - 1)) g.rect(cx - T / 2, cy - CELL / 2 - 0.5, T, CELL / 2 + 0.5).fill({ color: COLORS.wall });
    }
    for (const { x, y, t } of tiles) {
      if (t !== 'vent') continue;
      const px = x * CELL, py = y * CELL;
      const horiz = isWallish(x - 1, y) || isWallish(x + 1, y);
      g.roundRect(px + 8, py + 8, CELL - 16, CELL - 16, 4).fill({ color: COLORS.ventFill }).stroke({ width: 2, color: KIND_COLOR.ac });
      for (let i = 0; i < 4; i++) {
        if (horiz) g.moveTo(px + 13 + i * 7, py + 12).lineTo(px + 13 + i * 7, py + CELL - 12);
        else g.moveTo(px + 12, py + 13 + i * 7).lineTo(px + CELL - 12, py + 13 + i * 7);
      }
      g.stroke({ width: 1.5, color: KIND_COLOR.ac, alpha: 0.8 });
    }
  }

  private doorOpen = new Map<string, number>();

  /** Doors, drawn every frame: they swing open while someone walks through, then close. */
  private drawDoors(): void {
    const s = world.get();
    const f = s.floor;
    const g = this.doorG;
    g.clear();
    const isWallish = (x: number, y: number) => { const t = f.tiles[`${x},${y}`]; return t === 'wall' || t === 'door' || t === 'smartdoor' || t === 'vent'; };
    const people = [...Object.values(s.staff.engineers), ...Object.values(s.staff.trespassers)];
    for (const [k, t] of Object.entries(f.tiles)) {
      if (t !== 'door' && t !== 'smartdoor') continue;
      const [x, y] = k.split(',').map(Number) as [number, number];
      const near = people.some((p) => Math.abs(p.x - (x + 0.5)) < 1.1 && Math.abs(p.y - (y + 0.5)) < 1.1);
      const cur = this.doorOpen.get(k) ?? 0;
      const next = cur + ((near ? 1 : 0) - cur) * 0.18;
      this.doorOpen.set(k, next);
      const px = x * CELL, py = y * CELL;
      const horiz = isWallish(x - 1, y) || isWallish(x + 1, y);
      const ds = doorStates()[k]?.state ?? 'open';
      const color = t === 'smartdoor' ? (ds === 'locked' ? COLORS.healthOk : ds === 'sealed' ? COLORS.healthBad : COLORS.healthWarn) : COLORS.door;
      const L = CELL - 8;
      // closed: leaf across the opening; open: swung 90° on its hinge
      const ang = next * (Math.PI / 2);
      if (horiz) {
        g.rect(px, py + CELL / 2 - 5, 4, 10).fill({ color: COLORS.wall });
        g.rect(px + CELL - 4, py + CELL / 2 - 5, 4, 10).fill({ color: COLORS.wall });
        const hx = px + 4, hy = py + CELL / 2;
        g.moveTo(hx, hy).lineTo(hx + Math.cos(-ang) * L, hy + Math.sin(-ang) * L).stroke({ width: 4, color });
        if (next > 0.05) g.arc(hx, hy, L, -ang, 0).stroke({ width: 1, color, alpha: 0.35 });
      } else {
        g.rect(px + CELL / 2 - 5, py, 10, 4).fill({ color: COLORS.wall });
        g.rect(px + CELL / 2 - 5, py + CELL - 4, 10, 4).fill({ color: COLORS.wall });
        const hx = px + CELL / 2, hy = py + 4;
        g.moveTo(hx, hy).lineTo(hx + Math.sin(ang) * L, hy + Math.cos(ang) * L).stroke({ width: 4, color });
        if (next > 0.05) g.arc(hx, hy, L, Math.PI / 2 - ang, Math.PI / 2).stroke({ width: 1, color, alpha: 0.35 });
      }
      if (t === 'smartdoor') {
        g.roundRect(px + CELL / 2 - 6, py + CELL / 2 - 6, 12, 12, 3).fill({ color: COLORS.card }).stroke({ width: 1.5, color });
        g.circle(px + CELL / 2, py + CELL / 2, 2.5).fill({ color });
      }
    }
  }

  /** Tint each room by air temperature and label it. */
  private drawRooms(): void {
    const s = world.get();
    const g = this.roomTint;
    g.clear();
    const seen = new Set<string>();
    for (const r of runtime.rooms) {
      const t = s.climate.rooms[r.key] ?? s.climate.outside;
      const hot = Math.max(0, Math.min(1, (t - 26) / 30));
      const cold = Math.max(0, Math.min(1, (20 - t) / 8));
      const color = hot > 0 ? mix(0xffb347, 0xff3b30, Math.max(0, (t - 40) / 20)) : COLORS.coldTint;
      const alpha = hot > 0 ? 0.08 + hot * 0.3 : cold * 0.15;
      let mx = Infinity, my = Infinity;
      if (alpha > 0.01) for (const c of r.cells) {
        const [x, y] = c.split(',').map(Number) as [number, number];
        g.rect(x * CELL, y * CELL, CELL, CELL).fill({ color, alpha });
      }
      for (const c of r.cells) { const [x, y] = c.split(',').map(Number) as [number, number]; if (y < my || (y === my && x < mx)) { mx = x; my = y; } }
      seen.add(r.key);
      let lab = this.roomLabelViews.get(r.key);
      if (!lab) {
        lab = new Text({ text: '', resolution: 3, style: { fontFamily: LABEL_FONT, fontSize: 11, fill: COLORS.label, fontWeight: '500' } });
        this.roomLabels.addChild(lab);
        this.roomLabelViews.set(r.key, lab);
      }
      const txt = `${t.toFixed(1)} °C`;
      if (lab.text !== txt) lab.text = txt;
      lab.style.fill = t > 40 ? COLORS.healthBad : t > 30 ? COLORS.healthWarn : COLORS.label;
      lab.position.set(mx * CELL + 4, my * CELL + 3);
    }
    for (const [k, t] of this.roomLabelViews) if (!seen.has(k)) { t.destroy(); this.roomLabelViews.delete(k); }
  }

  /** Engineers and strangers, drawn every frame. */
  private drawPeople(): void {
    const s = world.get();
    const g = this.people;
    g.clear();
    const seen = new Set<string>();
    const label = (id: string, text: string, x: number, y: number, color: number) => {
      seen.add(id);
      let t = this.labelViews.get(id);
      if (!t) {
        t = new Text({ text, resolution: 3, style: { fontFamily: LABEL_FONT, fontSize: 9, fill: color, fontWeight: '500' } });
        t.anchor.set(0.5, 1);
        this.peopleLabels.addChild(t);
        this.labelViews.set(id, t);
      }
      if (t.text !== text) t.text = text;
      t.position.set(x, y);
    };
    for (const e of Object.values(s.staff.engineers)) {
      const x = e.x * CELL, y = e.y * CELL;
      g.roundRect((Math.floor(e.x) - 2) * CELL, (Math.floor(e.y) - 2) * CELL, CELL * 5, CELL * 5, 10)
        .fill({ color: COLORS.sight, alpha: 0.045 }).stroke({ width: 1, color: COLORS.sight, alpha: 0.16 });
      const seated = e.state === 'seated';
      const oy = seated ? 15 : 0;
      g.ellipse(x, y + oy + 2, 8, 5).fill({ color: COLORS.carShadow, alpha: 0.14 });
      g.circle(x, y + oy, 7).fill({ color: COLORS.engineer }).stroke({ width: 1.5, color: COLORS.engineerDark });
      g.circle(x, y + oy - 1, 3.4).fill({ color: 0xf1d3b3 });
      const job = e.jobId ? s.staff.jobs[e.jobId] : undefined;
      if (job?.started && !job.remote) {
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.012);
        g.circle(x, y + oy, 11).stroke({ width: 1.5, color: COLORS.healthWarn, alpha: 0.4 + pulse * 0.5 });
      }
      if (job?.remote) {
        const desk = e.deskId ? s.devices[e.deskId] : undefined;
        const tgt = s.devices[job.deviceId];
        if (desk && tgt) {
          const ax = (desk.gridPos.gx + 0.5) * CELL, ay = (desk.gridPos.gy + 0.5) * CELL;
          const bx = (tgt.gridPos.gx + 0.5) * CELL, by = (tgt.gridPos.gy + 0.5) * CELL;
          const n = Math.max(2, Math.floor(Math.hypot(bx - ax, by - ay) / 10));
          const phase = (Date.now() / 60) % 2;
          for (let i = 0; i < n; i++) if ((i + Math.floor(phase)) % 2 === 0) g.circle(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n, 1.4).fill({ color: COLORS.carrierNormal, alpha: 0.8 });
        }
      }
      if (e.state === 'chasing') g.circle(x, y, 10).stroke({ width: 2, color: COLORS.strangerRim, alpha: 0.7 });
      if (seated) { const t = this.labelViews.get(e.id); if (t) t.visible = false; seen.add(e.id); }
      else { label(e.id, e.name, x, y + oy - 10, COLORS.label); this.labelViews.get(e.id)!.visible = true; }
    }
    for (const t of Object.values(s.staff.trespassers)) {
      const x = t.x * CELL, y = t.y * CELL;
      g.ellipse(x, y + 2, 8, 5).fill({ color: COLORS.carShadow, alpha: 0.18 });
      g.circle(x, y, 7).fill({ color: COLORS.stranger }).stroke({ width: 2, color: COLORS.strangerRim });
      g.circle(x, y - 1, 3).fill({ color: 0x55555e });
      if (t.state === 'hacking') {
        const tgt = s.devices[t.targetId];
        const frac = t.progress / (10 * 20);
        if (tgt) g.rect(x - 10, y + 10, 20 * Math.min(1, frac), 3).fill({ color: COLORS.strangerRim });
      }
      label(t.id, t.spotted ? 'stranger!' : '?', x, y - 9, COLORS.strangerRim);
    }
    for (const [id, t] of this.labelViews) if (!seen.has(id)) { t.destroy(); this.labelViews.delete(id); }
  }

  private redrawWorld(): void {
    this.drawFloor();
    this.drawDoors();
    this.drawPeople();
    const s = world.get();
    const used = portUsage(s);

    // device views: create, update, remove
    const seen = new Set<string>();
    for (const d of Object.values(s.devices)) {
      seen.add(d.id);
      let v = this.views.get(d.id);
      if (v && v.kind !== d.kind) { v.root.destroy({ children: true }); this.views.delete(d.id); v = undefined; }
      if (!v) {
        const root = new Container();
        const icon = new Graphics(deviceContext(d.kind));
        const name = new Text({
          text: '', resolution: 3,
          style: { fontFamily: LABEL_FONT, fontSize: 10, fill: COLORS.label, fontWeight: '700' },
        });
        const sub = new Text({
          text: '', resolution: 3,
          style: { fontFamily: LABEL_FONT, fontSize: 8.5, fill: COLORS.sublabel },
        });
        name.anchor.set(0.5, 0);
        sub.anchor.set(0.5, 0);
        name.position.set(0, BODY / 2 + 4);
        sub.position.set(0, BODY / 2 + 17);
        const plate = new Graphics();
        root.addChild(icon, plate, name, sub);
        this.devices.addChild(root);
        v = { kind: d.kind, root, icon, plate, name, sub };
        this.views.set(d.id, v);
        const show = s.camera.scale >= 0.45;
        name.visible = show;
        sub.visible = show;
        plate.visible = show;
      }
      v.root.position.set((d.gridPos.gx + 0.5) * CELL, (d.gridPos.gy + 0.5) * CELL);
      if (d.kind === 'badge') { v.icon.visible = false; v.name.visible = false; v.sub.visible = false; v.plate.visible = false; continue; }
      const sl = subLabel(d, used);
      if (v.name.text !== d.name || v.sub.text !== sl || v.plate.context.instructions.length === 0) {
        v.name.text = d.name;
        v.sub.text = sl;
        const w = Math.max(v.name.width, v.sub.width) + 8;
        v.plate.clear();
        v.plate.roundRect(-w / 2, BODY / 2 + 2, w, 28, 6).fill({ color: COLORS.plate, alpha: 0.94 }).stroke({ width: 1, color: COLORS.plateLine });
      }
    }
    for (const [id, v] of this.views) {
      if (!seen.has(id)) {
        v.root.destroy({ children: true });
        this.views.delete(id);
      }
    }

    this.redrawInteractive();
  }

  /** Cables, ports, selection/hover overlay and ghost: everything that reacts to UI state. */
  private redrawInteractive(): void {
    const s = world.get();
    const u = ui.get();
    const p = pointer.get();
    const used = portUsage(s);
    const cableMode = u.tool.mode === 'cable';

    this.drawCables();

    // ports
    const pg = this.ports;
    pg.clear();
    for (const d of Object.values(s.devices)) {
      for (const port of d.ports) {
        const pos = portPos(d, port.index);
        const cableId = used.get(`${d.id}:${port.index}`);
        if (cableId) {
          const c = s.cables[cableId];
          pg.circle(pos.x, pos.y, 3.4).fill({ color: c ? CABLE_COLOR[c.type] : COLORS.portRing });
        } else {
          pg.circle(pos.x, pos.y, cableMode ? 4.4 : 3)
            .fill({ color: COLORS.portFree })
            .stroke({ width: 1.3, color: cableMode ? COLORS.hover : COLORS.portRing, alpha: cableMode ? 1 : 0.7 });
        }
      }
    }

    // overlay: hover, selection, pending cable
    const og = this.overlay;
    og.clear();
    const ring = (d: Device, pad: number) => {
      const x = d.gridPos.gx * CELL + (CELL - BODY) / 2 - pad;
      const y = d.gridPos.gy * CELL + (CELL - BODY) / 2 - pad;
      og.roundRect(x, y, BODY + pad * 2, BODY + pad * 2, 7 + pad);
    };
    const hovered = p.hoverDevice ? s.devices[p.hoverDevice] : undefined;
    if (hovered && (u.tool.mode !== 'place')) {
      ring(hovered, 3);
      og.stroke({ width: 1.5, color: COLORS.hover, alpha: 0.6 });
    }
    const selDev = u.selection?.type === 'device' ? s.devices[u.selection.id] : undefined;
    if (selDev) {
      ring(selDev, 4);
      og.stroke({ width: 2, color: COLORS.selection });
    }
    if (u.pendingCable) {
      const d = s.devices[u.pendingCable.deviceId];
      if (d) {
        ring(d, 4);
        og.stroke({ width: 2, color: CABLE_COLOR[u.cableType] });
        const from = u.pendingCable.explicit
          ? portPos(d, u.pendingCable.port)
          : { x: (d.gridPos.gx + 0.5) * CELL, y: (d.gridPos.gy + 0.5) * CELL };
        if (p.pointerWorld) {
          og.moveTo(from.x, from.y).lineTo(p.pointerWorld.x, p.pointerWorld.y)
            .stroke({ width: 2, color: CABLE_COLOR[u.cableType], alpha: 0.6 });
        }
      }
    }

    // ghost: placement preview or drag-move target
    let ghostKind: Device['kind'] | null = null;
    let ghostCell = null as { gx: number; gy: number } | null;
    let ghostOk = true;
    if (u.tool.mode === 'build' && p.hoverCell) {
      og.rect(p.hoverCell.gx * CELL + 1, p.hoverCell.gy * CELL + 1, CELL - 2, CELL - 2).stroke({ width: 2, color: COLORS.hover, alpha: 0.8 });
    }
    if (u.tool.mode === 'place' && p.hoverCell) {
      ghostKind = u.tool.kind;
      ghostCell = p.hoverCell;
      ghostOk = !deviceAtCell(s, ghostCell.gx, ghostCell.gy) && !placementError(s.floor, u.tool.kind, ghostCell.gx, ghostCell.gy);
    } else if (p.dragGhost) {
      const d = s.devices[p.dragGhost.deviceId];
      if (d) {
        ghostKind = d.kind;
        ghostCell = p.dragGhost.cell;
        const other = deviceAtCell(s, ghostCell.gx, ghostCell.gy);
        ghostOk = (!other || other.id === d.id) && !placementError(s.floor, d.kind, ghostCell.gx, ghostCell.gy);
      }
    }
    if (ghostKind && ghostCell) {
      this.ghost.visible = true;
      this.ghostIcon.context = deviceContext(ghostKind);
      this.ghost.position.set((ghostCell.gx + 0.5) * CELL, (ghostCell.gy + 0.5) * CELL);
      this.ghostMark.clear();
      if (!ghostOk) {
        this.ghostMark.roundRect(-BODY / 2, -BODY / 2, BODY, BODY, 6).fill({ color: COLORS.invalid, alpha: 0.45 });
      }
    } else {
      this.ghost.visible = false;
    }
  }

  private lastCableDraw = 0;

  /** Cables coloured by type, shifted toward red as load passes 70 % of capacity. */
  private drawCables(): void {
    const s = world.get();
    const u = ui.get();
    const cg = this.cables;
    cg.clear();
    const selCable = u.selection?.type === 'cable' ? u.selection.id : null;
    const portDown = (c: Cable) => [c.a, c.b].some((e) => {
      const d = s.devices[e.deviceId];
      return !d || !d.ports[e.port]?.up || d.health.state === 'failed';
    });
    for (const c of Object.values(s.cables)) {
      if (c.path.length < 2) continue;
      const pts = c.path;
      const trace = () => {
        cg.moveTo(pts[0]!.x, pts[0]!.y);
        for (let i = 1; i < pts.length; i++) cg.lineTo(pts[i]!.x, pts[i]!.y);
      };
      if (c.id === selCable) {
        trace();
        cg.stroke({ width: 9, color: COLORS.selection, alpha: 0.3, cap: 'round', join: 'round' });
      }
      const util = (runtime.cableLoad[c.id] ?? 0) / Math.max(1, c.bandwidthMbps);
      const dead = portDown(c);
      if (runtime.stpBlocked[c.id]) {
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i]!, b = pts[i + 1]!;
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          for (let t0 = 0; t0 < len; t0 += 10) {
            const t1 = Math.min(len, t0 + 5);
            cg.moveTo(a.x + ((b.x - a.x) * t0) / len, a.y + ((b.y - a.y) * t0) / len).lineTo(a.x + ((b.x - a.x) * t1) / len, a.y + ((b.y - a.y) * t1) / len);
          }
        }
        cg.stroke({ width: 2.4, color: CABLE_COLOR[c.type], alpha: 0.55 });
        const blk = s.devices[runtime.stpBlocked[c.id]!];
        const end = blk && c.b.deviceId === blk.id ? pts[pts.length - 1]! : pts[0]!;
        cg.circle(end.x, end.y, 5).fill({ color: COLORS.healthWarn }).stroke({ width: 1.2, color: COLORS.plate });
        continue;
      }
      const storm = runtime.storm[c.a.deviceId] && runtime.storm[c.b.deviceId];
      if (storm) {
        trace();
        cg.stroke({ width: 8, color: 0xff3df2, alpha: 0.25 + 0.25 * Math.sin(Date.now() * 0.02), cap: 'round', join: 'round' });
      }
      let color: number = CABLE_COLOR[c.type];
      if (util > 0.7) color = mix(color, COLORS.healthBad, Math.min(1, (util - 0.7) / 0.3));
      trace();
      cg.stroke({ width: c.type === 'fibre' ? 3.2 : 2.6, color: dead ? COLORS.healthBad : color, alpha: dead ? 0.45 : 1, cap: 'round', join: 'round' });
      if (util > 1 && !dead) {
        trace();
        cg.stroke({ width: 7, color: COLORS.healthBad, alpha: 0.18 + 0.12 * Math.sin(Date.now() * 0.008), cap: 'round', join: 'round' });
      }
    }
  }

  /** Point at fraction t along a cable, walking from the end attached to devId. */
  private alongCable(c: Cable, fromDev: string, t: number): Vec2 | null {
    const pts = c.a.deviceId === fromDev ? c.path : [...c.path].reverse();
    if (pts.length < 2) return null;
    let total = 0;
    const seg: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) { const l = Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y); seg.push(l); total += l; }
    let d = Math.min(1, Math.max(0, t)) * total;
    for (let i = 0; i < seg.length; i++) {
      if (d <= seg[i]! || i === seg.length - 1) {
        const f = seg[i]! ? d / seg[i]! : 0;
        return { x: pts[i]!.x + (pts[i + 1]!.x - pts[i]!.x) * f, y: pts[i]!.y + (pts[i + 1]!.y - pts[i]!.y) * f };
      }
      d -= seg[i]!;
    }
    return null;
  }

  /** Redraw carrier particles and health badges — called every sim tick. */
  private redrawSim(): void {
    const s = world.get();
    const cg = this.carriers;
    cg.clear();

    const now = performance.now();
    if (now - this.lastCableDraw > 150) { this.lastCableDraw = now; this.drawCables(); }
    this.drawPeople();
    this.drawDoors();
    if (now - this.lastRoomDraw > 500) { this.lastRoomDraw = now; this.drawRooms(); }
    if (now - this.lastFloorDraw > 1000) {
      this.lastFloorDraw = now;
      this.drawFloor();
    }
    for (const c of runtime.carriers) {
      const path = runtime.paths[c.flowId];
      if (!path) continue;
      const hop = path.hops[c.pathIndex];
      let pos: Vec2 | null = null;
      if (c.dying > 0) {
        const d = hop ? s.devices[hop.deviceId] : undefined;
        if (!d) continue;
        pos = { x: (d.gridPos.gx + 0.5) * CELL, y: (d.gridPos.gy + 0.5) * CELL };
        const k = c.dying / 12;
        cg.circle(pos.x, pos.y, c.size + (1 - k) * 8).stroke({ width: 1.5, color: COLORS.carrierAttack, alpha: k });
        continue;
      }
      const cable = hop?.cableId ? s.cables[hop.cableId] : undefined;
      if (!cable) continue;
      pos = this.alongCable(cable, hop!.deviceId, c.progress);
      if (!pos) continue;
      const color = c.kind === 'attack' ? COLORS.carrierAttack : c.kind === 'probe' ? COLORS.healthWarn
        : c.kind === 'control' ? COLORS.carrierControl : c.kind === 'backup' ? COLORS.carrierBackup : c.kind === 'backend' || c.kind === 'proxied' ? COLORS.carrierBackend
        : c.kind === 'transit' ? COLORS.carrierTransit : COLORS.carrierNormal;
      cg.circle(pos.x, pos.y, c.size).fill({ color, alpha: 0.9 });
    }

    // Health badges: colored indicators on degraded/failed devices
    const hg = this.healthBadges;
    hg.clear();
    for (const d of Object.values(s.devices)) {
      const bx = (d.gridPos.gx + 0.5) * CELL - BODY / 2 + 4;
      const by = (d.gridPos.gy + 0.5) * CELL - BODY / 2 + 4;
      if (d.compromised) {
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.006);
        hg.roundRect(bx - 8, by - 8, BODY + 8, BODY + 8, 8).stroke({ width: 2, color: COLORS.strangerRim, alpha: 0.4 + 0.5 * pulse });
        hg.circle(bx, by, 6).fill({ color: COLORS.strangerRim });
        hg.moveTo(bx - 3, by - 3).lineTo(bx + 3, by + 3).moveTo(bx + 3, by - 3).lineTo(bx - 3, by + 3).stroke({ width: 1.8, color: COLORS.plate });
      } else if (d.sw && d.sw.patch < s.staff.release) {
        hg.circle(bx, by + BODY - 8, 5).fill({ color: COLORS.plate, alpha: 0.95 });
        hg.poly([bx, by + BODY - 12, bx + 3.5, by + BODY - 7, bx - 3.5, by + BODY - 7]).fill({ color: COLORS.healthWarn });
      }
      // only what someone knows about gets a badge
      const keys = Object.keys(s.known ?? {}).filter((k) => k.startsWith(d.id + ':'));
      const repairing = d.health.state === 'repairing';
      if (!keys.length && !repairing) continue;
      const alert = keys.some((k) => !k.includes(':w:') && !k.endsWith(':wear') && !k.endsWith(':warm'));
      const cx = (d.gridPos.gx + 0.5) * CELL + BODY / 2 - 4;
      const cy = (d.gridPos.gy + 0.5) * CELL - BODY / 2 + 4;
      const color = repairing ? COLORS.carrierNormal : alert ? COLORS.healthBad : COLORS.healthWarn;
      // Outer ring
      hg.circle(cx, cy, 6).fill({ color: COLORS.plate, alpha: 0.95 });
      hg.circle(cx, cy, 5).fill({ color });

      // Pulsing effect for failed/critical devices
      if (alert && !repairing) {
        const pulse = 0.3 + 0.3 * Math.sin(Date.now() * 0.005);
        hg.circle(cx, cy, 8).stroke({ width: 1.5, color, alpha: pulse });
      }
    }

    // Also update device sub-labels to reflect health changes
    const used = portUsage(s);
    for (const d of Object.values(s.devices)) {
      const v = this.views.get(d.id);
      if (!v) continue;
      const sl = subLabel(d, used);
      if (v.sub.text !== sl) v.sub.text = sl;
      // Tint device icon based on health
      if (d.health.state === 'failed') {
        v.icon.alpha = 0.4;
      } else if (d.health.state === 'critical' || d.health.state === 'repairing') {
        v.icon.alpha = 0.65;
      } else {
        v.icon.alpha = 1;
      }
    }
  }
}

function mix(a: number, b: number, t: number): number {
  const ch = (n: number, sh: number) => (n >> sh) & 255;
  const m = (sh: number) => Math.round(ch(a, sh) + (ch(b, sh) - ch(a, sh)) * t) << sh;
  return m(16) | m(8) | m(0);
}

/** Stable per-cell pseudo-random number so trees and cars stay put between redraws. */
function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}
