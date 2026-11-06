// Config panel for the selected device or cable — plain DOM custom element.
//
// Rendering model (fixes the Phase 2 panel that rebuilt itself 20× a second):
//   • a structural render happens only when the selection, the device config
//     or a meaningful sim state (health state, unlocks, leases…) changes;
//   • numbers that move every tick are patched in place by "live" updaters;
//   • focus, caret, typed-but-uncommitted text and scroll survive re-renders;
//   • while an input has focus, sim-driven re-renders wait for blur.
import {
  ACCESS, AC_COOLING_KW, CABLE_BANDWIDTH, CELL, MEDIA_SWAP_PRICE, OVERHEAT_C, CPU_PARTS, DISK_PARTS, DISK_TYPES, GPU_PARTS, NIC_PARTS, RAM_PARTS, MON_AGENT_PORT, ROLES, SNMP_PORT, TICKS_PER_SEC, UPLINK_TIER,
  CERT_BONUS, CERT_PRICE, CERT_UPKEEP, CHASSIS, DEVICE_WATTS, PSU2_PRICE, RAID, SHUTDOWN_C, TEMP_CAP_RANGE, THROTTLE_C,
  type PartGate, LEASED_LINE, MULTI_ROLES } from '../balance';
import { GATE_NAME, gateOpen, partsProblem, peakWatts, roleBlocker, roleUse, serverCaps, swapCost } from '../state/hardware';
import { compName, OFF_LABEL, serverDown, serverPower, wattsOf } from '../sim/hw';
import { isMonitored, knownProblems } from '../sim/monitor';
import { deskReaches, engineerActivity } from '../sim/staff';
import { buildCtx } from '../sim/net';
import { heatOf, roomTemp } from '../sim/climate';
import { ACHIEVEMENTS } from '../progress';
import {
  backupOk, chain, visitorPort, deviceCapacity, endpointsOf, serviceProblem, towerPenalty, towerRevenue, failoverReady, FAULT_LABEL, isVulnerable, orderReimage, orderUpdate, priceOf, repairOptions,
  serviceRevenue, startRepair, upkeepOf, compCost, hotSwap, latencyFactor, orderInspect, orderSwap,
} from '../sim/engine';
import { REASON_LABEL } from '../sim/net';
import { DEVICE_DEFS } from '../state/devices';
import { portSide, portUsage } from '../state/geometry';
import { addrText, formatCidr, parseAddr, parseCidr, subnetOf } from '../state/ip';
import {
  assertNever, type ServerRole, type Cable, type CableType, type Device, type DeviceOf, type FirewallDevice, type FwAction,
  type DiskType, type FwProtocol, type Media, type PartSlot, type RaidLevel, type ServerParts, type ResolvedPath, type RoleKind, type RouterDevice, type Unlocks, type WorldState,
} from '../state/types';
import {
  type Check, checkCidr, checkIp, checkPorts, duplicateCheck, l3Subnets, natCheck, nextHopCheck,
  overlapCheck, serverGatewayCheck, checkAddr,
} from '../state/validate';
import {
  addRole, allFqdns, buyBiggerBlock, moveToFloor, nextBlockUpgrade, editRole, setRoleLinks, setPortMedia, setServiceFqdn, buyPart, deleteCable, deleteDevice, editDevice, genId, publicIps, removeRole, rotateDevice, runtime,
  select, setCableType, setServicePublicIp, setUplinkTier, toast, ui, world, cancelUpgrade, onBench, pendingParts, setCert, leaseLine, setRolePort, roleKey } from '../state/world';
import { cableGlyph, kindCss, kindGlyph } from './glyphs';
import { baseStyle } from './styles';
import { buildingAt, levelOf } from '../state/city';
import { onThemeChange } from './theme';

const SIDE_NAME = { N: 'top', E: 'right', S: 'bottom', W: 'left' } as const;

const UNLOCK_SOURCE: Partial<Record<keyof Unlocks, string>> = {};
for (const a of ACHIEVEMENTS) for (const u of a.unlocks ?? []) UNLOCK_SOURCE[u] = a.title;
const lockedMsg = (u: keyof Unlocks) => `Locked. Earn “${UNLOCK_SOURCE[u] ?? '?'}” in Goals to unlock.`;

const INSPECTOR_CSS = `
  :host {
    position: absolute; z-index: 20; display: flex; flex-direction: column;
    top: 14px; right: max(14px, env(safe-area-inset-right, 0px)); bottom: 14px; width: 400px;
    background: var(--paper); border-radius: var(--radius);
    box-shadow: var(--shadow-lg); overflow: hidden;
  }
  :host([hidden]) { display: none; }
  header {
    display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center;
    padding: 14px 14px 12px; border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg, color-mix(in srgb, var(--kind, var(--accent)) 10%, var(--paper)), var(--paper));
    box-shadow: inset 0 4px 0 var(--kind, var(--accent)); flex: none;
  }
  header .titles { display: grid; gap: 3px; min-width: 0; }
  header input {
    font-family: var(--font-body); font-size: 16px; font-weight: 700; background: transparent;
    border-color: transparent; padding: 3px 5px; margin-left: -5px;
  }
  header input:hover { border-color: var(--line); }
  header strong { font-size: 13px; overflow-wrap: anywhere; }
  .close { min-height: 32px; width: 34px; padding: 0; font-size: 18px; line-height: 1; }
  .body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 16px 16px; background: var(--well-soft); display: grid; gap: 4px; align-content: start; }
  section { display: grid; gap: 10px; padding: 14px; margin-top: 12px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); box-shadow: var(--shadow-sm); min-width: 0; }
  .body.enter section { animation: secIn .22s ease-out both; }
  .body.enter section:nth-child(2) { animation-delay: .03s; } .body.enter section:nth-child(3) { animation-delay: .06s; } .body.enter section:nth-child(4) { animation-delay: .09s; } .body.enter section:nth-child(n+5) { animation-delay: .12s; }
  @keyframes secIn { from { opacity: 0; transform: translateY(6px); } }
  .ptabs { display: flex; gap: 2px; margin: 10px 16px 0; padding: 3px; border-radius: 10px; background: var(--well); flex: none; }
  .ptabs button { flex: 1; border: 0; background: transparent; min-height: 32px; font-size: 13px; }
  .ptabs button:hover { background: var(--paper); }
  .ptabs button[aria-selected="true"] { background: var(--paper); color: var(--accent); box-shadow: var(--shadow-sm); }
  .pbadge { display: inline-block; min-width: 18px; margin-left: 6px; padding: 0 5px; border-radius: 999px; background: var(--bad); color: #fff; font-size: 11px; }
  h3 {
    margin: 0; font-family: var(--font-body); font-size: 12px; font-weight: 800;
    letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink);
    display: flex; justify-content: space-between; align-items: center; gap: 8px;
  }
  .field { display: grid; grid-template-columns: 86px minmax(0, 1fr); align-items: center; gap: 4px 10px; }
  .field > span:first-child { font-size: 12px; color: var(--ink-dim); }
  .msg { grid-column: 2; font-size: 11.5px; line-height: 1.35; }
  .msg.bad, .bad-t { color: var(--bad); }
  .msg.warn, .warn-t { color: var(--warn); }
  .msg.hint { color: var(--ink-faint); }
  .ok-t { color: var(--ok); }
  .kv { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 5px 10px; font-size: 12px; margin: 0; }
  .kv dt { color: var(--ink-dim); }
  .kv dd { margin: 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; min-width: 0; overflow-wrap: anywhere; }
  .ports { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .ports li { display: grid; grid-template-columns: 60px minmax(0, 1fr) 44px 74px; gap: 8px; font-size: 12px; align-items: center; }
  .pl { font-family: var(--font-mono); font-size: 12px; }
  .free { color: var(--ink-faint); }
  .linked { color: var(--ok); overflow-wrap: anywhere; }
  .side { font-family: var(--font-mono); font-size: 10.5px; color: var(--ink-faint); }
  .card { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--well-soft); min-width: 0; }
  .row { display: grid; gap: 6px; align-items: center; min-width: 0; }
  .if-row { grid-template-columns: 50px minmax(0, 1fr); }
  .rt-row { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) 46px 28px; }
  .nat-row { grid-template-columns: minmax(0, 1fr) 14px minmax(0, 1fr) 28px; }
  .nat-row .arrow, .natp-row .arrow { color: var(--ink-faint); text-align: center; }
  .natp-row { grid-template-columns: minmax(0, 1fr) 14px minmax(0, 1fr) 92px 28px; }
  .pat-row { grid-template-columns: minmax(0, 1fr) 14px minmax(0, 1fr) 28px; }
  .pat-row .arrow { color: var(--ink-faint); text-align: center; }
  .vlan-row { grid-template-columns: 76px 92px minmax(0, 1fr); }
  .subif-row { grid-template-columns: minmax(0, 1fr) 90px 28px; }
  .subif-row2 { grid-template-columns: minmax(0, 1fr) 70px; }
  .vpn-row { grid-template-columns: minmax(0, 1fr) auto 28px; }
  .vpn-row2 { grid-template-columns: minmax(0, 1fr) 18px minmax(0, 1fr); }
  .vpn-row2 .arrow { color: var(--ink-faint); text-align: center; }
  .mt-row { grid-template-columns: minmax(0, 1fr) 150px 28px; }
  .px-card { gap: 6px; }
  .px-head { grid-template-columns: minmax(0, 1fr) 28px; }
  .px-be { grid-template-columns: 22px minmax(0, 1fr) 28px; }
  .px-n { font-family: var(--font-mono); font-size: 11px; font-weight: 600; color: var(--ink-faint); text-align: center; }
  .px-foot { grid-template-columns: minmax(0, 1fr); justify-items: start; gap: 4px; }
  .fw-row1 { grid-template-columns: 26px 82px 68px minmax(0, 1fr) 28px 28px 28px; }
  .fw-row2 { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .fw-row3 { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1.2fr) minmax(0, 0.8fr); }
  .fw-if-row { grid-template-columns: 62px 44px minmax(0, 1fr); }
  .rl-row { grid-template-columns: minmax(0, 1.4fr) 74px 92px 28px; }
  .uf-row { grid-template-columns: minmax(0, 1fr) auto 28px; }
  .num { font-family: var(--font-mono); font-size: 12px; color: var(--ink-faint); }
  .sub { font-size: 10.5px; color: var(--ink-faint); font-family: var(--font-mono); }
  .icon-btn { min-height: 28px; width: 28px; padding: 0; font-size: 13px; }
  .lbl { font-size: 10.5px; color: var(--ink-faint); font-family: var(--font-mono); }
  .msgs { display: grid; gap: 2px; font-size: 11.5px; }
  .msgs .bad { color: var(--bad); } .msgs .warn { color: var(--warn); } .msgs .hint { color: var(--ink-faint); }
  .derived { font-family: var(--font-mono); font-size: 12px; color: var(--ink-dim); display: grid; gap: 3px; }
  .note { font-size: 12px; color: var(--ink-faint); line-height: 1.45; margin: 0; }
  .locked { font-size: 12px; color: var(--ink-faint); line-height: 1.45; margin: 0; padding: 8px 10px; background: var(--well); border-radius: 8px; }
  .add { justify-self: start; font-size: 12px; }
  .seg { display: flex; gap: 2px; flex-wrap: wrap; padding: 3px; background: var(--well); border-radius: 10px; }
  .seg button { font-size: 12px; min-height: 30px; border: 0; background: transparent; }
  .seg button[aria-pressed="true"] { background: var(--paper); color: var(--accent); box-shadow: var(--shadow-sm); }
  .bar { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; }
  .bar i { display: block; height: 100%; width: 0; background: var(--ok); border-radius: 3px; transition: width .25s; }
  .meter { display: grid; grid-template-columns: 66px minmax(0, 1fr) 92px; gap: 8px; align-items: center; font-size: 12px; }
  .meter .v { font-family: var(--font-mono); font-size: 11.5px; text-align: right; color: var(--ink-dim); font-variant-numeric: tabular-nums; }
  .repairs { display: grid; gap: 6px; }
  .repairs button { display: grid; grid-template-columns: minmax(0, 1fr) auto; text-align: left; gap: 2px 8px; }
  .repairs button small { grid-column: 1 / -1; color: var(--ink-faint); font-size: 11px; }
  .repairs button:disabled { opacity: .45; cursor: not-allowed; }
  .trace { display: grid; gap: 2px; font-size: 11.5px; line-height: 1.4; margin: 0; padding: 0; list-style: none; }
  .trace li { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 6px; }
  .trace .dir { color: var(--ink-faint); font-family: var(--font-mono); }
  .trace b { font-weight: 600; color: var(--ink); }
  .trace .stop { color: var(--bad); }
  .explain { font-size: 12.5px; line-height: 1.5; padding: 9px 12px; border-radius: 10px; border: 0; background: var(--well); }
  .explain.ok { background: var(--ok-soft); color: var(--ok); }
  .explain.bad { background: var(--bad-soft); color: var(--bad); }
  .explain.warn { background: var(--warn-soft); color: var(--warn); }
  .explain + .explain, .explain + button { margin-top: 4px; }
  table.talk { width: 100%; border-collapse: collapse; font-size: 11.5px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; table-layout: fixed; }
  table.talk th { text-align: left; font-weight: 500; color: var(--ink-faint); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; padding: 2px 4px; }
  table.talk td { padding: 3px 4px; border-top: 1px solid var(--line); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  table.talk td.r, table.talk th.r { text-align: right; }
  tr.attack td:first-child { color: var(--bad); }
  tr.probe td:first-child { color: var(--warn); }
  .hits { font-family: var(--font-mono); font-size: 10.5px; color: var(--ink-faint); }
  .hits.on { color: var(--accent); }
  .logs { display: grid; gap: 3px; font-size: 11.5px; line-height: 1.35; }
  .logs .warn { color: var(--warn); } .logs .alert { color: var(--bad); }
  footer { display: flex; gap: 8px; background: var(--well-soft); padding: 12px 16px calc(10px + env(safe-area-inset-bottom, 0px)); border-top: 1px solid var(--line); flex: none; }
  footer .grow { flex: 1; }
  label.check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-dim); }
  label.check input { width: auto; min-height: 0; }
  .glyph { display: flex; align-items: center; }
  @media (max-width: 759px) {
    :host {
      top: auto; left: 0; right: 0; bottom: 0; width: auto; max-height: 64%;
      border-radius: 16px 16px 0 0;
      padding-left: env(safe-area-inset-left, 0px); padding-right: env(safe-area-inset-right, 0px);
    }
    footer { padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px)); }
  }
`;

// ---------- DOM helpers ----------

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function btn(label: string, onClick: () => void, cls = '', title = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (cls) b.className = cls;
  if (title) { b.title = title; b.setAttribute('aria-label', title); }
  b.addEventListener('click', onClick);
  return b;
}

function makeInput(id: string, value: string, opts: {
  placeholder?: string; readonly?: boolean; ariaLabel?: string; check?: Check; onCommit?: (v: string) => void;
}): HTMLInputElement {
  const inp = document.createElement('input');
  inp.id = id;
  inp.value = value;
  inp.spellcheck = false;
  inp.autocomplete = 'off';
  if (opts.placeholder) inp.placeholder = opts.placeholder;
  if (opts.readonly) inp.readOnly = true;
  if (opts.ariaLabel) inp.setAttribute('aria-label', opts.ariaLabel);
  if (opts.check && opts.check.level !== 'hint') inp.className = opts.check.level;
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = value; inp.blur(); } });
  if (opts.onCommit) inp.addEventListener('change', () => opts.onCommit!(inp.value.trim()));
  return inp;
}

function makeField(label: string, value: string, opts: {
  id: string; placeholder?: string; readonly?: boolean; check?: Check; onCommit?: (v: string) => void;
}): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  wrap.appendChild(el('span', undefined, label));
  wrap.appendChild(makeInput(opts.id, value, opts));
  if (opts.check) wrap.appendChild(el('span', `msg ${opts.check.level}`, opts.check.msg));
  return wrap;
}

function makeMsgs(checks: Check[], showHints = false): HTMLElement | null {
  const shown = checks.filter((c): c is NonNullable<Check> => !!c && (showHints || c.level !== 'hint'));
  if (!shown.length) return null;
  const div = el('div', 'msgs');
  for (const c of shown) div.appendChild(el('span', c.level, c.msg));
  return div;
}

function makeSelect(id: string, options: { value: string; label: string; disabled?: boolean }[], selected: string, ariaLabel: string, onChange: (v: string) => void): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.id = id;
  sel.setAttribute('aria-label', ariaLabel);
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    opt.selected = o.value === selected;
    if (o.disabled) opt.disabled = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function makeCheck(id: string, label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const l = document.createElement('label');
  l.className = 'check';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = id;
  cb.checked = checked;
  cb.addEventListener('change', () => onChange(cb.checked));
  l.appendChild(cb);
  l.appendChild(document.createTextNode(label));
  return l;
}

/** Mark a section as live state (second tab) rather than configuration. */
function status<T extends HTMLElement>(sec: T): T { sec.dataset.cat = 'hw'; return sec; }

function section(title: string | HTMLElement, ...children: (HTMLElement | null)[]): HTMLElement {
  const sec = el('section');
  if (typeof title === 'string') sec.appendChild(el('h3', undefined, title));
  else sec.appendChild(title);
  for (const c of children) if (c) sec.appendChild(c);
  return sec;
}

function heading(text: string, right: HTMLElement | string): HTMLElement {
  const h = el('h3', undefined, text);
  h.appendChild(typeof right === 'string' ? el('span', 'mono', right) : right);
  return h;
}

