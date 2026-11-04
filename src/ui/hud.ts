// Topbar, incident banner, Goals/Events drawer and toasts — plain DOM custom elements.
import { TICKS_PER_SEC } from '../balance';
import { ACHIEVEMENTS } from '../progress';
import { uptimePercent } from '../sim/engine';
import { DEVICE_DEFS } from '../state/devices';
import { ENGINEER_HIRE, ENGINEER_SALARY } from '../balance';
import { engineerActivity, smartDoorsLocked } from '../sim/staff';
import { addPublicAddr, buyDomain, dropDomain, editDomain, fireEngineer, hireEngineer, onToast, removePublicAddr, runtime, toast, togglePublicService, ui, world, type ToastKind } from '../state/world';
import { DOMAIN_RENEWAL, REGISTRAR_DNS_FEE, TLDS } from '../balance';
import { resolvePublic } from '../sim/dns';
import { buildCtx } from '../sim/net';

type Tab = 'goals' | 'staff' | 'domains' | 'events';
import { fmtTime } from './inspector';
import { baseStyle } from './styles';

function hintText(): string {
  const u = ui.get();
  switch (u.tool.mode) {
    case 'select':
      return 'Tap a device or cable to configure it. Drag a device to move it, drag empty space to pan.';
    case 'place':
      return `Tap an empty floor cell to place ${u.tool.kind === 'tower' ? (u.tool.access === 'home' ? 'home networks' : 'a cell site') : `a ${DEVICE_DEFS[u.tool.kind].label.toLowerCase()}`}. Press Select or Esc when done.`;
    case 'cable':
      return u.pendingCable
        ? 'Now tap the second device. Tap empty space to cancel.'
        : `Tap two devices to run ${u.cableType} between them. Tap a port dot to pick that exact port.`;
    case 'build':
      return u.tool.tile === 'ground' ? 'Tap or drag to clear tiles back to open ground.' : `Tap or drag to lay ${u.tool.tile === 'smartdoor' ? 'smart doors' : u.tool.tile === 'raised' ? 'server-room floor' : `${u.tool.tile}s`}. Press Select or Esc when done.`;
  }
}

const SPEEDS = [
  { value: 0, label: '❚❚', title: 'Pause (Space)' },
  { value: 1, label: '1×', title: '1× speed (1)' },
  { value: 2, label: '2×', title: '2× speed (2)' },
  { value: 4, label: '4×', title: '4× speed (3)' },
];

/** Things the topbar menu asks main.ts to do. */
export interface GameActions {
  fit(): void;
  newGame(): void;
  example(): void;
  showcase(): void;
  save(): Promise<void>;
  load(): Promise<void>;
  slotLabel(): Promise<string>;
  exportSave(): Promise<void>;
  importSave(text: string): void;
}

const TOPBAR_CSS = `
  :host {
    display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 14px;
    padding: 8px max(14px, env(safe-area-inset-right, 0px)) 8px max(14px, env(safe-area-inset-left, 0px));
    background: var(--paper); border-bottom: 1px solid var(--line); position: relative; z-index: 40;
  }
  .brand { display: flex; align-items: baseline; gap: 10px; white-space: nowrap; }
  .logo { font-family: var(--font-display); font-weight: 600; font-size: 19px; letter-spacing: 0.02em; }
  .logo span { color: var(--accent); }
  .stage { font-family: var(--font-mono); font-size: 10.5px; color: var(--ink-faint); letter-spacing: 0.06em; text-transform: uppercase; }
  .hint { font-size: 12.5px; color: var(--ink-dim); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .right { display: flex; align-items: center; gap: 8px; }
  .econ { display: flex; align-items: center; gap: 12px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .econ .k { display: grid; gap: 1px; }
  .econ .k small { font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-faint); }
  .balance { font-size: 13.5px; color: var(--ok); font-weight: 500; }
  .balance.neg { color: var(--bad); }
  .net { font-size: 11.5px; }
  .uptime { font-size: 11.5px; color: var(--ink-dim); }
  .util { display: grid; gap: 3px; }
  .util-bar { width: 64px; height: 6px; border-radius: 3px; background: var(--well); overflow: hidden; }
  .util-bar i { display: block; height: 100%; width: 0; background: var(--accent); transition: width 0.3s; }
  .util span { font-size: 10.5px; color: var(--ink-dim); }
  .speeds { display: flex; gap: 2px; }
  .speeds button { font-size: 11px; min-height: 28px; min-width: 32px; padding: 2px 6px; font-family: var(--font-mono); }
  .speeds button[aria-pressed="true"] { border-color: var(--accent); background: var(--raised-hover); }
  button { font-size: 12.5px; }
  button.goals { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
  .badge { display: inline-block; min-width: 18px; padding: 0 5px; margin-left: 4px; border-radius: 9px; background: var(--accent); color: var(--canvas); font-size: 10.5px; font-family: var(--font-mono); }
  .menu-wrap { position: relative; }
  .menu {
    position: absolute; right: 0; top: calc(100% + 6px); z-index: 50; display: grid; gap: 4px; padding: 6px; min-width: 230px;
    background: var(--paper); border: 1px solid var(--line-strong); border-radius: 8px; box-shadow: 0 10px 30px rgb(0 0 0 / .4);
  }
  .menu[hidden] { display: none; }
  .menu button { text-align: left; }
  .menu small { color: var(--ink-faint); font-size: 11px; padding: 0 4px 4px; }
  button.confirm { color: var(--bad); border-color: var(--bad); }
  @media (max-width: 1100px) { .hint { display: none; } :host { grid-template-columns: auto 1fr; } }
  @media (max-width: 759px) {
    :host { grid-template-columns: 1fr; row-gap: 6px; padding-top: 6px; padding-bottom: 6px; }
    .brand .stage { display: none; }
    .right { flex-wrap: wrap; justify-content: space-between; }
    .econ { gap: 8px; }
    .util { display: none; }
  }
`;

