// Pixi scene (architecture v2, §2): screen-space grid, then a camera-transformed
// world container holding cables, devices, ports, overlay and placement ghost.
import { Application, Container, Graphics, Text } from 'pixi.js';
import { BODY, CELL, HP_CRITICAL, HP_WARNING } from '../balance';
import { portPos, portUsage } from '../state/geometry';
import { assertNever, type Building, type Cable, type Device, type Flow, type FlowKind, type ResolvedPath, type Vec2 } from '../state/types';
import { focusOf, pointer, runtime, ui, world, deviceAtCell } from '../state/world';
import { doorStates, smartDoorsLocked } from '../sim/staff';
import { inParking, isIndoor, isPath, placementError, tileAt } from '../state/floor';
import { flowShape } from '../sim/net';
import { layoutCables } from './cablelayout';
import { VolumeScene, drawGround, floorTileColor } from './volume';
import { STRIDE, buildingAt, levelOf } from '../state/city';
import { clearIconCache, deviceContext } from './icons';
import { CABLE_COLOR, COLORS, KIND_COLOR } from './palette';

interface DeviceView {
  kind: string;
  root: Container;
  label: Container;
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

/** Shift a polyline sideways (to its right) by d, keeping corners joined. */
function offsetPath(pts: Vec2[], d: number): Vec2[] {
  const n = pts.length;
  const norm = (i: number): Vec2 => {
    const a = pts[i]!, b = pts[i + 1]!;
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
  };
  return pts.map((p, i) => {
    const n0 = i > 0 ? norm(i - 1) : norm(0);
    const n1 = i < n - 1 ? norm(i) : norm(n - 2);
    let nx = n0.x + n1.x, ny = n0.y + n1.y;
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    const cos = Math.max(0.5, nx * n1.x + ny * n1.y);
    return { x: p.x + (nx * d) / cos, y: p.y + (ny * d) / cos };
  });
}

const ROLE_SHORT: Record<string, string> = { web: 'web', gpu: 'gpu', nas: 'nas', san: 'san', auth: 'auth', mirror: 'mirror' };

export class Renderer {
  readonly app = new Application();
  private grid = new Graphics();
  private worldLayer = new Container();
  /** floor-plane layers: tilted into isometric by these two transforms */
  private plane = new Container();
  private planeInner = new Container();
  /** upright text and badges, placed at projected points */
  private labels = new Container();
  private deviceLabels = new Container();
  private iso = new VolumeScene();
  private view: 'top' | 'iso' = 'top';
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
    this.worldLayer.addChild(this.plane, this.iso.stand, this.labels);
    this.plane.addChild(this.planeInner);
    this.planeInner.addChild(this.floorG, this.roomTint, this.doorG, this.cables, this.carriers, this.devices, this.ports, this.people, this.overlay, this.ghost);
    this.labels.addChild(this.healthBadges, this.deviceLabels, this.roomLabels, this.peopleLabels);
    this.view = 'iso';   // one view now: top-down with volume
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
    ui.subscribe((u) => {
      if (focusOf(world.get(), u) !== this.iso.focus) { if ((u.level ?? 0) !== this.iso.level) this.setLevel(u.level ?? 0); else this.redrawWorld(); return; }
      if ((u.level ?? 0) !== this.iso.level) this.setLevel(u.level ?? 0); else this.redrawInteractive();
    });
    pointer.subscribe(() => this.redrawInteractive());
    this.app.renderer.on('resize', () => this.drawGrid());
    this.app.ticker.add(() => { const now = performance.now(); this.drawStreams(now); if (this.view === 'iso') { this.iso.animate(world.get(), now); this.iso.drawPeople(world.get(), now); } });

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
    for (const v of this.views.values()) { v.root.destroy({ children: true }); v.label.destroy({ children: true }); }
    this.views.clear();
    this.iso.clear();
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
    const p = this.project((up.gridPos.gx + 0.5) * CELL, (up.gridPos.gy + 0.5) * CELL);
    const x = p.x * scale, y = p.y * scale;
    const left = this.view === 'iso' ? w * 0.4 : Math.min(w * 0.25, 160);
    world.update((wd) => { wd.camera = { scale, x: left - x, y: h * 0.42 - y }; }, 'camera');
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  screenToWorld(sx: number, sy: number): Vec2 {
    const c = world.get().camera;
    const x = (sx - c.x) / c.scale, y = (sy - c.y) / c.scale;
    return { x, y };
  }