const mbps = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} Gbps` : `${v.toFixed(v < 10 ? 1 : 0)} Mbps`);
const money = (v: number) => `$${v.toFixed(2)}`;
const tb = (gb: number) => (gb >= 1000 ? `${(gb / 1000).toFixed(gb % 1000 ? 1 : 0)} TB` : `${gb} GB`);

/** Human summary of what an upgrade changes. */
function partsDiff(a: ServerParts, b: ServerParts): string {
  const out: string[] = [];
  if (a.chassis !== b.chassis) out.push(`${CHASSIS[b.chassis]!.label} chassis`);
  if (a.cpu !== b.cpu) out.push(CPU_PARTS[b.cpu]!.label);
  if (a.ram !== b.ram) out.push(`${RAM_PARTS[b.ram]!.label} RAM`);
  if (a.gpu !== b.gpu || a.gpus !== b.gpus) out.push(b.gpus ? `${b.gpus} × ${GPU_PARTS[b.gpu]!.label}` : 'no GPU');
  if (a.nic !== b.nic) out.push(`${NIC_PARTS[b.nic]!.label} NIC`);
  if (a.ports !== b.ports) out.push(`${b.ports} ports`);
  if (a.disk !== b.disk || a.diskType !== b.diskType || a.disks !== b.disks) out.push(`${b.disks} × ${DISK_PARTS[b.disk]!.label} ${DISK_TYPES[b.diskType].label}`);
  if (a.raid !== b.raid) out.push(RAID[b.raid].label);
  if (a.psu2 !== b.psu2) out.push(b.psu2 ? 'second PSU' : 'one PSU');
  return out.join(', ') || 'no change';
}

// ---------- Inspector ----------

type Live = () => void;

export class NsInspector extends HTMLElement {
  private shadow: ShadowRoot;
  private unsubs: (() => void)[] = [];
  private live: Live[] = [];
  private queued = false;
  private lastKey = '';
  private lastSel = '';
  private lastLive = 0;
  private wantRender = false;
  private openTraces = new Set<string>();
  private roleChoice: RoleKind | null = null;
  private panelTab: 'sw' | 'hw' = 'sw';
  private lastPanelKey = '';

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.shadow.appendChild(baseStyle());
    const style = document.createElement('style');
    style.textContent = INSPECTOR_CSS;
    this.shadow.appendChild(style);
    this.shadow.addEventListener('focusout', () => {
      // a sim-driven render was waiting for the user to finish typing
      setTimeout(() => { if (this.wantRender && !this.editing()) this.schedule(); }, 0);
    });
    this.render();
    this.unsubs.push(
      world.subscribe((_s, reason) => {
        if (reason === 'camera') return;
        if (reason === 'sim') this.onSim();
        else this.schedule();
      }),
      ui.subscribe(() => this.schedule()),
      onThemeChange(() => this.schedule()),
    );
  }

  disconnectedCallback(): void {
    this.unsubs.forEach((u) => u());
  }

  private editing(): boolean {
    const a = this.shadow.activeElement as HTMLElement | null;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA') && (a as HTMLInputElement).type !== 'checkbox';
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.render(); });
  }

  private onSim(): void {
    const now = performance.now();
    if (now - this.lastLive < 200) return;
    this.lastLive = now;
    for (const fn of this.live) fn();
    if (this.structureKey() !== this.lastKey) {
      if (this.editing()) this.wantRender = true;
      else this.schedule();
    }
  }

  /** Changes to anything in here need a structural re-render. */
  private structureKey(): string {
    const s = world.get();
    const sel = ui.get().selection;
    if (!sel) return 'none';
    if (sel.type === 'cable') return `c:${sel.id}:${!!s.cables[sel.id]}`;
    const d = s.devices[sel.id];
    if (!d) return 'gone';
    const h = d.health;
    const svc = Object.values(s.services).find((v) => v.serverId === d.id);
    return JSON.stringify([
      d.id, h.state, h.fault, h.repairKind, s.unlocks, svc?.publicIp ?? null,
      d.kind === 'server' || d.kind === 'desk' || d.kind === 'tower' || d.kind === 'badge' ? [d.ip, d.mask, d.gateway] : null,
      d.ports.map((p) => p.media + p.up).join(), d.kind === 'server' ? [d.parts, d.hw.off, d.hw.tempCap, d.cert, d.agents.monitor, d.hw.comps.length] : null,
      Object.keys(s.known ?? {}).filter((k) => k.startsWith(d.id + ':')).join(), Object.values(s.staff.jobs).filter((j) => j.deviceId === d.id).map((j) => JSON.stringify(j.parts ?? j.comps ?? '') + j.paid).join(),
      d.compromised?.since ?? null, d.sw?.patch ?? null, s.staff.release,
      Object.values(s.staff.jobs).filter((j) => j.deviceId === d.id).map((j) => j.kind + (j.engineerId ? '+' : '')).join(),
      d.kind === 'desk' ? d.ownerId : null, Object.keys(s.staff.engineers).length,
      (runtime.learned[d.id] ?? []).map((r) => `${r.dest}>${r.nextHop}`).join(','),
    ]);
  }

  // ---------- live helpers ----------

  private liveText(fn: () => string, cls = 'mono'): HTMLElement {
    const span = el('span', cls, fn());
    this.live.push(() => { const t = fn(); if (span.textContent !== t) span.textContent = t; });
    return span;
  }

  private liveMeter(label: string, frac: () => number, text: () => string, health = false, neutral = false): HTMLElement {
    const row = el('div', 'meter');
    row.appendChild(el('span', undefined, label));
    const bar = el('div', 'bar');
    const i = el('i');
    bar.appendChild(i);
    row.appendChild(bar);
    const v = el('span', 'v');
    row.appendChild(v);
    const upd = () => {
      const f = frac();
      i.style.width = `${Math.min(100, Math.max(0, f * 100))}%`;
      i.style.background = neutral ? 'var(--ink-dim)' : health
        ? (f <= 0.25 ? 'var(--bad)' : f <= 0.6 ? 'var(--warn)' : 'var(--ok)')
        : (f > 1 ? 'var(--bad)' : f > 0.8 ? 'var(--warn)' : 'var(--ok)');
      v.textContent = text();
    };
    upd();
    this.live.push(upd);
    return row;
  }

  private liveBlock(fn: () => HTMLElement): HTMLElement {
    const box = el('div');
    box.style.display = 'contents';
    let last = '';
    const upd = () => {
      const n = fn();
      const html = n.outerHTML;
      if (html === last) return;
      last = html;
      box.replaceChildren(n);
    };
    upd();
    this.live.push(upd);
    return box;
  }

  // ---------- shared sections ----------

  private healthSection(d: Device): HTMLElement {
    const s = world.get();
    if (d.kind === 'server') {
      const sec = section('Condition');
      sec.appendChild(this.monitorStatus(d.id));
      const box = el('div', 'repairs');
      const price = priceOf(d);
      const b = btn('', () => { let err: string | null = null; world.update((w) => { err = startRepair(w, runtime, d.id, 'replace'); }); if (err) toast(err, 'error'); });
      b.innerHTML = `<span>Replace every part</span><span class="mono">$${price}</span><small>A complete new server in the same case. Needs downtime.</small>`;
      box.appendChild(b);
      sec.appendChild(box);
      return sec;
    }
    const smart = () => world.get().unlocks.monitoring && isMonitored(runtime, d.id);
    const sec = section(heading('Health', this.liveText(() => {
      const x = world.get().devices[d.id];
      if (!x) return '';
      if (x.health.state === 'repairing') return 'repairing';
      return smart() ? `${Math.round((x.wear ?? 0) * 100)} % worn` : 'wear: no data';
    })));
    if (d.kind !== 'uplink') sec.appendChild(this.liveMeter('Life left', () => {
      const x = world.get().devices[d.id];
      return x && smart() ? 1 - Math.min(1, x.wear ?? 0) : 1;
    }, () => (smart() ? '' : '?'), true));
    sec.appendChild(this.liveBlock(() => {
      const st = world.get();
      const x = st.devices[d.id];
      const box = el('div');
      if (!x) return box;
      const kp = knownProblems(st, x);
      for (const p of kp) box.appendChild(el('div', `explain ${p.level === 'alert' ? 'bad' : 'warn'}`, `${p.msg}. ${p.via === 'monitoring' ? `Monitoring alert${p.ack ? `, seen by ${p.by}` : ', nobody at the console yet'}` : `Noticed by ${p.by}`}.`));
      if (!kp.length && (x.health.state === 'failed' || x.health.fault === 'nic')) box.appendChild(el('div', 'explain bad', 'Something is wrong here, but nobody has noticed what yet. Send an engineer, or monitor it.'));
      return box;
    }));
    if (d.kind !== 'uplink') sec.appendChild(this.monitorStatus(d.id));
    if (d.health.state === 'repairing') {
      sec.appendChild(this.liveText(() => {
        const x = world.get().devices[d.id]?.health;
        const left = x?.repairEndsAt ? Math.max(0, (x.repairEndsAt - world.get().time.tick) / TICKS_PER_SEC) : 0;
        return `${x?.repairKind === 'full' ? 'Repair, offline' : 'Maintenance, still running'} · ${left.toFixed(0)} s left`;
      }, 'note'));
    }
    if (d.kind !== 'uplink') {
      sec.appendChild(this.liveText(() => {
        const st = world.get();
        const j = Object.values(st.staff.jobs).find((x) => x.deviceId === d.id && x.kind !== 'update');
        if (!j) return '';
        const e = j.engineerId ? st.staff.engineers[j.engineerId] : undefined;
        if (!e) return 'Ordered: waiting for a free engineer.';
        return e.name + ' ' + engineerActivity(st, e) + (j.started ? ` · ${Math.ceil(j.workLeft / TICKS_PER_SEC)} s left` : '');
      }, 'note'));
      const box = el('div', 'repairs');
      const known = knownProblems(s, d);
      for (const o of repairOptions(d)) {
        const allowed = o.allowed && (o.kind !== 'full' || known.length > 0);
        const b = btn('', () => {
          let err: string | null = null;
          world.update((w) => { err = startRepair(w, runtime, d.id, o.kind); });
          if (err) toast(err, 'error');
        });
        b.disabled = !allowed;
        b.innerHTML = `<span>${o.label}</span><span class="mono">$${o.cost}${o.seconds ? ` · ${o.seconds} s` : ''}</span><small>${o.why}</small>`;
        box.appendChild(b);
      }
      if (!known.length && (d.health.state === 'failed' || d.health.fault)) {
        const b = btn('', () => { const e = orderInspect(world.get(), d.id); if (e) toast(e, 'error'); });
        b.innerHTML = '<span>Send an engineer to check</span><span class="mono">free</span><small>They walk over and see what is wrong.</small>';
        box.appendChild(b);
      }
      sec.appendChild(box);
    }
    return sec;
  }

  private usageSection(d: Device): HTMLElement | null {
    if (!('usage' in d)) return null;
    const cap = () => { const x = world.get().devices[d.id]; return x ? deviceCapacity(x) : 1; };
    const use = () => { const x = world.get().devices[d.id]; return x && 'usage' in x ? x.usage.bandwidth : 0; };
    const offered = () => { const x = world.get().devices[d.id]; return x && 'usage' in x ? x.usage.offered ?? 0 : 0; };
    const drop = () => Math.max(0, offered() - cap());
    if (d.kind === 'server') {
      const u = () => { const x = world.get().devices[d.id]; return x && 'usage' in x ? x.usage : null; };
      return section(heading('Load', this.liveText(() => { const x = u(); return x?.bottleneck === 'off' ? 'off' : `limit: ${x?.bottleneck ?? '—'}`; })),
        this.liveMeter('Traffic', use, () => `${mbps(Math.min(offered(), cap()))} / ${mbps(cap())}`),
        this.liveMeter('CPU', () => u()?.cpu ?? 0, () => `${Math.round((u()?.cpu ?? 0) * 100)} %`),
        this.liveMeter('Memory', () => u()?.ram ?? 0, () => `${Math.round((u()?.ram ?? 0) * 100)} %`),
        this.liveMeter('Disk IO', () => u()?.io ?? 0, () => `${Math.round((u()?.io ?? 0) * 100)} %`),
        this.liveMeter('Network', () => u()?.nic ?? 0, () => `${Math.round((u()?.nic ?? 0) * 100)} %`),
        d.parts.gpus ? this.liveMeter('GPU', () => u()?.gpu ?? 0, () => `${Math.round((u()?.gpu ?? 0) * 100)} %`) : null,
        this.liveText(() => {
          const x = u();
          if (!x) return '';
          if (drop() > 0.5) return `Overloaded: ${mbps(offered())} offered, ${mbps(drop())} dropped. The ${x.bottleneck} is the limit: upgrade that first.`;
          if (x.bandwidth > 0.8) return `Above 80 % responses slow down and some visitors give up (−${Math.round((1 - latencyFactor(world.get().devices[d.id])) * 100)} %). ${x.bottleneck} is the limit.`;
          return '';
        }, 'note warn-t'),
      );
    }
    return section('Load',
      this.liveMeter('Traffic', use, () => `${mbps(Math.min(offered(), cap()))} / ${mbps(cap())}`),
      this.liveText(() => drop() > 0.5 ? `Overloaded: ${mbps(offered())} offered, ${mbps(drop())} dropped.` : '', 'note bad-t'),
    );
  }

  private talkersSection(d: Device, title = 'Top talkers'): HTMLElement {
    return status(section(title,
      d.kind === 'firewall' ? el('p', 'note', 'Every flow that touched this device right now, heaviest first. During a flood one unfamiliar range dominates.') : null,
      this.liveBlock(() => {
        const rows = (runtime.talkers[d.id] ?? []).slice(0, 8);
        if (!rows.length) return el('p', 'note', 'No traffic.');
        const t = el('table', 'talk');
        t.innerHTML = '<colgroup><col style="width:38%"><col style="width:22%"><col style="width:18%"><col style="width:22%"></colgroup><tr><th>Source</th><th>Proto</th><th class="r">Mbps</th><th>Result</th></tr>';
        for (const r of rows) {
          const tr = el('tr', r.kind);
          tr.innerHTML = `<td title="${r.src}">${r.src}</td><td>${r.proto}</td><td class="r">${r.mbps.toFixed(r.mbps < 10 ? 1 : 0)}</td><td class="${r.ok ? 'ok-t' : 'bad-t'}">${r.verdict}</td>`;
          t.appendChild(tr);
        }
        return t;
      }),
    ));
  }

  private portsSection(s: WorldState, d: Device): HTMLElement {
    const used = portUsage(s);
    const list = el('ul', 'ports');
    for (const p of d.ports) {
      const li = document.createElement('li');
      li.appendChild(el('span', 'pl', p.label));
      const cid = used.get(`${d.id}:${p.index}`);
      const cable = cid ? s.cables[cid] : undefined;
      if (!p.up) li.appendChild(el('span', 'bad-t', 'down (NIC fault)'));
      else if (cable) {
        const other = cable.a.deviceId === d.id && cable.a.port === p.index ? cable.b : cable.a;
        const od = s.devices[other.deviceId];
        li.appendChild(el('span', 'linked', `→ ${od?.name ?? '?'} ${od?.ports[other.port]?.label ?? ''}`));
      } else li.appendChild(el('span', 'free', 'free'));
      li.appendChild(el('span', 'side', SIDE_NAME[portSide(d, p.index)]));
      const ms = makeSelect(`media-${p.index}`, [{ value: 'copper', label: 'copper' }, { value: 'fibre', label: 'fibre' }], p.media, `${p.label} media`, (v) => {
        const e = setPortMedia(d.id, p.index, v as Media);
        if (e) { toast(e, 'error'); this.schedule(); } else toast(`${d.name} ${p.label} is now ${v} ($${MEDIA_SWAP_PRICE} transceiver).`);
      });
      ms.style.minHeight = '26px';
      ms.style.padding = '2px 4px';
      li.appendChild(ms);
      list.appendChild(li);
    }
    if (!d.ports.length) return section('Ports', el('p', 'note', 'No network ports.'));
    return section('Ports', list, el('p', 'note', `Copper ports take ethernet or crossover cables, fibre ports take fibre. Swapping the transceiver costs $${MEDIA_SWAP_PRICE}; unplug the cable first.`));
  }

  private logsSection(d: Device): HTMLElement {
    return section('Recent events', this.liveBlock(() => {
      const logs = world.get().logs.filter((l) => l.deviceId === d.id).slice(-5).reverse();
      if (!logs.length) return el('p', 'note', 'Nothing yet.');
      const box = el('div', 'logs');
      for (const l of logs) box.appendChild(el('span', l.level, `${fmtTime(l.tick)} ${l.msg}`));
      return box;
    }));
  }

  // ---------- L3 config shared by router and firewall ----------

  private routesSection(d: RouterDevice | FirewallDevice): HTMLElement {
    const edit = (fn: (x: RouterDevice | FirewallDevice) => void) => editL3(d.id, fn);
    const sec = section(heading('Routing table', `${d.routes.length} static`));
    const conn = el('div', 'derived');
    const nets = l3Subnets(d as RouterDevice | FirewallDevice);
    if (nets.length) for (const n of nets) conn.appendChild(el('span', undefined, `C  ${formatCidr(n.cidr)} → ${n.name}`));
    else conn.appendChild(el('span', 'note', 'No connected networks yet. Give an interface an IP.'));
    sec.appendChild(conn);
    sec.appendChild(el('p', 'note', 'C = connected, created by interface IPs. Static routes: destination network and the next router\'s IP. The exit port follows from the next hop.'));

    d.routes.forEach((rt, i) => {
      const destCheck = checkCidr(rt.dest, false);
      const hopCheck = nextHopCheck(d as RouterDevice | FirewallDevice, rt.nextHop);
      const upd = (fn: (r: typeof rt) => void) => edit((x) => { const r = x.routes[i]; if (r) fn(r); });
      const row = el('div', 'row rt-row');
      row.appendChild(makeInput(`${rt.id}-dest`, rt.dest, { placeholder: '0.0.0.0/0', ariaLabel: 'Destination network', check: destCheck, onCommit: (v) => upd((r) => { r.dest = v; }) }));
      row.appendChild(makeInput(`${rt.id}-hop`, rt.nextHop, { placeholder: 'next hop IP', ariaLabel: 'Next hop', check: hopCheck, onCommit: (v) => upd((r) => { r.nextHop = v; }) }));
      row.appendChild(makeInput(`${rt.id}-metric`, String(rt.metric), {
        placeholder: '1', ariaLabel: 'Metric',
        onCommit: (v) => upd((r) => { const n = Number(v); if (Number.isFinite(n) && n >= 0) r.metric = Math.round(n); }),
      }));
      row.appendChild(btn('✕', () => edit((x) => { x.routes.splice(i, 1); }), 'icon-btn danger', 'Delete route'));
      sec.appendChild(row);
      const m = makeMsgs([destCheck, hopCheck], true);
      if (m) sec.appendChild(m);
    });
    sec.appendChild(btn('+ Add static route', () => edit((x) => { x.routes.push({ id: genId('rt'), dest: '0.0.0.0/0', nextHop: '', metric: 1 }); }), 'add'));

    const s = world.get();
    const learned = runtime.learned[d.id] ?? [];
    if (s.unlocks.dynamicRouting) {
      sec.appendChild(makeCheck(`${d.id}-ospf`, ' OSPF: share connected networks and static routes with neighbours', d.ospf, (v) => edit((x) => { x.ospf = v; })));
      if (learned.length) {
        const lr = el('div', 'derived');
        for (const r of learned) lr.appendChild(el('span', undefined, `O  ${r.dest} via ${r.nextHop} (${r.via}, ${r.metric} hop${r.metric === 1 ? '' : 's'})`));
        sec.appendChild(lr);
      } else if (d.ospf) sec.appendChild(el('p', 'note', 'No OSPF neighbours yet. Another OSPF device must share a subnet with this one.'));
    } else {
      sec.appendChild(el('p', 'locked', `Dynamic routing (OSPF): ${lockedMsg('dynamicRouting')}`));
    }
    return sec;
  }

  private natSection(d: RouterDevice | FirewallDevice): HTMLElement {
    const edit = (fn: (x: RouterDevice | FirewallDevice) => void) => editL3(d.id, fn);
    const s = world.get();
    const sec = section(heading('Static NAT', `${d.nat.length}`));
    sec.appendChild(el('p', 'note', 'Pairs a public address with a private one. Leave the port blank to pass the whole address through, or forward just one port (tcp 443, tcp 2222→22) so a single public IP can serve several machines.'));
    d.nat.forEach((n, i) => {
      const c = natCheck(s, d as RouterDevice | FirewallDevice, n.publicIp, n.privateIp);
      const upd = (fn: (x: typeof n) => void) => edit((x) => { const r = x.nat[i]; if (r) fn(r); });
      const row = el('div', 'row natp-row');
      row.appendChild(makeInput(`${n.id}-pub`, n.publicIp, { placeholder: publicIps(s)[3] ?? '203.0.113.5', ariaLabel: 'Public IP', onCommit: (v) => upd((x) => { x.publicIp = v; }) }));
      row.appendChild(el('span', 'arrow', '→'));
      row.appendChild(makeInput(`${n.id}-priv`, n.privateIp, { placeholder: '192.168.10.10', ariaLabel: 'Private IP', onCommit: (v) => upd((x) => { x.privateIp = v; }) }));
      row.appendChild(makeInput(`${n.id}-port`, natPortText(n), {
        placeholder: 'all ports', ariaLabel: 'Ports (e.g. tcp 2222→22)',
        onCommit: (v) => { const r = parseNatPort(v); if (typeof r === 'string') { toast(r, 'error'); this.schedule(); return; } upd((x) => { x.proto = r.proto; x.publicPort = r.publicPort; x.privatePort = r.privatePort; }); },
      }));
      row.appendChild(btn('✕', () => edit((x) => { x.nat.splice(i, 1); }), 'icon-btn danger', 'Delete NAT entry'));
      sec.appendChild(row);
      const m = makeMsgs([c]);
      if (m) sec.appendChild(m);
    });
    sec.appendChild(btn('+ Add NAT entry', () => edit((x) => { x.nat.push({ id: genId('nat'), publicIp: '', privateIp: '' }); }), 'add'));
    // dynamic source NAT
    sec.appendChild(el('h3', undefined, 'Dynamic NAT'));
    if (!s.unlocks.dynamicNat) {
      sec.appendChild(el('p', 'locked', `Many inside hosts sharing one outside address: ${lockedMsg('dynamicNat')}`));
      return sec;
    }
    sec.appendChild(el('p', 'note', 'A whole inside network goes out through one shared address: the one on the port the traffic leaves by. Replies come back, but nobody outside can open a connection in. Hosts with their own static entry keep using it.'));
    const ports = d.interfaces.map((i) => ({ value: String(i.port), label: `${'name' in i ? (i as { name: string }).name : d.ports[i.port]?.label ?? `port ${i.port}`}${i.ip ? ` (${i.ip})` : ''}` }));
    (d.pat ?? []).forEach((r, i) => {
      const upd = (fn: (x: NonNullable<typeof d.pat>[number]) => void) => edit((x) => { const y = x.pat?.[i]; if (y) fn(y); });
      const row = el('div', 'row pat-row');
      row.appendChild(makeInput(`${r.id}-src`, r.src, { placeholder: '192.168.10.0/24', ariaLabel: 'Inside network', check: parseCidr(r.src) || !r.src ? null : { level: 'bad', msg: 'Use a network like 192.168.10.0/24' }, onCommit: (v) => upd((x) => { x.src = v.trim(); }) }));
      row.appendChild(el('span', 'arrow', '→'));
      row.appendChild(makeSelect(`${r.id}-out`, ports, String(r.outPort), 'Leaves through', (v) => upd((x) => { x.outPort = Number(v); })));
      row.appendChild(btn('✕', () => edit((x) => { x.pat?.splice(i, 1); }), 'icon-btn danger', 'Delete dynamic NAT rule'));
      sec.appendChild(row);
    });
    const outside = d.interfaces.find((i) => 'name' in i && (i as { name: string }).name === 'outside') ?? d.interfaces[0];
    sec.appendChild(btn('+ Add dynamic NAT', () => edit((x) => { (x.pat ??= []).push({ id: genId('pat'), src: '', outPort: outside?.port ?? 0 }); }), 'add'));
    return sec;
  }

  // ---------- per-kind bodies ----------

  private uplinkBody(d: DeviceOf<'uplink'>): HTMLElement[] {
    const s = world.get();
    const c = parseCidr(d.publicSubnet)!;
    const size = 2 ** (32 - c.prefix);
    const kv = el('dl', 'kv');
    kv.innerHTML = `
      <dt>Public block</dt><dd>${d.publicSubnet}</dd>
      <dt>ISP gateway</dt><dd>${d.uplinkIp}</dd>
      <dt>Your addresses</dt><dd>${publicIps(s)[0]} – ${publicIps(s).slice(-1)[0]} (${size - 3})</dd>`;
    const info = section('Internet connection', kv,
      el('p', 'note', 'Visitors and attacks arrive on the WAN port. The ISP asks "who has <public IP>?" on this link, so a device behind it must own that address or NAT it. Use the ISP gateway as your default route\'s next hop.'));
    const nb = nextBlockUpgrade(s);
    if (nb) {
      const cnt = 2 ** (32 - nb.prefix) - 3;
      info.appendChild(btn(`Buy a bigger block: /${nb.prefix} (${cnt} addresses) · $${nb.price.toLocaleString()}`, () => {
        const err = buyBiggerBlock();
        if (err) toast(err, 'error');
        else toast(`Your public block is now ${nb.subnet}. Change your edge device's outside address to /${nb.prefix} to use the new addresses.`, 'good');
      }, 'add', `Becomes ${nb.subnet}. It contains your current block, so nothing in use changes.`));
      info.appendChild(el('p', 'sub', `Becomes ${nb.subnet}: your current addresses stay. To use the new ones, give your edge device's outside address the prefix /${nb.prefix}.`));
    } else info.appendChild(el('p', 'sub', 'This is the biggest block your ISP offers.'));

    const bw = () => Math.max(1, (world.get().devices[d.id] as DeviceOf<'uplink'>).bandwidthMbps);
    const tierSec = section(heading('Line', this.liveText(() => `${mbps(Math.min(runtime.uplinkMbps, bw()))} / ${mbps(bw())}`)));
    tierSec.appendChild(this.liveMeter('Used', () => Math.min(1, runtime.uplinkMbps / bw()), () => `${Math.round(Math.min(1, runtime.uplinkMbps / bw()) * 100)} %`));
    tierSec.appendChild(this.liveText(() => runtime.uplinkMbps > bw() + 0.5 ? `Line full: ${mbps(runtime.uplinkMbps)} offered, ${mbps(runtime.uplinkMbps - bw())} dropped before it reaches you.` : '', 'note bad-t'));
    const seg = el('div', 'seg');
    for (const t of ['basic', 'business', 'carrier'] as const) {
      const info2 = UPLINK_TIER[t];
      const locked = t === 'carrier' && !s.unlocks.carrierUplink;
      const b = btn(`${info2.label} · ${mbps(info2.bandwidthMbps)} · ${info2.costPerSec ? `$${info2.costPerSec}/s` : 'free'}`, () => {
        const err = setUplinkTier(t, d.id);
        if (err) toast(err, 'error'); else toast(`Uplink set to ${info2.label}.`);
      });
      b.setAttribute('aria-pressed', String(d.uplinkTier === t));
      b.disabled = locked;
      if (locked) b.title = lockedMsg('carrierUplink');
      seg.appendChild(b);
    }
    tierSec.appendChild(seg);
    tierSec.appendChild(el('p', 'note', 'Everything entering your network shares this line, attacks included. Blocking a flood at your firewall protects the server, but the line stays full unless the ISP filters it upstream.'));

    const ufSec = section('Upstream filtering');
    if (!s.unlocks.upstreamFiltering) ufSec.appendChild(el('p', 'locked', lockedMsg('upstreamFiltering')));
    else {
      const edit = (fn: (x: DeviceOf<'uplink'>) => void) => editDevice(d.id, 'uplink', fn);
      ufSec.appendChild(el('p', 'note', 'The ISP drops these source ranges before they reach your line.'));
      d.upstreamFilters.forEach((f, i) => {
        const row = el('div', 'row uf-row');
        const chk = checkCidr(f.src, false);
        row.appendChild(makeInput(`${f.id}-src`, f.src, { placeholder: '198.51.100.0/24', ariaLabel: 'Source range', check: chk, onCommit: (v) => edit((x) => { const r = x.upstreamFilters[i]; if (r) r.src = v; }) }));
        row.appendChild(makeCheck(`${f.id}-on`, ' on', f.enabled, (v) => edit((x) => { const r = x.upstreamFilters[i]; if (r) r.enabled = v; })));
        row.appendChild(btn('✕', () => edit((x) => { x.upstreamFilters.splice(i, 1); }), 'icon-btn danger', 'Delete filter'));
        ufSec.appendChild(row);
      });
      ufSec.appendChild(btn('+ Add filter', () => edit((x) => { x.upstreamFilters.push({ id: genId('uf'), src: '', enabled: true }); }), 'add'));
    }
    return [info, tierSec, ufSec, this.talkersSection(d, 'Incoming traffic')];
  }

  private addressingSection(s: WorldState, d: Host): HTMLElement {
    const edit = (fn: (x: Host) => void) => editHost(d.id, fn);
    const net = subnetOf(d.ip, d.mask);
    const netSec = section('Network');
    const mode = el('div', 'seg');
    for (const m of ['static', 'dhcp'] as const) {
      const b = btn(m === 'static' ? 'Static IP' : 'DHCP', () => edit((x) => { x.addressing = m; if (m === 'dhcp') { x.ip = ''; x.gateway = ''; } }));
      b.setAttribute('aria-pressed', String(d.addressing === m));
      if (m === 'dhcp' && !s.unlocks.dhcp) { b.disabled = true; b.title = lockedMsg('dhcp'); }
      mode.appendChild(b);
    }
    netSec.appendChild(mode);
    if (d.addressing === 'dhcp') {
      const kv = el('dl', 'kv');
      kv.innerHTML = `<dt>Leased address</dt><dd>${d.ip ? addrText(d.ip, d.mask) : 'waiting…'}</dd><dt>Gateway</dt><dd>${d.gateway || '—'}</dd>`;
      netSec.appendChild(kv);
      if (!d.ip) netSec.appendChild(el('p', 'note warn-t', 'No lease. Enable a DHCP pool on the router or firewall interface on this segment.'));
    } else {
      netSec.appendChild(makeField('Address', addrText(d.ip, d.mask), {
        id: 'srv-ip', placeholder: '192.168.10.10/24', check: checkAddr(d.ip, d.mask) ?? duplicateCheck(s, d.ip, d.name),
        onCommit: (v) => this.commitAddr(v, (ip, mask) => edit((x) => { x.ip = ip; x.mask = mask; })),
      }));
      netSec.appendChild(makeField('Gateway', d.gateway, {
        id: 'srv-gw', placeholder: '192.168.10.1', check: serverGatewayCheck(d as DeviceOf<'server'>),
        onCommit: (v) => edit((x) => { x.gateway = v; }),
      }));
    }
    if (d.kind === 'server' && d.addressing === 'static') {
      netSec.appendChild(makeField('DNS server', d.dns, {
        id: 'srv-dns', placeholder: 'e.g. 192.168.10.53', check: checkIp(d.dns, 'Needed to look up names like app1.lan'),
        onCommit: (v) => editDevice(d.id, 'server', (x) => { x.dns = v; }),
      }));
    }
    if (d.kind === 'server') {
      if (!d.extra.length) netSec.appendChild(el('p', 'note', 'Buy extra ports under Hardware to add back-end networks (eth1–eth3) for GPU and storage traffic.'));
      d.extra.forEach((x, i) => {
        const n = i + 1;
        netSec.appendChild(el('h3', undefined, `eth${n} · extra network`));
        netSec.appendChild(makeField(`eth${n} address`, addrText(x.ip, x.mask), {
          id: `srv-ip${n}`, placeholder: `10.10.${n - 1}.10/24`, check: checkAddr(x.ip, x.mask, 'Not used') ?? duplicateCheck(s, x.ip, `${d.name} eth${n}`),
          onCommit: (v) => this.commitAddr(v, (ip, mask) => editDevice(d.id, 'server', (y) => { const e = y.extra[i]; if (e) { e.ip = ip; e.mask = mask; } })),
        }));
      });
      if (d.extra.length) netSec.appendChild(el('p', 'note', 'Extra ports have no gateway: they only reach their own subnet. Ideal for orchestrator ↔ GPU and storage traffic.'));
    }
    const kv = el('dl', 'kv');
    kv.innerHTML = `<dt>Subnet</dt><dd>${net ? formatCidr(net) : '—'}</dd><dt>MAC</dt><dd>${d.mac}</dd>`;
    netSec.appendChild(kv);
    return netSec;
  }

  private serverBody(s: WorldState, d: DeviceOf<'server'>): HTMLElement[] {
    const edit = (fn: (x: DeviceOf<'server'>) => void) => editDevice(d.id, 'server', fn);

    // ── Roles
    const use = roleUse(d.roles.map((r) => r.role));
    const rolesSec = section(heading('Roles', `${d.roles.length} installed`));
    rolesSec.appendChild(el('p', 'note', 'One server can run several roles as long as its CPU, RAM and disk cover them all.'));
    rolesSec.appendChild(this.budgetMeters(use, d.specs));
    const ips = publicIps(s);
    for (const r of d.roles) {
      const def = ROLES[r.role];
      const card = el('div', 'card');
      const top = el('div', 'row');
      top.style.gridTemplateColumns = 'minmax(0,1fr) auto';
      top.style.gridTemplateColumns = 'minmax(0,1fr) 92px auto';
      const t = el('div');
      const same = d.roles.filter((x) => x.role === r.role);
      t.innerHTML = `<b>${def.label}${same.length > 1 ? ` ${same.indexOf(r) + 1}` : ''}</b> <span class="sub">${def.proto}</span>`;
      top.appendChild(t);
      if (def.ports) top.appendChild(el('span', 'sub', def.ports.join(' / ')));
      else top.appendChild(makeInput(`role-${roleKey(r)}-port`, String(r.port), {
        placeholder: String(def.port), ariaLabel: `${def.label} port`,
        onCommit: (v) => { const e = setRolePort(d.id, roleKey(r), Number(v.trim())); if (e) { toast(e, 'error'); this.schedule(); } },
      }));
      top.appendChild(btn('Remove', () => removeRole(d.id, roleKey(r)), 'danger', `Remove ${def.label}`));
      card.appendChild(top);
      if (def.linksTo) card.appendChild(this.linkEditor(s, d, r));
      const ex = this.roleExtras(s, d, r.role);
      if (ex) card.appendChild(ex);
      const svc = r.serviceId ? s.services[r.serviceId] : undefined;
      if (svc) {
        card.appendChild(el('p', 'sub', `Listens on ${ROLES[r.role].proto}/${svc.port}${svc.port === 80 && svc.kind !== 'dns' ? ' (and 443 with a certificate)' : ''} on every interface of this server. Visitors find it by its domain name${svc.port !== 80 && svc.kind !== 'dns' ? ` and port, like name:${svc.port}` : ''}, or under Public IPs in the Internet tab.`));
        const names = allFqdns(s);
        const fd = el('label', 'field');
        fd.appendChild(el('span', undefined, 'Domain name'));
        fd.appendChild(makeSelect(`svc-${svc.id}-fqdn`, [{ value: '', label: names.length ? 'none' : 'none (buy a domain in Domains)' }, ...names.map((n) => ({ value: n, label: n }))], svc.fqdn ?? '', 'Domain name', (v) => setServiceFqdn(svc.id, v || null)));
        card.appendChild(fd);
        card.appendChild(this.liveText(() => {
          const v = world.get().services[svc.id];
          if (!v) return '';
          const eps = endpointsOf(world.get(), runtime, v);
          const vp = visitorPort(world.get(), v);
          return eps.length ? `Visitors arrive on ${eps.map((e) => `${e}:${vp}`).join(', ')}${eps.length > 1 ? ' (shared, health-checked)' : ''}` : 'No public IP points here yet';
        }, 'sub'));
        card.appendChild(this.liveText(() => {
          const v = world.get().services[svc.id];
          if (!v) return '';
          const fl = v.flowId ? world.get().flows[v.flowId] : undefined;
          const extra = v.kind === 'cloud' ? ` · ${(v.usedGB / 1000).toFixed(2)} TB stored` : v.kind === 'ai' ? ` · ${chain(world.get(), runtime, v).tflops.toFixed(0)} TFLOPS behind it` : '';
          const tot = (v.flowIds ?? []).reduce((a, id) => a + (world.get().flows[id]?.rateMbps ?? 0), 0);
          return `${Math.round(v.availability * 100)} % up · ${money(serviceRevenue(world.get(), v))}/s · ${tot ? mbps(tot) : fl ? mbps(fl.rateMbps) : '—'} · rep ${v.reputation.toFixed(2)}${extra} · app v${v.appVersion ?? 1} ×${(v.quality ?? 1).toFixed(2)}${(v.devProgress ?? 0) > 0 ? ` (next ${Math.round((v.devProgress ?? 0) * 100)} %)` : ''}`;
        }, 'sub'));
        const det = document.createElement('details');
        det.id = `trace-${svc.id}`;
        det.open = this.openTraces.has(svc.id);
        det.addEventListener('toggle', () => { if (det.open) this.openTraces.add(svc.id); else this.openTraces.delete(svc.id); });
        det.innerHTML = '<summary class="sub">Path check</summary>';
        det.appendChild(this.liveBlock(() => {
          const v = world.get().services[svc.id];
          return renderTrace(world.get(), v?.flowId ? runtime.paths[v.flowId] : undefined);
        }));
        card.appendChild(det);
        card.appendChild(this.liveBlock(() => {
          const v = world.get().services[svc.id];
          const p = v?.flowId ? runtime.paths[v.flowId] : undefined;
          const ok = !!p && !p.blocked && !!p.ret && !p.ret.blocked;
          const prob = v ? serviceProblem(world.get(), runtime, v) : null;
          if (prob && (ok || !p)) return el('div', 'explain bad', prob);
          if (ok && v?.fqdn) { const vp = visitorPort(world.get(), v); return el('div', 'explain ok', `Visitors find it as ${v.fqdn}${vp !== 80 && vp !== 443 ? `:${vp}` : ''} (${runtime.resolve[v.id]?.ip}), about 40 % more of them than by bare IP.`); }
          return el('div', `explain ${ok ? 'ok' : 'bad'}`, ok ? 'Reachable from the internet, replies get back.' : (p?.explain ?? 'Waiting…'));
        }));
      } else {
        card.appendChild(el('p', 'note', def.blurb));
      }
      rolesSec.appendChild(card);
    }
    // add a role
    const addRow = el('div', 'row');
    addRow.style.gridTemplateColumns = 'minmax(0,1fr) minmax(0,0.8fr) auto';
    const avail = (Object.keys(ROLES) as RoleKind[]).filter((k) => MULTI_ROLES.has(k) || !d.roles.some((r) => r.role === k));
    if (avail.length) {
      const roleSel = makeSelect('role-add', avail.map((k) => ({ value: k, label: `${ROLES[k].label}${roleBlocker(d, k) ? ' ✕' : ''}` })), this.roleChoice ?? avail[0]!, 'Role to add', (v) => { this.roleChoice = v as RoleKind; this.schedule(); });
      const choice = (avail.includes(this.roleChoice as RoleKind) ? this.roleChoice : avail[0]) as RoleKind;
      const def = ROLES[choice];
      const usedIps = new Set(Object.values(s.services).filter((v) => v.port === def.port && v.serverId !== d.id).map((v) => v.publicIp));
      const defIp = ips.find((ip) => ip === d.ip && !usedIps.has(ip)) ?? ips.find((ip) => !usedIps.has(ip)) ?? '';
      addRow.style.gridTemplateColumns = 'minmax(0,1fr) auto';
      addRow.appendChild(roleSel);
      const blocker = roleBlocker(d, choice);
      const add = btn('Add', () => { const e = addRole(d.id, choice); if (e) toast(e, 'error'); else toast(`${def.label} installed on ${d.name}.${def.service ? ' Publish it on a public IP in the Internet tab.' : ''}`); }, '', `Add ${def.label}`);
      add.disabled = !!blocker;
      addRow.appendChild(add);
      rolesSec.appendChild(addRow);
      rolesSec.appendChild(el('p', blocker ? 'note warn-t' : 'note', blocker ? `${def.label}: ${blocker}. Upgrade the hardware below.` : `${def.blurb} Uses ${def.cores} core${def.cores > 1 ? 's' : ''}, ${def.ramGB} GB RAM, ${def.diskGB} GB disk.${def.service ? ' Afterwards publish it on a public IP (Internet tab) and NAT that IP to this server on your edge.' : ''}`));
    }

    // ── Hardware
    const P = pendingParts(s, d.id) ?? d.parts;
    const job = Object.values(s.staff.jobs).find((j) => j.deviceId === d.id && j.kind === 'upgrade');
    const bench = onBench(s, d.id);
    const hwSec = section(heading('Hardware', `$${upkeepOf(d).toFixed(3)}/s upkeep`));
    hwSec.appendChild(el('p', 'note', bench
      ? 'On the bench (no cables plugged in): parts are fitted straight away. You get half the old part back as trade-in.'
      : 'An engineer fits changes on site. Extra drives and a second power supply go in while it runs; anything else needs the server off for a while.'));
    if (job) {
      const box = el('div', `explain ${job.cold ? 'bad' : 'ok'}`);
      const diff = partsDiff(d.parts, job.parts!);
      box.appendChild(el('div', undefined, `Upgrade ordered ($${job.paid ?? 0}): ${diff}. ${job.cold ? 'Needs downtime.' : 'Hot-swap, no downtime.'}`));
      box.appendChild(this.liveText(() => {
        const st = world.get();
        const j = st.staff.jobs[job.id];
        if (!j) return '';
        const e = j.engineerId ? st.staff.engineers[j.engineerId] : undefined;
        return e ? `${e.name}: ${engineerActivity(st, e)}${j.started ? ` · ${Math.ceil(j.workLeft / TICKS_PER_SEC)} s left` : ''}` : 'Waiting for a free engineer.';
      }, 'sub'));
      if (!job.started) box.appendChild(btn('Cancel upgrade (refund)', () => cancelUpgrade(d.id), 'ghost'));
      hwSec.appendChild(box);
    }
    const slot = (label: string, key: PartSlot, opts: { value: string; label: string; disabled?: boolean }[], cur: string) => {
      const f = el('label', 'field');
      f.appendChild(el('span', undefined, label));
      f.appendChild(makeSelect(`part-${key}`, opts, cur, label, (v) => {
        const val = key === 'diskType' || key === 'raid' ? v : Number(v);
        const e = buyPart(d.id, key, val as never);
        if (e) { toast(e, 'error'); this.schedule(); }
        else toast(onBench(world.get(), d.id) ? `${d.name}: ${label.toLowerCase()} changed.` : `${d.name}: ${label.toLowerCase()} ordered. An engineer will fit it.`);
      }));
      hwSec.appendChild(f);
    };
    const opt = (key: PartSlot, value: string | number, label: string, gate: PartGate = 'base') => {
      const next = { ...P, [key]: value } as ServerParts;
      if (key === 'gpu') next.gpus = Number(value) === 0 ? 0 : Math.max(1, P.gpus);
      const cur = String(P[key]) === String(value);
      const open = gateOpen(gate, s.unlocks);
      const bad = cur ? null : partsProblem(next);
      const cost = swapCost(P, next);
      return { value: String(value), label: `${label}${cur ? '' : !open ? ` · locked (${GATE_NAME[gate]})` : bad ? ' ✕' : ` · $${cost}`}`, disabled: !cur && (!open || !!bad) };
    };
    slot('Chassis', 'chassis', CHASSIS.map((c, i) => opt('chassis', i, `${c.label}: ${c.bays} bays, ${c.gpuSlots} GPU, ${c.psuW} W PSU`, c.gate)), String(P.chassis));
    slot('CPU', 'cpu', CPU_PARTS.map((p, i) => opt('cpu', i, `${p.label} · ${p.tdp} W`, p.gate)), String(P.cpu));
    slot('Memory', 'ram', RAM_PARTS.map((p, i) => opt('ram', i, p.label, p.gate)), String(P.ram));
    slot('GPU', 'gpu', GPU_PARTS.map((p, i) => opt('gpu', i, i ? `${p.label} · ${p.watts} W` : p.label, p.gate)), String(P.gpu));
    if (P.gpu > 0) slot('GPU cards', 'gpus', Array.from({ length: CHASSIS[P.chassis]!.gpuSlots }, (_, i) => opt('gpus', i + 1, `${i + 1} card${i ? 's' : ''}`)), String(P.gpus));
    slot('Network card', 'nic', NIC_PARTS.map((p, i) => opt('nic', i, p.label, p.gate)), String(P.nic));
    slot('Ports', 'ports', [1, 2, 3, 4].map((n) => opt('ports', n, `${n} port${n > 1 ? 's' : ''} (eth0${n > 1 ? `–eth${n - 1}` : ''})`)), String(P.ports));
    slot('Drive size', 'disk', DISK_PARTS.map((p, i) => opt('disk', i, p.label, p.gate)), String(P.disk));
    slot('Drive type', 'diskType', (Object.keys(DISK_TYPES) as DiskType[]).map((t) => opt('diskType', t, `${DISK_TYPES[t].label} (speed ×${DISK_TYPES[t].speed}, ${DISK_TYPES[t].watts} W)`, DISK_TYPES[t].gate)), P.diskType);
    slot('Drives', 'disks', Array.from({ length: CHASSIS[P.chassis]!.bays }, (_, i) => opt('disks', i + 1, `${i + 1} × ${DISK_PARTS[P.disk]!.label}`)), String(P.disks));
    slot('RAID', 'raid', (Object.keys(RAID) as RaidLevel[]).map((r) => opt('raid', r, `${RAID[r].label}${RAID[r].min > 1 ? ` (${RAID[r].min}+ drives)` : ''}`)), P.raid);
    hwSec.appendChild(el('p', 'sub', `${RAID[P.raid].blurb} ${P.disks} × ${DISK_PARTS[P.disk]!.label} → ${tb(DISK_PARTS[P.disk]!.gb * RAID[P.raid].cap(P.disks))} usable, survives ${RAID[P.raid].tol(P.disks)} dead drive${RAID[P.raid].tol(P.disks) === 1 ? '' : 's'}, disk speed ×${(DISK_TYPES[P.diskType].speed * RAID[P.raid].io(P.disks)).toFixed(1)}. Changing the RAID level, drive model or removing drives rebuilds the array: data comes back only from a backup.`));
    if (CHASSIS[P.chassis]!.redundantOk) hwSec.appendChild(makeCheck('part-psu2', ` Redundant power supply ($${PSU2_PRICE}): keeps running when one PSU dies`, P.psu2, (v) => { const e = buyPart(d.id, 'psu2', v); if (e) { toast(e, 'error'); this.schedule(); } }));
    const peak = peakWatts(P), psu = CHASSIS[P.chassis]!.psuW;
    const cap = serverCaps(d);
    const kv = el('dl', 'kv');
    kv.innerHTML = `<dt>Power budget</dt><dd class="${peak > psu * 0.9 ? 'warn-t' : ''}">${peak} W peak of ${psu} W</dd><dt>Can serve</dt><dd>${mbps(cap.total)} (limit: ${cap.bottleneck})</dd><dt>Storage</dt><dd>${tb(d.specs.storageGB)} usable</dd><dt>Value</dt><dd>$${priceOf(d)}</dd>`;
    hwSec.appendChild(kv);

    // ── Parts and their condition
    const partsSec = section(heading('Parts', this.liveText(() => {
      const x = world.get().devices[d.id];
      if (x?.kind !== 'server') return '';
      const a = x.hw.array;
      return `${RAID[x.parts.raid].label} · ${a === 'rebuilding' ? `rebuilding ${Math.round(x.hw.rebuild * 100)} %` : a}`;
    })));
    partsSec.appendChild(this.liveBlock(() => this.partsTable(d.id)));
    const swapJob = Object.values(s.staff.jobs).find((j) => j.deviceId === d.id && j.kind === 'swap');
    if (swapJob) partsSec.appendChild(this.liveText(() => {
      const st = world.get();
      const j = st.staff.jobs[swapJob.id];
      if (!j) return '';
      const e = j.engineerId ? st.staff.engineers[j.engineerId] : undefined;
      return `Spare parts ordered (${j.cold ? 'needs downtime' : 'hot-swap'}): ${e ? `${e.name} ${engineerActivity(st, e)}${j.started ? ` · ${Math.ceil(j.workLeft / TICKS_PER_SEC)} s left` : ''}` : 'waiting for a free engineer'}.`;
    }, 'note'));

    // ── Agents
    const agSec = section('Agents');
    const servers = Object.values(s.devices).filter((x) => x.kind === 'server' && x.id !== d.id) as DeviceOf<'server'>[];
    const nasList = [...(d.roles.some((r) => r.role === 'nas') ? [d] : []), ...servers.filter((x) => x.roles.some((r) => r.role === 'nas'))];
    const sanList = servers.filter((x) => x.roles.some((r) => r.role === 'san'));
    const b = d.agents.backup;
    agSec.appendChild(makeCheck('ag-backup', ' Backup agent: copy this server to a NAS (tcp/445)', b.enabled, (v) => edit((x) => { x.agents.backup.enabled = v; if (v && !x.agents.backup.targetId) x.agents.backup.targetId = nasList[0]?.id ?? null; })));
    if (b.enabled) {
      const f = el('label', 'field');
      f.appendChild(el('span', undefined, 'Back up to'));
      f.appendChild(makeSelect('ag-backup-nas', [{ value: '', label: nasList.length ? 'choose a NAS' : 'no NAS server yet' }, ...nasList.map((x) => ({ value: x.id, label: x.id === d.id ? 'this server (same disks: quick, but lost with it)' : `${x.name} (${x.ip || 'no IP'})` }))], b.targetId ?? '', 'Backup target', (v) => edit((x) => { x.agents.backup.targetId = v || null; })));
      agSec.appendChild(f);
      agSec.appendChild(this.liveBlock(() => {
        const ok = backupOk(world.get(), runtime, d.id);
        const fl = Object.values(world.get().flows).find((x) => x.kind === 'backup' && x.origin === d.id);
        const p = fl ? runtime.paths[fl.id] : undefined;
        return el('div', `explain ${ok ? 'ok' : 'bad'}`, ok ? 'Backups are landing on the NAS. A reimage or disk loss restores without data loss.' : (p?.explain || 'Backup target not reachable: pick a NAS and make sure this server can reach it on tcp/445.'));
      }));
    }
    const fo = d.agents.failover;
    agSec.appendChild(makeCheck('ag-failover', ' Failover agent: a standby takes over this server\'s IP if it goes down', fo.enabled, (v) => edit((x) => { x.agents.failover.enabled = v; })));
    if (fo.enabled) {
      const f = el('label', 'field');
      f.appendChild(el('span', undefined, 'Standby'));
      f.appendChild(makeSelect('ag-fo-partner', [{ value: '', label: 'choose a server' }, ...servers.map((x) => ({ value: x.id, label: `${x.name} (${x.ip || 'no IP'})` }))], fo.partnerId ?? '', 'Standby server', (v) => edit((x) => { x.agents.failover.partnerId = v || null; })));
      agSec.appendChild(f);
      if (d.roles.some((r) => ROLES[r.role].stateful)) {
        const f2 = el('label', 'field');
        f2.appendChild(el('span', undefined, 'Shared SAN'));
        f2.appendChild(makeSelect('ag-fo-san', [{ value: '', label: sanList.length ? 'choose a SAN' : 'no SAN server yet' }, ...sanList.map((x) => ({ value: x.id, label: x.name }))], fo.sanId ?? '', 'Shared SAN', (v) => edit((x) => { x.agents.failover.sanId = v || null; })));
        agSec.appendChild(f2);
      }
      agSec.appendChild(this.liveBlock(() => {
        const st = world.get();
        const partner = fo.partnerId ? st.devices[fo.partnerId] : undefined;
        if (runtime.takeover[d.id]) return el('div', 'explain ok', `Failed over: ${st.devices[runtime.takeover[d.id]!]?.name} is answering for ${d.ip}.`);
        if (!partner) return el('div', 'explain bad', 'Pick a standby server with the same roles on the same subnet.');
        const r = failoverReady(st, buildCtx(st, runtime), st.devices[d.id]!, partner);
        return el('div', `explain ${r.ok ? 'ok' : 'bad'}`, r.why);
      }));
    }
    // monitoring agent
    const mon = d.agents.monitor ?? { enabled: false, masterIp: '' };
    if (!d.roles.some((r) => r.role === 'monitor')) {
      agSec.appendChild(makeCheck('ag-monitor', ` Monitoring agent: answers polls on tcp/${MON_AGENT_PORT}`, mon.enabled, (v) => edit((x) => { x.agents.monitor = { enabled: v, masterIp: x.agents.monitor?.masterIp ?? '' }; })));
      if (mon.enabled) {
        const f = el('label', 'field');
        f.appendChild(el('span', undefined, 'Master IP'));
        f.appendChild(makeInput('ag-mon-master', mon.masterIp, {
          placeholder: '192.168.10.60', ariaLabel: 'Monitoring master IP', check: checkIp(mon.masterIp, ''),
          onCommit: (v) => edit((x) => { x.agents.monitor = { enabled: true, masterIp: v.trim() }; }),
        }));
        agSec.appendChild(f);
        agSec.appendChild(el('p', 'sub', `The agent only answers polls from this address. Add ${d.ip || 'this server\'s IP'} as an agent target on the master.`));
      }
    }

    // ── Certificate
    const certSec = section(heading('Certificate', d.cert ? 'installed' : 'none'));
    certSec.appendChild(makeCheck('srv-cert', ` TLS certificate ($${CERT_PRICE}, $${CERT_UPKEEP}/s): websites answered here switch to HTTPS on tcp/443. Allow 443 on your firewall.`, !!d.cert, (v) => { const e = setCert(d.id, v); if (e) { toast(e, 'error'); this.schedule(); } }));
    certSec.appendChild(this.liveText(() => {
      const st = world.get();
      const here = Object.values(st.services).filter((v) => v.kind !== 'dns' && (v.flowIds ?? []).some((id) => runtime.paths[id]?.reachedServer === d.id));
      if (!here.length) return 'No visitors are answered by this server. Put the certificate on whatever visitors connect to: a reverse proxy needs one, the web servers behind it do not.';
      const names = here.map((v) => v.fqdn ?? `${st.devices[v.serverId]?.name} ${v.kind}`).join(', ');
      return d.cert ? `Answers ${names} with HTTPS: ×${CERT_BONUS} visitors and revenue.` : `Answers ${names}. A certificate here gives them ×${CERT_BONUS} visitors and revenue.`;
    }, 'note'));
    return [this.addressingSection(s, d), rolesSec, agSec, certSec, status(hwSec), status(partsSec)];
  }

  private partsTable(id: string): HTMLElement {
    const st = world.get();
    const d = st.devices[id];
    const box = el('div');
    if (d?.kind !== 'server') return box;
    const known = knownProblems(st, d);
    const smart = st.unlocks.monitoring && isMonitored(runtime, d.id);
    const down = serverDown(d, st.time.tick);
    if (down && !known.some((p) => p.level === 'alert')) {
      const b = el('div', 'explain bad', 'Not responding, and nobody knows why yet. Send an engineer to look, or set up monitoring so it reports problems.');
      box.appendChild(b);
      const ib = btn('Send an engineer to check', () => { const e = orderInspect(world.get(), id); if (e) toast(e, 'error'); }, 'ghost');
      box.appendChild(ib);
    }
    for (const p of known) {
      box.appendChild(el('div', `explain ${p.level === 'alert' ? 'bad' : 'warn'}`, `${p.msg}. ${p.via === 'monitoring' ? `Monitoring alert${p.ack ? `, seen by ${p.by}` : ', nobody at the console yet'}` : `Noticed by ${p.by}`}.`));
    }
    const t = el('table', 'talk');
    t.innerHTML = '<colgroup><col style="width:30%"><col style="width:34%"><col style="width:36%"></colgroup><tr><th>Part</th><th>Condition</th><th class="r">Spare</th></tr>';
    const jobComps = new Set(Object.values(st.staff.jobs).filter((j) => j.deviceId === id && j.kind === 'swap').flatMap((j) => j.comps ?? []));
    const knownFailed = new Set(known.flatMap((p) => (p.fix === 'swap' && p.level === 'alert' ? p.comps ?? [] : [])));
    for (const c of d.hw.comps) {
      const tr = document.createElement('tr');
      const failed = c.failed && knownFailed.has(c.id);
      const cond = failed ? '<span class="bad-t">FAILED</span>' : smart ? `<span class="${c.wear >= 0.75 ? 'warn-t' : ''}">${Math.round(c.wear * 100)} % worn</span>` : '<span class="sub">no data</span>';
      tr.innerHTML = `<td>${compName(d, c)}</td><td>${cond}</td><td class="r"></td>`;
      const cell = tr.lastElementChild as HTMLElement;
      if (jobComps.has(c.id)) cell.textContent = 'ordered';
      else {
        const b = btn(`$${compCost(d, c)}${hotSwap(d, c) ? ' hot' : ''}`, () => { let e: string | null = null; world.update((w) => { e = orderSwap(w, id, [c.id]); }); if (e) toast(e, 'error'); }, 'ghost', `Replace ${compName(d, c).toLowerCase()}${hotSwap(d, c) ? ' while it runs' : ' (needs downtime)'}`);
        b.style.padding = '2px 8px';
        cell.appendChild(b);
      }
      t.appendChild(tr);
    }
    box.appendChild(t);
    if (!smart) box.appendChild(el('p', 'sub', st.unlocks.monitoring ? 'Wear readings need the monitoring agent to answer a master\'s polls.' : `Wear readings (SMART) unlock with “${UNLOCK_SOURCE.monitoring ?? '?'}”.`));
    return box;
  }

  /** Commit an address typed as "ip/prefix"; complain instead of saving half of it. */
  private commitAddr(v: string, save: (ip: string, mask: string) => void): void {
    const r = parseAddr(v);
    if (typeof r === 'string') { toast(r, 'error'); this.schedule(); return; }
    save(r.ip, r.mask);
  }

  private monitorStatus(id: string): HTMLElement {
    return this.liveBlock(() => {
      const st = world.get();
      const d = st.devices[id];
      if (!d) return el('div');
      const m = runtime.monitored?.[id];
      if (m && runtime.monSilent?.[id]) return el('div', 'explain warn', `Not answering ${st.devices[m]?.name ?? '?'}'s polls: ${runtime.monWhy?.[id] ?? 'no reply'}. The master raises an alert; it cannot read wear until it answers again.`);
      if (m) return el('div', 'explain ok', m === id ? 'Monitoring master: it watches itself.' : `Watched by ${st.devices[m]?.name ?? '?'}: if anything breaks, an alert goes out straight away.`);
      return el('div', 'explain bad', `Not monitored (${runtime.monWhy?.[id] ?? 'no monitoring server'}). Nobody hears about a problem here until an engineer walks past.`);
    });
  }

  /** Settings that only some roles have: proxy rules, local DNS zone, mirror upstream. */
  private roleExtras(s: WorldState, d: DeviceOf<'server'>, role: RoleKind): HTMLElement | null {
    const r = d.roles.find((x) => x.role === role)!;
    const box = el('div');
    box.style.display = 'grid';
    box.style.gap = '5px';
    if (role === 'monitor') {
      box.appendChild(el('span', 'lbl', 'Poll targets: address → method'));
      (r.targets ?? []).forEach((t, i) => {
        const row = el('div', 'row mt-row');
        row.appendChild(makeInput(`mt-${t.id}-ip`, t.ip, { placeholder: '192.168.10.10', ariaLabel: 'Address to poll', check: checkIp(t.ip, ''), onCommit: (v) => editRole(d.id, 'monitor', (x) => { const y = x.targets?.[i]; if (y) y.ip = v.trim(); }) }));
        row.appendChild(makeSelect(`mt-${t.id}-m`, [{ value: 'agent', label: `Agent ${MON_AGENT_PORT}` }, { value: 'snmp', label: `SNMP ${SNMP_PORT}` }], t.method, 'Method', (v) => editRole(d.id, 'monitor', (x) => { const y = x.targets?.[i]; if (y) y.method = v as 'agent' | 'snmp'; })));
        row.appendChild(btn('✕', () => editRole(d.id, 'monitor', (x) => { x.targets?.splice(i, 1); }), 'icon-btn danger', 'Remove target'));
        box.appendChild(row);
        box.appendChild(this.liveText(() => {
          const st = runtime.monTargets?.[`${d.id}:${t.id}`];
          return st ? `${st.ok ? '✓' : '✕'} ${st.msg}` : t.ip ? 'polling…' : '';
        }, 'sub'));
      });
      box.appendChild(btn('+ Add target', () => editRole(d.id, 'monitor', (x) => { (x.targets ??= []).push({ id: genId('mt'), ip: '', method: 'agent' }); }), 'add'));
      box.appendChild(this.liveText(() => {
        const st = world.get();
        const watched = Object.entries(runtime.monitored ?? {}).filter(([, m]) => m === d.id).length;
        const quiet = Object.keys(runtime.monSilent ?? {}).filter((k) => runtime.monitored?.[k] === d.id).map((k) => st.devices[k]?.name ?? '?');
        const cons = Object.entries(runtime.consoles ?? {}).filter(([, m]) => m === d.id).map(([k]) => st.devices[k]?.name ?? '?');
        return `${watched ? `Hearing from ${watched} device${watched === 1 ? '' : 's'}` : 'Not hearing from anything yet'}${quiet.length ? `; silent: ${quiet.join(', ')}` : ''}. Servers answer through their agent, which needs this server's address (${d.ip || 'set one first'}). Routers, firewalls, desks and doors answer SNMP. Any firewall in between has to let the poll through. ${cons.length ? `The console is open on ${cons.join(', ')}, so staff there react to alerts.` : 'No desk can open the console (tcp/80) yet: you still get alerts, but your staff won\'t.'}`;
      }, 'note'));
      return box;
    }
    if (role === 'proxy') {
      box.appendChild(el('span', 'lbl', 'Public name → back ends (internal name or IP), one per row'));
      const names = allFqdns(s);
      const rules = r.rules ?? [];
      // rules sharing a public name form one group: the proxy balances over them and fails over
      const groups: { fqdn: string; ids: string[] }[] = [];
      for (const rule of rules) {
        const g = rule.fqdn ? groups.find((x) => x.fqdn === rule.fqdn) : undefined;
        if (g) g.ids.push(rule.id); else groups.push({ fqdn: rule.fqdn, ids: [rule.id] });
      }
      const editRules = (fn: (list: { id: string; fqdn: string; backend: string }[]) => void) =>
        editRole(d.id, 'proxy', (x) => { fn((x.rules ??= [])); });
      groups.forEach((g, gi) => {
        const card = el('div', 'card px-card');
        const head = el('div', 'row px-head');
        head.appendChild(makeSelect(`px-g${gi}-${g.ids[0]}-n`, [{ value: '', label: names.length ? 'choose a name' : 'no domains yet' }, ...[...names, ...(g.fqdn && !names.includes(g.fqdn) ? [g.fqdn] : [])].map((n) => ({ value: n, label: n }))], g.fqdn, 'Public name',
          (v) => editRules((list) => { for (const y of list) if (g.ids.includes(y.id)) y.fqdn = v; })));
        head.appendChild(btn('✕', () => editRules((list) => { for (let i = list.length - 1; i >= 0; i--) if (g.ids.includes(list[i]!.id)) list.splice(i, 1); }), 'icon-btn danger', 'Delete this name and all its back ends'));
        card.appendChild(head);
        g.ids.forEach((id, bi) => {
          const rule = rules.find((y) => y.id === id)!;
          const row = el('div', 'row px-be');
          row.appendChild(el('span', 'px-n', bi === 0 ? '→' : String(bi + 1)));
          row.appendChild(makeInput(`px-${id}-b`, rule.backend, {
            placeholder: bi === 0 ? 'app1.lan or 192.168.10.10' : 'another back end', ariaLabel: `Back end ${bi + 1}`,
            onCommit: (v) => editRules((list) => {
              const i = list.findIndex((y) => y.id === id);
              if (i < 0) return;
              const parts = v.split(/[\s,]+/).filter(Boolean);
              list[i]!.backend = parts[0] ?? '';
              list.splice(i + 1, 0, ...parts.slice(1).map((b) => ({ id: genId('rule'), fqdn: list[i]!.fqdn, backend: b })));
            }),
          }));
          row.appendChild(btn('✕', () => editRules((list) => { const i = list.findIndex((y) => y.id === id); if (i >= 0) list.splice(i, 1); }), 'icon-btn danger', 'Remove this back end'));
          card.appendChild(row);
        });
        const foot = el('div', 'row px-foot');
        foot.appendChild(btn('+ Add back end', () => editRules((list) => {
          let last = -1;
          list.forEach((y, i) => { if (g.ids.includes(y.id)) last = i; });
          list.splice(last + 1, 0, { id: genId('rule'), fqdn: g.fqdn, backend: '' });
        }), 'add', 'Another back end for the same name: load is balanced and it takes over if one dies'));
        foot.appendChild(this.liveText(() => {
          if (!g.fqdn) return '';
          const v = Object.values(world.get().services).find((y) => y.fqdn === g.fqdn);
          if (!v) return `No service uses ${g.fqdn} yet: set it as a service's domain name.`;
          const c = runtime.proxyChk[`${v.id}@${d.id}`];
          return c ? `${c.ok ? '✓' : '✕'} ${c.why}` : 'checking…';
        }, 'sub'));
        card.appendChild(foot);
        box.appendChild(card);
      });
      box.appendChild(btn('+ Add name', () => editRules((list) => { list.push({ id: genId('rule'), fqdn: '', backend: '' }); }), 'add'));
      box.appendChild(el('p', 'note', 'With more than one server behind a name, visitors are spread across them, and a server that stops answering simply stops getting any. Names like app1.lan are looked up through this server\'s DNS server. To share the work between several proxies too, give the domain one record per proxy.'));
      return box;
    }
    if (role === 'dns_local') {
      box.appendChild(el('span', 'lbl', 'Local zone'));
      (r.records ?? []).forEach((rec, i) => {
        const row = el('div', 'row nat-row');
        row.appendChild(makeInput(`dl-${rec.id}-n`, rec.name, { placeholder: 'app1.lan', ariaLabel: 'Name', onCommit: (v) => editRole(d.id, 'dns_local', (x) => { const y = x.records?.[i]; if (y) y.name = v.toLowerCase(); }) }));
        row.appendChild(el('span', 'arrow', '→'));
        row.appendChild(makeInput(`dl-${rec.id}-ip`, rec.ip, { placeholder: '192.168.10.20', ariaLabel: 'IP', check: checkIp(rec.ip, ''), onCommit: (v) => editRole(d.id, 'dns_local', (x) => { const y = x.records?.[i]; if (y) y.ip = v; }) }));
        row.appendChild(btn('✕', () => editRole(d.id, 'dns_local', (x) => { x.records?.splice(i, 1); }), 'icon-btn danger', 'Delete record'));
        box.appendChild(row);
      });
      box.appendChild(btn('+ Add record', () => editRole(d.id, 'dns_local', (x) => { (x.records ??= []).push({ id: genId('rec'), name: '', ip: '' }); }), 'add'));
      box.appendChild(el('p', 'note', `Hosts use it when their DNS server is ${d.ip || 'this server\'s IP'}. Names it does not know are forwarded to the internet, if this server can reach it.`));
      return box;
    }
    if (role === 'mirror') {
      const proxies = Object.values(s.devices).filter((x): x is DeviceOf<'server'> => x.kind === 'server' && x.roles.some((y) => y.role === 'fwd_proxy'));
      const f = el('label', 'field');
      f.appendChild(el('span', undefined, 'Internet via'));
      f.appendChild(makeSelect('mirror-up', [{ value: 'direct', label: 'direct (needs NAT)' }, ...proxies.map((x) => ({ value: x.id, label: `forward proxy ${x.name}` }))], r.upstream ?? 'direct', 'Upstream', (v) => editRole(d.id, 'mirror', (x) => { x.upstream = v as 'direct'; })));
      box.appendChild(f);
      box.appendChild(this.liveBlock(() => {
        const m = runtime.mirrorOk[d.id];
        const st = world.get();
        const role = (st.devices[d.id] as DeviceOf<'server'> | undefined)?.roles.find((x) => x.role === 'mirror');
        const have = role?.cachedRelease ?? 0;
        const rel = st.staff.release;
        const cache = have >= rel ? `Holds release #${rel}.` : role?.fetchLeft !== undefined ? `Downloading release #${rel}… ${Math.ceil(role.fetchLeft / TICKS_PER_SEC)} s left.` : `Does not have release #${rel} yet.`;
        return el('div', `explain ${m?.ok ? 'ok' : 'bad'}`, m ? (m.ok ? `${m.why} ${cache} Devices fetch from it when their update source is ${d.ip || 'its IP'}.` : `${m.why} ${cache}`) : 'Checking…');
      }));
      return box;
    }
    return null;
  }

  /** Pick the back-end servers a role talks to, with live reachability. */
  private linkEditor(s: WorldState, d: DeviceOf<'server'>, r: ServerRole): HTMLElement {
    const role = r.role;
    const key = roleKey(r);
    const def = ROLES[role];
    const box = el('div');
    box.style.display = 'grid';
    box.style.gap = '4px';
    const wanted = def.linksTo!.map((k) => ROLES[k].label).join(' or ');
    const cands = Object.values(s.devices).filter((x): x is DeviceOf<'server'> => x.kind === 'server' && x.roles.some((y) => def.linksTo!.includes(y.role)));
    box.appendChild(el('span', 'lbl', `${def.multiLink ? 'Uses' : 'Uses'} ${wanted}${def.multiLink ? ' (pick several)' : ''}`));
    if (!cands.length) {
      box.appendChild(el('p', 'note warn-t', `No server runs ${wanted} yet. Add that role here or on another server.`));
      return box;
    }
    if (def.multiLink) {
      for (const c of cands) {
        box.appendChild(makeCheck(`link-${role}-${c.id}`, ` ${c.id === d.id ? 'this server' : c.name}${c.kind === 'server' && role === 'orchestrator' ? ` · ${c.specs.gpuTflops} TFLOPS` : ''}`, r.links.includes(c.id),
          (v) => setRoleLinks(d.id, key, v ? [...r.links, c.id] : r.links.filter((x) => x !== c.id))));
      }
    } else {
      const f = el('label', 'field');
      f.appendChild(el('span', undefined, 'Back end'));
      f.appendChild(makeSelect(`link-${role}`, [{ value: '', label: 'choose…' }, ...cands.map((c) => ({ value: c.id, label: c.id === d.id ? 'this server' : `${c.name} (${c.extra[0]?.ip || c.ip || 'no IP'})` }))], r.links[0] ?? '', `${def.label} back end`, (v) => setRoleLinks(d.id, key, v ? [v] : [])));
      box.appendChild(f);
    }
    box.appendChild(this.liveBlock(() => {
      const st = runtime.roleLinks[`${d.id}:${key}`];
      const out = el('div', 'derived');
      if (!r.links.length) { out.appendChild(el('span', 'warn-t', 'Not linked yet.')); return out; }
      for (const id of st?.ok ?? []) out.appendChild(el('span', 'ok-t', `✓ ${id === d.id ? 'this server (local)' : world.get().devices[id]?.name ?? id}`));
      for (const b of st?.bad ?? []) out.appendChild(el('span', 'bad-t', `✕ ${b.why}`));
      if (!st) out.appendChild(el('span', 'note', 'Checking…'));
      return out;
    }));
    return box;
  }

  private budgetMeters(use: { cores: number; ramGB: number; diskGB: number }, sp: { cpuCores: number; ramGB: number; storageGB: number }): HTMLElement {
    const box = el('div');
    box.style.display = 'grid';
    box.style.gap = '4px';
    const m = (label: string, a: number, b: number, unit: string) => {
      const row = el('div', 'meter');
      row.appendChild(el('span', undefined, label));
      const bar = el('div', 'bar');
      const i = el('i');
      const f = a / Math.max(1, b);
      i.style.width = `${Math.min(100, f * 100)}%`;
      i.style.background = f > 1 ? 'var(--bad)' : f > 0.8 ? 'var(--warn)' : 'var(--accent)';
      bar.appendChild(i);
      row.appendChild(bar);
      row.appendChild(el('span', 'v', `${a} / ${b} ${unit}`));
      box.appendChild(row);
    };
    m('Cores', use.cores, sp.cpuCores, '');
    m('RAM', use.ramGB, sp.ramGB, 'GB');
    m('Disk', use.diskGB, sp.storageGB, 'GB');
    return box;
  }

  private towerBody(s: WorldState, d: DeviceOf<'tower'>): HTMLElement[] {
    const def = ACCESS[d.access];
    const intro = section(d.access === 'cell' ? 'Cell site' : 'Home networks',
      el('p', 'note', `You are the ISP for these customers. ${d.access === 'cell' ? 'A cell site pushes heavy mobile traffic with evening peaks and sudden spikes.' : 'A street of home broadband customers.'} Their traffic must be routed through your network to the ISP gateway. You earn $${def.payPerMbps}/s per Mbps carried, plus a bonus while 99 % or more gets out. Once it has gone live, every outage longer than 10 s costs an SLA penalty of $${def.penalty}/s.`),
      el('p', 'note', 'Give it an IP and a gateway. If the address is private, add a static NAT entry on your edge device: the ISP drops private sources. It shares the uplink with your websites, so plan bandwidth.'),
    );
    const v = () => { const x = world.get().devices[d.id]; return x?.kind === 'tower' ? x : undefined; };
    const stats = el('dl', 'kv');
    const row = (label: string, fn: () => string) => { stats.appendChild(el('dt', undefined, label)); const dd = el('dd'); dd.appendChild(this.liveText(fn, '')); stats.appendChild(dd); };
    row('Subscriber load', () => { const x = v(); const f = x?.subs.flowId ? world.get().flows[x.subs.flowId] : undefined; return f ? mbps(f.rateMbps) : '—'; });
    row('Getting out', () => { const x = v(); return x ? `${Math.round(x.subs.availability * 100)} %` : ''; });
    row('Earning', () => { const x = v(); if (!x) return ''; const pen = towerPenalty(x); return pen ? `SLA penalty −${money(pen)}/s` : `${money(towerRevenue(world.get(), x))}/s`; });
    row('Spike', () => { const x = v(); return x && world.get().time.tick < x.subs.spikeUntil ? `yes, ${Math.ceil((x.subs.spikeUntil - world.get().time.tick) / TICKS_PER_SEC)} s left` : 'none'; });
    row('Reputation', () => { const x = v(); return x ? `${x.subs.reputation.toFixed(2)} (demand ${x.subs.demand.toFixed(2)})` : ''; });
    const subs = section(heading('Subscribers', this.liveText(() => { const x = v(); return x && x.subs.availability >= 0.99 ? 'uptime bonus on' : 'no uptime bonus'; })), stats);
    subs.appendChild(el('h3', undefined, 'Path check'));
    subs.appendChild(this.liveBlock(() => {
      const x = v();
      return renderTrace(world.get(), x?.subs.flowId ? runtime.paths[x.subs.flowId] : undefined, true);
    }));
    return [intro, ...(d.far ? [this.farSection(s, d)] : []), this.addressingSection(s, d), subs];
  }

  /** A site across town: where it is, and the leased line that brings it in. */
  private farSection(s: WorldState, d: DeviceOf<'tower'>): HTMLElement {
    const line = Object.values(s.cables).find((c) => c.leased && (c.a.deviceId === d.id || c.b.deviceId === d.id));
    const sec = section(heading('Across town', d.far!.place));
    sec.appendChild(el('p', 'note', `Off the map in ${d.far!.place}, about ${d.far!.travelS} s away by van. An engineer who goes there to fix it is away for the drive both ways.`));
    if (line) {
      const end = line.a.deviceId === d.id ? line.b : line.a;
      const at = s.devices[end.deviceId];
      sec.appendChild(el('p', 'explain ok', `Leased line (${LEASED_LINE.mbps} Mbps, $${LEASED_LINE.upkeep}/s) arrives at ${at?.name ?? '?'} ${at?.ports[end.port]?.label ?? ''}.`));
      sec.appendChild(btn('Cancel the line', () => deleteCable(line.id), 'danger'));
      return sec;
    }
    sec.appendChild(el('p', 'explain bad', 'No line yet: its customers can\'t reach anything. Bring the line in on a free fibre port of a router, firewall or switch.'));
    const used = new Set(Object.values(s.cables).flatMap((c) => [`${c.a.deviceId}:${c.a.port}`, `${c.b.deviceId}:${c.b.port}`]));
    const opts: { value: string; label: string }[] = [];
    for (const x of Object.values(s.devices)) {
      if (x.id === d.id || (x.kind === 'tower' && x.far) || !['router', 'firewall', 'switch', 'uplink', 'ddos_scrubber'].includes(x.kind)) continue;
      x.ports.forEach((p, i) => { if (p.media === 'fibre' && !used.has(`${x.id}:${i}`)) opts.push({ value: `${x.id}:${i}`, label: `${x.name} ${p.label}` }); });
    }
    if (!opts.length) { sec.appendChild(el('p', 'note', 'None of your routers, firewalls or switches has a free fibre port. Fit a fibre transceiver on one (Hardware tab).')); return sec; }
    sec.appendChild(makeSelect(`far-${d.id}`, [{ value: '', label: 'Bring the line in at…' }, ...opts], '', 'Leased line port', (v) => {
      if (!v) return;
      const [id, port] = v.split(':');
      if (leaseLine(d.id, { deviceId: id!, port: Number(port) })) toast(`Leased line to ${d.name} is in.`, 'good');
    }));
    return sec;
  }

  private deskBody(s: WorldState, d: DeviceOf<'desk'>): HTMLElement[] {
    const owner = d.ownerId ? s.staff.engineers[d.ownerId] : undefined;
    const who = section('Workstation',
      el('p', 'note', owner ? `${owner.name} sits here.` : 'Free. The next engineer without a desk will take it.'),
      el('p', 'note', 'From this PC the engineer patches servers, routers, firewalls and other PCs over SSH (tcp/22), without walking over. Repairs still need someone on site.'),
    );
    const reach = section('Remote access', this.liveBlock(() => {
      const st = world.get();
      const box = el('div', 'derived');
      const targets = Object.values(st.devices).filter((x) => x.sw && x.id !== d.id);
      if (!targets.length) { box.appendChild(el('span', 'note', 'Nothing to manage yet.')); return box; }
      for (const t of targets.slice(0, 10)) {
        const ok = deskReaches(st, runtime, st.devices[d.id]!, t);
        box.appendChild(el('span', ok ? 'ok-t' : 'bad-t', `${ok ? '✓' : '✕'} ${t.name}`));
      }
      return box;
    }));
    return [who, this.addressingSection(s, d), reach];
  }

  private softwareSection(s: WorldState, d: Device): HTMLElement | null {
    if (!d.sw) return null;
    const sec = section(heading('Software', this.liveText(() => {
      const x = world.get().devices[d.id];
      if (!x?.sw) return '';
      const rel = world.get().staff.release;
      if (x.sw.patch >= rel) return `release #${rel} · up to date`;
      return isVulnerable(world.get(), x) ? `release #${x.sw.patch} · VULNERABLE` : `release #${x.sw.patch} · update #${rel} available`;
    })));
    if (d.compromised) {
      sec.appendChild(el('div', 'explain bad', `Compromised: ${d.compromised.label}. ${d.kind === 'desk' ? 'The attacker uses this PC to probe servers over SMB (tcp/445). ' : 'Its services are offline. '}An engineer has to reimage it on site.`));
      const job = Object.values(s.staff.jobs).find((j) => j.deviceId === d.id && j.kind === 'reimage');
      if (!job) sec.appendChild(btn('Send an engineer to reimage it', () => { let e: string | null = null; world.update((w) => { e = orderReimage(w, d.id); }); if (e) toast(e, 'error'); }, 'add'));
    }
    const job = Object.values(s.staff.jobs).find((j) => j.deviceId === d.id && j.kind === 'update');
    if (d.sw.patch < s.staff.release && !job) {
      sec.appendChild(btn('Push update', () => { let e: string | null = null; world.update((w) => { e = orderUpdate(w, d.id); }); if (e) toast(e, 'error'); }, 'add', 'Queue the update for an engineer'));
    }
    const f = el('label', 'field');
    f.appendChild(el('span', undefined, 'Update source'));
    f.appendChild(makeInput('sw-src', d.updateSrc ?? '', {
      placeholder: 'internet (tcp/443)', ariaLabel: 'Update source', check: d.updateSrc ? checkIp(d.updateSrc, '') : null,
      onCommit: (v) => world.update((w) => { const x = w.devices[d.id]; if (x) x.updateSrc = v.trim(); }),
    }));
    sec.appendChild(f);
    sec.appendChild(el('p', 'sub', d.updateSrc?.trim()
      ? `Updates come from the mirror at ${d.updateSrc.trim()} (port 8080), so patching takes half as long.`
      : 'Updates come straight from the internet (port 443), so this machine needs a route out through NAT. Or enter an update mirror\'s address.'));
    sec.appendChild(this.liveBlock(() => {
      const st = world.get();
      const j = Object.values(st.staff.jobs).find((x) => x.deviceId === d.id && x.kind === 'update');
      if (j?.waitWhy && (j.started || j.retryAt !== undefined)) return el('div', 'explain warn', `Patch waiting: ${j.waitWhy}${!j.started && j.retryAt ? ` Retrying in ${Math.max(0, Math.ceil((j.retryAt - st.time.tick) / TICKS_PER_SEC))} s.` : ''}`);
      return el('span');
    }));
    sec.appendChild(this.liveText(() => {
      const st = world.get();
      const j = Object.values(st.staff.jobs).find((x) => x.deviceId === d.id);
      if (!j) return st.staff.autoPatch ? 'Engineers patch new releases automatically (Staff tab).' : 'Auto-patching is off.';
      const e = j.engineerId ? st.staff.engineers[j.engineerId] : undefined;
      if (!e) return j.retryAt !== undefined && st.time.tick < j.retryAt ? 'On hold: the update couldn\'t be downloaded, so the engineer is doing something else for now.' : 'Queued: waiting for a free engineer.';
      if (j.kind === 'update' && j.started && !j.waitWhy) return `${e.name} is patching it${j.remote ? ' remotely from a desk' : ' on site'}; the release is downloading.`;
      return j.remote ? `${e.name} is patching it remotely from a desk.` : j.started ? `${e.name} is working on it on site.` : `${e.name} is on the way.`;
    }, 'note'));
    return sec;
  }

  private routerBody(s: WorldState, d: DeviceOf<'router'>): HTMLElement[] {
    const edit = (fn: (x: DeviceOf<'router'>) => void) => editDevice(d.id, 'router', fn);
    const ifSec = section('Interfaces');
    ifSec.appendChild(el('p', 'note', 'Each port is its own subnet. The router\'s IP on a port is the gateway for devices on that side.'));
    for (const itf of d.interfaces) {
      const label = d.ports[itf.port]!.label;
      const ipCheck = (itf.ip ? checkAddr(itf.ip, itf.mask) : null) ?? duplicateCheck(s, itf.ip, `${d.name} ${label}`);
      const row = el('div', 'row if-row');
      const pl = el('span', 'pl');
      pl.innerHTML = `${label}<br><span class="side">${SIDE_NAME[portSide(d, itf.port)]}</span>`;
      row.appendChild(pl);
      row.appendChild(makeInput(`rt-${itf.port}-ip`, addrText(itf.ip, itf.mask), { placeholder: 'unassigned, e.g. 192.168.10.1/24', ariaLabel: `${label} address`, check: ipCheck, onCommit: (v) => this.commitAddr(v, (ip, mask) => edit((x) => { x.interfaces[itf.port]!.ip = ip; x.interfaces[itf.port]!.mask = mask; })) }));
      ifSec.appendChild(row);
      if (s.unlocks.dhcp && itf.ip) ifSec.appendChild(makeCheck(`rt-${itf.port}-dhcp`, ` DHCP server on ${label}`, itf.dhcp.enabled, (v) => edit((x) => { x.interfaces[itf.port]!.dhcp.enabled = v; })));
      const msgs = makeMsgs([ipCheck, overlapCheck(d, itf.port)]);
      if (msgs) ifSec.appendChild(msgs);
    }
    if (!s.unlocks.dhcp) ifSec.appendChild(el('p', 'locked', `DHCP server: ${lockedMsg('dhcp')}`));
    return [ifSec, this.subifSection(s, d), this.routesSection(d), this.natSection(d)];
  }

  private climateSection(d: Device): HTMLElement | null {
    if (d.kind === 'uplink' || d.kind === 'ac') return null;
    const cur = () => world.get().devices[d.id];
    const sec = section(heading('Temperature', this.liveText(() => {
      const x = cur();
      return x ? `${(x.temp ?? 0).toFixed(1)} °C · room ${roomTemp(world.get(), runtime, x.gridPos).toFixed(1)} °C` : '';
    })));
    if (d.kind !== 'server') {
      sec.appendChild(this.liveMeter('Device', () => (cur()?.temp ?? 0) / THROTTLE_C, () => `${Math.round(cur()?.temp ?? 0)} / ${THROTTLE_C} °C`));
      sec.appendChild(this.liveText(() => {
        const x = cur();
        if (!x) return '';
        return `Draws ${Math.round(wattsOf(x))} W, all of it ends up as heat in the room. It runs hotter than the room by its watts × ${DEVICE_WATTS[x.kind].r} °C/W, wears faster when hot (life halves every 10 °C) and shuts down at ${THROTTLE_C} °C.`;
      }, 'note'));
      return sec;
    }
    const srv = () => { const x = cur(); return x?.kind === 'server' ? x : null; };
    sec.appendChild(this.liveMeter('CPU', () => (srv()?.hw.cpuTemp ?? 0) / SHUTDOWN_C, () => `${Math.round(srv()?.hw.cpuTemp ?? 0)} °C`));
    if (d.parts.gpus) sec.appendChild(this.liveMeter('GPU', () => (srv()?.hw.gpuTemp ?? 0) / SHUTDOWN_C, () => `${Math.round(srv()?.hw.gpuTemp ?? 0)} °C`));
    sec.appendChild(this.liveMeter('Fans', () => srv()?.hw.fan ?? 0, () => `${Math.round((srv()?.hw.fan ?? 0) * 100)} %`, false, true));
    sec.appendChild(this.liveMeter('Clock', () => srv()?.hw.clock ?? 1, () => `${Math.round((srv()?.hw.clock ?? 1) * 100)} %`, true));
    sec.appendChild(this.liveText(() => {
      const x = srv();
      if (!x) return '';
      const pw = serverPower(x);
      const ch = CHASSIS[x.parts.chassis]!;
      if (x.hw.off) return `Powered off: ${OFF_LABEL[x.hw.off]}.`;
      return `Draws ${Math.round(x.hw.watts)} W (CPU ${Math.round(pw.cpu)} W${x.parts.gpus ? `, GPU ${Math.round(pw.gpu)} W` : ''}). CPU = inlet air + CPU watts × ${ch.cpuR} °C/W (${ch.label} cooler, better with fans up). Throttles at ${THROTTLE_C} °C, shuts down at ${SHUTDOWN_C} °C. Heat wears parts: life halves every 10 °C.`;
    }, 'note'));
    if (world.get().unlocks.throttling) {
      const f = el('label', 'field');
      f.appendChild(el('span', undefined, 'Temp cap'));
      const opts = [{ value: '', label: `Off (hardware limit ${THROTTLE_C} °C)` }];
      for (let t = TEMP_CAP_RANGE[0]; t <= TEMP_CAP_RANGE[1]; t += 5) opts.push({ value: String(t), label: `${t} °C` });
      f.appendChild(makeSelect('srv-tcap', opts, d.hw.tempCap ? String(d.hw.tempCap) : '', 'Temperature cap', (v) => editDevice(d.id, 'server', (x) => { x.hw.tempCap = v ? Number(v) : null; })));
      sec.appendChild(f);
      sec.appendChild(el('p', 'sub', 'Near the cap the server lowers its clock. Power drops with clock^2.5, performance only with the clock: cooler, longer-lived parts for a little less capacity.'));
    } else sec.appendChild(el('p', 'locked', `Temperature cap (throttling): ${lockedMsg('throttling')}`));
    return sec;
  }

  private badgeBody(s: WorldState, d: DeviceOf<'badge'>): HTMLElement[] {
    const edit = (fn: (x: DeviceOf<'badge'>) => void) => editDevice(d.id, 'badge', fn);
    const sec = section('Door control',
      el('p', 'note', 'This door has a built-in badge controller with a network port (eth0). Cable it to a switch, give it an IP, and point it at an Auth server: every badge is checked over LDAP (tcp/389). If it cannot reach one, the door falls back to its fail mode.'),
      makeField('Auth server', d.authIp, { id: 'bd-auth', placeholder: '192.168.10.30', check: checkIp(d.authIp, 'IP of a server running the Auth role'), onCommit: (v) => edit((x) => { x.authIp = v; }) }),
    );
    const seg = el('div', 'seg');
    for (const m of ['open', 'closed'] as const) {
      const b = btn(m === 'open' ? 'Fail open (anyone gets in)' : 'Fail closed (nobody gets in)', () => edit((x) => { x.failMode = m; }));
      b.setAttribute('aria-pressed', String(d.failMode === m));
      seg.appendChild(b);
    }
    sec.appendChild(seg);
    sec.appendChild(this.liveBlock(() => {
      const box = el('div', 'derived');
      const st = runtime.doors[`${d.gridPos.gx},${d.gridPos.gy}`];
      if (st) box.appendChild(el('span', st.state === 'locked' ? 'ok-t' : 'bad-t', `${st.state === 'locked' ? 'Locked' : st.state === 'sealed' ? 'Sealed' : 'Unlocked'}: ${st.why}`));
      return box;
    }));
    const net: HTMLElement[] = [];
    const n = section('Network');
    n.appendChild(makeField('Address', addrText(d.ip, d.mask), { id: 'bd-ip', placeholder: '192.168.10.60/24', check: checkAddr(d.ip, d.mask) ?? duplicateCheck(s, d.ip, d.name), onCommit: (v) => this.commitAddr(v, (ip, mask) => edit((x) => { x.ip = ip; x.mask = mask; })) }));
    n.appendChild(makeField('Gateway', d.gateway, { id: 'bd-gw', placeholder: '192.168.10.1', onCommit: (v) => edit((x) => { x.gateway = v; }) }));
    net.push(n);
    return [sec, ...net];
  }

  private acBody(d: DeviceOf<'ac'>): HTMLElement[] {
    const sec = section('Cooling',
      el('p', 'note', `Removes up to ${AC_COOLING_KW} kW of heat from the room it stands in, roughly what 4–5 busy servers make. Stops cooling below 16 °C.`),
      makeCheck('ac-on', ' Running', d.on, (v) => editDevice(d.id, 'ac', (x) => { x.on = v; })),
      this.liveText(() => { const x = world.get().devices[d.id]; return x ? `Room air: ${roomTemp(world.get(), runtime, x.gridPos).toFixed(1)} °C · outside ${world.get().climate.outside.toFixed(1)} °C` : ''; }, 'note'),
    );
    return [sec];
  }

  private switchBody(d: DeviceOf<'switch'>): HTMLElement[] {
    const s = world.get();
    const stpSec = section(heading('Spanning tree', d.stp ? 'RSTP on' : 'off'),
      el('p', 'note', 'Cable switches in a ring for redundancy. Spanning tree blocks the extra links so frames do not loop, and opens one when an active link fails. Without it, a loop causes a broadcast storm that takes down the whole switch network.'),
      makeCheck('sw-stp', ' Run spanning tree on this switch', d.stp, (v) => editDevice(d.id, 'switch', (x) => { x.stp = v; })),
      this.liveBlock(() => {
        const box = el('div', 'derived');
        if (runtime.storm[d.id]) { box.appendChild(el('span', 'bad-t', 'BROADCAST STORM: this switch is in a loop and STP is off somewhere in it.')); return box; }
        const mine = Object.entries(runtime.stpBlocked).filter(([cid]) => { const c = world.get().cables[cid]; return c && (c.a.deviceId === d.id || c.b.deviceId === d.id); });
        if (!mine.length) box.appendChild(el('span', 'note', 'No blocked links: no loop through this switch.'));
        for (const [cid, by] of mine) {
          const c = world.get().cables[cid]!;
          const other = c.a.deviceId === d.id ? c.b : c.a;
          const mineEnd = c.a.deviceId === d.id ? c.a : c.b;
          box.appendChild(el('span', 'warn-t', `${d.ports[mineEnd.port]?.label} ↔ ${world.get().devices[other.deviceId]?.name}: blocked by STP${by === d.id ? ' (here)' : ''}, standing by`));
        }
        return box;
      }),
    );
    return [this.vlanPortsSection(s, d), stpSec, ...this.switchForwarding(s, d)];
  }

  /** Per port: access (one VLAN) or trunk (tagged VLANs to another switch or a router). */
  private vlanPortsSection(s: WorldState, d: DeviceOf<'switch'>): HTMLElement {
    const vids = new Set<number>([1]);
    for (const v of Object.values(d.vlans ?? {})) if (v.mode === 'access') vids.add(v.vid);
    const sec = section(heading('VLANs', vids.size > 1 ? [...vids].sort((a, b) => a - b).join(', ') : 'all ports in VLAN 1'));
    sec.appendChild(el('p', 'note', 'Each VLAN is its own network on the same switch. Access ports belong to one VLAN; a trunk carries several, tagged, to another switch or to a router with VLAN sub-interfaces.'));
    const edit = (port: number, fn: (v: { mode: 'access' | 'trunk'; vid: number; allowed: string }) => void) =>
      editDevice(d.id, 'switch', (x) => { const all = (x.vlans ??= {}); const cur = all[port] ?? { mode: 'access', vid: 1, allowed: 'all' }; fn(cur); all[port] = cur; });
    for (const p of d.ports) {
      const v = d.vlans?.[p.index] ?? { mode: 'access' as const, vid: 1, allowed: 'all' };
      const cab = Object.values(s.cables).find((c) => (c.a.deviceId === d.id && c.a.port === p.index) || (c.b.deviceId === d.id && c.b.port === p.index));
      const peer = cab ? s.devices[cab.a.deviceId === d.id ? cab.b.deviceId : cab.a.deviceId]?.name : undefined;
      const row = el('div', 'row vlan-row');
      const pl = el('span', 'pl');
      pl.innerHTML = `${p.label}<br><span class="side">${peer ? '' : 'free'}</span>`;
      if (peer) (pl.querySelector('.side') as HTMLElement).textContent = peer;
      row.appendChild(pl);
      row.appendChild(makeSelect(`vl-${p.index}-m`, [{ value: 'access', label: 'access' }, { value: 'trunk', label: 'trunk' }], v.mode, `${p.label} mode`, (m) => edit(p.index, (x) => { x.mode = m as 'access' | 'trunk'; })));
      if (v.mode === 'access') {
        row.appendChild(makeInput(`vl-${p.index}-v`, String(v.vid), {
          placeholder: '1', ariaLabel: `${p.label} VLAN`,
          onCommit: (t) => { const n = Number(t); if (Number.isInteger(n) && n >= 1 && n <= 4094) edit(p.index, (x) => { x.vid = n; }); else { toast('A VLAN is a number from 1 to 4094', 'error'); this.schedule(); } },
        }));
      } else {
        row.appendChild(makeInput(`vl-${p.index}-a`, v.allowed, {
          placeholder: 'all, or 10,20,30-35', ariaLabel: `${p.label} allowed VLANs`,
          check: /^\s*(all|\d+(-\d+)?(\s*,\s*\d+(-\d+)?)*)\s*$/i.test(v.allowed || 'all') ? null : { level: 'bad', msg: 'Use all, or a list like 10,20,30-35' },
          onCommit: (t) => edit(p.index, (x) => { x.allowed = t.trim() || 'all'; }),
        }));
      }
      sec.appendChild(row);
    }
    return sec;
  }

  /** Site-to-site VPNs: encrypted tunnels to your other buildings or to customers. */
  private vpnSection(s: WorldState, d: DeviceOf<'firewall'>): HTMLElement {
    const vpns = d.vpns ?? [];
    const sec = section(heading('Site-to-site VPN', vpns.length ? this.liveText(() => `${vpns.filter((v) => runtime.vpnUp?.[`${d.id}:${v.id}`]?.up).length} of ${vpns.length} up`) : 'none'));
    sec.appendChild(el('p', 'note', 'An encrypted tunnel across the internet: traffic for the remote network goes into it here and comes out at the other end. Both ends need each other\'s public address, the same key, and the networks the other way round. The peer must reach this firewall on UDP 500 and 4500.'));
    const edit = (fn: (x: DeviceOf<'firewall'>) => void) => editDevice(d.id, 'firewall', fn);
    vpns.forEach((v, i) => {
      const upd = (fn: (y: NonNullable<typeof d.vpns>[number]) => void) => edit((x) => { const y = x.vpns?.[i]; if (y) fn(y); });
      const card = el('div', 'card');
      const r1 = el('div', 'row vpn-row');
      r1.appendChild(makeInput(`vpn-${v.id}-peer`, v.peer, { placeholder: 'peer public IP', ariaLabel: 'Peer public IP', check: v.peer ? checkIp(v.peer, '') : null, onCommit: (t) => upd((y) => { y.peer = t.trim(); }) }));
      r1.appendChild(makeCheck(`vpn-${v.id}-on`, ' on', v.enabled, (on) => upd((y) => { y.enabled = on; })));
      r1.appendChild(btn('✕', () => edit((x) => { x.vpns?.splice(i, 1); }), 'icon-btn danger', 'Remove VPN'));
      card.appendChild(r1);
      const r2 = el('div', 'row vpn-row2');
      r2.appendChild(makeInput(`vpn-${v.id}-l`, v.local, { placeholder: 'your network, 192.168.10.0/24', ariaLabel: 'Local network', check: v.local ? checkCidr(v.local, false) : null, onCommit: (t) => upd((y) => { y.local = t.trim(); }) }));
      r2.appendChild(el('span', 'arrow', '⇄'));
      r2.appendChild(makeInput(`vpn-${v.id}-r`, v.remote, { placeholder: 'their network', ariaLabel: 'Remote network', check: v.remote ? checkCidr(v.remote, false) : null, onCommit: (t) => upd((y) => { y.remote = t.trim(); }) }));
      card.appendChild(r2);
      card.appendChild(makeInput(`vpn-${v.id}-k`, v.key, { placeholder: 'shared key', ariaLabel: 'Shared key', onCommit: (t) => upd((y) => { y.key = t; }) }));
      card.appendChild(this.liveBlock(() => {
        const st = runtime.vpnUp?.[`${d.id}:${v.id}`];
        return el('div', `explain ${st?.up ? 'ok' : 'bad'}`, st ? st.why : 'Checking…');
      }));
      sec.appendChild(card);
    });
    sec.appendChild(btn('+ Add VPN', () => edit((x) => { (x.vpns ??= []).push({ id: genId('vpn'), peer: '', local: '', remote: '', key: '', enabled: true }); }), 'add'));
    void s;
    return sec;
  }

  /** Router-on-a-stick: one port, several VLANs, an address in each. */
  private subifSection(s: WorldState, d: DeviceOf<'router'> | DeviceOf<'firewall'>): HTMLElement {
    const subs = d.subifs ?? [];
    const fw = d.kind === 'firewall';
    const sec = section(heading('VLAN sub-interfaces', subs.length ? `${subs.length}` : 'none'));
    sec.appendChild(el('p', 'note', `Router-on-a-stick: several VLANs over a single cable. The switch port at the other end must be a trunk that carries them. Each sub-interface is the gateway of its VLAN${fw ? ', and a zone with its own security level' : ''}.`));
    const edit = (fn: (x: DeviceOf<'router'> | DeviceOf<'firewall'>) => void) => editL3(d.id, fn);
    const ports = d.ports.map((p) => ({ value: String(p.index), label: p.label }));
    subs.forEach((v, i) => {
      const upd = (fn: (y: NonNullable<typeof d.subifs>[number]) => void) => edit((x) => { const y = x.subifs?.[i]; if (y) fn(y); });
      const card = el('div', 'card');
      const row = el('div', 'row subif-row');
      row.appendChild(makeSelect(`si-${v.id}-p`, ports, String(v.port), 'Port', (t) => upd((y) => { y.port = Number(t); })));
      row.appendChild(makeInput(`si-${v.id}-v`, String(v.vlan), {
        placeholder: 'VLAN', ariaLabel: 'VLAN',
        onCommit: (t) => { const n = Number(t); if (Number.isInteger(n) && n >= 2 && n <= 4094) upd((y) => { y.vlan = n; }); else { toast('Sub-interfaces use VLANs 2–4094 (VLAN 1 is the port itself)', 'error'); this.schedule(); } },
      }));
      const chk = (v.ip ? checkAddr(v.ip, v.mask) : null) ?? duplicateCheck(s, v.ip, `${d.name}.${v.vlan}`);
      row.appendChild(btn('✕', () => edit((x) => { x.subifs?.splice(i, 1); }), 'icon-btn danger', 'Remove sub-interface'));
      card.appendChild(row);
      card.appendChild(makeInput(`si-${v.id}-ip`, addrText(v.ip, v.mask), { placeholder: 'gateway address, e.g. 192.168.30.1/24', ariaLabel: 'Address', check: chk, onCommit: (t) => this.commitAddr(t, (ip, mask) => upd((y) => { y.ip = ip; y.mask = mask; })) }));
      if (fw) {
        const r2 = el('div', 'row subif-row2');
        r2.appendChild(makeInput(`si-${v.id}-n`, v.name ?? '', { placeholder: `zone name, e.g. vlan${v.vlan}`, ariaLabel: 'Zone name', onCommit: (t) => upd((y) => { y.name = t.trim(); }) }));
        r2.appendChild(makeInput(`si-${v.id}-l`, String(v.securityLevel ?? 50), {
          placeholder: '0-100', ariaLabel: 'Security level',
          onCommit: (t) => { const n = Number(t); if (Number.isInteger(n) && n >= 0 && n <= 100) upd((y) => { y.securityLevel = n; }); else { toast('Security level must be 0–100', 'error'); this.schedule(); } },
        }));
        card.appendChild(r2);
      }
      card.appendChild(el('span', 'sub', `${d.ports[v.port]?.label ?? '?'}.${v.vlan}${fw ? ` · zone ${v.name || `vlan${v.vlan}`} · level ${v.securityLevel ?? 50}` : ''}`));
      if (s.unlocks.dhcp && v.ip) card.appendChild(makeCheck(`si-${v.id}-dhcp`, ` DHCP server on VLAN ${v.vlan}`, v.dhcp.enabled, (on) => upd((y) => { y.dhcp.enabled = on; })));
      const m = makeMsgs([chk]);
      if (m) card.appendChild(m);
      sec.appendChild(card);
    });
    const next = Math.max(9, ...subs.map((x) => x.vlan)) + 1;
    sec.appendChild(btn('+ Add sub-interface', () => edit((x) => { (x.subifs ??= []).push({ id: genId('si'), port: x.ports.find((p) => p.label)?.index ?? 0, vlan: next, ip: '', mask: '/24', dhcp: { enabled: false }, ...(fw ? { name: `vlan${next}`, securityLevel: 50 } : {}) }); }), 'add'));
    return sec;
  }

  private switchForwarding(s: WorldState, d: DeviceOf<'switch'>): HTMLElement[] {
    const sec = section(heading('Forwarding', s.unlocks.macLearning ? 'MAC learning' : 'flooding'));
    sec.appendChild(el('p', 'note', 'Ports in the same VLAN share one subnet (one broadcast domain). A router or firewall joins different subnets and VLANs.'));
    if (!s.unlocks.macLearning) {
      sec.appendChild(el('p', 'locked', `This switch behaves like a hub: each frame goes out every port, which loads every cable. MAC learning: ${lockedMsg('macLearning')}`));
    } else {
      sec.appendChild(this.liveBlock(() => {
        const x = world.get().devices[d.id];
        const t = x?.kind === 'switch' ? Object.entries(x.macTable) : [];
        if (!t.length) return el('p', 'note', 'MAC table empty. It fills as traffic flows.');
        const box = el('div', 'derived');
        for (const [mac, p] of t) box.appendChild(el('span', undefined, `${mac} → ${x!.ports[p]?.label}`));
        return box;
      }));
    }
    return [sec];
  }

  private firewallBody(s: WorldState, d: DeviceOf<'firewall'>): HTMLElement[] {
    const edit = (fn: (x: DeviceOf<'firewall'>) => void) => editDevice(d.id, 'firewall', fn);

    const ifSec = section('Interfaces');
    ifSec.appendChild(el('p', 'note', 'Routed mode: every interface has its own subnet. Higher → lower security level is allowed by default; lower → higher needs an ACL allow rule.'));
    for (const iface of d.interfaces) {
      const card = el('div', 'card');
      const row = el('div', 'row fw-if-row');
      row.appendChild(el('span', 'pl', iface.name));
      row.appendChild(makeInput(`fw-if-${iface.port}-lvl`, String(iface.securityLevel), {
        placeholder: '0-100', ariaLabel: `${iface.name} security level`,
        onCommit: (v) => { const n = Number(v); if (Number.isFinite(n) && n >= 0 && n <= 100) edit((x) => { const f = x.interfaces.find((i) => i.port === iface.port); if (f) f.securityLevel = Math.round(n); }); else toast('Security level must be 0–100', 'error'); },
      }));
      const ipCheck = (iface.ip ? checkAddr(iface.ip, iface.mask) : null) ?? duplicateCheck(s, iface.ip, `${d.name} ${iface.name}`);
      row.appendChild(makeInput(`fw-if-${iface.port}-ip`, addrText(iface.ip, iface.mask), { placeholder: 'unassigned, e.g. 10.0.0.1/30', ariaLabel: `${iface.name} address`, check: ipCheck, onCommit: (v) => this.commitAddr(v, (ip, mask) => edit((x) => { const f = x.interfaces.find((i) => i.port === iface.port); if (f) { f.ip = ip; f.mask = mask; } })) }));
      card.appendChild(row);
      card.appendChild(el('span', 'sub', `${d.ports[iface.port]?.label} port · ${SIDE_NAME[portSide(d, iface.port)]} side · level ${iface.securityLevel}`));
      if (s.unlocks.dhcp && iface.ip) card.appendChild(makeCheck(`fw-if-${iface.port}-dhcp`, ` DHCP server on ${iface.name}`, iface.dhcp.enabled, (v) => edit((x) => { const f = x.interfaces.find((i) => i.port === iface.port); if (f) f.dhcp.enabled = v; })));
      const m = makeMsgs([ipCheck]);
      if (m) card.appendChild(m);
      ifSec.appendChild(card);
    }

    // ACL
    const zones = [{ value: 'any', label: 'any' }, ...d.interfaces.map((i) => ({ value: i.name, label: i.name }))];
    const rulesSec = section(heading('Access rules', `${d.rules.length}`));
    rulesSec.appendChild(el('p', 'note', 'Checked top to bottom, first match decides. From/to are the interfaces the packet enters and leaves by. Destination is the real (after NAT) address.'));
    const move = (i: number, dir: -1 | 1) => edit((x) => { const j = i + dir; if (j < 0 || j >= x.rules.length) return; [x.rules[i], x.rules[j]] = [x.rules[j]!, x.rules[i]!]; });
    d.rules.forEach((r, i) => {
      const upd = (fn: (x: typeof r) => void) => edit((x) => { const rr = x.rules[i]; if (rr) fn(rr); });
      const srcC = checkCidr(r.src, true);
      const dstC = checkCidr(r.dst, true);
      const portC = r.protocol === 'icmp' ? null : checkPorts(r.ports);
      const card = el('div', 'card');
      const row1 = el('div', 'row fw-row1');
      row1.appendChild(el('span', 'num', `#${i + 1}`));
      const act = makeSelect(`${r.id}-act`, [{ value: 'allow', label: 'allow' }, { value: 'deny', label: 'deny' }], r.action, 'Action', (v) => upd((x) => { x.action = v as FwAction; }));
      act.style.color = r.action === 'deny' ? 'var(--bad)' : 'var(--ok)';
      row1.appendChild(act);
      row1.appendChild(makeSelect(`${r.id}-proto`, ['any', 'tcp', 'udp', 'icmp'].map((p) => ({ value: p, label: p })), r.protocol, 'Protocol', (v) => upd((x) => { x.protocol = v as FwProtocol; })));
      const hits = this.liveText(() => {
        const key = `${d.id}:${r.id}`;
        const m = runtime.ruleHits[key] ?? 0;
        const n = runtime.ruleHitCount?.[key] ?? 0;
        if (m > 0) return `${n}× · ${mbps(m)} now`;
        const last = runtime.ruleLastHit?.[key];
        if (last === undefined) return 'no hits';
        const ago = Math.max(0, Math.round((world.get().time.tick - last) / TICKS_PER_SEC));
        return `${n}× · ${ago < 60 ? `${ago} s` : `${Math.round(ago / 60)} min`} ago`;
      }, 'hits');
      this.live.push(() => { hits.classList.toggle('on', (runtime.ruleHits[`${d.id}:${r.id}`] ?? 0) > 0); hits.title = 'Sessions that matched this rule since the game was loaded, and when it last matched'; });
      row1.appendChild(hits);
      const up = btn('↑', () => move(i, -1), 'icon-btn', 'Move rule up'); up.disabled = i === 0; row1.appendChild(up);
      const dn = btn('↓', () => move(i, 1), 'icon-btn', 'Move rule down'); dn.disabled = i === d.rules.length - 1; row1.appendChild(dn);
      row1.appendChild(btn('✕', () => edit((x) => { x.rules.splice(i, 1); }), 'icon-btn danger', 'Delete rule'));
      card.appendChild(row1);

      const row2 = el('div', 'row fw-row2');
      const zf = el('label', 'field'); zf.style.gridTemplateColumns = '34px minmax(0,1fr)';
      zf.appendChild(el('span', 'lbl', 'from')); zf.appendChild(makeSelect(`${r.id}-sz`, zones, r.srcZone, 'From interface', (v) => upd((x) => { x.srcZone = v; })));
      const zt = el('label', 'field'); zt.style.gridTemplateColumns = '22px minmax(0,1fr)';
      zt.appendChild(el('span', 'lbl', 'to')); zt.appendChild(makeSelect(`${r.id}-dz`, zones, r.dstZone, 'To interface', (v) => upd((x) => { x.dstZone = v; })));
      row2.appendChild(zf); row2.appendChild(zt);
      card.appendChild(row2);

      const row3 = el('div', 'row fw-row3');
      row3.appendChild(el('span', 'lbl', 'source'));
      row3.appendChild(el('span', 'lbl', 'destination'));
      row3.appendChild(el('span', 'lbl', 'dst port'));
      row3.appendChild(makeInput(`${r.id}-src`, r.src, { placeholder: 'any', ariaLabel: 'Source', check: srcC, onCommit: (v) => upd((x) => { x.src = v || 'any'; }) }));
      row3.appendChild(makeInput(`${r.id}-dst`, r.dst, { placeholder: 'any', ariaLabel: 'Destination', check: dstC, onCommit: (v) => upd((x) => { x.dst = v || 'any'; }) }));
      row3.appendChild(makeInput(`${r.id}-ports`, r.protocol === 'icmp' ? '—' : r.ports, { placeholder: 'any', readonly: r.protocol === 'icmp', ariaLabel: 'Destination ports', check: portC, onCommit: (v) => upd((x) => { x.ports = v || 'any'; }) }));
      card.appendChild(row3);
      const m = makeMsgs([srcC, dstC, portC]);
      if (m) card.appendChild(m);
      rulesSec.appendChild(card);
    });
    const addRow = el('div', 'seg');
    addRow.appendChild(btn('+ Allow rule', () => edit((x) => { x.rules.push({ id: genId('fw'), action: 'allow', protocol: 'tcp', srcZone: 'outside', dstZone: 'inside', src: 'any', dst: 'any', ports: '80', log: false }); }), 'add'));
    addRow.appendChild(btn('+ Deny rule', () => edit((x) => { x.rules.unshift({ id: genId('fw'), action: 'deny', protocol: 'any', srcZone: 'any', dstZone: 'any', src: '', dst: 'any', ports: 'any', log: true }); }), 'add', 'Adds a deny rule at the top'));
    rulesSec.appendChild(addRow);

    const polSec = section('When no rule matches');
    const seg = el('div', 'seg');
    for (const p of ['deny', 'allow'] as const) {
      const b = btn(`${p} traffic`, () => edit((x) => { x.defaultPolicy = p; }));
      b.setAttribute('aria-pressed', String(d.defaultPolicy === p));
      seg.appendChild(b);
    }
    polSec.appendChild(seg);
    polSec.appendChild(el('p', 'note', 'Applies to low → high security traffic that no rule matched. Real firewalls default to deny.'));

    return [ifSec, this.subifSection(s, d), rulesSec, polSec, this.natSection(d), this.routesSection(d), this.vpnSection(s, d), this.talkersSection(d)];
  }

  private scrubberBody(d: DeviceOf<'ddos_scrubber'>): HTMLElement[] {
    const s = world.get();
    const edit = (fn: (x: DeviceOf<'ddos_scrubber'>) => void) => editDevice(d.id, 'ddos_scrubber', fn);
    const over = section('Inline protection',
      el('p', 'note', 'Transparent: no IP needed. Cable it between the uplink and your edge firewall (upstream → ISP, downstream → firewall). It filters before your firewall spends capacity.'),
      makeCheck('sc-syn', ' SYN flood protection (SYN cookies drop half-open floods)', d.synProtection, (v) => edit((x) => { x.synProtection = v; })),
    );
    if (s.unlocks.autoMitigation) {
      over.appendChild(makeCheck('sc-auto', ' Auto-mitigation: drop any single source range above the threshold', d.autoMitigation, (v) => edit((x) => { x.autoMitigation = v; })));
      over.appendChild(makeField('Threshold', String(d.autoThresholdMbps), { id: 'sc-thr', placeholder: 'Mbps', onCommit: (v) => { const n = Number(v); if (n > 0) edit((x) => { x.autoThresholdMbps = n; }); } }));
    } else over.appendChild(el('p', 'locked', `Auto-mitigation: ${lockedMsg('autoMitigation')}`));

    const rl = section(heading('Rate limits', `${d.rateLimits.length}`));
    rl.appendChild(el('p', 'note', 'Per source range. "limit" caps everything matching the rule to that many Mbps together; "drop" discards it. Visitors come from everywhere, so only an "any" rule touches them.'));
    d.rateLimits.forEach((r, i) => {
      const upd = (fn: (x: typeof r) => void) => edit((x) => { const rr = x.rateLimits[i]; if (rr) fn(rr); });
      const row = el('div', 'row rl-row');
      const c = checkCidr(r.src, true);
      row.appendChild(makeInput(`${r.id}-src`, r.src, { placeholder: 'source range', ariaLabel: 'Source range', check: c, onCommit: (v) => upd((x) => { x.src = v || 'any'; }) }));
      row.appendChild(makeInput(`${r.id}-max`, String(r.maxMbps), { placeholder: 'Mbps', ariaLabel: 'Max Mbps', onCommit: (v) => { const n = Number(v); if (n > 0) upd((x) => { x.maxMbps = n; }); } }));
      row.appendChild(makeSelect(`${r.id}-act`, [{ value: 'limit', label: 'limit' }, { value: 'drop', label: 'drop' }], r.action, 'Action', (v) => upd((x) => { x.action = v as 'limit' | 'drop'; })));
      row.appendChild(btn('✕', () => edit((x) => { x.rateLimits.splice(i, 1); }), 'icon-btn danger', 'Delete rate limit'));
      rl.appendChild(row);
      rl.appendChild(makeCheck(`${r.id}-on`, ` rule #${i + 1} enabled`, r.enabled, (v) => upd((x) => { x.enabled = v; })));
      const m = makeMsgs([c]);
      if (m) rl.appendChild(m);
    });
    rl.appendChild(btn('+ Add rate limit', () => edit((x) => { x.rateLimits.push({ id: genId('rl'), src: '', maxMbps: 10, action: 'drop', enabled: true }); }), 'add'));
    return [over, rl, this.talkersSection(d)];
  }

  private deviceBody(s: WorldState, d: Device): HTMLElement[] {
    switch (d.kind) {
      case 'uplink': return this.uplinkBody(d);
      case 'server': return this.serverBody(s, d);
      case 'router': return this.routerBody(s, d);
      case 'switch': return this.switchBody(d);
      case 'firewall': return this.firewallBody(s, d);
      case 'ddos_scrubber': return this.scrubberBody(d);
      case 'desk': return this.deskBody(s, d);
      case 'tower': return this.towerBody(s, d);
      case 'ac': return this.acBody(d);
      case 'badge': return this.badgeBody(s, d);
      default: return assertNever(d);
    }
  }

  // ---------- full renders ----------

  private renderDevice(s: WorldState, d: Device): DocumentFragment {
    const frag = document.createDocumentFragment();
    const def = DEVICE_DEFS[d.kind];
    const header = document.createElement('header');
    header.style.setProperty('--kind', kindCss(d.kind));
    const glyph = el('span', 'glyph');
    glyph.innerHTML = kindGlyph(d.kind, 30);
    header.appendChild(glyph);
    const titles = el('div', 'titles');
    titles.appendChild(el('span', 'eyebrow', `${def.label} · $${upkeepOf(d).toFixed(2)}/s upkeep`));
    const nameInput = makeInput('dev-name', d.name, {
      ariaLabel: 'Device name',
      onCommit: (v) => {
        if (v) world.update((w) => { const x = w.devices[d.id]; if (x) x.name = v.slice(0, 24); });
        else this.schedule();
      },
    });
    titles.appendChild(nameInput);
    header.appendChild(titles);
    header.appendChild(btn('×', () => select(null), 'close ghost', 'Close panel'));
    frag.appendChild(header);

    // two tabs: what you set up, and how the box is doing
    // status first on the second tab: condition, load, heat; then the parts you can change
    const own = this.deviceBody(s, d);
    const secs: HTMLElement[] = own.filter((x) => x.dataset.cat !== 'hw');
    const sw = this.softwareSection(s, d);
    if (sw) secs.push(sw);
    secs.push(status(this.healthSection(d)));
    const usage = this.usageSection(d);
    if (usage) secs.push(status(usage));
    const clim = this.climateSection(d);
    if (clim) secs.push(status(clim));
    secs.push(...own.filter((x) => x.dataset.cat === 'hw'), status(this.portsSection(s, d)), status(this.logsSection(d)));
    const names = d.kind === 'server' ? ['Software', 'Hardware'] : ['Setup', 'Status'];
    const tabs = el('div', 'ptabs');
    tabs.setAttribute('role', 'tablist');
    const probs = knownProblems(s, d).length + (d.health.state === 'failed' ? 1 : 0);
    (['sw', 'hw'] as const).forEach((k, i) => {
      const b = btn(names[i]!, () => { this.panelTab = k; this.render(); });
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(this.panelTab === k));
      if (k === 'hw' && probs) { const n = el('span', 'pbadge', String(probs)); b.appendChild(n); }
      tabs.appendChild(b);
    });
    frag.appendChild(tabs);
    const body = el('div', 'body');
    body.id = 'panel-body';
    body.dataset.tab = this.panelTab;
    const key = `${d.id}:${this.panelTab}`;
    if (key !== this.lastPanelKey) body.classList.add('enter');
    this.lastPanelKey = key;
    for (const sec of secs) if ((sec.dataset.cat ?? 'sw') === this.panelTab) body.appendChild(sec);
    frag.appendChild(body);

    const footer = document.createElement('footer');
    footer.appendChild(btn('Rotate ports', () => rotateDevice(d.id), '', 'Turn the ports 90° clockwise (R)'));
    const home = buildingAt(s.buildings, d.gridPos.gx, d.gridPos.gy);
    if (home && home.floors > 1 && d.kind !== 'uplink' && d.kind !== 'badge' && !(d.kind === 'switch' && d.stack)) {
      const here = levelOf(d.gridPos.gy);
      const opts = [{ value: '', label: 'Move to floor…' }, ...Array.from({ length: home.floors }, (_, z) => z).filter((z) => z !== here).map((z) => ({ value: String(z), label: z === 0 ? 'Ground floor' : `Floor ${z}` }))];
      footer.appendChild(makeSelect('dev-floor', opts, '', 'Move to floor', (v) => { if (!v) return; const e = moveToFloor(d.id, Number(v)); if (e) { toast(e, 'error'); this.schedule(); } else toast(`${d.name} moved. Its cables came off.`); }));
    }
    footer.appendChild(el('span', 'grow'));
    if (d.kind === 'badge') footer.appendChild(btn('Make it a plain door', () => deleteDevice(d.id), 'danger'));
    else if (d.kind !== 'uplink') footer.appendChild(btn(`Delete ${def.label.toLowerCase()}`, () => deleteDevice(d.id), 'danger'));
    frag.appendChild(footer);
    return frag;
  }

  private renderCable(s: WorldState, c: Cable): DocumentFragment {
    const frag = document.createDocumentFragment();
    const endLabel = (e: Cable['a']) => { const d = s.devices[e.deviceId]; return `${d?.name ?? '?'} · ${d?.ports[e.port]?.label ?? '?'}`; };
    let len = 0;
    for (let i = 0; i < c.path.length - 1; i++) len += Math.hypot(c.path[i + 1]!.x - c.path[i]!.x, c.path[i + 1]!.y - c.path[i]!.y);
    const header = document.createElement('header');
    const g = el('span');
    g.style.color = 'var(--ink-dim)';
    g.innerHTML = cableGlyph(30);
    header.appendChild(g);
    const titles = el('div', 'titles');
    titles.appendChild(el('span', 'eyebrow', 'Cable'));
    titles.appendChild(el('strong', undefined, `${endLabel(c.a)} ↔ ${endLabel(c.b)}`));
    header.appendChild(titles);
    header.appendChild(btn('×', () => select(null), 'close ghost', 'Close panel'));
    frag.appendChild(header);

    const body = el('div', 'body');
    body.id = 'panel-body';
    const seg = el('div', 'seg');
    for (const t of ['ethernet', 'fibre', 'crossover'] as CableType[]) {
      const b = btn(t, () => setCableType(c.id, t));
      b.setAttribute('aria-pressed', String(c.type === t));
      seg.appendChild(b);
    }
    const kv = el('dl', 'kv');
    kv.innerHTML = `<dt>Bandwidth</dt><dd>${mbps(CABLE_BANDWIDTH[c.type])}</dd><dt>Length</dt><dd>${(len / CELL).toFixed(1)} cells</dd>`;
    body.appendChild(section('Type', seg, kv));
    body.appendChild(section('Load', this.liveMeter('Traffic', () => (runtime.cableLoad[c.id] ?? 0) / c.bandwidthMbps, () => mbps(runtime.cableLoad[c.id] ?? 0)),
      this.liveText(() => runtime.stpBlocked[c.id] ? 'Blocked by spanning tree: a standby link that takes over if the active path fails.' : runtime.storm[c.a.deviceId] && runtime.storm[c.b.deviceId] ? 'Part of a switch loop without STP: broadcast storm!' : '', 'note')));
    frag.appendChild(body);

    const footer = document.createElement('footer');
    footer.appendChild(el('span', 'grow'));
    footer.appendChild(btn('Delete cable', () => deleteCable(c.id), 'danger'));
    frag.appendChild(footer);
    return frag;
  }

  private render(): void {
    const s = world.get();
    const sel = ui.get().selection;
    const d = sel?.type === 'device' ? s.devices[sel.id] : undefined;
    const c = sel?.type === 'cable' ? s.cables[sel.id] : undefined;
    this.wantRender = false;
    this.lastKey = this.structureKey();
    const selKey = sel ? `${sel.type}:${sel.id}` : '';

    this.hidden = !d && !c;
    if (this.hidden) { this.live = []; this.lastSel = ''; return; }

    // remember focus, typed text, caret and scroll
    const sameSel = selKey === this.lastSel;
    const oldBody = this.shadow.getElementById('panel-body');
    const scroll = sameSel && oldBody ? oldBody.scrollTop : 0;
    const active = this.shadow.activeElement as HTMLInputElement | null;
    const focusId = sameSel && active?.id ? active.id : null;
    const typed = focusId && active && active.tagName === 'INPUT' ? { value: active.value, a: active.selectionStart, b: active.selectionEnd } : null;

    const styles = this.shadow.querySelectorAll('style');
    while (this.shadow.childNodes.length > styles.length) this.shadow.removeChild(this.shadow.lastChild!);
    this.live = [];
    this.shadow.appendChild(d ? this.renderDevice(s, d) : this.renderCable(s, c!));
    this.lastSel = selKey;

    const body = this.shadow.getElementById('panel-body');
    if (body) body.scrollTop = scroll;
    if (focusId) {
      const n = this.shadow.getElementById(focusId) as HTMLInputElement | null;
      if (n) {
        n.focus({ preventScroll: true });
        if (typed && n.tagName === 'INPUT') {
          n.value = typed.value;
          try { n.setSelectionRange(typed.a, typed.b); } catch { /* not a text input */ }
        }
      }
    }
  }
}
customElements.define('ns-inspector', NsInspector);