export class NsTopbar extends HTMLElement {
  private shadow: ShadowRoot;
  actions: GameActions | null = null;
  private els: Record<string, HTMLElement> = {};
  private speedBtns: HTMLButtonElement[] = [];
  private menu!: HTMLElement;
  private confirming: string | null = null;
  private lastRender = 0;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.shadow.appendChild(baseStyle());
    const style = document.createElement('style');
    style.textContent = TOPBAR_CSS;
    this.shadow.appendChild(style);
    const root = document.createElement('div');
    root.style.display = 'contents';
    root.innerHTML = `
      <div class="brand"><span class="logo">Net<span>Sim</span></span><span class="stage">Phase 4 · Building &amp; staff</span></div>
      <div class="hint" aria-live="polite"></div>
      <div class="right">
        <div class="econ">
          <div class="k"><small>Balance</small><span class="balance" data-el="balance">$0</span></div>
          <div class="k"><small>Net / s</small><span class="net" data-el="net">$0</span></div>
          <div class="k"><small>Uptime</small><span class="uptime" data-el="uptime">—</span></div>
          <div class="k util"><small>Uplink</small><div class="util-bar"><i data-el="util-bar"></i></div><span data-el="util">0 / 100 Mbps</span></div>
        </div>
        <div class="speeds" role="radiogroup" aria-label="Simulation speed"></div>
        <button class="goals" data-action="domains" title="Public IPs, domains and DNS">Internet</button>
        <button class="goals" data-action="staff" title="Engineers, jobs and security">Staff<span class="badge" data-el="staffcount">0</span></button>
        <button class="goals" data-action="goals" title="Goals, unlocks and events">Goals<span class="badge" data-el="goalcount">0</span></button>
        <div class="menu-wrap">
          <button data-action="menu" aria-haspopup="true" aria-expanded="false">Game ▾</button>
          <div class="menu" hidden>
            <button data-action="save">Save to slot</button>
            <button data-action="load">Load slot</button>
            <small data-el="slot">Slot: empty</small>
            <button data-action="export">Download save file</button>
            <button data-action="import">Upload save file…</button>
            <input type="file" id="save-file" accept=".json,.netsim,application/json" hidden>
            <button data-action="fit">Fit view (F)</button>
            <button data-action="example">Open example network</button>
            <button data-action="showcase">Open showcase campus</button>
            <button data-action="new">New game</button>
          </div>
        </div>
      </div>`;
    this.shadow.appendChild(root);
    for (const n of this.shadow.querySelectorAll<HTMLElement>('[data-el]')) this.els[n.dataset.el!] = n;
    this.menu = this.shadow.querySelector('.menu')!;

    const speeds = this.shadow.querySelector('.speeds')!;
    for (const sp of SPEEDS) {
      const b = document.createElement('button');
      b.textContent = sp.label;
      b.title = sp.title;
      b.setAttribute('aria-label', sp.title);
      b.addEventListener('click', () => world.update((w) => { w.speed = sp.value as 0 | 1 | 2 | 4; }, 'world'));
      speeds.appendChild(b);
      this.speedBtns.push(b);
    }

