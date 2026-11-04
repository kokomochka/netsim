// Tool palette — plain DOM custom element (no Lit).
import { ACCESS, CABLE_BANDWIDTH, CABLE_PRICE, TILE_PRICE } from '../balance';
import { DEVICE_DEFS, NETWORK_KINDS } from '../state/devices';
import type { CableType, Tile } from '../state/types';
import { setTool, ui } from '../state/world';
import { cableGlyph, kindGlyph, selectGlyph } from './glyphs';
import { baseStyle } from './styles';

const CABLE_TYPES: { type: CableType; label: string; color: string }[] = [
  { type: 'ethernet', label: 'Ethernet', color: '#b4c2d4' },
  { type: 'fibre', label: 'Fibre', color: '#ffa94d' },
  { type: 'crossover', label: 'Crossover', color: '#5fb8ff' },
];

const BUILD_TOOLS: { tile: Tile; label: string; title: string }[] = [
  { tile: 'floor', label: 'Floor', title: 'Office floor. Devices and desks stand on floor tiles.' },
  { tile: 'raised', label: 'Server floor', title: 'Raised server-room floor.' },
  { tile: 'wall', label: 'Wall', title: 'Wall. People cannot pass.' },
  { tile: 'door', label: 'Door', title: 'Door. Anyone can walk through.' },
  { tile: 'smartdoor', label: 'Smart door', title: 'Badge door with a built-in controller and network port. Cable it to a switch, then tap it to set its IP and Auth server. It locks only while it can reach Auth.' },
  { tile: 'vent', label: 'Vent', title: 'Vent in a wall. Mixes air between two rooms, or lets a little heat out if it faces outside. Paint it on a wall.' },
  { tile: 'ground', label: 'Clear', title: 'Clear a tile back to open ground.' },
];

const TILE_SVG: Record<Tile, string> = {
  floor: '<rect x="-12" y="-12" width="24" height="24" rx="2" fill="#4c535c" stroke="#8b939c" stroke-width="1.5"/><path d="M-12 0H12M0 -12V12" stroke="#6b737c" stroke-width="1"/>',
  raised: '<rect x="-12" y="-12" width="24" height="24" rx="2" fill="#3c4756" stroke="#8fa0b5" stroke-width="1.5"/><g fill="#8fa0b5"><circle cx="-6" cy="-6" r="1.3"/><circle cx="6" cy="-6" r="1.3"/><circle cx="-6" cy="6" r="1.3"/><circle cx="6" cy="6" r="1.3"/></g>',
  wall: '<rect x="-13" y="-5" width="26" height="10" fill="#d8d2c4"/><rect x="-5" y="-13" width="10" height="26" fill="#d8d2c4"/>',
  door: '<rect x="-13" y="-4" width="5" height="8" fill="#d8d2c4"/><rect x="8" y="-4" width="5" height="8" fill="#d8d2c4"/><path d="M-8 0V-14" stroke="#c49a6c" stroke-width="2.5"/><path d="M-8 -14A14 14 0 0 1 6 0" fill="none" stroke="#c49a6c" stroke-width="1"/>',
  smartdoor: '<rect x="-13" y="-4" width="5" height="8" fill="#d8d2c4"/><rect x="8" y="-4" width="5" height="8" fill="#d8d2c4"/><path d="M-8 0V-14" stroke="#7fe3a0" stroke-width="2.5"/><path d="M-8 -14A14 14 0 0 1 6 0" fill="none" stroke="#7fe3a0" stroke-width="1"/><circle cx="0" cy="6" r="3" fill="#7fe3a0"/>',
  ground: '<rect x="-12" y="-12" width="24" height="24" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 3"/><path d="M-6 -6L6 6M6 -6L-6 6" stroke="currentColor" stroke-width="1.8"/>',
  vent: '<rect x="-13" y="-5" width="26" height="10" fill="#d8d2c4"/><rect x="-9" y="-9" width="18" height="18" rx="3" fill="#1d2a35" stroke="#9fe8ff" stroke-width="1.8"/><path d="M-5 -6V6M-1.5 -6V6M2 -6V6M5.5 -6V6" stroke="#9fe8ff" stroke-width="1.3"/>',
};

function tileGlyph(t: Tile): string {
  return '<svg width="26" height="26" viewBox="-18 -18 36 36" aria-hidden="true">' + TILE_SVG[t] + '</svg>';
}