// ---------- helpers ----------

type Host = DeviceOf<'server'> | DeviceOf<'desk'> | DeviceOf<'tower'>;

function editHost(id: string, fn: (x: Host) => void): void {
  const d = world.get().devices[id];
  if (d?.kind === 'server') editDevice(id, 'server', fn);
  else if (d?.kind === 'desk') editDevice(id, 'desk', fn);
  else if (d?.kind === 'tower') editDevice(id, 'tower', fn);
}

function editL3(id: string, fn: (x: RouterDevice | FirewallDevice) => void): void {
  const d = world.get().devices[id];
  if (d?.kind === 'router') editDevice(id, 'router', fn);
  else if (d?.kind === 'firewall') editDevice(id, 'firewall', fn);
}


export function fmtTime(tick: number): string {
  const s = Math.floor(tick / TICKS_PER_SEC);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function esc(t: string): string {
  return t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
}

/** Hop-by-hop explanation of a service's request and reply. */
export function renderTrace(s: WorldState, p: ResolvedPath | undefined, oneWay = false): HTMLElement {
  const box = el('div');
  box.style.display = 'grid';
  box.style.gap = '6px';
  if (!p) { box.appendChild(el('p', 'note', 'One moment…')); return box; }
  const okAll = !p.blocked && (oneWay || (!!p.ret && !p.ret.blocked));
  box.appendChild(el('div', `explain ${okAll ? 'ok' : 'bad'}`, okAll ? (oneWay ? 'Traffic gets out to the internet.' : 'Request and reply both get through.') : p.explain || (p.ret?.explain ?? '')));
  const list = el('ol', 'trace');
  const add = (path: ResolvedPath, dir: string) => {
    path.hops.forEach((h, i) => {
      const li = el('li');
      const stop = path.blocked && path.blockedAt === i;
      li.innerHTML = `<span class="dir">${dir}</span><span class="${stop ? 'stop' : ''}"><b>${esc(s.devices[h.deviceId]?.name ?? '?')}</b> ${esc(h.note)}${stop ? ` ✕ ${REASON_LABEL[path.reason!]}` : ''}</span>`;
      list.appendChild(li);
    });
  };
  add(p, '→');
  if (p.ret) add(p.ret, '←');
  box.appendChild(list);
  return box;
}

/** "tcp 2222→22" for a port forward, "" for a whole-address entry. */
function natPortText(n: { proto?: string; publicPort?: number; privatePort?: number }): string {
  if (!n.publicPort) return '';
  const to = n.privatePort && n.privatePort !== n.publicPort ? `→${n.privatePort}` : '';
  return `${n.proto ?? 'tcp'} ${n.publicPort}${to}`;
}

/** Read "443", "tcp 443", "udp 53", "tcp 2222→22" (or "2222:22", "2222->22"); empty = all ports. */
function parseNatPort(v: string): { proto?: 'tcp' | 'udp'; publicPort?: number; privatePort?: number } | string {
  const t = v.trim().toLowerCase();
  if (!t || t === 'all' || t === 'any') return { proto: undefined, publicPort: undefined, privatePort: undefined };
  const m = /^(tcp|udp)?\s*\/?\s*(\d{1,5})\s*(?:(?:→|->|:|>)\s*(\d{1,5}))?$/.exec(t);
  if (!m) return 'Type a port like 443, or tcp 2222→22 to forward to a different port';
  const a = Number(m[2]), b = m[3] ? Number(m[3]) : undefined;
  if (a < 1 || a > 65535 || (b !== undefined && (b < 1 || b > 65535))) return 'Ports go from 1 to 65535';
  return { proto: (m[1] as 'tcp' | 'udp' | undefined) ?? 'tcp', publicPort: a, privatePort: b && b !== a ? b : undefined };
}