    const fileIn = this.shadow.getElementById('save-file') as HTMLInputElement;
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files?.[0];
      fileIn.value = '';
      if (!f) return;
      try { this.actions?.importSave(await f.text()); } catch { toast('Could not read that file.', 'error'); }
      this.toggleMenu(false);
    });
    this.shadow.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      const a = t?.dataset.action;
      if (!a || !t) return;
      void this.onAction(a, t);
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.menu.hidden && !e.composedPath().includes(this)) this.toggleMenu(false);
    });

    this.render();
    world.subscribe((_s, reason) => {
      if (reason === 'camera') return;
      if (reason === 'sim') {
        const now = performance.now();
        if (now - this.lastRender < 250) return;
        this.lastRender = now;
      }
      this.render();
    });
    ui.subscribe(() => this.render());
  }

  private toggleMenu(open: boolean): void {
    this.menu.hidden = !open;
    this.shadow.querySelector('[data-action="menu"]')!.setAttribute('aria-expanded', String(open));
    if (open && this.actions) void this.actions.slotLabel().then((l) => { this.els.slot!.textContent = l; });
    if (!open) this.resetConfirm();
  }

  private resetConfirm(): void {
    this.confirming = null;
    const n = this.shadow.querySelector<HTMLButtonElement>('[data-action="new"]')!;
    n.textContent = 'New game'; n.className = '';
    const x = this.shadow.querySelector<HTMLButtonElement>('[data-action="example"]')!;
    x.textContent = 'Open example network'; x.className = '';
    const sc = this.shadow.querySelector<HTMLButtonElement>('[data-action="showcase"]')!;
    sc.textContent = 'Open showcase campus'; sc.className = '';
    const l = this.shadow.querySelector<HTMLButtonElement>('[data-action="load"]')!;
    l.textContent = 'Load slot'; l.className = '';
  }

  private needConfirm(a: string, b: HTMLButtonElement, text: string): boolean {
    if (this.confirming === a) return false;
    this.resetConfirm();
    this.confirming = a;
    b.textContent = text;
    b.className = 'confirm';
    return true;
  }

  private async onAction(a: string, b: HTMLButtonElement): Promise<void> {
    const act = this.actions;
    switch (a) {
      case 'menu': this.toggleMenu(this.menu.hidden); return;
      case 'goals': (document.querySelector('ns-goals') as NsGoals | null)?.show('goals'); return;
      case 'staff': (document.querySelector('ns-goals') as NsGoals | null)?.show('staff'); return;
      case 'domains': (document.querySelector('ns-goals') as NsGoals | null)?.show('domains'); return;
      case 'fit': act?.fit(); this.toggleMenu(false); return;
      case 'save': await act?.save(); this.toggleMenu(false); return;
      case 'export': this.toggleMenu(false); await act?.exportSave(); return;
      case 'import': (this.shadow.getElementById('save-file') as HTMLInputElement).click(); return;
      case 'load': if (this.needConfirm(a, b, 'Replace current game?')) return; await act?.load(); this.toggleMenu(false); return;
      case 'new': if (this.needConfirm(a, b, 'Erase and start over?')) return; act?.newGame(); this.toggleMenu(false); return;
      case 'example': if (this.needConfirm(a, b, 'Replace current game?')) return; act?.example(); this.toggleMenu(false); return;
      case 'showcase': if (this.needConfirm(a, b, 'Replace current game?')) return; act?.showcase(); this.toggleMenu(false); return;
    }
  }

  private render(): void {
    const s = world.get();
    const e = this.els;
    this.shadow.querySelector('.hint')!.textContent = hintText();
    const bal = s.economy.balance;
    e.balance!.textContent = `${bal < 0 ? '−' : ''}$${Math.abs(Math.floor(bal)).toLocaleString()}`;
    e.balance!.classList.toggle('neg', bal < 0);
    const net = s.economy.revenuePerSec - s.economy.upkeepPerSec;
    e.net!.textContent = `${net >= 0 ? '+' : '−'}$${Math.abs(net).toFixed(2)}`;
    e.net!.style.color = net >= 0 ? 'var(--ok)' : 'var(--bad)';
    e.net!.title = `Revenue $${s.economy.revenuePerSec.toFixed(2)}/s, upkeep $${s.economy.upkeepPerSec.toFixed(2)}/s`;
    const up = uptimePercent(s);
    e.uptime!.textContent = up === null ? '—' : `${up.toFixed(up >= 99.95 ? 1 : 2)} %`;
    e.uptime!.title = 'Average site availability, rolling 60 minutes';
    const uplink = Object.values(s.devices).find((d) => d.kind === 'uplink');
    if (uplink?.kind === 'uplink') {
      const offeredPct = (runtime.uplinkMbps / uplink.bandwidthMbps) * 100;
      const pct = Math.min(100, offeredPct);
      (e['util-bar'] as HTMLElement).style.width = `${Math.min(100, pct)}%`;
      (e['util-bar'] as HTMLElement).style.background = offeredPct > 100 ? 'var(--bad)' : pct > 80 ? 'var(--warn)' : 'var(--accent)';
      e.util!.textContent = offeredPct > 100.5
        ? `${uplink.bandwidthMbps} / ${uplink.bandwidthMbps} Mbps · ${(runtime.uplinkMbps - uplink.bandwidthMbps).toFixed(0)} dropped`
        : `${runtime.uplinkMbps.toFixed(0)} / ${uplink.bandwidthMbps} Mbps`;
    }
    SPEEDS.forEach((sp, i) => this.speedBtns[i]!.setAttribute('aria-pressed', String(sp.value === s.speed)));
    const done = ACHIEVEMENTS.filter((a) => s.achievements[a.id]?.done).length;
    e.goalcount!.textContent = `${done}/${ACHIEVEMENTS.length}`;
    const tres = Object.keys(s.staff.trespassers).length;
    e.staffcount!.textContent = tres ? `${tres} intruder` : String(Object.keys(s.staff.engineers).length);
    e.staffcount!.style.background = tres ? 'var(--bad)' : '';
  }
}
customElements.define('ns-topbar', NsTopbar);

// ---------- Incident banner ----------

const BANNER_CSS = `
  :host { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); z-index: 15; pointer-events: none; width: min(92%, 560px); }
  .b { pointer-events: auto; display: grid; gap: 4px; padding: 8px 12px; border-radius: 8px; background: color-mix(in srgb, var(--bad) 18%, var(--paper));
       border: 1px solid var(--bad); font-size: 12.5px; box-shadow: 0 6px 24px rgb(0 0 0 / .35); }
  .b.recon { background: color-mix(in srgb, var(--warn) 14%, var(--paper)); border-color: var(--warn); }
  .b strong { font-family: var(--font-mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
  .b span { color: var(--ink-dim); }
  .bar { height: 4px; border-radius: 2px; background: var(--well); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--bad); }
`;

