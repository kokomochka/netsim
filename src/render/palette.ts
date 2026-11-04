// Canvas colours. The DOM UI mirrors these as CSS tokens in index.html.
import type { CableType, DeviceKind } from '../state/types';

export const COLORS = {
  background: 0xe9eff5,   // outside the building: light canvas
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
  floor: 0xf7f9fc,        // office: clean light tiles
  floorSeam: 0xe7ecf2,
  raised: 0xe3eaf2,       // server room: raised floor panels
  raisedSeam: 0xd0d9e4,
  raisedDot: 0xa9b6c7,
  wall: 0x5d6b82,         // slate walls
  wallEdge: 0x45526a,
  door: 0xb7834d,
  engineer: 0x1e88e5,
  engineerDark: 0x0f4f8a,
  stranger: 0x2a3547,
  strangerRim: 0xe5484d,
  sight: 0x1e88e5,
  gridMinor: 0x5a6a85,
  gridMajor: 0x5a6a85,
  card: 0xffffff,
  plate: 0xffffff,
  label: 0x2a3547,
  sublabel: 0x5a6a85,
  selection: 0x1e88e5,
  hover: 0x5aa9ef,
  invalid: 0xe5484d,
  led: 0x13c98a,
  portFree: 0xffffff,
  portRing: 0x8f9bb0,
  // Phase 2 additions
  healthOk: 0x13a882,
  healthWarn: 0xe09a00,
  healthBad: 0xe5484d,
  carrierNormal: 0x1e88e5,
  carrierAttack: 0xe5484d,
} as const;

export const KIND_COLOR: Record<DeviceKind, number> = {
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

export const CABLE_COLOR: Record<CableType, number> = {
  ethernet: 0x7d8ca3,
  fibre: 0xf08c00,
  crossover: 0x3b82f6,
};
