// Light / dark theme: follows the system setting until the player picks one.
import { applyCanvasTheme } from '../render/palette';

export type Theme = 'light' | 'dark';
const KEY = 'netsim_theme';
const listeners = new Set<(t: Theme) => void>();
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

function stored(): Theme | null {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; } catch { return null; }
}

let current: Theme = stored() ?? (media?.matches ? 'dark' : 'light');

function apply(t: Theme): void {
  current = t;
  document.documentElement.dataset.theme = t;
  applyCanvasTheme(t === 'dark');
  for (const fn of listeners) fn(t);
}

export function theme(): Theme { return current; }

export function setTheme(t: Theme): void {
  try { localStorage.setItem(KEY, t); } catch { /* private mode: still switch for this session */ }
  apply(t);
}

export function toggleTheme(): void { setTheme(current === 'dark' ? 'light' : 'dark'); }

export function onThemeChange(fn: (t: Theme) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// apply at load, so components that render on definition already see the right palette
apply(current);

/** Call once at startup: follow later system theme changes. */
export function initTheme(): void {
  media?.addEventListener?.('change', (e) => { if (!stored()) apply(e.matches ? 'dark' : 'light'); });
}