export class NsBanner extends HTMLElement {
  private shadow = this.attachShadow({ mode: 'open' });
  private box!: HTMLElement;
  private last = 0;
  connectedCallback(): void {
    this.shadow.appendChild(baseStyle());
    const st = document.createElement('style');
    st.textContent = BANNER_CSS;
    this.shadow.appendChild(st);
    this.box = document.createElement('div');
    this.shadow.appendChild(this.box);
    world.subscribe((_s, r) => {
      if (r === 'camera') return;
      const now = performance.now();
      if (r === 'sim' && now - this.last < 300) return;
      this.last = now;
      this.render();
    });
  }
  private render(): void {
    const s = world.get();
    const inc = Object.values(s.activeIncidents).find((i) => i.phase !== 'resolved');
    if (!inc) { this.box.innerHTML = ''; return; }
    const now = s.time.tick;
    if (inc.phase === 'recon') {
      this.box.innerHTML = `<div class="b recon"><strong>Recon detected</strong><span>Port scan of ${inc.targetIp} from ${inc.srcRanges[0]}. An attack may follow within ${Math.max(0, Math.ceil((inc.floodAt - now) / TICKS_PER_SEC))} s.</span></div>`;
      return;
    }
    const frac = inc.offeredSum > 0 ? inc.deliveredSum / inc.offeredSum : 0;
    const left = Math.max(0, Math.ceil((inc.endAt - now) / TICKS_PER_SEC));
    const prog = 1 - (inc.endAt - now) / Math.max(1, inc.endAt - inc.floodAt);
    this.box.innerHTML = `<div class="b"><strong>DDoS in progress · ${left} s left</strong>
      <span>${inc.totalVolumeMbps.toFixed(0)} Mbps ${inc.attackType.replace('_', ' ')} from ${inc.srcRanges.join(', ')} → ${inc.targetIp}.
      ${(frac * 100).toFixed(0)} % reaching the server so far (under 20 % counts as mitigated).</span>
      <div class="bar"><i style="width:${Math.min(100, prog * 100)}%"></i></div></div>`;
  }
}
customElements.define('ns-banner', NsBanner);

// ---------- Goals / Events drawer ----------

const GOALS_CSS = `
  :host { position: absolute; z-index: 25; top: 12px; left: max(12px, env(safe-area-inset-left, 0px)); bottom: 12px; width: 380px; display: none; flex-direction: column;
          background: var(--paper); border: 1px solid var(--line-strong); border-radius: 10px; box-shadow: 0 12px 40px rgb(0 0 0 / .4); overflow: hidden; }
  :host([open]) { display: flex; }
  header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
  header .tabs { display: flex; gap: 4px; flex: 1; }
  header .tabs button[aria-pressed="true"] { border-color: var(--accent); background: var(--raised-hover); }
  .close { width: 34px; padding: 0; font-size: 18px; }
  .body { overflow-y: auto; padding: 10px 12px 14px; display: grid; gap: 8px; align-content: start; overscroll-behavior: contain; }
  .intro { font-size: 12.5px; color: var(--ink-dim); line-height: 1.5; margin: 0; }
  .a { display: grid; gap: 6px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--well-soft); }
  .a.done { border-color: color-mix(in srgb, var(--ok) 45%, var(--line)); }
  .a.locked { opacity: .55; }
  .a .t { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
  .a .t b { font-size: 13.5px; }
  .a .t span { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-faint); white-space: nowrap; }
  .a.done .t span { color: var(--ok); }
  .a p { margin: 0; font-size: 12.5px; line-height: 1.45; }
  .a .rw { color: var(--accent); font-size: 12px; }
  .a ol { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.5; color: var(--ink-dim); display: grid; gap: 2px; }
  .a details summary { cursor: pointer; font-size: 12px; color: var(--ink-dim); }
  .bar { height: 5px; border-radius: 3px; background: var(--well); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); }
  .unl { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { font-family: var(--font-mono); font-size: 10.5px; padding: 2px 7px; border-radius: 10px; border: 1px solid var(--line); color: var(--ink-faint); }
  .chip.on { border-color: var(--ok); color: var(--ok); }
  .log { display: grid; gap: 4px; font-size: 12px; line-height: 1.4; }
  .log div { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 8px; }
  .log time { font-family: var(--font-mono); color: var(--ink-faint); font-size: 11px; }
  .log .warn { color: var(--warn); } .log .alert { color: var(--bad); }
  @media (max-width: 759px) { :host { left: 0; right: 0; width: auto; top: auto; max-height: 70%; border-radius: 12px 12px 0 0; } }
`;

const UNLOCK_NAMES: Record<string, string> = {
  macLearning: 'MAC learning', dhcp: 'DHCP', dynamicRouting: 'OSPF', serverM: 'Server M', serverL: 'Server L',
  carrierUplink: 'Carrier uplink', monitoring: 'Monitoring', autoMitigation: 'Auto-mitigation', upstreamFiltering: 'Upstream filtering',
};

