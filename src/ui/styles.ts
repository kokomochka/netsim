// Shared component styles as a plain CSS string (no Lit dependency).
// Injected into shadow roots or used as a <style> block.

export const baseCSS = `
  :host { font-family: var(--font-body); font-size: 13px; color: var(--ink); }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  button {
    font: inherit; color: inherit; cursor: pointer;
    background: var(--raised); border: 1px solid var(--line); border-radius: 6px;
    padding: 6px 10px; min-height: 32px;
    transition: background 0.12s, border-color 0.12s;
  }
  button:hover { background: var(--raised-hover); border-color: var(--line-strong); }
  button:focus-visible, input:focus-visible, select:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 1px;
  }
  button.danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
  button.danger:hover { background: color-mix(in srgb, var(--bad) 14%, var(--raised)); }
  button.ghost { background: transparent; border-color: transparent; }
  button.ghost:hover { background: var(--raised); border-color: var(--line); }
  input, select {
    font-family: var(--font-mono); font-size: 12.5px; color: var(--ink);
    background: var(--well); border: 1px solid var(--line); border-radius: 5px;
    padding: 5px 7px; min-height: 30px; width: 100%; min-width: 0;
  }
  input::placeholder { color: var(--ink-faint); }
  input[readonly] { color: var(--ink-dim); background: transparent; border-style: dashed; }
  input.bad { border-color: var(--bad); }
  input.warn { border-color: var(--warn); }
  .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .eyebrow {
    font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.09em; text-transform: uppercase;
    color: var(--ink-faint);
  }
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