const PALETTE_CSS = `
  :host {
    display: flex; flex-direction: column; gap: 6px;
    background: var(--paper); border-right: 1px solid var(--line);
    padding: 10px 8px; overflow-y: auto;
  }
  .group { display: flex; flex-direction: column; gap: 6px; }
  .sep { height: 1px; background: var(--line); margin: 4px 2px; flex: none; }
  .tool {
    display: grid; justify-items: center; gap: 2px; padding: 7px 4px 6px; width: 76px;
    background: transparent; border: 1px solid transparent; border-radius: 8px; color: var(--ink-dim);
  }
  .tool:hover { background: var(--raised); border-color: var(--line); color: var(--ink); }
  .tool[aria-pressed="true"] {
    background: var(--raised); border-color: var(--accent); color: var(--ink);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .name { font-size: 11.5px; font-weight: 500; text-align: center; line-height: 1.15; }
  .head { font-family: var(--font-mono); font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-faint); text-align: center; padding-top: 2px; }
  .price { font-family: var(--font-mono); font-size: 10px; color: var(--ink-faint); }
  .cables { display: flex; flex-direction: column; gap: 4px; }
  .chip {
    display: flex; align-items: center; gap: 6px; min-height: 28px; padding: 3px 7px;
    font-size: 11px; border-radius: 6px; background: transparent; border-color: var(--line);
  }
  .chip[aria-pressed="true"] { border-color: var(--accent); background: var(--raised); }
  .swatch { width: 14px; height: 3px; border-radius: 2px; flex: none; }
  .glyph { display: flex; align-items: center; justify-content: center; }
  @media (max-width: 759px) {
    :host {
      flex-direction: row; border-right: 0; border-top: 1px solid var(--line);
      padding: 6px max(8px, env(safe-area-inset-right, 0px)) calc(6px + env(safe-area-inset-bottom, 0px)) max(8px, env(safe-area-inset-left, 0px));
      overflow-x: auto; overflow-y: hidden; gap: 4px; align-items: stretch;
    }
    .group { flex-direction: row; gap: 4px; }
    .sep { width: 1px; height: auto; margin: 4px 2px; }
    .tool { width: 64px; flex: none; }
    .cables { flex-direction: column; justify-content: center; }
    .chip { min-height: 22px; padding: 1px 6px; font-size: 10.5px; }
  }
`;

export class NsPalette extends HTMLElement {
  private shadow: ShadowRoot;
  private unsub?: () => void;
  private root!: HTMLElement;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.shadow.appendChild(baseStyle());
    const style = document.createElement('style');
    style.textContent = PALETTE_CSS;
    this.shadow.appendChild(style);

    this.root = document.createElement('div');
    this.root.style.display = 'contents';
    this.shadow.appendChild(this.root);

