// Topbar, incident banner, Goals/Events drawer and toasts — plain DOM custom elements.
import { TICKS_PER_SEC } from '../balance';
import { ACHIEVEMENTS } from '../progress';
import { uptimePercent } from '../sim/engine';
import { DEVICE_DEFS } from '../state/devices';
import { ENGINEER_HIRE, ENGINEER_SALARY, TRAITS } from '../balance';
import { engineerActivity, smartDoorsLocked } from '../sim/staff';
import { addPublicAddr, buyBuilding, buyDomain, dropDomain, editDomain, fireEngineer, hireEngineer, onToast, publicIps, removePublicAddr, runtime, toast, togglePublicService, ui, world, type ToastKind } from '../state/world';
import { DOMAIN_RENEWAL, REGISTRAR_DNS_FEE, TLDS } from '../balance';
import { resolvePublic } from '../sim/dns';
import { buildCtx } from '../sim/net';
import { knownProblems, masters, ownerOfIp, targetsOf } from '../sim/monitor';
import type { Building, Device } from '../state/types';
import { STRIDE } from '../state/city';
import { CELL } from '../balance';

type Tab = 'goals' | 'staff' | 'domains' | 'monitoring' | 'events';
import { fmtTime } from './inspector';
import { baseStyle } from './styles';
import { onThemeChange, theme, toggleTheme } from './theme';
import { canRedo, canUndo, onUndoChange } from '../state/undo';
import { doUndo } from '../input';