export class NsGoals extends HTMLElement {
  private shadow = this.attachShadow({ mode: 'open' });
  private tab: Tab = 'goals';
  show(tab: Tab): void {
    if (this.hasAttribute('open') && this.tab === tab) { this.removeAttribute('open'); return; }
    this.tab = tab;
    this.setAttribute('open', '');
    this.render();
  }
  private body!: HTMLElement;
  private last = 0;
  private openDetails = new Set<string>();
  static get observedAttributes() { return ['open']; }
  attributeChangedCallback(): void { this.render(); }
  connectedCallback(): void {
    this.shadow.appendChild(baseStyle());
    const st = document.createElement('style');
    st.textContent = GOALS_CSS;
    this.shadow.appendChild(st);
    const h = document.createElement('header');
    h.innerHTML = `<div class="tabs"><button data-tab="goals">Goals</button><button data-tab="staff">Staff</button><button data-tab="domains">Internet</button><button data-tab="events">Events</button></div><button class="close ghost" aria-label="Close goals">×</button>`;
    this.shadow.appendChild(h);
    this.body = document.createElement('div');
    this.body.className = 'body';
    this.shadow.appendChild(this.body);
    h.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.classList.contains('close')) this.removeAttribute('open');
      else { this.tab = b.dataset.tab as Tab; this.render(); }
    });
    this.body.addEventListener('toggle', (e) => {
      const d = e.target as HTMLDetailsElement;
      if (d.dataset.id) { if (d.open) this.openDetails.add(d.dataset.id); else this.openDetails.delete(d.dataset.id); }
    }, true);
    world.subscribe((_s, r) => {
      if (r === 'camera' || !this.hasAttribute('open')) return;
      const now = performance.now();
      if (r === 'sim' && now - this.last < 500) return;
      this.last = now;
      this.render();
    });
    this.render();
  }
  /** Build into a scratch element and swap only when something changed, so clicks are never lost. */
  private render(): void {
    if (!this.body) return;
    const a = this.shadow.activeElement as HTMLElement | null;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) return; // never yank a field the player is typing in
    const real = this.body;
    const tmp = document.createElement('div');
    this.body = tmp;
    try { this.renderInto(); } finally { this.body = real; }
    if (tmp.innerHTML === real.innerHTML) return;
    const scroll = real.scrollTop;
    real.replaceChildren(...Array.from(tmp.childNodes));
    real.scrollTop = scroll;
  }
  private renderInto(): void {
    for (const b of this.shadow.querySelectorAll<HTMLButtonElement>('[data-tab]')) b.setAttribute('aria-pressed', String(b.dataset.tab === this.tab));
    const s = world.get();
    const scroll = this.body.scrollTop;
    this.body.innerHTML = '';
    if (this.tab === 'staff') { this.renderStaff(); this.body.scrollTop = scroll; return; }
    if (this.tab === 'domains') { this.renderDomains(); return; }
    if (this.tab === 'events') {
      const log = document.createElement('div');
      log.className = 'log';
      const items = [...s.logs].reverse();
      if (!items.length) log.innerHTML = '<p class="intro">No events yet.</p>';
      for (const l of items) {
        const r = document.createElement('div');
        r.innerHTML = `<time>${fmtTime(l.tick)}</time><span class="${l.level}"></span>`;
        r.querySelector('span')!.textContent = `${s.devices[l.deviceId]?.name ? '' : ''}${l.msg}`;
        log.appendChild(r);
      }
      this.body.appendChild(log);
    } else {
      const intro = document.createElement('p');
      intro.className = 'intro';
      intro.textContent = s.meta.sandbox
        ? 'This is the example network: a sandbox that does not award goals. Start a new game from the Game menu to play the career.'
        : 'Everything starts manual: you type every IP, mask, gateway, route, NAT entry and rule yourself. Each goal proves a skill and unlocks the automation that replaces it.';
      this.body.appendChild(intro);
      const unl = document.createElement('div');
      unl.className = 'unl';
      for (const [k, name] of Object.entries(UNLOCK_NAMES)) {
        const c = document.createElement('span');
        const on = s.unlocks[k as keyof typeof s.unlocks];
        c.className = `chip${on ? ' on' : ''}`;
        c.textContent = `${on ? '✓' : '🔒︎'} ${name}`;
        unl.appendChild(c);
      }
      this.body.appendChild(unl);
      let firstOpen = true;
      for (const a of ACHIEVEMENTS) {
        const st = s.achievements[a.id];
        const locked = a.requires?.some((r) => !s.achievements[r]?.done) ?? false;
        const card = document.createElement('div');
        card.className = `a${st?.done ? ' done' : ''}${locked ? ' locked' : ''}`;
        const target = a.target ?? 1;
        const prog = st?.done ? target : st?.progress ?? 0;
        const status = st?.done ? 'done' : locked ? 'locked' : a.target ? `${Math.floor(prog).toLocaleString()} / ${target.toLocaleString()}` : 'open';
        card.innerHTML = `<div class="t"><b></b><span>${status}</span></div><p class="g"></p><p class="rw"></p>${a.target && !st?.done ? `<div class="bar"><i style="width:${(prog / target) * 100}%"></i></div>` : ''}`;
        card.querySelector('b')!.textContent = a.title;
        card.querySelector('.g')!.textContent = a.goal;
        card.querySelector('.rw')!.textContent = `Reward: ${a.reward}`;
        if (!st?.done && !locked) {
          const det = document.createElement('details');
          det.dataset.id = a.id;
          if (this.openDetails.has(a.id) || (firstOpen && !this.openDetails.size)) det.open = true;
          firstOpen = false;
          det.innerHTML = '<summary>How to do it</summary>';
          const ol = document.createElement('ol');
          for (const h of a.how) { const li = document.createElement('li'); li.textContent = h; ol.appendChild(li); }
          det.appendChild(ol);
          card.appendChild(det);
        }
        this.body.appendChild(card);
      }
    }
    this.body.scrollTop = scroll;
  }
}
customElements.define('ns-goals', NsGoals);

