// Pointer, touch and keyboard handling. One finger / left mouse: tap acts on
// the current tool, drag pans (or moves the selected device). Two fingers:
// pinch-zoom + pan. Wheel: zoom at cursor. Middle mouse: pan.
import { redo, undo } from './state/undo';
import { CITY_H, CITY_W, STRIDE, levelOf } from './state/city';
import { BODY, CELL, ZOOM_MAX, ZOOM_MIN } from './balance';
import { distToPolyline, nearestFreePort, portAtPoint, portPos, freePorts } from './state/geometry';
import type { Camera, Vec2 } from './state/types';
import {
  connect, deleteCable, deleteDevice, deviceAtCell, moveDevice, paintTile, placeDevice, pointer, rotateDevice,
  select, setTool, toast, ui, world,
} from './state/world';
import type { Renderer } from './render/renderer';

const TAP_SLOP = 7; // px of movement before a press becomes a drag

type Gesture =
  | { kind: 'none' }
  | { kind: 'press'; x: number; y: number; deviceId: string | null; mouseButton: number }
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'move'; deviceId: string }
  | { kind: 'paint'; last: string; errored: boolean }
  | { kind: 'pinch'; d0: number; mid0: Vec2; cam0: Camera };

export function setCamera(cam: Camera): void {
  // keep the middle of the screen over the city, on the storey on show
  const cv = document.querySelector('#stage canvas') as HTMLCanvasElement | null;
  const w = cv?.clientWidth ?? 1000, h = cv?.clientHeight ?? 700;
  const lvl = ui.get().level ?? 0;
  const mx = (w / 2 - cam.x) / cam.scale, my = (h / 2 - cam.y) / cam.scale;
  const x0 = -4 * CELL, x1 = (CITY_W + 4) * CELL, y0 = (lvl * STRIDE - 4) * CELL, y1 = (lvl * STRIDE + CITY_H + 4) * CELL;
  const cx = Math.min(x1, Math.max(x0, mx)), cy = Math.min(y1, Math.max(y0, my));
  const c = { scale: cam.scale, x: w / 2 - cx * cam.scale, y: h / 2 - cy * cam.scale };
  world.update((wd) => { wd.camera = c; }, 'camera');
}

export function zoomAt(sx: number, sy: number, factor: number): void {
  const c = world.get().camera;
  const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, c.scale * factor));
  const wx = (sx - c.x) / c.scale;
  const wy = (sy - c.y) / c.scale;
  setCamera({ scale, x: sx - wx * scale, y: sy - wy * scale });
}

export function fitView(r: Renderer): void {
  const lvl = r.level;
  const devs = Object.values(world.get().devices).filter((d) => levelOf(d.gridPos.gy) === lvl);
  const { w, h } = r.screenSize;
  const margin = Math.min(80, Math.max(20, w * 0.06));
  if (devs.length === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of devs) {
    for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const p = r.project((d.gridPos.gx + cx) * CELL, (d.gridPos.gy + cy) * CELL);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y - (r.isIso ? 40 : 0)); maxY = Math.max(maxY, p.y + 24);
    }
  }
  const bw = Math.max(maxX - minX, CELL * 6);
  const bh = Math.max(maxY - minY, CELL * 4);
  const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min((w - margin * 2) / bw, (h - margin * 2) / bh, 1.6)));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  setCamera({ scale, x: w / 2 - cx * scale, y: h / 2 - cy * scale });
}

/** On phones the panel is a bottom sheet; slide the camera so the selected device stays above it. */
export function keepSelectionVisible(r: Renderer): void {
  let last: string | null = null;
  ui.subscribe((u) => {
    const sel = u.selection?.type === 'device' ? u.selection.id : null;
    if (sel === last) return;
    last = sel;
    const { w, h } = r.screenSize;
    if (!sel || w >= 760) return;
    const d = world.get().devices[sel];
    if (!d) return;
    const c = world.get().camera;
    const sy = r.project((d.gridPos.gx + 0.5) * CELL, (d.gridPos.gy + 0.5) * CELL).y * c.scale + c.y;
    const sheetTop = h * 0.36;
    if (sy > sheetTop - 30) setCamera({ ...c, y: c.y - (sy - h * 0.2) });
  });
}