  /** World floor point → camera-space point (identity in the top-down view). */
  project(x: number, y: number): Vec2 {
    return { x, y };
  }

  get isIso(): boolean { return this.view === 'iso'; }

  /** In 3D the boxes stand above their floor cell: pick them by what is drawn. */
  pickDevice(sx: number, sy: number): string | null {
    const c = world.get().camera;
    return this.iso.pick((sx - c.x) / c.scale, (sy - c.y) / c.scale);
  }

  /** A closed building under a screen point, if any. */
  pickBuilding(sx: number, sy: number): Building | null {
    const c = world.get().camera;
    return this.iso.pickBuilding(world.get(), (sx - c.x) / c.scale, (sy - c.y) / c.scale);
  }

  /** Can you see inside this cell right now? */
  cellVisible(gx: number, gy: number): boolean { return this.iso.cellVisible(world.get(), gx, gy); }

  /** Switch between the flat plan and the isometric view, keeping the same spot in the middle. */
  private setLevel(level: number): void {
    const c = world.get().camera;
    const from = this.iso.level;
    this.iso.level = level;
    this.floorKey = '';
    this.iso.clear();
    // same spot on the other storey: its band is (level - from) × STRIDE rows away
    world.update((wd) => { wd.camera = { scale: c.scale, x: c.x, y: c.y - (level - from) * STRIDE * CELL * c.scale }; }, 'camera');
    this.redrawWorld();
  }

  get level(): number { return this.iso.level; }

  /** Where labels hang under a device, and where its badges float. */
  private anchor(d: Device): { x: number; y: number; top: number } {
    const cx = (d.gridPos.gx + 0.5) * CELL, cy = (d.gridPos.gy + 0.5) * CELL;
    return { x: cx, y: cy, top: cy - BODY / 2 - this.iso.heightOf(d.kind) + 2 };
  }

  get screenSize(): { w: number; h: number } {
    return { w: this.app.screen.width, h: this.app.screen.height };
  }