    this.render();
    this.unsub = ui.subscribe(() => this.render());
  }

  disconnectedCallback(): void {
    this.unsub?.();
  }

  private render(): void {
    const u = ui.get();
    const t = u.tool;

    // Rebuild DOM each render — palette is small and changes infrequently
    this.root.innerHTML = '';

    // Tools group
    const toolGroup = document.createElement('div');
    toolGroup.className = 'group';
    toolGroup.setAttribute('role', 'toolbar');
    toolGroup.setAttribute('aria-label', 'Tools');

    // Select button
    const selectBtn = this.makeToolButton(
      selectGlyph(), 'Select', 'configure',
      t.mode === 'select',
      'Select and configure (Esc)',
      () => setTool({ mode: 'select' }),
    );
    toolGroup.appendChild(selectBtn);

    // Cable button
    const cableBtn = this.makeToolButton(
      cableGlyph(), 'Cable', `$${CABLE_PRICE[u.cableType]}`,
      t.mode === 'cable',
      'Run a cable between two devices',
      () => setTool({ mode: 'cable' }),
    );
    toolGroup.appendChild(cableBtn);

    // Cable type chips (visible when cable tool active)
    if (t.mode === 'cable') {
      const cablesDiv = document.createElement('div');
      cablesDiv.className = 'cables';
      cablesDiv.setAttribute('role', 'radiogroup');
      cablesDiv.setAttribute('aria-label', 'Cable type');
      for (const c of CABLE_TYPES) {
        const chip = document.createElement('button');
        chip.className = 'chip';
        chip.setAttribute('aria-pressed', String(u.cableType === c.type));
        chip.title = `${c.label}, ${CABLE_BANDWIDTH[c.type] / 1000} Gbps`;
        chip.innerHTML = `<span class="swatch" style="background:${c.color}"></span>${c.label}`;
        chip.addEventListener('click', () => {
          ui.update((x) => { x.cableType = c.type; }, 'ui');
        });
        cablesDiv.appendChild(chip);
      }
      toolGroup.appendChild(cablesDiv);
    }

    this.root.appendChild(toolGroup);

    // Separator
    const sep = document.createElement('div');
    sep.className = 'sep';
    this.root.appendChild(sep);

    // Devices group
    const devGroup = document.createElement('div');
    devGroup.className = 'group';
    devGroup.setAttribute('role', 'toolbar');
    devGroup.setAttribute('aria-label', 'Devices');

    for (const k of NETWORK_KINDS) {
      const def = DEVICE_DEFS[k];
      const active = t.mode === 'place' && t.kind === k;
      const btn = this.makeToolButton(
        kindGlyph(k), def.label, `$${def.price}`,
        active,
        `${def.label}: ${def.blurb}`,
        () => setTool(active ? { mode: 'select' } : { mode: 'place', kind: k }),
      );
      devGroup.appendChild(btn);
    }

    this.root.appendChild(devGroup);

    const sepA = document.createElement('div');
    sepA.className = 'sep';
    this.root.appendChild(sepA);
    const acc = document.createElement('div');
    acc.className = 'group';
    acc.setAttribute('role', 'toolbar');
    acc.setAttribute('aria-label', 'Customers');
    const headA = document.createElement('span');
    headA.className = 'head';
    headA.textContent = 'Be an ISP';
    acc.appendChild(headA);
    for (const a of ['cell', 'home'] as const) {
      const def = ACCESS[a];
      const active = t.mode === 'place' && t.kind === 'tower' && (t.access ?? 'cell') === a;
      acc.appendChild(this.makeToolButton(kindGlyph('tower'), def.label, '$' + def.price, active, def.label + ': ' + def.blurb + '. Route its traffic to the ISP gateway and earn per Mbps.',
        () => setTool(active ? { mode: 'select' } : { mode: 'place', kind: 'tower', access: a })));
    }
    this.root.appendChild(acc);

    const sep2 = document.createElement('div');
    sep2.className = 'sep';
    this.root.appendChild(sep2);
    const build = document.createElement('div');
    build.className = 'group';
    build.setAttribute('role', 'toolbar');
    build.setAttribute('aria-label', 'Build');
    const head = document.createElement('span');
    head.className = 'head';
    head.textContent = 'Build';
    build.appendChild(head);
    const deskActive = t.mode === 'place' && t.kind === 'desk';
    build.appendChild(this.makeToolButton(kindGlyph('desk'), 'Desk + PC', '$' + DEVICE_DEFS.desk.price, deskActive,
      'Desk with a PC. A free engineer sits here and can patch devices over the network.',
      () => setTool(deskActive ? { mode: 'select' } : { mode: 'place', kind: 'desk' })));
    const acActive = t.mode === 'place' && t.kind === 'ac';
    build.appendChild(this.makeToolButton(kindGlyph('ac'), 'AC unit', '$' + DEVICE_DEFS.ac.price, acActive,
      'AC unit: removes heat from its room.', () => setTool(acActive ? { mode: 'select' } : { mode: 'place', kind: 'ac' })));
    for (const b of BUILD_TOOLS) {
      const active = t.mode === 'build' && t.tile === b.tile;
      build.appendChild(this.makeToolButton(tileGlyph(b.tile), b.label, b.tile === 'ground' ? 'free' : '$' + TILE_PRICE[b.tile], active,
        b.title + ' Drag to paint.', () => setTool(active ? { mode: 'select' } : { mode: 'build', tile: b.tile })));
    }
    this.root.appendChild(build);
  }

  private makeToolButton(
    svgHtml: string, name: string, price: string,
    pressed: boolean, title: string, onClick: () => void,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'tool';
    btn.setAttribute('aria-pressed', String(pressed));
    btn.title = title;
    btn.innerHTML = `
      <span class="glyph">${svgHtml}</span>
      <span class="name">${name}</span>
      <span class="price">${price}</span>
    `;
    btn.addEventListener('click', onClick);
    return btn;
  }
}
customElements.define('ns-palette', NsPalette);
