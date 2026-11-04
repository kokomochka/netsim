// Canvas colours for the light and dark themes. The DOM UI mirrors these as CSS tokens
// in template-head-body.txt. COLORS / KIND_COLOR / CABLE_COLOR hold the active theme;
// applyCanvasTheme() swaps them in place and the renderer redraws.
import type { CableType, DeviceKind } from '../state/types';

const LIGHT = {
  background: 0xe9eff5,   // outside the building
  ground: 0xe9eff5,
  groundLine: 0xdbe3ec,
  grass: 0xdcefe0,
  grassDark: 0xd4eadb,
  tree: 0x8fcfa4,
  treeLight: 0xc2e8cd,
  trunkShadow: 0x7fa58c,
  path: 0xe2e8ef,
  pathSeam: 0xd3dbe4,
  asphalt: 0xcfd7e1,
  stall: 0xffffff,
  carShadow: 0x2a3547,
  fence: 0x8f9bb0,
  floor: 0xf7f9fc,        // office tiles
  floorSeam: 0xe7ecf2,
  raised: 0xe3eaf2,       // server room: raised floor panels
  raisedSeam: 0xd0d9e4,
  raisedDot: 0xa9b6c7,
  wall: 0x5d6b82,
  wallEdge: 0x45526a,
  door: 0xb7834d,
  ventFill: 0xffffff,
  engineer: 0x1e88e5,
  engineerDark: 0x0f4f8a,
  stranger: 0x2a3547,
  strangerRim: 0xe5484d,
  sight: 0x1e88e5,
  coldTint: 0x1e88e5,
  gridMinor: 0x5a6a85,
  gridMajor: 0x5a6a85,
  card: 0xffffff,
  plate: 0xffffff,
  plateLine: 0xe5eaef,
  label: 0x2a3547,
  sublabel: 0x5a6a85,
  selection: 0x1e88e5,
  hover: 0x5aa9ef,
  invalid: 0xe5484d,
  led: 0x13c98a,
  portFree: 0xffffff,
  portRing: 0x8f9bb0,
  healthOk: 0x13a882,
  healthWarn: 0xe09a00,
  healthBad: 0xe5484d,
  carrierNormal: 0x1e88e5,
  carrierAttack: 0xe5484d,
  carrierControl: 0x13a882,
  carrierBackup: 0xe09a00,
  carrierBackend: 0x7460ee,
  carrierTransit: 0x03a9c7,
};

const DARK: typeof LIGHT = {
  background: 0x141a24,
  ground: 0x141a24,
  groundLine: 0x1d2533,
  grass: 0x18261f,
  grassDark: 0x16231c,
  tree: 0x2c6146,
  treeLight: 0x3d8059,
  trunkShadow: 0x070d0a,
  path: 0x212a37,
  pathSeam: 0x2a3444,
  asphalt: 0x1b2230,
  stall: 0x5d6b82,
  carShadow: 0x000000,
  fence: 0x4a566b,
  floor: 0x232b38,
  floorSeam: 0x2b3444,
  raised: 0x1c2430,
  raisedSeam: 0x283141,
  raisedDot: 0x46536a,
  wall: 0x8f9bb0,
  wallEdge: 0x6b778c,
  door: 0xc99560,
  ventFill: 0x141a24,
  engineer: 0x3b9cf0,
  engineerDark: 0x0b3a66,
  stranger: 0x0b0f16,
  strangerRim: 0xf2626a,
  sight: 0x3b9cf0,
  coldTint: 0x3b9cf0,
  gridMinor: 0xa8b3c4,
  gridMajor: 0xa8b3c4,
  card: 0x1f2735,
  plate: 0x1f2735,
  plateLine: 0x323d4f,
  label: 0xe6ebf2,
  sublabel: 0xa3afc2,
  selection: 0x5aa9ef,
  hover: 0x7dbdf5,
  invalid: 0xf2626a,
  led: 0x2bd49a,
  portFree: 0x1f2735,
  portRing: 0x7c8799,
  healthOk: 0x2bd49a,
  healthWarn: 0xf5b423,
  healthBad: 0xf2626a,
  carrierNormal: 0x3b9cf0,
  carrierAttack: 0xf2626a,
  carrierControl: 0x2bd49a,
  carrierBackup: 0xf5b423,
  carrierBackend: 0x9b8cf5,
  carrierTransit: 0x2cc6e0,
};

const KIND_LIGHT: Record<DeviceKind, number> = {
  uplink: 0x7460ee,
  server: 0x1e88e5,
  router: 0xe09a00,
  switch: 0x13a882,
  firewall: 0xe5484d,
  ddos_scrubber: 0xc935c4,
  desk: 0xb7834d,
  tower: 0x7460ee,
  ac: 0x03a9c7,
  badge: 0x13a882,
};

const KIND_DARK: Record<DeviceKind, number> = {
  uplink: 0x9b8cf5,
  server: 0x49a6f2,
  router: 0xf5b423,
  switch: 0x2bd49a,
  firewall: 0xf2626a,
  ddos_scrubber: 0xe063dc,
  desk: 0xd0a06e,
  tower: 0x9b8cf5,
  ac: 0x2cc6e0,
  badge: 0x2bd49a,
};

const CABLE_LIGHT: Record<CableType, number> = { ethernet: 0x7d8ca3, fibre: 0xf08c00, crossover: 0x3b82f6 };
const CABLE_DARK: Record<CableType, number> = { ethernet: 0x8f9bb0, fibre: 0xf59e0b, crossover: 0x5aa9ef };

export const COLORS = { ...LIGHT };
export const KIND_COLOR: Record<DeviceKind, number> = { ...KIND_LIGHT };
export const CABLE_COLOR: Record<CableType, number> = { ...CABLE_LIGHT };

/** Switch the canvas palette in place. Callers must redraw (Renderer.retheme). */
export function applyCanvasTheme(dark: boolean): void {
  Object.assign(COLORS, dark ? DARK : LIGHT);
  Object.assign(KIND_COLOR, dark ? KIND_DARK : KIND_LIGHT);
  Object.assign(CABLE_COLOR, dark ? CABLE_DARK : CABLE_LIGHT);
}