export function attachInput(r: Renderer, isUiBusy: () => boolean): void {
  const canvas = r.canvas;
  const pointers = new Map<number, Vec2>();
  const devAt = (sp: Vec2, cell: { gx: number; gy: number }) => {
    const id = r.pickDevice(sp.x, sp.y);
    return (id ? world.get().devices[id] : undefined) ?? deviceAtCell(world.get(), cell.gx, cell.gy);
  };
  let gesture: Gesture = { kind: 'none' };

  const local = (e: PointerEvent | WheelEvent): Vec2 => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const cellOf = (wpt: Vec2) => ({ gx: Math.floor(wpt.x / CELL), gy: Math.floor(wpt.y / CELL) });

  const updateHover = (sp: Vec2 | null) => {
    if (!sp) {
      pointer.update((p) => { p.hoverCell = null; p.hoverDevice = null; p.pointerWorld = null; }, 'ui');
      return;
    }
    const wpt = r.screenToWorld(sp.x, sp.y);
    const cell = cellOf(wpt);
    const dev = devAt(sp, cell);
    pointer.update((p) => {
      p.pointerWorld = wpt;
      p.hoverCell = cell;
      p.hoverDevice = dev?.id ?? null;
    }, 'ui');
  };

  const onTap = (sp: Vec2) => {
    const s = world.get();
    const u = ui.get();
    const wpt = r.screenToWorld(sp.x, sp.y);
    const cell = cellOf(wpt);
    const dev = u.tool.mode === 'place' ? deviceAtCell(s, cell.gx, cell.gy) : devAt(sp, cell);
    switch (u.tool.mode) {
      case 'place': {
        placeDevice(u.tool.kind, cell, u.tool.access, !!u.tool.stack);
        return;
      }
      case 'select': {
        if (dev) return select({ type: 'device', id: dev.id });
        const tol = 8 / s.camera.scale;
        let best: string | null = null;
        let bestD = tol;
        for (const c of Object.values(s.cables)) {
          const d = distToPolyline(wpt, c.path);
          if (d <= bestD) { bestD = d; best = c.id; }
        }
        return select(best ? { type: 'cable', id: best } : null);
      }
      case 'cable': {
        if (!dev) {
          if (u.pendingCable) ui.update((x) => { x.pendingCable = null; }, 'ui');
          return;
        }
        // near a port dot picks that port; the middle of the device leaves the choice to auto-pick
        const radius = Math.min(BODY * 0.35, Math.max(BODY * 0.22, 12 / s.camera.scale));
        const explicit = portAtPoint(dev, wpt, radius);
        if (explicit !== null && freePorts(s, dev).indexOf(explicit) === -1) {
          toast(`${dev.name} ${dev.ports[explicit]!.label} already has a cable.`, 'error');
          return;
        }
        if (!u.pendingCable) {
          if (freePorts(s, dev).length === 0) {
            toast(`${dev.name} has no free ports.`, 'error');
            return;
          }
          ui.update((x) => {
            x.pendingCable = { deviceId: dev.id, port: explicit ?? 0, explicit: explicit !== null };
          }, 'ui');
          return;
        }
        const pend = u.pendingCable;
        const devA = s.devices[pend.deviceId];
        if (!devA) return;
        if (devA.id === dev.id) {
          ui.update((x) => { x.pendingCable = null; }, 'ui');
          return;
        }
        // pick B's port: the one tapped, or the free one nearest A
        const aRef = pend.explicit ? portPos(devA, pend.port) : { x: (devA.gridPos.gx + 0.5) * CELL, y: (devA.gridPos.gy + 0.5) * CELL };
        const portB = explicit ?? nearestFreePort(s, dev, aRef);
        if (portB === null) {
          toast(`${dev.name} has no free ports.`, 'error');
          return;
        }
        const portA = pend.explicit ? pend.port : nearestFreePort(s, devA, portPos(dev, portB));
        if (portA === null) {
          toast(`${devA.name} has no free ports.`, 'error');
          return;
        }
        const id = connect({ deviceId: devA.id, port: portA }, { deviceId: dev.id, port: portB }, u.cableType);
        ui.update((x) => { x.pendingCable = null; }, 'ui');
        if (id) toast(`Connected ${devA.name} ${devA.ports[portA]!.label} → ${dev.name} ${dev.ports[portB]!.label}`);
        return;
      }
    }
  };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const sp = local(e);
    pointers.set(e.pointerId, sp);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()] as [Vec2, Vec2];
      pointer.update((p) => { p.dragGhost = null; }, 'ui');
      gesture = {
        kind: 'pinch',
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        cam0: { ...world.get().camera },
      };
      return;
    }
    if (pointers.size > 2) return;
    if (e.pointerType === 'mouse' && e.button === 1) {
      e.preventDefault();
      gesture = { kind: 'pan', lastX: sp.x, lastY: sp.y };
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const wpt = r.screenToWorld(sp.x, sp.y);
    const cell = cellOf(wpt);
    const tool = ui.get().tool;
    if (tool.mode === 'build') {
      const err = paintTile(cell.gx, cell.gy, tool.tile);
      if (err) toast(err, 'error');
      gesture = { kind: 'paint', last: `${cell.gx},${cell.gy}`, errored: !!err };
      return;
    }
    const dev = devAt(sp, cell);
    gesture = { kind: 'press', x: sp.x, y: sp.y, deviceId: dev?.id ?? null, mouseButton: e.button };
  });

  canvas.addEventListener('pointermove', (e) => {
    const sp = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, sp);

    if (gesture.kind === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()] as [Vec2, Vec2];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const g = gesture;
      const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, g.cam0.scale * (d / g.d0)));
      // keep the world point under the starting midpoint under the current midpoint
      const wx = (g.mid0.x - g.cam0.x) / g.cam0.scale;
      const wy = (g.mid0.y - g.cam0.y) / g.cam0.scale;
      setCamera({ scale, x: mid.x - wx * scale, y: mid.y - wy * scale });
      return;
    }

    if (gesture.kind === 'paint') {
      const tool = ui.get().tool;
      const cell = cellOf(r.screenToWorld(sp.x, sp.y));
      const k = `${cell.gx},${cell.gy}`;
      if (tool.mode === 'build' && k !== gesture.last) {
        gesture.last = k;
        const err = paintTile(cell.gx, cell.gy, tool.tile);
        if (err && !gesture.errored) { toast(err, 'error'); gesture.errored = true; }
      }
      updateHover(sp);
      return;
    }
    if (gesture.kind === 'press') {
      if (Math.hypot(sp.x - gesture.x, sp.y - gesture.y) > TAP_SLOP) {
        const u = ui.get();
        const canMove = gesture.deviceId && u.tool.mode === 'select';
        if (canMove) {
          select({ type: 'device', id: gesture.deviceId! });
          gesture = { kind: 'move', deviceId: gesture.deviceId! };
        } else {
          gesture = { kind: 'pan', lastX: gesture.x, lastY: gesture.y };
        }
      }
    }

    if (gesture.kind === 'pan') {
      const c = world.get().camera;
      setCamera({ ...c, x: c.x + (sp.x - gesture.lastX), y: c.y + (sp.y - gesture.lastY) });
      gesture.lastX = sp.x;
      gesture.lastY = sp.y;
    } else if (gesture.kind === 'move') {
      const id = gesture.deviceId;
      const cell = cellOf(r.screenToWorld(sp.x, sp.y));
      pointer.update((p) => { p.dragGhost = { deviceId: id, cell }; }, 'ui');
    }

    // hover (mouse) and rubber-band target (any pointer while a cable is pending)
    if (e.pointerType === 'mouse' || ui.get().pendingCable) updateHover(sp);
  });

  const end = (e: PointerEvent) => {
    const had = pointers.delete(e.pointerId);
    if (!had) return;
    const sp = local(e);
    if (gesture.kind === 'press') {
      onTap(sp);
    } else if (gesture.kind === 'move') {
      const ghost = pointer.get().dragGhost;
      if (ghost) moveDevice(ghost.deviceId, ghost.cell);
      pointer.update((p) => { p.dragGhost = null; }, 'ui');
    }
    if (gesture.kind === 'pinch') {
      // the remaining finger continues as a pan without a jump
      const rest = [...pointers.values()][0];
      gesture = rest ? { kind: 'pan', lastX: rest.x, lastY: rest.y } : { kind: 'none' };
      return;
    }
    if (pointers.size === 0) gesture = { kind: 'none' };
    if (e.pointerType !== 'mouse' && !ui.get().pendingCable) updateHover(null);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    pointer.update((p) => { p.dragGhost = null; }, 'ui');
    gesture = { kind: 'none' };
  });
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && !pointers.size) updateHover(null);
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const sp = local(e);
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(sp.x, sp.y, Math.exp(-delta * 0.0015));
  }, { passive: false });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    if (isUiBusy()) return; // typing in a panel field
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      doUndo(e.key === 'y' || e.key === 'Y' || e.shiftKey);
      return;
    }
    const u = ui.get();
    if (e.key === 'Escape') {
      if (u.pendingCable) ui.update((x) => { x.pendingCable = null; }, 'ui');
      else if (u.tool.mode !== 'select') setTool({ mode: 'select' });
      else select(null);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && u.selection) {
      e.preventDefault();
      if (u.selection.type === 'device') deleteDevice(u.selection.id);
      else deleteCable(u.selection.id);
      return;
    }
    if ((e.key === 'r' || e.key === 'R') && u.selection?.type === 'device') {
      rotateDevice(u.selection.id);
      return;
    }
    if (e.key === 'f' || e.key === 'F') fitView(r);
    // Speed controls: space = toggle pause, 1-3 = speed presets
    if (e.key === ' ') {
      e.preventDefault();
      const spd = world.get().speed;
      world.update((w) => { w.speed = spd === 0 ? 1 : 0; }, 'world');
      return;
    }
    if (e.key === '1') { world.update((w) => { w.speed = 1; }, 'world'); return; }
    if (e.key === '2') { world.update((w) => { w.speed = 2; }, 'world'); return; }
    if (e.key === '3') { world.update((w) => { w.speed = 4; }, 'world'); return; }
  });
}

/** Undo or redo one change, and say what it did to the money. */
export function doUndo(again: boolean): void {
  const r = again ? redo() : undo();
  if (!r.ok) { toast(again ? 'Nothing to redo.' : 'Nothing to undo.'); return; }
  const sel = ui.get().selection;
  if (sel && (sel.type === 'device' ? !world.get().devices[sel.id] : !world.get().cables[sel.id])) ui.update((x) => { x.selection = null; }, 'ui');
  const m = Math.round(r.money);
  toast(`${again ? 'Redone' : 'Undone'}${m > 0 ? ` · $${m} back` : m < 0 ? ` · $${-m} spent again` : ''}.`);
}