function hintText(): string {
  const u = ui.get();
  switch (u.tool.mode) {
    case 'select':
      return 'Click a device or cable to set it up. Drag a device to move it; drag empty floor to look around.';
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
    display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 18px;
    margin: 14px; padding: 10px max(16px, env(safe-area-inset-right, 0px)) 10px max(16px, env(safe-area-inset-left, 0px));
    background: var(--paper); border-radius: var(--radius); box-shadow: var(--shadow-sm); position: relative; z-index: 40;
  }
  .brand { display: flex; align-items: center; gap: 12px; white-space: nowrap; }
  .logo { display: flex; align-items: center; gap: 10px; font-family: var(--font-display); font-weight: 800; font-size: 20px; letter-spacing: -0.01em; color: var(--ink); }
  .logo::before {
    content: ""; width: 34px; height: 34px; border-radius: 10px; flex: none;
    background:
      radial-gradient(circle at 30% 30%, #fff 0 2.5px, transparent 3px),
      radial-gradient(circle at 70% 30%, #fff 0 2.5px, transparent 3px),
      radial-gradient(circle at 50% 72%, #fff 0 2.5px, transparent 3px),
      linear-gradient(135deg, #49a6f2, var(--accent) 55%, #7460ee);
    box-shadow: 0 6px 14px color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .logo .word span { color: var(--accent); }
  .stage {
    font-size: 11px; font-weight: 700; color: var(--accent); background: var(--accent-soft);
    padding: 4px 10px; border-radius: 999px; letter-spacing: .02em;
  }
  .hint { font-size: 13px; color: var(--ink-dim); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .right { display: flex; align-items: center; gap: 10px; }
  .econ { display: flex; align-items: stretch; gap: 8px; font-variant-numeric: tabular-nums; }
  .econ .k { display: grid; gap: 2px; align-content: center; padding: 5px 12px; border-radius: 10px; background: var(--well); min-width: 74px; }
  .econ .k small { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-faint); }
  .balance { font-size: 15px; font-weight: 800; color: var(--ok); }
  .balance.neg { color: var(--bad); }
  .net { font-size: 13px; font-weight: 700; }
  .uptime { font-size: 13px; font-weight: 700; color: var(--ink); }
  .util { display: grid; gap: 4px; }
  .util-bar { width: 84px; height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; }
  .util-bar i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #49a6f2, var(--accent)); border-radius: 3px; transition: width 0.3s; }
  .util span { font-size: 11px; font-weight: 600; color: var(--ink-dim); }
  .speeds { display: flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--well); }
  .speeds button { font-size: 12px; min-height: 30px; min-width: 36px; padding: 2px 8px; border: 0; background: transparent; border-radius: 8px; }
  .speeds button:hover { background: var(--paper); }
  .speeds button[aria-pressed="true"] { background: var(--paper); color: var(--accent); box-shadow: var(--shadow-sm); }
  button { font-size: 13px; }
  button.goals { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
  button.goals:hover { background: var(--accent); color: #fff; }
  button.goals:hover .badge { background: #fff; color: var(--accent); }
  .badge { display: inline-block; min-width: 20px; padding: 1px 6px; margin-left: 6px; border-radius: 999px; background: var(--accent); color: #fff; font-size: 11px; font-weight: 700; text-align: center; }
  button[data-action="menu"] { background: var(--accent); border-color: var(--accent); color: #fff; box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 30%, transparent); }
  button[data-action="menu"]:hover { background: var(--accent-strong); color: #fff; }
  .undo-pair { display: flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--well); }
  button.icon { width: 32px; min-height: 30px; padding: 0; display: grid; place-items: center; border-radius: 8px; border: 0; }
  button.icon svg { width: 17px; height: 17px; }
  button.icon:disabled { opacity: .35; }
  button.view { width: 38px; padding: 0; border-radius: 10px; background: var(--well); font-size: 12px; font-weight: 800; letter-spacing: .02em; }
  button.view:hover { background: var(--accent-soft); color: var(--accent); }
  button.theme { width: 38px; padding: 0; display: grid; place-items: center; border-radius: 10px; background: var(--well); }
  button.theme:hover { background: var(--accent-soft); color: var(--accent); }
  button.theme svg { width: 18px; height: 18px; }
  .menu-wrap { position: relative; }
  .menu {
    position: absolute; right: 0; top: calc(100% + 8px); z-index: 50; display: grid; gap: 2px; padding: 8px; min-width: 240px;
    background: var(--paper); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow-lg);
  }
  .menu[hidden] { display: none; }
  .menu button { text-align: left; border: 0; background: transparent; font-weight: 500; color: var(--ink); }
  .menu button:hover { background: var(--accent-soft); color: var(--accent); }
  .menu small { color: var(--ink-faint); font-size: 11px; padding: 0 12px 6px; }
  button.confirm { color: var(--bad) !important; background: var(--bad-soft) !important; }
  @media (max-width: 1280px) { .hint { display: none; } :host { grid-template-columns: auto 1fr; } .right { justify-content: flex-end; } }
  @media (max-width: 980px) { .econ .k:nth-child(3) { display: none; } }
  @media (max-width: 759px) {
    :host { grid-template-columns: 1fr; row-gap: 8px; margin: 0; border-radius: 0; padding-top: 8px; padding-bottom: 8px; }
    .brand .stage { display: none; }
    .right { flex-wrap: wrap; justify-content: space-between; }
    .econ { gap: 6px; }
    .econ .k { min-width: 0; padding: 4px 8px; }
    .util { display: none !important; }
    .right { gap: 6px; }
    button { padding: 5px 9px; font-size: 12px; min-height: 32px; }
    .logo { font-size: 18px; } .logo::before { width: 30px; height: 30px; }
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
      <div class="brand"><span class="logo"><span class="word">Net<span>Sim</span></span></span></div>
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
        <button class="goals" data-action="monitoring" data-el="monbtn" title="What your monitoring servers see" hidden>Monitoring<span class="badge" data-el="moncount">0</span></button>
        <button class="goals" data-action="goals" title="Goals, unlocks and events">Goals<span class="badge" data-el="goalcount">0</span></button>
        <div class="undo-pair">
          <button class="icon ghost" data-action="undo" title="Undo (Ctrl+Z)" aria-label="Undo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg></button>
          <button class="icon ghost" data-action="redo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg></button>
        </div>
        <button class="theme ghost" data-action="theme" title="Switch light / dark mode" aria-label="Switch light / dark mode"></button>
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
    const themeBtn = this.shadow.querySelector<HTMLButtonElement>('button.theme')!;
    const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
    const paintTheme = () => { themeBtn.innerHTML = theme() === 'dark' ? SUN : MOON; themeBtn.title = theme() === 'dark' ? 'Light mode' : 'Dark mode'; };
    paintTheme();
    onThemeChange(paintTheme);
    const paintUndo = () => {
      (this.shadow.querySelector('[data-action="undo"]') as HTMLButtonElement).disabled = !canUndo();
      (this.shadow.querySelector('[data-action="redo"]') as HTMLButtonElement).disabled = !canRedo();
    };
    paintUndo();
    onUndoChange(paintUndo);

    this.shadow.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (t === themeBtn) { toggleTheme(); return; }
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
      case 'undo': doUndo(false); return;
      case 'redo': doUndo(true); return;
      case 'monitoring': (document.querySelector('ns-goals') as NsGoals | null)?.show('monitoring'); return;
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
    const ms = masters(s);
    e.monbtn!.hidden = !ms.length;
    const alerts = Object.entries(s.known ?? {}).filter(([, k]) => k.via === 'monitoring').length + Object.keys(runtime.monSilent ?? {}).length;
    e.moncount!.textContent = String(alerts);
    e.moncount!.style.background = alerts ? 'var(--bad)' : '';
  }
}
customElements.define('ns-topbar', NsTopbar);

// ---------- Incident banner ----------

const BANNER_CSS = `
  :host { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); z-index: 15; pointer-events: none; width: min(92%, 580px); }
  .b { pointer-events: auto; display: grid; gap: 6px; padding: 12px 16px; border-radius: var(--radius); background: var(--paper);
       border-left: 4px solid var(--bad); font-size: 13px; box-shadow: var(--shadow-lg); }
  .b.recon { border-left-color: var(--warn); }
  .b strong { font-size: 12px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; color: var(--bad); }
  .b.recon strong { color: var(--warn); }
  .b span { color: var(--ink-dim); line-height: 1.45; }
  .bar { height: 6px; border-radius: 3px; background: var(--bad-soft); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--bad); border-radius: 3px; }
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

// ---------- Where you are: building, storey, buying ----------

const WHERE_CSS = `
  :host { position: absolute; z-index: 14; top: 12px; left: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; max-width: calc(100% - 24px); }
  .bar { display: flex; gap: 6px; align-items: center; padding: 6px; border-radius: 12px; background: var(--paper); box-shadow: var(--shadow); }
  select { width: auto; max-width: 230px; font-family: var(--font-body); font-weight: 600; font-size: 13px; min-height: 32px; }
  .floors { display: flex; gap: 2px; padding: 3px; border-radius: 9px; background: var(--well); }
  .floors button { min-width: 34px; min-height: 28px; padding: 0 8px; border: 0; background: transparent; font-size: 12.5px; }
  .floors button[aria-pressed="true"] { background: var(--paper); color: var(--accent); box-shadow: var(--shadow-sm); }
  .buy { background: var(--accent); border-color: var(--accent); color: #fff; }
  .buy:hover { background: var(--accent-strong); color: #fff; }
  .info { font-size: 12px; color: var(--ink-dim); padding: 0 4px; }
`;

export class NsWhere extends HTMLElement {
  private shadow = this.attachShadow({ mode: 'open' });
  private box!: HTMLElement;
  private bld = '';
  private seed = -1;
  private last = '';
  connectedCallback(): void {
    this.shadow.appendChild(baseStyle());
    const st = document.createElement('style');
    st.textContent = WHERE_CSS;
    this.shadow.appendChild(st);
    this.box = document.createElement('div');
    this.box.style.display = 'contents';
    this.shadow.appendChild(this.box);
    world.subscribe((_s, r) => { if (r !== 'sim' && r !== 'camera') this.render(); });
    ui.subscribe(() => this.render());
    this.render();
  }

  /** Centre the camera on a building's storey. */
  private goTo(b: Building, level: number): void {
    const cv = document.querySelector('#stage canvas') as HTMLCanvasElement | null;
    const w = cv?.clientWidth ?? 1000, h = cv?.clientHeight ?? 700;
    const xs = b.rects.flatMap((q) => [q.x0, q.x1 + 1]), ys = b.rects.flatMap((q) => [q.y0, q.y1 + 1]);
    const cx = ((Math.min(...xs) + Math.max(...xs)) / 2) * CELL, cy = ((Math.min(...ys) + Math.max(...ys)) / 2 + level * STRIDE) * CELL;
    const scale = world.get().camera.scale;
    // the renderer moves the camera between bands itself; set the storey first, then aim
    ui.update((u) => { u.level = level; }, 'ui');
    world.update((wd) => { wd.camera = { scale, x: w / 2 - cx * scale, y: h / 2 - cy * scale }; }, 'camera');
  }

  private render(): void {
    const s = world.get();
    const bs = Object.values(s.buildings ?? {});
    if (bs.length <= 1) { this.box.innerHTML = ''; return; }
    // a new city (new game, load) starts at your own building
    if (s.meta.seed !== this.seed) { this.seed = s.meta.seed; this.bld = ''; }
    if (!s.buildings[this.bld]) this.bld = bs.find((b) => b.owned)?.id ?? bs[0]!.id;
    const b = s.buildings[this.bld]!;
    const level = ui.get().level ?? 0;
    const key = `${this.bld}|${level}|${bs.map((x) => `${x.id}${x.owned ? 1 : 0}`).join()}|${Math.floor(s.economy.balance / 500)}`;
    if (key === this.last) return;
    this.last = key;
    this.box.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'bar';
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Building');
    const order = [...bs].sort((a, c) => Number(c.owned) - Number(a.owned) || Number(c.forSale) - Number(a.forSale) || a.name.localeCompare(c.name));
    let group = '';
    for (const x of order) {
      const g = x.owned ? 'Yours' : x.forSale ? 'For sale' : 'Neighbours';
      if (g !== group) { const og = document.createElement('option'); og.disabled = true; og.textContent = `── ${g}`; sel.appendChild(og); group = g; }
      const o = document.createElement('option');
      o.value = x.id;
      o.textContent = `${x.name} · ${x.floors} floor${x.floors === 1 ? '' : 's'}${!x.owned && x.forSale ? ` · $${x.price.toLocaleString()}` : ''}`;
      o.selected = x.id === this.bld;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { this.bld = sel.value; const nb = world.get().buildings[sel.value]!; this.goTo(nb, Math.min(level, nb.owned ? nb.floors - 1 : 0)); sel.blur(); });
    bar.appendChild(sel);
    if (b.owned) {
      const fl = document.createElement('div');
      fl.className = 'floors';
      fl.setAttribute('role', 'radiogroup');
      fl.setAttribute('aria-label', 'Floor');
      for (let z = b.floors - 1; z >= 0; z--) {
        const btn2 = document.createElement('button');
        btn2.textContent = z === 0 ? 'G' : String(z);
        btn2.title = z === 0 ? 'Ground floor' : `Floor ${z}`;
        btn2.setAttribute('aria-pressed', String(z === level));
        btn2.addEventListener('click', () => this.goTo(b, z));
        fl.appendChild(btn2);
      }
      bar.appendChild(fl);
    } else if (b.forSale) {
      const buy = document.createElement('button');
      buy.className = 'buy';
      buy.textContent = `Buy for $${b.price.toLocaleString()}`;
      buy.addEventListener('click', () => { const err = buyBuilding(b.id); if (err) toast(err, 'error'); else { toast(`${b.name} is yours. It comes with its own internet line and addresses.`, 'good'); this.last = ''; this.render(); } });
      bar.appendChild(buy);
    } else {
      const i = document.createElement('span');
      i.className = 'info';
      i.textContent = 'Not for sale';
      bar.appendChild(i);
    }
    this.box.appendChild(bar);
  }
}
customElements.define('ns-where', NsWhere);

// ---------- Goals / Events drawer ----------

const GOALS_CSS = `
  :host { position: absolute; z-index: 25; top: 14px; left: max(14px, env(safe-area-inset-left, 0px)); bottom: 14px; width: 390px; display: none; flex-direction: column;
          background: var(--paper); border-radius: var(--radius); box-shadow: var(--shadow-lg); overflow: hidden; }
  :host([open]) { display: flex; }
  header { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
  header .tabs { display: flex; gap: 2px; flex: 1; padding: 3px; background: var(--well); border-radius: 10px; }
  header .tabs button { flex: 1; border: 0; background: transparent; padding: 4px 8px; font-size: 12.5px; min-height: 30px; }
  header .tabs button:hover { background: var(--paper); }
  header .tabs button[aria-pressed="true"] { background: var(--paper); color: var(--accent); box-shadow: var(--shadow-sm); }
  .close { width: 34px; padding: 0; font-size: 20px; font-weight: 400; }
  .body { overflow-y: auto; padding: 14px; display: grid; gap: 10px; align-content: start; overscroll-behavior: contain; background: var(--well-soft); }
  .intro { font-size: 13px; color: var(--ink-dim); line-height: 1.55; margin: 0; }
  .a { display: grid; gap: 8px; padding: 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); box-shadow: var(--shadow-sm); }
  .a.done { border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); background: linear-gradient(0deg, var(--paper), var(--paper)) padding-box; box-shadow: inset 4px 0 0 var(--ok), var(--shadow-sm); }
  .a.locked { opacity: .6; box-shadow: none; background: var(--well); }
  .a .t { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
  .a .t b { font-size: 14px; font-weight: 700; }
  .a .t span { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-faint); white-space: nowrap; padding: 2px 8px; border-radius: 999px; background: var(--well); }
  .a.done .t span { color: var(--ok); background: var(--ok-soft); }
  .a p { margin: 0; font-size: 13px; line-height: 1.5; }
  .a .rw { color: var(--accent); font-size: 12.5px; font-weight: 600; }
  .a ol { margin: 0; padding-left: 18px; font-size: 12.5px; line-height: 1.55; color: var(--ink-dim); display: grid; gap: 3px; }
  .a details summary { cursor: pointer; font-size: 12.5px; font-weight: 600; color: var(--ink-dim); }
  .a details summary:hover { color: var(--accent); }
  .bar { height: 6px; border-radius: 3px; background: var(--accent-soft); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
  .unl { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 999px; background: var(--well); color: var(--ink-faint); border: 1px solid var(--line); }
  .chip.on { border-color: transparent; background: var(--ok-soft); color: var(--ok); }
  .mon-pick { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 10px; font-size: 12.5px; font-weight: 600; color: var(--ink-dim); }
  .mon-sum { display: flex; flex-wrap: wrap; gap: 6px; }
  .mon-sum span { font-size: 12px; padding: 4px 10px; border-radius: 999px; background: var(--paper); border: 1px solid var(--line); color: var(--ink-dim); }
  .mon-sum span.bad { background: var(--bad-soft); color: var(--bad); border-color: transparent; }
  .mon-sum span.warn { background: var(--warn-soft); color: var(--warn); border-color: transparent; }
  .mon-card { display: grid; gap: 8px; width: 100%; text-align: left; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); box-shadow: var(--shadow-sm); color: var(--ink); cursor: pointer; animation: rise .25s ease-out; }
  .mon-card:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: var(--paper); color: var(--ink); }
  .mon-card.alert { box-shadow: inset 4px 0 0 var(--bad), var(--shadow-sm); }
  .mon-card.warn, .mon-card.busy { box-shadow: inset 4px 0 0 var(--warn), var(--shadow-sm); }
  .mon-card .t { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .mon-card .t b { font-size: 13.5px; }
  .mon-card .via { font-family: var(--font-mono); font-size: 10.5px; color: var(--ink-faint); }
  .mon-bars { display: grid; grid-template-columns: 58px minmax(0, 1fr) 54px; gap: 5px 8px; align-items: center; font-size: 11.5px; }
  .mon-bars .k { color: var(--ink-dim); }
  .mon-bars .v { font-family: var(--font-mono); font-size: 11px; text-align: right; color: var(--ink-dim); }
  .mon-bars .bar i { background: var(--ok); transition: width .4s ease; }
  .mon-bars .bar.warm i { background: var(--warn); }
  .mon-bars .bar.hot i { background: var(--bad); }
  .mon-alert, .mon-warn, .mon-ok { font-size: 12px; line-height: 1.45; padding: 6px 10px; border-radius: 8px; }
  .mon-alert { background: var(--bad-soft); color: var(--bad); }
  .mon-warn { background: var(--warn-soft); color: var(--warn); }
  .mon-ok { background: var(--ok-soft); color: var(--ok); }
  .mon-empty { font-size: 13px; line-height: 1.5; padding: 14px; border-radius: var(--radius); background: var(--paper); border: 1px dashed var(--line-strong); color: var(--ink-dim); }
  @keyframes rise { from { opacity: 0; transform: translateY(4px); } }
  .log { display: grid; gap: 6px; font-size: 12.5px; line-height: 1.45; }
  .log div { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 8px; padding: 6px 8px; border-radius: 8px; background: var(--paper); }
  .log time { font-family: var(--font-mono); color: var(--ink-faint); font-size: 11px; }
  .log .warn { color: var(--warn); } .log .alert { color: var(--bad); }
  @media (max-width: 759px) { :host { left: 0; right: 0; width: auto; top: auto; bottom: 0; max-height: 70%; border-radius: 16px 16px 0 0; } }
`;

const UNLOCK_NAMES: Record<string, string> = {
  macLearning: 'MAC learning', dhcp: 'DHCP', dynamicRouting: 'OSPF', serverM: 'Server M', serverL: 'Server L',
  carrierUplink: 'Carrier uplink', monitoring: 'Monitoring', autoMitigation: 'Auto-mitigation', upstreamFiltering: 'Upstream filtering', dynamicNat: 'Dynamic NAT',
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
    h.innerHTML = `<div class="tabs"><button data-tab="goals">Goals</button><button data-tab="staff">Staff</button><button data-tab="domains">Internet</button><button data-tab="monitoring" data-mon>Monitor</button><button data-tab="events">Events</button></div><button class="close ghost" aria-label="Close goals">×</button>`;
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
  private monMaster = '';

  /** The monitoring console as one master sees it: only what it has polled. */
  private renderMonitoring(): void {
    const s = world.get();
    const ms = masters(s);
    const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
    if (!ms.length) { this.body.appendChild(mk('p', 'intro', 'No monitoring server yet. Give a server the Monitoring master role and list what it should poll.')); return; }
    if (!ms.some((m) => m.id === this.monMaster)) this.monMaster = ms[0]!.id;
    const pickRow = mk('label', 'mon-pick');
    pickRow.appendChild(mk('span', '', 'Console of'));
    const sel = document.createElement('select');
    for (const m of ms) { const o = document.createElement('option'); o.value = m.id; o.textContent = `${m.name}${m.ip ? ` (${m.ip})` : ''}`; o.selected = m.id === this.monMaster; sel.appendChild(o); }
    sel.addEventListener('change', () => { this.monMaster = sel.value; sel.blur(); this.render(); });
    pickRow.appendChild(sel);
    this.body.appendChild(pickRow);
    const m = ms.find((x) => x.id === this.monMaster)!;
    // you look at it the way your staff do: from a desk that can open its web page
    const desks = Object.entries(runtime.consoles ?? {}).filter(([, mid]) => mid === m.id).map(([id]) => s.devices[id]?.name ?? '?');
    if (!desks.length) {
      this.body.appendChild(mk('div', 'mon-empty', `Can't open ${m.name}'s console. A desk has to reach it on tcp/80${m.ip ? ` (http://${m.ip})` : ''}. Cable a desk into that network or allow it through the firewall.`));
      return;
    }
    const watched = Object.entries(runtime.monitored ?? {}).filter(([, mid]) => mid === m.id).map(([id]) => s.devices[id]).filter((d): d is Device => !!d);
    // which address and method reached each device
    const how = new Map<string, string>();
    for (const t of targetsOf(m)) { const o = ownerOfIp(s, t.ip); if (o) how.set(o.id, `${t.method === 'agent' ? 'agent' : 'SNMP'} · ${t.ip.trim()}`); }
    const pct = (v: number | undefined) => Math.round(Math.max(0, Math.min(1, v ?? 0)) * 100);
    type Row = { d: Device; sev: number; card: HTMLElement };
    const rows: Row[] = [];
    for (const d of watched) {
      const silent = !!runtime.monSilent?.[d.id];
      const probs = knownProblems(s, d);
      const card = mk('div', 'mon-card');
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      const pick = () => ui.update((u) => { u.selection = { type: 'device', id: d.id }; }, 'ui');
      card.addEventListener('click', pick);
      card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
      const head = mk('div', 't');
      head.appendChild(mk('b', '', d.name));
      head.appendChild(mk('span', 'via', d.id === m.id ? 'this server' : how.get(d.id) ?? 'seen on the path'));
      card.appendChild(head);
      let sev = 0;
      if (silent) {
        sev = 3;
        card.appendChild(mk('div', 'mon-alert', `Not answering: ${runtime.monWhy?.[d.id]?.replace(/^[^:]+: (No answer: )?/, '') ?? 'no reply'}`));
      } else {
        // agents report the inside of a server; SNMP only interface traffic and health
        const bars: [string, number, string][] = [];
        if (d.kind === 'server') {
          bars.push(['CPU', pct(d.usage.cpu), `${pct(d.usage.cpu)} %`], ['RAM', pct(d.usage.ram), `${pct(d.usage.ram)} %`], ['Disk', pct(d.usage.storage), `${pct(d.usage.storage)} %`], ['Network', pct(d.usage.bandwidth), `${pct(d.usage.bandwidth)} %`]);
        } else if ('usage' in d) bars.push(['Traffic', pct(d.usage.bandwidth), `${pct(d.usage.bandwidth)} %`]);
        if (d.temp !== undefined) bars.push(['Temp', Math.min(100, Math.round(d.temp)), `${Math.round(d.temp)} °C`]);
        if (d.kind === 'server' && s.unlocks.monitoring) { const w = Math.max(0, ...d.hw.comps.map((c) => c.wear)); bars.push(['Wear', pct(w), `${pct(w)} %`]); }
        const grid = mk('div', 'mon-bars');
        for (const [k, v, txt] of bars) {
          const hot = (k === 'Temp' ? v >= 80 : k === 'Wear' ? v >= 70 : v >= 90);
          if (hot) sev = Math.max(sev, 1);
          grid.appendChild(mk('span', 'k', k));
          const bar = mk('div', `bar${hot ? ' hot' : v >= 75 && k !== 'Temp' ? ' warm' : ''}`);
          const fill = mk('i'); fill.style.width = `${k === 'Temp' ? Math.min(100, v) : v}%`; bar.appendChild(fill);
          grid.appendChild(bar);
          grid.appendChild(mk('span', 'v', txt));
        }
        if (bars.length) card.appendChild(grid);
        else card.appendChild(mk('div', 'mon-ok', 'Up.'));
      }
      for (const p of probs) {
        sev = Math.max(sev, p.level === 'alert' ? 3 : 2);
        card.appendChild(mk('div', p.level === 'alert' ? 'mon-alert' : 'mon-warn', `${p.msg}${p.ack ? ` · ${p.by} is on it` : ''}`));
      }
      card.classList.add(['ok', 'busy', 'warn', 'alert'][sev]!);
      rows.push({ d, sev, card });
    }
    rows.sort((a, b) => b.sev - a.sev || a.d.name.localeCompare(b.d.name));
    const nAlert = rows.filter((r) => r.sev === 3).length, nWarn = rows.filter((r) => r.sev === 2).length, nBusy = rows.filter((r) => r.sev === 1).length;
    const sum = mk('div', 'mon-sum');
    sum.innerHTML = `<span><b>${rows.length}</b> watched</span><span class="${nAlert ? 'bad' : ''}"><b>${nAlert}</b> down or failing</span><span class="${nWarn ? 'warn' : ''}"><b>${nWarn}</b> warnings</span><span class="${nBusy ? 'warn' : ''}"><b>${nBusy}</b> running hot</span>`;
    this.body.appendChild(sum);
    this.body.appendChild(mk('p', 'intro', `Open on ${desks.join(', ')}. You see what ${m.name} sees: add more addresses to its poll list to watch more.`));
    for (const r of rows) this.body.appendChild(r.card);
    if (!rows.length) this.body.appendChild(mk('div', 'mon-empty', `${m.name} isn't hearing from anything yet. Add addresses to its poll targets.`));
  }

  private renderInto(): void {
    const mon = this.shadow.querySelector<HTMLButtonElement>('[data-mon]');
    if (mon) mon.hidden = !masters(world.get()).length;
    for (const b of this.shadow.querySelectorAll<HTMLButtonElement>('[data-tab]')) b.setAttribute('aria-pressed', String(b.dataset.tab === this.tab));
    const s = world.get();
    const scroll = this.body.scrollTop;
    this.body.innerHTML = '';
    if (this.tab === 'staff') { this.renderStaff(); this.body.scrollTop = scroll; return; }
    if (this.tab === 'domains') { this.renderDomains(); return; }
    if (this.tab === 'monitoring') { this.renderMonitoring(); this.body.scrollTop = scroll; return; }
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
        : 'Everything starts manual: every address, route, NAT entry and firewall rule is yours to type. Each goal proves a skill and unlocks the automation that replaces it.';
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
          for (const h of typeof a.how === 'function' ? a.how(world.get()) : a.how) { const li = document.createElement('li'); li.textContent = h; ol.appendChild(li); }
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
  ipIn.id = 'pip-new'; ipIn.placeholder = publicIps(world.get())[3] ?? '203.0.113.5'; ipIn.setAttribute('aria-label', 'Public IP');
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
  intro.textContent = `Engineers fix hardware on site and patch software, remotely from any desk whose PC can reach the device. Hiring through an agency costs $${ENGINEER_HIRE}; pay is around $${ENGINEER_SALARY}/s. Now and then someone walks in asking for a job.`;
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
    const tr = document.createElement('p');
    tr.className = 'rw';
    tr.textContent = `$${(e.salary ?? ENGINEER_SALARY).toFixed(3)}/s${e.traits?.length ? ' · ' + e.traits.map((t) => `${TRAITS[t]?.label}: ${TRAITS[t]?.blurb}`).join(' · ') : ''}`;
    card.appendChild(tr);
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
    position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    pointer-events: none; z-index: 30; width: min(92vw, 480px);
  }
  .t {
    background: var(--paper); border: 0; border-left: 4px solid var(--accent); border-radius: 10px;
    padding: 10px 14px; font-size: 13px; line-height: 1.45; box-shadow: var(--shadow-lg);
    animation: in 0.18s ease-out;
  }
  .t.error, .t.alert { border-left-color: var(--bad); }
  .t.warn { border-left-color: var(--warn); }
  .t.good { border-left-color: var(--ok); }
  @keyframes in { from { opacity: 0; transform: translateY(8px); } }
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