  private applyCamera(): void {
    const c = world.get().camera;
    this.worldLayer.position.set(c.x, c.y);
    this.worldLayer.scale.set(c.scale);
    this.plane.scale.set(1, 1);
    this.planeInner.rotation = 0;
    this.iso.stand.visible = true;
    this.devices.visible = false;
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
    if (this.view === 'iso') { g.clear(); return; }
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
    const L = this.iso.level;
    const owned = Object.values(s.buildings).filter((b) => b.owned).map((b) => `${b.id}:${b.floors}`).join(',');
    const key = `${L}|${this.iso.focus}|${owned}|${JSON.stringify(f.tiles)}|${JSON.stringify(doorStates())}`;
    if (key === this.floorKey) return;
    this.floorKey = key;
    const g = this.floorG;
    g.clear();
    drawGround(g, s, L, (x, y) => tileAt(f, x, y), (x, gy) => {
      // a building cell: draw the storey's floor only if it is one of yours
      const b = buildingAt(s.buildings, x, gy);
      if (!b || !b.owned || b.id !== this.iso.focus || levelOf(gy) >= b.floors) return;
      const t = tileAt(f, x, gy);
      const c = floorTileColor(t);
      if (!c) return;
      const px = x * CELL, py = gy * CELL;
      g.rect(px, py, CELL, CELL).fill({ color: c.fill });
      g.rect(px + 0.5, py + 0.5, CELL - 1, CELL - 1).stroke({ width: 1, color: c.seam });
      if (c.dots !== undefined) for (const a of [12, 24, 36]) for (const bb of [12, 24, 36]) g.circle(px + a, py + bb, 1).fill({ color: c.dots, alpha: 0.8 });
      if (t === 'lift') {
        g.rect(px + 6, py + 6, CELL - 12, CELL - 12).stroke({ width: 2, color: 0x4d535b });
        g.moveTo(px + CELL / 2, py + 9).lineTo(px + CELL / 2, py + CELL - 9).stroke({ width: 1.5, color: 0x4d535b });
        g.poly([px + CELL / 2 - 5, py + 16, px + CELL / 2, py + 11, px + CELL / 2 + 5, py + 16]).fill({ color: 0xf0f0f0 });
        g.poly([px + CELL / 2 - 5, py + CELL - 16, px + CELL / 2, py + CELL - 11, px + CELL / 2 + 5, py + CELL - 16]).fill({ color: 0xf0f0f0 });
      }
    });
    this.iso.buildStatic(s, (x, y) => tileAt(f, x, y));
    this.lastDoorState = smartDoorsLocked(s);
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
      const [rx, ry] = (r.cells[0] ?? '0,0').split(',').map(Number) as [number, number];
      if (!this.iso.cellVisible(s, rx, ry)) continue;
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
      const lp = this.project(mx * CELL + 6, my * CELL + 6);
      lab.position.set(lp.x, lp.y - 3);
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
      // x, y are floor coordinates of the label point in the flat plan
      const lp = this.project(x, y);
      t.position.set(lp.x, lp.y - 30);
    };
    const iso = this.view === 'iso';
    for (const e of Object.values(s.staff.engineers)) {
      const x = e.x * CELL, y = e.y * CELL;
      if (e.away || !this.iso.cellVisible(s, Math.floor(e.x), Math.floor(e.y))) { const t = this.labelViews.get(e.id); if (t) t.visible = false; seen.add(e.id); continue; }
      g.roundRect((Math.floor(e.x) - 2) * CELL, (Math.floor(e.y) - 2) * CELL, CELL * 5, CELL * 5, 10)
        .fill({ color: COLORS.sight, alpha: 0.045 }).stroke({ width: 1, color: COLORS.sight, alpha: 0.16 });
      const seated = e.state === 'seated';
      const oy = seated ? 15 : 0;
      if (!iso) {
        g.ellipse(x, y + oy + 2, 8, 5).fill({ color: COLORS.carShadow, alpha: 0.14 });
        g.circle(x, y + oy, 7).fill({ color: COLORS.engineer }).stroke({ width: 1.5, color: COLORS.engineerDark });
        g.circle(x, y + oy - 1, 3.4).fill({ color: 0xf1d3b3 });
      }
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
      if (e.state === 'chasing' && !iso) g.circle(x, y, 10).stroke({ width: 2, color: COLORS.strangerRim, alpha: 0.7 });
      if (seated) { const t = this.labelViews.get(e.id); if (t) t.visible = false; seen.add(e.id); }
      else { label(e.id, e.name, x, y + oy - 10, COLORS.label); this.labelViews.get(e.id)!.visible = true; }
    }
    for (const t of Object.values(s.staff.trespassers)) {
      const x = t.x * CELL, y = t.y * CELL;
      if (!this.iso.cellVisible(s, Math.floor(t.x), Math.floor(t.y))) continue;
      if (!iso) {
        g.ellipse(x, y + 2, 8, 5).fill({ color: COLORS.carShadow, alpha: 0.18 });
        g.circle(x, y, 7).fill({ color: COLORS.stranger }).stroke({ width: 2, color: COLORS.strangerRim });
        g.circle(x, y - 1, 3).fill({ color: 0x55555e });
      }
      if (t.state === 'hacking') {
        const tgt = s.devices[t.targetId];
        const frac = t.progress / (10 * 20);
        if (tgt) g.rect(x - 10, y + 10, 20 * Math.min(1, frac), 3).fill({ color: COLORS.strangerRim });
      }
      label(t.id, t.spotted ? 'stranger!' : '?', x, y - 9, COLORS.strangerRim);
    }
    for (const v of Object.values(s.deals?.visitors ?? {})) {
      if (!this.iso.cellVisible(s, Math.floor(v.x), Math.floor(v.y))) continue;
      const x = v.x * CELL, y = v.y * CELL;
      if (v.state === 'waiting') {
        // a speech bubble: they want to talk to someone
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.005);
        g.roundRect(x - 12, y - 64, 24, 16, 6).fill({ color: 0xffffff, alpha: 0.95 }).stroke({ width: 1.5, color: COLORS.healthWarn, alpha: 0.6 + pulse * 0.4 });
        g.poly([x - 3, y - 48, x + 3, y - 48, x, y - 43]).fill({ color: 0xffffff });
        for (const dx of [-6, 0, 6]) g.circle(x + dx, y - 56, 1.8).fill({ color: 0x5b6168 });
      }
      label(v.id, v.name.split(' ')[0]!, x, y + 26, COLORS.label);
    }
    for (const [id, t] of this.labelViews) if (!seen.has(id)) { t.destroy(); this.labelViews.delete(id); }
  }

  private redrawWorld(): void {
    const f = focusOf(world.get(), ui.get());
    if (f !== this.iso.focus) { this.iso.focus = f; this.floorKey = ''; this.iso.clear(); }
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
        const label = new Container();
        root.addChild(icon);
        label.addChild(plate, name, sub);
        this.devices.addChild(root);
        this.deviceLabels.addChild(label);
        v = { kind: d.kind, root, label, icon, plate, name, sub };
        this.views.set(d.id, v);
        const show = s.camera.scale >= 0.45;
        name.visible = show;
        sub.visible = show;
        plate.visible = show;
      }
      v.root.position.set((d.gridPos.gx + 0.5) * CELL, (d.gridPos.gy + 0.5) * CELL);
      const vis = this.iso.cellVisible(s, d.gridPos.gx, d.gridPos.gy);
      v.root.visible = vis;
      v.label.visible = vis;
      const an = this.anchor(d);
      v.label.position.set(an.x, an.y);
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
        v.label.destroy({ children: true });
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
    if (this.view === 'iso') this.iso.syncDevices(s, u.selection?.type === 'device' ? u.selection.id : null, p.hoverDevice);
    const used = portUsage(s);
    const cableMode = u.tool.mode === 'cable';

    this.drawCables();

    // ports
    const pg = this.ports;
    pg.clear();
    for (const d of Object.values(s.devices)) {
      if (!this.iso.cellVisible(s, d.gridPos.gx, d.gridPos.gy)) continue;
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
      ghostOk = !deviceAtCell(s, ghostCell.gx, ghostCell.gy) && !placementError(s, u.tool.kind, ghostCell.gx, ghostCell.gy);
    } else if (p.dragGhost) {
      const d = s.devices[p.dragGhost.deviceId];
      if (d) {
        ghostKind = d.kind;
        ghostCell = p.dragGhost.cell;
        const other = deviceAtCell(s, ghostCell.gx, ghostCell.gy);
        ghostOk = (!other || other.id === d.id) && !placementError(s, d.kind, ghostCell.gx, ghostCell.gy);
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
  private cableDisplay = new Map<string, Vec2[]>();

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
    // spread shared runs into lanes and hop over crossings (display only)
    this.cableDisplay = layoutCables(Object.values(s.cables));
    for (const c of Object.values(s.cables)) {
      if (c.path.length < 2) continue;
      const pts = this.cableDisplay.get(c.id) ?? c.path;
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

  // ── Traffic streams ──────────────────────────────────────────────────────
  // Dashes slide along each cable in the direction traffic moves. They are
  // animated every frame in real time (not per sim tick), so they stay smooth
  // at 4×: speed only nudges the pace. Width follows volume, colour the kind.
  private streams: { pts: Vec2[]; mbps: number; color: number; attack: boolean }[] = [];
  private blocks: Vec2[] = [];
  private streamPhase = 0;
  private lastFrame = 0;

  /** Sum traffic per cable and direction. Cheap enough to run each sim tick. */
  private collectStreams(): void {
    const s = world.get();
    const agg = new Map<string, { cable: Cable; from: string; mbps: number; byKind: Map<FlowKind, number> }>();
    const blocks: Vec2[] = [];
    const add = (p: ResolvedPath, f: Flow, mbps: number) => {
      const end = p.blocked && p.blockedAt !== null ? p.blockedAt : p.hops.length - 1;
      for (let i = 0; i < end; i++) {
        const h = p.hops[i]!;
        const cable = h.cableId ? s.cables[h.cableId] : undefined;
        if (!cable || cable.path.length < 2) continue;
        const key = `${cable.id}>${h.deviceId}`;
        let e = agg.get(key);
        if (!e) { e = { cable, from: h.deviceId, mbps: 0, byKind: new Map() }; agg.set(key, e); }
        e.mbps += mbps;
        e.byKind.set(f.kind, (e.byKind.get(f.kind) ?? 0) + mbps);
      }
      if (p.blocked && p.blockedAt !== null) {
        const d = s.devices[p.hops[p.blockedAt]?.deviceId ?? ''];
        if (d) blocks.push({ x: (d.gridPos.gx + 0.5) * CELL, y: (d.gridPos.gy + 0.5) * CELL });
      }
    };
    for (const f of Object.values(s.flows)) {
      const p = runtime.paths[f.id];
      if (!p || p.hops.length < 2) continue;
      const mbps = Math.max(0.1, f.rateMbps);
      const sh = flowShape(s, f);
      const both = !p.blocked && p.ret && !p.ret.blocked;
      add(p, f, both ? mbps * sh.req : mbps);
      if (both) add(p.ret!, f, mbps * sh.resp);
    }
    this.streams = [];
    // two directions on one cable run side by side
    const both = new Set<string>();
    for (const e of agg.values()) {
      const other = e.cable.a.deviceId === e.from ? e.cable.b.deviceId : e.cable.a.deviceId;
      if (agg.has(`${e.cable.id}>${other}`)) both.add(e.cable.id);
    }
    for (const e of agg.values()) {
      let kind: FlowKind = 'http', best = -1;
      if (e.byKind.has('attack')) kind = 'attack';
      else for (const [k, v] of e.byKind) if (v > best) { kind = k; best = v; }
      const shown = this.cableDisplay.get(e.cable.id) ?? e.cable.path;
      let pts = e.cable.a.deviceId === e.from ? shown : [...shown].reverse();
      if (both.has(e.cable.id)) pts = offsetPath(pts, 2.2);
      this.streams.push({ pts, mbps: e.mbps, color: this.kindColor(kind), attack: kind === 'attack' });
    }
    this.blocks = blocks;
  }

  private kindColor(k: FlowKind): number {
    return k === 'attack' ? COLORS.carrierAttack : k === 'probe' ? COLORS.healthWarn
      : k === 'control' ? COLORS.carrierControl : k === 'backup' ? COLORS.carrierBackup : k === 'backend' || k === 'proxied' ? COLORS.carrierBackend
      : k === 'transit' ? COLORS.carrierTransit : COLORS.carrierNormal;
  }

  /** Per-frame: draw the dash streams at the current phase. */
  private drawStreams(now: number): void {
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    const speed = world.get().speed;
    this.streamPhase += dt * (speed > 0 ? 46 * Math.sqrt(speed) : 0);
    const cg = this.carriers;
    cg.clear();
    const DASH = 4.5, PERIOD = 22;
    for (const st of this.streams) {
      const w = Math.min(3.6, 1.5 + Math.log2(1 + st.mbps) * 0.26);
      const phase = (this.streamPhase * (st.attack ? 1.6 : 1)) % PERIOD;
      let walked = 0;
      for (let i = 0; i < st.pts.length - 1; i++) {
        const a = st.pts[i]!, b = st.pts[i + 1]!;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 0.01) continue;
        const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
        // dash k covers [k*PERIOD + phase, +DASH] in path distance
        let k = Math.floor((walked - phase) / PERIOD);
        for (;;) {
          const d0 = k * PERIOD + phase - walked, d1 = d0 + DASH;
          if (d0 >= len) break;
          const t0 = Math.max(0, d0), t1 = Math.min(len, d1);
          if (t1 > t0) cg.moveTo(a.x + ux * t0, a.y + uy * t0).lineTo(a.x + ux * t1, a.y + uy * t1);
          k++;
        }
        walked += len;
      }
      cg.stroke({ width: w, color: st.color, alpha: 0.9, cap: 'round' });
    }
    if (this.blocks.length) {
      const pulse = (now % 900) / 900;
      for (const p of this.blocks) {
        cg.circle(p.x, p.y, 10 + pulse * 16).stroke({ width: 2, color: COLORS.carrierAttack, alpha: (1 - pulse) * 0.8 });
      }
    }
  }

  /** Redraw health badges and sim-driven layers — called every sim tick. */
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
    this.collectStreams();

    // Health badges: colored indicators on degraded/failed devices
    const hg = this.healthBadges;
    hg.clear();
    for (const d of Object.values(s.devices)) {
      if (!this.iso.cellVisible(s, d.gridPos.gx, d.gridPos.gy)) continue;
      const an = this.anchor(d);
      const bx = an.x - BODY / 2 + 4;
      const by = an.top + 4;
      if (d.compromised) {
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.006);
        if (true) hg.ellipse(an.x, an.y + BODY / 2, BODY * 0.7, BODY * 0.3).stroke({ width: 2, color: COLORS.strangerRim, alpha: 0.4 + 0.5 * pulse });
        else hg.roundRect(bx - 8, by - 8, BODY + 8, BODY + 8, 8).stroke({ width: 2, color: COLORS.strangerRim, alpha: 0.4 + 0.5 * pulse });
        hg.circle(bx, by, 6).fill({ color: COLORS.strangerRim });
        hg.moveTo(bx - 3, by - 3).lineTo(bx + 3, by + 3).moveTo(bx + 3, by - 3).lineTo(bx - 3, by + 3).stroke({ width: 1.8, color: COLORS.plate });
      } else if (d.sw && d.sw.patch < s.staff.release) {
        const ty = by;
        hg.circle(bx, ty, 5).fill({ color: COLORS.plate, alpha: 0.95 });
        hg.poly([bx, ty - 4, bx + 3.5, ty + 1, bx - 3.5, ty + 1]).fill({ color: COLORS.healthWarn });
      }
      // only what someone knows about gets a badge
      const keys = Object.keys(s.known ?? {}).filter((k) => k.startsWith(d.id + ':'));
      const repairing = d.health.state === 'repairing';
      if (!keys.length && !repairing) continue;
      const alert = keys.some((k) => !k.includes(':w:') && !k.endsWith(':wear') && !k.endsWith(':warm'));
      const cx = an.x + BODY / 2 - 4;
      const cy = an.top + 4;
      const color = repairing ? COLORS.carrierNormal : alert ? COLORS.healthBad : COLORS.healthWarn;
      hg.circle(cx, cy, 6).fill({ color: COLORS.plate, alpha: 0.95 });
      hg.circle(cx, cy, 5).fill({ color });
      if (alert && !repairing) {
        const pulse = 0.3 + 0.3 * Math.sin(Date.now() * 0.005);
        hg.circle(cx, cy, 8 + pulse * 4).stroke({ width: 1.5, color, alpha: 0.6 - pulse * 0.6 });
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