// staff tab lives on the prototype to keep NsGoals readable
declare module './hud' { interface NsGoals { renderStaff(): void; renderDomains(): void } }

NsGoals.prototype.renderDomains = function renderDomains(this: NsGoals): void {
  const body = (this as unknown as { body: HTMLElement }).body;
  const s = world.get();
  const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  // ── public IPs
  const ipCard = mk('div', 'a');
  const upl = Object.values(s.devices).find((d) => d.kind === 'uplink');
  ipCard.appendChild(mk('b', '', 'Public IPs'));
  ipCard.appendChild(mk('p', '', `Your ISP gave you ${upl?.kind === 'uplink' ? upl.publicSubnet : 'a block'} (gateway ${upl?.kind === 'uplink' ? upl.uplinkIp : '?'}). List the addresses you put to use and which services visitors reach on each. Traffic arrives on these IPs; your NAT and routing decide which server gets it. Services with a domain name use the domain's records instead.`));
  const ipRow = mk('div');
  ipRow.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px';
  const ipIn = mk('input');
  ipIn.id = 'pip-new'; ipIn.placeholder = '203.0.113.5'; ipIn.setAttribute('aria-label', 'Public IP');
  ipIn.addEventListener('keydown', (e) => e.stopPropagation());
  const ipAdd = mk('button', '', 'Add IP');
  ipAdd.addEventListener('click', () => { const e = addPublicAddr(ipIn.value); if (e) toast(e, 'error'); });
  ipRow.append(ipIn, ipAdd);
  ipCard.appendChild(ipRow);
  const svcs = Object.values(s.services).filter((v) => !v.fqdn);
  for (const a of Object.values(s.publicAddrs)) {
    const box = mk('div');
    box.style.cssText = 'display:grid;gap:3px;padding:6px 0;border-top:1px solid var(--line)';
    const top = mk('div');
    top.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px';
    top.appendChild(mk('b', '', a.ip));
    const rm = mk('button', 'ghost', 'Remove');
    rm.addEventListener('click', () => removePublicAddr(a.id));
    top.appendChild(rm);
    box.appendChild(top);
    if (!svcs.length) box.appendChild(mk('p', '', 'No service without a domain yet.'));
    for (const v of svcs) {
      const l = mk('label');
      l.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:12px';
      const cb = mk('input');
      cb.type = 'checkbox'; cb.style.width = 'auto'; cb.id = `pip-${a.id}-${v.id}`;
      cb.checked = a.services.includes(v.id);
      cb.addEventListener('change', () => togglePublicService(a.id, v.id, cb.checked));
      l.appendChild(cb);
      l.appendChild(document.createTextNode(`${s.devices[v.serverId]?.name ?? '?'} · ${v.kind} (${v.kind === 'dns' ? 'udp' : 'tcp'}/${v.port})`));
      box.appendChild(l);
    }
    const uses = [
      ...Object.values(s.devices).flatMap((d) => (d.kind === 'router' || d.kind === 'firewall') ? d.nat.filter((n) => n.publicIp === a.ip).map((n) => `NAT on ${d.name} → ${n.privateIp}`) : []),
      ...Object.values(s.domains).flatMap((d) => d.records.filter((r) => r.ip === a.ip).map((r) => `${r.name === '@' || !r.name ? d.name : `${r.name}.${d.name}`}`)),
    ];
    box.appendChild(mk('p', '', uses.length ? `Used by: ${uses.join(' · ')}` : 'Not NATed anywhere yet: add a static NAT entry on your edge device, or give a server this IP.'));
    ipCard.appendChild(box);
  }
  body.appendChild(ipCard);
  const intro = mk('p', 'intro', `A domain lets visitors find you by name: named sites get about 40 % more traffic. Each domain costs a renewal of $${DOMAIN_RENEWAL}/s. Its DNS records say which public IP a name points to. Point several names at one reverse proxy to save public IPs.`);
  body.appendChild(intro);
  // buy
  const buy = mk('div', 'a');
  buy.appendChild(mk('b', '', 'Register a domain'));
  const row = mk('div');
  row.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) 104px auto;gap:6px';
  const inp = mk('input');
  inp.id = 'dom-name'; inp.placeholder = 'mycompany'; inp.setAttribute('aria-label', 'Domain name');
  inp.addEventListener('keydown', (e) => e.stopPropagation());
  const tld = mk('select');
  tld.id = 'dom-tld'; tld.setAttribute('aria-label', 'Ending');
  for (const [t, p] of Object.entries(TLDS)) { const o = mk('option', '', `.${t} $${p}`); o.value = t; tld.appendChild(o); }
  const b = mk('button', '', 'Buy');
  b.addEventListener('click', () => {
    const e = buyDomain(`${inp.value.trim().toLowerCase()}.${tld.value}`);
    if (e) toast(e, 'error'); else toast(`You own ${inp.value.trim().toLowerCase()}.${tld.value}. Add records below.`, 'good');
  });
  row.append(inp, tld, b);
  buy.appendChild(row);
  body.appendChild(buy);
  const ips = Object.values(s.publicAddrs).map((a) => a.ip);
  const ctx = buildCtx(s, runtime);
  for (const d of Object.values(s.domains)) {
    const card = mk('div', 'a');
    const t = mk('div', 't');
    t.appendChild(mk('b', '', d.name));
    t.appendChild(mk('span', '', d.hosting === 'registrar' ? `registrar DNS · $${(DOMAIN_RENEWAL + REGISTRAR_DNS_FEE).toFixed(3)}/s` : `self-hosted · $${DOMAIN_RENEWAL}/s`));
    card.appendChild(t);
    const host = mk('select');
    host.id = `dom-${d.id}-host`;
    for (const [v, l] of [['registrar', `Registrar answers DNS ($${REGISTRAR_DNS_FEE}/s)`], ['self', 'My Public DNS server answers']] as const) { const o = mk('option', '', l); o.value = v; o.selected = d.hosting === v; host.appendChild(o); }
    host.addEventListener('change', () => editDomain(d.id, (x) => { x.hosting = host.value as 'registrar' | 'self'; }));
    card.appendChild(host);
    if (d.hosting === 'self') {
      const ns = mk('select');
      ns.id = `dom-${d.id}-ns`;
      const o0 = mk('option', '', 'name server IP…'); o0.value = ''; ns.appendChild(o0);
      for (const ip of ips) { const o = mk('option', '', `name server ${ip}`); o.value = ip; o.selected = d.nsIp === ip; ns.appendChild(o); }
      ns.addEventListener('change', () => editDomain(d.id, (x) => { x.nsIp = ns.value; }));
      card.appendChild(ns);
      card.appendChild(mk('p', '', 'Run the Public DNS role on a server, NAT this IP to it, and allow udp/53 from outside in your firewall.'));
    }
    card.appendChild(mk('b', '', 'Records'));
    d.records.forEach((r, i) => {
      const rr = mk('div');
      rr.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 30px;gap:6px;align-items:center';
      const n = mk('input');
      n.id = `rec-${r.id}-n`; n.value = r.name; n.placeholder = 'www (or @)'; n.setAttribute('aria-label', 'Record name');
      n.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') n.blur(); });
      n.addEventListener('change', () => editDomain(d.id, (x) => { const y = x.records[i]; if (y) y.name = n.value.trim().toLowerCase(); }));
      const ip = mk('select');
      ip.id = `rec-${r.id}-ip`;
      const z = mk('option', '', ips.length ? 'points to…' : 'add a public IP above first'); z.value = ''; ip.appendChild(z);
      for (const v of ips) { const o = mk('option', '', v); o.value = v; o.selected = r.ip === v; ip.appendChild(o); }
      ip.addEventListener('change', () => editDomain(d.id, (x) => { const y = x.records[i]; if (y) y.ip = ip.value; }));
      const del = mk('button', 'ghost', '✕');
      del.setAttribute('aria-label', 'Delete record');
      del.addEventListener('click', () => editDomain(d.id, (x) => { x.records.splice(i, 1); }));
      rr.append(n, ip, del);
      card.appendChild(rr);
      const fq = r.name === '@' || !r.name ? d.name : `${r.name}.${d.name}`;
      const res = resolvePublic(s, ctx, fq);
      card.appendChild(mk('p', '', `${res.ip ? '✓' : '✕'} ${fq}: ${res.why}`));
    });
    const add = mk('button', '', '+ Add record');
    add.style.justifySelf = 'start';
    add.addEventListener('click', () => editDomain(d.id, (x) => { x.records.push({ id: `rec_${Date.now().toString(36)}`, name: x.records.length ? '' : 'www', ip: '' }); }));
    card.appendChild(add);
    const drop = mk('button', 'ghost', 'Let the domain expire');
    drop.style.justifySelf = 'start';
    drop.addEventListener('click', () => dropDomain(d.id));
    card.appendChild(drop);
    body.appendChild(card);
  }
};
NsGoals.prototype.renderStaff = function renderStaff(this: NsGoals): void {
  const body = (this as unknown as { body: HTMLElement }).body;
  const s = world.get();
  const st = s.staff;
  const intro = document.createElement('p');
  intro.className = 'intro';
  intro.textContent = `Engineers repair hardware on site and patch software, remotely from a desk when its PC can reach the device. Each costs $${ENGINEER_HIRE} to hire and $${ENGINEER_SALARY}/s in salary.`;
  body.appendChild(intro);
  const hire = document.createElement('button');
  hire.textContent = `Hire engineer · $${ENGINEER_HIRE}`;
  hire.addEventListener('click', () => { const e = hireEngineer(); if (e) toast(e, 'error'); else toast('A new engineer arrived at the door.', 'good'); });
  body.appendChild(hire);
  for (const e of Object.values(st.engineers)) {
    const card = document.createElement('div');
    card.className = 'a';
    const desk = e.deskId ? s.devices[e.deskId]?.name : null;
    card.innerHTML = '<div class="t"><b></b><span></span></div><p class="g"></p>';
    card.querySelector('b')!.textContent = e.name;
    card.querySelector('.t span')!.textContent = desk ?? 'no desk';
    card.querySelector('.g')!.textContent = engineerActivity(s, e);
    const fire = document.createElement('button');
    fire.textContent = 'Let go';
    fire.className = 'ghost';
    fire.style.justifySelf = 'start';
    fire.addEventListener('click', () => fireEngineer(e.id));
    card.appendChild(fire);
    body.appendChild(card);
  }
  if (!Object.keys(st.engineers).length) {
    const p = document.createElement('p');
    p.className = 'intro';
    p.textContent = 'Nobody works here. Nothing gets repaired or patched until you hire someone.';
    body.appendChild(p);
  }
  const toggles = document.createElement('div');
  toggles.className = 'a';
  toggles.innerHTML = '<div class="t"><b>Standing orders</b></div>';
  const mk = (label: string, on: boolean, set: (v: boolean) => void) => {
    const l = document.createElement('label');
    l.style.cssText = 'display:flex;gap:8px;align-items:center;font-size:12.5px';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = on;
    cb.style.width = 'auto';
    cb.addEventListener('change', () => world.update((w) => set.call(null, cb.checked) ?? w, 'world'));
    l.appendChild(cb);
    l.appendChild(document.createTextNode(label));
    toggles.appendChild(l);
  };
  mk('Fix problems an engineer has seen, reimage hacked machines (pays for parts)', st.autoMaintain, (v) => { world.get().staff.autoMaintain = v; });
  mk('Patch new releases automatically', st.autoPatch, (v) => { world.get().staff.autoPatch = v; });
  body.appendChild(toggles);
  const jobs = Object.values(st.jobs);
  const jc = document.createElement('div');
  jc.className = 'a';
  jc.innerHTML = `<div class="t"><b>Work queue</b><span>${jobs.length}</span></div>`;
  const labels: Record<string, string> = { preventive: 'Preventive maintenance', full: 'Full repair', replace: 'Replace', update: 'Patch', reimage: 'Reimage' };
  for (const j of jobs) {
    const p = document.createElement('p');
    const e = j.engineerId ? st.engineers[j.engineerId] : undefined;
    p.textContent = `${labels[j.kind]} · ${s.devices[j.deviceId]?.name ?? '?'} · ${e ? `${e.name}${j.remote ? ' (remote)' : j.started ? ' (working)' : ' (on the way)'}` : 'waiting'}`;
    jc.appendChild(p);
  }
  if (!jobs.length) { const p = document.createElement('p'); p.textContent = 'Nothing to do.'; jc.appendChild(p); }
  body.appendChild(jc);
  const sec = document.createElement('div');
  sec.className = 'a';
  const out = Object.values(s.devices).filter((d) => d.sw && d.sw.patch < st.release).length;
  const comp = Object.values(s.devices).filter((d) => d.compromised).map((d) => d.name);
  sec.innerHTML = '<div class="t"><b>Security</b></div>';
  for (const line of [
    `Latest release: #${st.release}. ${out ? `${out} device${out > 1 ? 's' : ''} out of date.` : 'Everything is patched.'}`,
    comp.length ? `Compromised: ${comp.join(', ')}.` : 'No compromised machines.',
    `Smart doors: ${Object.values(runtime.doors).map((d) => d.state).join(', ') || 'none'}. A door only locks while a badge reader next to it reaches an Auth server.`,
    Object.keys(st.trespassers).length ? `${Object.keys(st.trespassers).length} stranger(s) on the premises!` : 'No strangers on site.',
    `Trespassers caught: ${s.stats.trespassersCaught}.`,
  ]) { const p = document.createElement('p'); p.textContent = line; sec.appendChild(p); }
  body.appendChild(sec);
};

