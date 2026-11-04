// SVG twins of the canvas icons, for the palette and panel headers.
// Plain DOM version — returns SVG element strings (no Lit dependency).
import { KIND_COLOR } from '../render/palette';
import { assertNever, type DeviceKind } from '../state/types';

/** CSS hex for a Pixi 0xRRGGBB colour. */
export const hex = (n: number): string => '#' + n.toString(16).padStart(6, '0');

// Same hues as the canvas, so palette, panels and map agree.
export const KIND_CSS = Object.fromEntries(
  Object.entries(KIND_COLOR).map(([k, v]) => [k, hex(v)]),
) as Record<DeviceKind, string>;

function svgWrap(size: number, body: string): string {
  return `<svg width="${size}" height="${size}" viewBox="-18 -18 36 36" aria-hidden="true">${body}</svg>`;
}

export function kindGlyph(kind: DeviceKind, size = 26): string {
  const c = KIND_CSS[kind];
  let body: string;
  switch (kind) {
    case 'server':
      body = `<rect x="-11" y="-14" width="22" height="28" rx="2.5" fill="${c}" fill-opacity=".16" stroke="${c}" stroke-width="2"/>
        <path d="M-7 -7H3M-7 -1H3M-7 5H3" stroke="${c}" stroke-width="1.6"/>
        <circle cx="6.5" cy="-7" r="1.9" fill="#13c98a"/>`;
      break;
    case 'router':
      body = `<circle r="15" fill="${c}" fill-opacity=".16" stroke="${c}" stroke-width="2"/>
        <path d="M0 -3.5V-8.5M3.5 0H8.5M0 3.5V8.5M-3.5 0H-8.5" stroke="${c}" stroke-width="1.8"/>
        <path d="M0 -12 2.9 -8.5 -2.9 -8.5ZM12 0 8.5 2.9 8.5 -2.9ZM0 12 -2.9 8.5 2.9 8.5ZM-12 0 -8.5 -2.9 -8.5 2.9Z" fill="${c}"/>`;
      break;
    case 'switch':
      body = `<rect x="-16" y="-9" width="32" height="18" rx="2.5" fill="${c}" fill-opacity=".16" stroke="${c}" stroke-width="2"/>
        <path d="M-10 -4V4M-6 -4V4M-2 -4V4M2 -4V4M6 -4V4M10 -4V4" stroke="${c}" stroke-width="1.6"/>`;
      break;
    case 'firewall':
      body = `<path d="M0 -15 12.5 -10 11.5 3 0 15 -11.5 3 -12.5 -10Z" fill="${c}" fill-opacity=".16" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>
        <path d="M-11.5 -1H11.5" stroke="${c}" stroke-width="2"/>`;
      break;
    case 'uplink':
    case 'tower':
      body = `<path d="M-14 8 A3.5 3.5 0 0 1 -14 1 A6 6 0 0 1 -7.2 -4.9 A8 8 0 0 1 7.2 -4.9 A6 6 0 0 1 14 1 A3.5 3.5 0 0 1 14 8Z"
          fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>
        <path d="M0 -6V3" stroke="${c}" stroke-width="2"/><path d="M0 8 -3.2 3 3.2 3Z" fill="${c}"/>`;
      break;
    case 'ddos_scrubber':
      body = `<rect x="-14" y="-10" width="28" height="20" rx="3" fill="${c}" fill-opacity=".16" stroke="${c}" stroke-width="2"/>
        <path d="M-8 0H8" stroke="${c}" stroke-width="2"/>
        <path d="M-4 -5V5" stroke="${c}" stroke-width="1.5" stroke-dasharray="2 2"/>
        <path d="M4 -5V5" stroke="${c}" stroke-width="1.5" stroke-dasharray="2 2"/>
        <circle cx="-8" cy="0" r="2" fill="${c}"/><circle cx="8" cy="0" r="2" fill="${c}"/>`;
      break;
    case 'badge':
      body = '<rect x="-9" y="-13" width="18" height="26" rx="3" fill="' + c + '" fill-opacity=".14" stroke="' + c + '" stroke-width="2"/>'
        + '<rect x="-5" y="-9" width="10" height="7" rx="1.5" fill="#0a1c34" stroke="' + c + '" stroke-width="1.2"/>'
        + '<circle cy="5" r="3.5" fill="none" stroke="' + c + '" stroke-width="1.6"/><circle cy="5" r="1.2" fill="' + c + '"/>';
      break;
    case 'ac':
      body = '<rect x="-14" y="-14" width="28" height="28" rx="3" fill="' + c + '" fill-opacity=".12" stroke="' + c + '" stroke-width="2"/>'
        + '<circle r="10" fill="none" stroke="' + c + '" stroke-width="1.6"/>'
        + '<path d="M0 0Q6 -6 3 -9M0 0Q6 6 9 3M0 0Q-6 6 -3 9M0 0Q-6 -6 -9 -3" fill="none" stroke="' + c + '" stroke-width="2"/>';
      break;
    case 'desk':
      body = '<rect x="-15" y="-9" width="30" height="16" rx="2" fill="' + c + '" fill-opacity=".22" stroke="' + c + '" stroke-width="1.8"/>'
        + '<rect x="-8" y="-13" width="16" height="9" rx="1.5" fill="#0a1c34" stroke="' + c + '" stroke-width="1.6"/>'
        + '<rect x="-6" y="-11.5" width="12" height="6" fill="#5fd0ff" fill-opacity=".55"/>'
        + '<rect x="-9" y="1" width="18" height="4" rx="1" fill="' + c + '" fill-opacity=".6"/>'
        + '<circle cx="0" cy="12" r="4" fill="' + c + '" fill-opacity=".35" stroke="' + c + '" stroke-width="1.2"/>';
      break;
    default:
      assertNever(kind);
  }
  return svgWrap(size, body);
}

export function selectGlyph(size = 26): string {
  return svgWrap(size,
    `<path d="M-8 -13 9 3 1 4 5 12 1.5 13.5 -2.5 5.5 -8 11Z" fill="currentColor" fill-opacity=".18" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>`);
}

export function cableGlyph(size = 26): string {
  return svgWrap(size,
    `<path d="M-12 -9H-3V9H12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>
     <circle cx="-12" cy="-9" r="3" fill="var(--paper)" stroke="currentColor" stroke-width="1.8"/>
     <circle cx="12" cy="9" r="3" fill="var(--paper)" stroke="currentColor" stroke-width="1.8"/>`);
}
