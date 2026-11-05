// Tool palette — plain DOM custom element (no Lit).
import { ACCESS, CABLE_BANDWIDTH, CABLE_PRICE, MULTIFLOOR_SWITCH_PRICE, TILE_PRICE, LEASED_LINE } from '../balance';
import { DEVICE_DEFS, NETWORK_KINDS } from '../state/devices';
import type { CableType, Tile } from '../state/types';
import { setTool, ui, buildFarTower, select, toast } from '../state/world';
import { CABLE_COLOR, COLORS, KIND_COLOR } from '../render/palette';
import { onThemeChange } from './theme';
import { cableGlyph, hex, kindGlyph, selectGlyph } from './glyphs';
import { baseStyle } from './styles';

const CABLE_TYPES: { type: CableType; label: string }[] = [
  { type: 'ethernet', label: 'Ethernet' },
  { type: 'fibre', label: 'Fibre' },
  { type: 'crossover', label: 'Crossover' },
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

function tileSvg(t: Tile): string {
  const C = COLORS;
  const floor = hex(C.floor), seam = hex(C.floorSeam), raised = hex(C.raised), dot = hex(C.raisedDot), edge = hex(C.portRing);
  const wall = hex(C.wall), door = hex(C.door), ok = hex(C.healthOk), ac = hex(KIND_COLOR.ac), vent = hex(C.ventFill);
  switch (t) {
    case 'floor': return `<rect x="-12" y="-12" width="24" height="24" rx="2" fill="${floor}" stroke="${edge}" stroke-width="1.5"/><path d="M-12 0H12M0 -12V12" stroke="${seam}" stroke-width="1"/>`;
    case 'raised': return `<rect x="-12" y="-12" width="24" height="24" rx="2" fill="${raised}" stroke="${dot}" stroke-width="1.5"/><g fill="${dot}"><circle cx="-6" cy="-6" r="1.3"/><circle cx="6" cy="-6" r="1.3"/><circle cx="-6" cy="6" r="1.3"/><circle cx="6" cy="6" r="1.3"/></g>`;
    case 'wall': return `<rect x="-13" y="-5" width="26" height="10" fill="${wall}"/><rect x="-5" y="-13" width="10" height="26" fill="${wall}"/>`;
    case 'door': return `<rect x="-13" y="-4" width="5" height="8" fill="${wall}"/><rect x="8" y="-4" width="5" height="8" fill="${wall}"/><path d="M-8 0V-14" stroke="${door}" stroke-width="2.5"/><path d="M-8 -14A14 14 0 0 1 6 0" fill="none" stroke="${door}" stroke-width="1"/>`;
    case 'smartdoor': return `<rect x="-13" y="-4" width="5" height="8" fill="${wall}"/><rect x="8" y="-4" width="5" height="8" fill="${wall}"/><path d="M-8 0V-14" stroke="${ok}" stroke-width="2.5"/><path d="M-8 -14A14 14 0 0 1 6 0" fill="none" stroke="${ok}" stroke-width="1"/><circle cx="0" cy="6" r="3" fill="${ok}"/>`;
    case 'ground': return '<rect x="-12" y="-12" width="24" height="24" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 3"/><path d="M-6 -6L6 6M6 -6L-6 6" stroke="currentColor" stroke-width="1.8"/>';
    default: return '';
    case 'vent': return `<rect x="-13" y="-5" width="26" height="10" fill="${wall}"/><rect x="-9" y="-9" width="18" height="18" rx="3" fill="${vent}" stroke="${ac}" stroke-width="1.8"/><path d="M-5 -6V6M-1.5 -6V6M2 -6V6M5.5 -6V6" stroke="${ac}" stroke-width="1.3"/>`;
  }
}

function tileGlyph(t: Tile): string {
  return '<svg width="26" height="26" viewBox="-18 -18 36 36" aria-hidden="true">' + tileSvg(t) + '</svg>';
}

const PALETTE_CSS = `
  :host {
    display: flex; flex-direction: column; gap: 2px; width: 212px;
    background: var(--paper); margin: 0 14px 14px 14px; border-radius: var(--radius); box-shadow: var(--shadow-sm);
    padding: 14px 12px; overflow-y: auto;
  }
  .group { display: flex; flex-direction: column; gap: 2px; }
  .sep { height: 0; margin: 6px 0; flex: none; }
  .tool {
    display: grid; grid-template-columns: 34px minmax(0, 1fr); align-items: center; column-gap: 10px;
    padding: 6px 10px 6px 6px; width: 100%; min-height: 46px; text-align: left;
    background: transparent; border: 0; border-radius: 10px; color: var(--ink-dim);
  }
  .tool .glyph { grid-row: span 2; width: 34px; height: 34px; border-radius: 9px; background: var(--well); transition: background .15s; }
  .tool .glyph svg { width: 24px; height: 24px; }
  .tool:hover { background: var(--accent-soft); color: var(--accent); border: 0; }
  .tool:hover .glyph { background: var(--paper); }
  .tool[aria-pressed="true"] {
    background: var(--accent); color: #fff;
    box-shadow: 0 6px 16px color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .tool[aria-pressed="true"] .glyph { background: var(--paper); color: var(--accent); }
  .tool[aria-pressed="true"] .price { color: rgb(255 255 255 / .8); }
  .name { font-size: 13px; font-weight: 600; line-height: 1.2; align-self: end; }
  .price { font-size: 11px; font-weight: 500; color: var(--ink-faint); align-self: start; font-variant-numeric: tabular-nums; }
  .head {
    font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: var(--ink);
    padding: 10px 8px 6px;
  }
  .cables { display: flex; flex-direction: column; gap: 4px; padding: 4px 0 4px 50px; }
  .chip {
    display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 3px 10px;
    font-size: 12px; border-radius: 8px; background: transparent; border-color: transparent;
  }
  .chip[aria-pressed="true"] { border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: var(--accent-soft); color: var(--accent); }
  .swatch { width: 16px; height: 4px; border-radius: 2px; flex: none; }
  .glyph { display: flex; align-items: center; justify-content: center; }
  @media (min-width: 1101px) {
    .group { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
    .head, .cables { grid-column: 1 / -1; }
    .cables { padding: 2px 0 4px; flex-direction: row; flex-wrap: wrap; }
    .tool { grid-template-columns: 1fr; justify-items: center; text-align: center; row-gap: 2px; padding: 6px 4px; min-height: 0; }
    .tool .glyph { grid-row: auto; width: 30px; height: 30px; }
    .tool .glyph svg { width: 20px; height: 20px; }
    .name { font-size: 12px; align-self: auto; }
    .price { align-self: auto; }
    .head { padding: 8px 4px 2px; }
    .sep { margin: 2px 0; }
  }
  @media (max-width: 1100px) {
    :host { width: 96px; padding: 10px 8px; }
    .tool { grid-template-columns: 1fr; justify-items: center; text-align: center; row-gap: 3px; padding: 7px 4px; }
    .tool .glyph { grid-row: auto; }
    .name { font-size: 11.5px; align-self: auto; }
    .price { align-self: auto; }
    .head { text-align: center; font-size: 9.5px; padding: 8px 2px 4px; }
    .cables { padding: 2px 0; }
    .chip { font-size: 11px; padding: 2px 6px; }
  }
  @media (max-width: 759px) {
    :host {
      flex-direction: row; width: auto; margin: 0; border-radius: 0; box-shadow: 0 -2px 10px rgb(42 53 71 / .08);
      padding: 6px max(8px, env(safe-area-inset-right, 0px)) calc(6px + env(safe-area-inset-bottom, 0px)) max(8px, env(safe-area-inset-left, 0px));
      overflow-x: auto; overflow-y: hidden; gap: 4px; align-items: stretch;
    }
    .group { flex-direction: row; gap: 4px; }
    .head { writing-mode: vertical-rl; transform: rotate(180deg); padding: 4px 2px; }
    .sep { width: 1px; height: auto; margin: 4px 2px; background: var(--line); }
    .tool { width: 68px; flex: none; }
    .cables { flex-direction: column; justify-content: center; }
    .chip { min-height: 22px; padding: 1px 6px; font-size: 10.5px; }
  }
`;

export class NsPalette extends HTMLElement {
  private shadow: ShadowRoot;
  private unsub?: () => void;
  private root!: HTMLElement;
  private far = false;

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
    const u1 = ui.subscribe(() => this.render());
    const u2 = onThemeChange(() => this.render());
    this.unsub = () => { u1(); u2(); };
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
    const headT = document.createElement('span');
    headT.className = 'head';
    headT.textContent = 'Tools';
    toolGroup.appendChild(headT);

    // Select button
    const selectBtn = this.makeToolButton(
      selectGlyph(), 'Select', 'inspect & set up',
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
        chip.innerHTML = `<span class="swatch" style="background:${hex(CABLE_COLOR[c.type])}"></span>${c.label}`;
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
    const headD = document.createElement('span');
    headD.className = 'head';
    headD.textContent = 'Network';
    devGroup.appendChild(headD);

    for (const k of NETWORK_KINDS) {
      const def = DEVICE_DEFS[k];
      const active = t.mode === 'place' && t.kind === k && !(t.kind === 'switch' && t.stack);
      const btn = this.makeToolButton(
        kindGlyph(k), def.label, `$${def.price}`,
        active,
        `${def.label}: ${def.blurb}`,
        () => setTool(active ? { mode: 'select' } : { mode: 'place', kind: k }),
      );
      devGroup.appendChild(btn);
    }

    {
      const active = t.mode === 'place' && t.kind === 'switch' && !!t.stack;
      devGroup.appendChild(this.makeToolButton(kindGlyph('switch'), 'Multi-floor switch', `$${MULTIFLOOR_SWITCH_PRICE}/floor`, active,
        'One switch on every floor of the building, at the same spot, joined inside. The only way to link floors.',
        () => setTool(active ? { mode: 'select' } : { mode: 'place', kind: 'switch', stack: true })));
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
    // where the site goes: here on the map, or across town on a leased line
    const where = document.createElement('div');
    where.className = 'cables';
    for (const [far, label, tip] of [[false, 'On the map', 'Place it on open ground and run a cable to it'], [true, 'Across town', `Off the map, on a leased line ($${LEASED_LINE.price} to set up, $${LEASED_LINE.upkeep}/s). Repairs mean a drive.`]] as const) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = label;
      chip.title = tip;
      chip.setAttribute('aria-pressed', String(this.far === far));
      chip.addEventListener('click', () => { this.far = far; if (far && t.mode === 'place' && t.kind === 'tower') setTool({ mode: 'select' }); else this.render(); });
      where.appendChild(chip);
    }
    acc.appendChild(where);
    for (const a of ['cell', 'home'] as const) {
      const def = ACCESS[a];
      const active = !this.far && t.mode === 'place' && t.kind === 'tower' && (t.access ?? 'cell') === a;
      const price = this.far ? def.price + LEASED_LINE.price : def.price;
      acc.appendChild(this.makeToolButton(kindGlyph('tower'), def.label, '$' + price, active, def.label + ': ' + def.blurb + (this.far ? '. Built across town on a leased line.' : '. Route its traffic to the ISP gateway and earn per Mbps.'),
        () => {
          if (!this.far) { setTool(active ? { mode: 'select' } : { mode: 'place', kind: 'tower', access: a }); return; }
          const id = buildFarTower(a);
          if (id) { select({ type: 'device', id }); toast(`Built in town, off the map. Bring its leased line into one of your buildings from its panel.`, 'good'); }
        }));
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