// ---------- Toasts ----------

interface ToastItem { id: number; msg: string; kind: ToastKind }

const TOASTS_CSS = `
  :host {
    position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    pointer-events: none; z-index: 30; width: min(92vw, 480px);
  }
  .t {
    background: var(--paper); border: 1px solid var(--line-strong); border-left-width: 3px; border-radius: 8px;
    padding: 8px 12px; font-size: 12.5px; line-height: 1.4; box-shadow: 0 6px 24px rgb(0 0 0 / 0.35);
    animation: in 0.16s ease-out;
  }
  .t.error, .t.alert { border-color: var(--bad); }
  .t.warn { border-color: var(--warn); }
  .t.good { border-color: var(--ok); }
  @keyframes in { from { opacity: 0; transform: translateY(6px); } }
`;

export class NsToasts extends HTMLElement {
  private shadow = this.attachShadow({ mode: 'open' });
  private items: ToastItem[] = [];
  private seq = 0;
  private container!: HTMLElement;
  connectedCallback(): void {
    this.shadow.appendChild(baseStyle());
    const st = document.createElement('style');
    st.textContent = TOASTS_CSS;
    this.shadow.appendChild(st);
    this.container = document.createElement('div');
    this.container.style.display = 'contents';
    this.shadow.appendChild(this.container);
    onToast((msg, kind) => {
      const item: ToastItem = { id: ++this.seq, msg, kind };
      this.items = [...this.items.slice(-3), item];
      this.render();
      setTimeout(() => { this.items = this.items.filter((i) => i.id !== item.id); this.render(); }, kind === 'info' ? 2600 : 6000);
    });
  }
  private render(): void {
    this.container.innerHTML = '';
    for (const item of this.items) {
      const div = document.createElement('div');
      div.className = `t ${item.kind}`;
      div.setAttribute('role', item.kind === 'alert' ? 'alert' : 'status');
      div.textContent = item.msg;
      this.container.appendChild(div);
    }
  }
}
customElements.define('ns-toasts', NsToasts);
