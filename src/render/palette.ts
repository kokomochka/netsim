// Canvas colours. The DOM UI mirrors these as CSS tokens in index.html.
import type { CableType, DeviceKind } from '../state/types';

export const COLORS = {
  background: 0x141a21,   // outside the building: dark asphalt
  ground: 0x161c23,
  groundLine: 0x222a33,
  grass: 0x2c4a2e,
  grassDark: 0x2a472c,
  tree: 0x2f6b35,
  treeLight: 0x4c8f4a,
  trunkShadow: 0x10200f,
  path: 0x6a6d70,
  pathSeam: 0x5a5d60,
  asphalt: 0x2a2d31,
  stall: 0xd9d6cc,
  floor: 0x4c535c,        // office: grey carpet tiles
  floorSeam: 0x434950,
  raised: 0x3c4756,       // server room: raised floor panels
  raisedSeam: 0x2f3946,
  raisedDot: 0x56647a,
  wall: 0xd8d2c4,         // plaster walls
  wallEdge: 0xa59f92,
  door: 0x8a6a48,
  engineer: 0x3fd0b8,
  engineerDark: 0x0f4d45,
  stranger: 0x2a2a30,
  strangerRim: 0xff5a5a,
  sight: 0x3fd0b8,
  gridMinor: 0xbcd6ff,
  gridMajor: 0xbcd6ff,
  card: 0x112c4f,
  label: 0xe4eeff,
  sublabel: 0x8fb4e6,
  selection: 0xffffff,
  hover: 0x8fd3ff,
  invalid: 0xff6b6b,
  led: 0x6dff9c,
  portFree: 0x0c2240,
  portRing: 0xbcd6ff,
  // Phase 2 additions
  healthOk: 0x7fe3a0,
  healthWarn: 0xffc861,
  healthBad: 0xff7a72,
  carrierNormal: 0x5fd0ff,
  carrierAttack: 0xff4444,
} as const;

export const KIND_COLOR: Record<DeviceKind, number> = {
  uplink: 0xc7b8ff,
  server: 0x7fd1ff,
  router: 0xffd27a,
  switch: 0x8fe3a5,
  firewall: 0xff8f86,
  ddos_scrubber: 0xff61d8,
  desk: 0xe0b98c,
  tower: 0xc7b8ff,
  ac: 0x9fe8ff,
  badge: 0x7fe3a0,
};

export const CABLE_COLOR: Record<CableType, number> = {
  ethernet: 0xb4c2d4,
  fibre: 0xffa94d,
  crossover: 0x5fb8ff,
};
