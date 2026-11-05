import { TICK_MS } from './balance';
import { attachInput, fitView, keepSelectionVisible } from './input';
import { Renderer } from './render/renderer';
import { initSimulation, notices, tick } from './sim/engine';
import { exportJson, importJson, loadAutosave, loadSlot, saveNow, saveSlot, slotInfo, startAutosave } from './state/persist';
import { sampleWorld } from './state/sample';
import { showcaseWorld } from './state/showcase';
import { newWorld, resetRuntime, runtime, toast, ui, world } from './state/world';
import type { WorldState } from './state/types';
import { initTheme, onThemeChange } from './ui/theme';
import { installUndo } from './state/undo';
import './ui/hud';
import './ui/inspector';
import './ui/palette';
import type { NsTopbar } from './ui/hud';

/** True while the user is typing in a panel field, so shortcuts stay out of the way. */
function isUiBusy(): boolean {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
}

async function boot(): Promise<void> {
  const stage = document.getElementById('stage')!;
  initTheme();
  installUndo();
  const renderer = new Renderer();
  await renderer.init(stage);
  onThemeChange(() => renderer.retheme());
  document.getElementById('boot')?.remove();

  const install = (s: WorldState, fit: boolean) => {
    resetRuntime();
    ui.update((u) => { u.selection = null; u.pendingCable = null; }, 'ui');
    world.replace(s, 'load');
    initSimulation(world.get(), runtime);
    if (fit) fitView(renderer);
  };

  const saved = await loadAutosave();
  if (saved) {
    install(saved, false);
  } else {
    install(newWorld(), false);
    renderer.centerOnUplink();
    document.querySelector('ns-goals')?.setAttribute('open', '');
    toast('New career. Open Goals for your first task, or Game → Open example network to see a finished build.');
  }

  attachInput(renderer, isUiBusy);
  keepSelectionVisible(renderer);
  const bar = document.querySelector('ns-topbar') as NsTopbar;
  bar.actions = {
    fit: () => fitView(renderer),
    newGame: () => { install(newWorld(), false); renderer.centerOnUplink(); toast('New game started.'); },
    showcase: () => { install(showcaseWorld(), true); toast('Showcase campus loaded (sandbox, no goals): 12 servers with RAID and a monitoring master, AI cluster, cloud, cell site, office.'); },
    example: () => { install(sampleWorld(), true); toast('Example network loaded (sandbox, no goals). Tap devices to see how it is configured.'); },
    save: async () => { toast((await saveSlot()) ? 'Saved to slot.' : 'Could not save: browser storage is blocked.', 'info'); },
    load: async () => {
      const s = await loadSlot();
      if (!s) { toast('The save slot is empty.', 'error'); return; }
      install(s, true);
      toast('Slot loaded.');
    },
    exportSave: async () => {
      const text = exportJson(world.get());
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const filename = `netsim-${stamp}.json`;
      const claude = (window as unknown as { claude?: { use(n: string): Promise<{ save(r: { filename: string; data: string }): Promise<unknown> } | null> } }).claude;
      const dl = claude ? await claude.use('downloads').catch(() => null) : null;
      if (dl) {
        try { await dl.save({ filename, data: text }); toast(`Saved ${filename}.`, 'good'); return; }
        catch (e) {
          const code = (e as { code?: string }).code;
          if (code === 'declined') { toast('Download cancelled.'); return; }
          if (code === 'rate_limited') { toast('A download prompt is already open.', 'error'); return; }
        }
      }
      showSaveText(text, filename);
    },
    importSave: (text: string) => {
      const s = importJson(text);
      if (!s) { toast('That is not a NetSim save file (or it comes from a newer version).', 'error'); return; }
      install(s, true);
      toast('Save file loaded.', 'good');
    },
    slotLabel: async () => {
      const i = await slotInfo();
      return i ? `Slot: saved ${new Date(i.savedAt).toLocaleString()} · $${Math.floor(i.balance)}` : 'Slot: empty';
    },
  };
  startAutosave();

  let lastTime = 0;
  let accum = 0;
  const loop = (now: number) => {
    if (lastTime > 0) {
      accum += Math.min(now - lastTime, 250);
      let steps = 0;
      while (accum >= TICK_MS && steps < 8) {
        if (world.get().speed > 0) world.update((w) => { tick(w, runtime); }, 'sim');
        accum -= TICK_MS;
        steps++;
      }
      if (steps === 8) accum = 0;
      while (notices.length) {
        const n = notices.shift()!;
        toast(n.msg, n.level);
      }
    }
    lastTime = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  setInterval(() => { if (world.get().speed > 0) void saveNow(); }, 30_000);

  (window as unknown as { netsim: unknown }).netsim = { world, ui, renderer, runtime };
}

boot().catch((err) => {
  console.error(err);
  const el = document.getElementById('boot');
  if (el) el.textContent = `Could not start the renderer: ${err?.message ?? err}`;
});

/** Fallback when this view cannot offer downloads: show the save as text to copy. */
function showSaveText(text: string, filename: string): void {
  document.getElementById('save-dialog')?.remove();
  const box = document.createElement('div');
  box.id = 'save-dialog';
  box.style.cssText = 'position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:rgb(42 53 71 / .45);padding:16px';
  const card = document.createElement('div');
  card.style.cssText = 'width:min(560px,100%);display:grid;gap:10px;padding:16px;background:var(--paper);border:0;border-radius:var(--radius);box-shadow:var(--shadow-lg);color:var(--ink);font:13px var(--font-body)';
  const h = document.createElement('b');
  h.textContent = `Save as text (${filename})`;
  const p = document.createElement('p');
  p.style.margin = '0';
  p.textContent = 'Downloads are not available here. Copy this text into a file ending in .json; Upload save file reads it back.';
  const ta = document.createElement('textarea');
  ta.id = 'save-text';
  ta.readOnly = true;
  ta.value = text;
  ta.style.cssText = 'width:100%;height:220px;font:11px var(--font-mono);background:var(--well);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:6px';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
  const btn = (label: string, fn: () => void) => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'font:inherit;color:inherit;background:var(--raised);border:1px solid var(--line);border-radius:6px;padding:6px 12px;cursor:pointer'; b.addEventListener('click', fn); return b; };
  row.append(
    btn('Copy', () => { navigator.clipboard?.writeText(text).then(() => toast('Copied.'), () => { ta.select(); toast('Press Ctrl+C to copy.'); }) ?? ta.select(); }),
    btn('Close', () => box.remove()),
  );
  card.append(h, p, ta, row);
  box.appendChild(card);
  box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });
  document.body.appendChild(box);
  ta.select();
}
