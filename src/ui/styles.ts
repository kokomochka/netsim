// Shared component styles as a plain CSS string (no Lit dependency).
// Injected into shadow roots or used as a <style> block.

export const baseCSS = `
  :host { font-family: var(--font-body); font-size: 13px; color: var(--ink); -webkit-font-smoothing: antialiased; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  button {
    font: inherit; font-weight: 600; color: var(--ink-dim); cursor: pointer;
    background: var(--raised); border: 1px solid var(--line); border-radius: 8px;
    padding: 6px 12px; min-height: 34px;
    transition: background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s;
  }
  button:hover { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); color: var(--accent); }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
    outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
    border-color: var(--accent);
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 30%, transparent); }
  button.primary:hover { background: var(--accent-strong); border-color: var(--accent-strong); color: #fff; }
  button.danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 35%, var(--line)); }
  button.danger:hover { background: var(--bad-soft); border-color: var(--bad); color: var(--bad); }
  button.ghost { background: transparent; border-color: transparent; }
  button.ghost:hover { background: var(--raised-hover); border-color: transparent; color: var(--ink); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  input, select, textarea {
    font-family: var(--font-mono); font-size: 12.5px; color: var(--ink);
    background: var(--paper); border: 1px solid var(--line-strong); border-radius: 8px;
    padding: 5px 8px; min-height: 32px; width: 100%; min-width: 0;
    transition: border-color .15s, box-shadow .15s;
  }
  input:hover, select:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--line-strong)); }
  input[type="checkbox"], input[type="radio"] { accent-color: var(--accent); }
  input::placeholder { color: var(--ink-faint); }
  input[readonly] { color: var(--ink-dim); background: var(--well); border-style: dashed; }
  input.bad { border-color: var(--bad); background: var(--bad-soft); }
  input.warn { border-color: var(--warn); background: var(--warn-soft); }
  .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .eyebrow {
    font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--ink-faint);
  }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }
  ::-webkit-scrollbar-track { background: transparent; }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }
`;

/** Create a <style> element with the base styles. */
export function baseStyle(): HTMLStyleElement {
  const el = document.createElement('style');
  el.textContent = baseCSS;
  return el;
}
