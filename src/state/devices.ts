// Device registry (architecture v2, §3). Phase 2 edition.
// One entry per kind drives the palette, the factory, port layout and pricing.
// The mapped type makes a missing kind a compile error.
import {
  DDOS_SCRUBBER_CAPACITY_MBPS, DEVICE_PRICE, DEVICE_UPKEEP,
  FIREWALL_CAPACITY_MBPS, UPLINK_START,
} from '../balance';
import { BASE_PARTS, freshHw, specsFor } from './hardware';
import type {
  DeviceId, DeviceKind, DeviceOf, FirewallInterface, GridPos, Health, Media, Port, Side, Software, Usage,
} from './types';

export interface DeviceDef<K extends DeviceKind> {
  kind: K;
  label: string;
  namePrefix: string;
  blurb: string;
  price: number;
  upkeepPerSec: number;
  placeable: boolean; // false = pre-placed only (uplink)
  ports: Omit<Port, 'index' | 'up' | 'media'>[];
  create(id: DeviceId, name: string, pos: GridPos): DeviceOf<K>;
}

export const freshHealth = (): Health => ({
  hp: 100,
  state: 'ok',
  fault: null,
  faultPort: null,
  degradeRatePerTick: 0,
  repairEndsAt: null,
  repairKind: null,
});

const zeroUsage = (): Usage => ({ cpu: 0, ram: 0, storage: 0, bandwidth: 0 });
/** New hardware ships with the current release; the world fixes this up on placement. */
export const freshSw = (): Software => ({ patch: 0, outdatedSince: null });

function makePorts(spec: Omit<Port, 'index' | 'up' | 'media'>[], media: Media = 'copper'): Port[] {
  return spec.map((p, index) => ({ ...p, index, up: true, media }));
}

/** Deterministic locally-administered MAC from an id. */
export function macFor(id: string, salt = 0): string {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const bytes = [0x02, 0x4e];
  for (let i = 0; i < 4; i++) bytes.push((h >>> (i * 8)) & 255);
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(':');
}

const side = (s: Side, offset = 0.5, label: string) => ({ side: s, offset, label });

/** Default firewall interfaces for a freshly placed firewall. */
function defaultFwInterfaces(id: DeviceId, ports: Port[]): FirewallInterface[] {
  const defs: { name: string; securityLevel: number }[] = [
    { name: 'outside', securityLevel: 0 },
    { name: 'inside', securityLevel: 100 },
    { name: 'dmz', securityLevel: 50 },
    { name: 'spare', securityLevel: 50 },
  ];
  return ports.map((p, i) => ({
    port: p.index,
    name: defs[i]?.name ?? `if${i}`,
    securityLevel: defs[i]?.securityLevel ?? 50,
    ip: '',
    mask: '255.255.255.0',
    mac: macFor(id, p.index + 100),
    dhcp: { enabled: false },
  }));
}

export const DEVICE_DEFS: { [K in DeviceKind]: DeviceDef<K> } = {
  uplink: {
    kind: 'uplink',
    label: 'Uplink',
    namePrefix: 'ISP',
    blurb: 'Your connection to the internet',
    price: DEVICE_PRICE.uplink,
    upkeepPerSec: DEVICE_UPKEEP.uplink,
    placeable: false,
    ports: [side('E', 0.5, 'WAN')],
    create(id, name, gridPos) {
      return {
        kind: 'uplink', id, name, gridPos, rotation: 0,
        ports: makePorts(this.ports), health: freshHealth(),
        publicSubnet: UPLINK_START.publicSubnet,
        uplinkIp: UPLINK_START.uplinkIp,
        bandwidthMbps: UPLINK_START.bandwidthMbps,
        uplinkTier: UPLINK_START.uplinkTier,
        upstreamFilters: [],
      };
    },
  },
  server: {
    kind: 'server',
    label: 'Server',
    namePrefix: 'Server',
    blurb: 'Hosts sites and services',
    price: DEVICE_PRICE.server,
    upkeepPerSec: DEVICE_UPKEEP.server,
    placeable: true,
    ports: [side('W', 0.5, 'eth0')],
    create(id, name, gridPos) {
      return {
        kind: 'server', id, name, gridPos, rotation: 0,
        ports: makePorts(this.ports), health: freshHealth(),
        addressing: 'static', ip: '', mask: '255.255.255.0', gateway: '', extra: [], dns: '', mac: macFor(id),
        parts: { ...BASE_PARTS }, specs: specsFor(BASE_PARTS), roles: [],
        agents: { backup: { enabled: false, targetId: null }, failover: { enabled: false, partnerId: null, sanId: null }, monitor: { enabled: false, masterIp: '' } },
        usage: zeroUsage(), sw: freshSw(), compromised: null, hw: freshHw(BASE_PARTS), cert: false,
      };
    },
  },
  router: {
    kind: 'router',
    label: 'Router',
    namePrefix: 'Router',
    blurb: 'Joins subnets, one IP per port',
    price: DEVICE_PRICE.router,
    upkeepPerSec: DEVICE_UPKEEP.router,
    placeable: true,
    ports: [side('N', 0.5, 'Gi0/0'), side('E', 0.5, 'Gi0/1'), side('S', 0.5, 'Gi0/2'), side('W', 0.5, 'Gi0/3')],
    create(id, name, gridPos) {
      const ports = makePorts(this.ports);
      return {
        kind: 'router', id, name, gridPos, rotation: 0, ports, health: freshHealth(),
        interfaces: ports.map((p) => ({ port: p.index, ip: '', mask: '255.255.255.0', mac: macFor(id, p.index + 1), dhcp: { enabled: false } })),
        routes: [], nat: [], ospf: false, usage: zeroUsage(), sw: freshSw(), compromised: null,
      };
    },
  },
  switch: {
    kind: 'switch',
    label: 'Switch',
    namePrefix: 'Switch',
    blurb: 'Eight ports on one subnet',
    price: DEVICE_PRICE.switch,
    upkeepPerSec: DEVICE_UPKEEP.switch,
    placeable: true,
    ports: [
      side('N', 0.2, 'p1'), side('N', 0.4, 'p2'), side('N', 0.6, 'p3'), side('N', 0.8, 'p4'),
      side('S', 0.8, 'p5'), side('S', 0.6, 'p6'), side('S', 0.4, 'p7'), side('S', 0.2, 'p8'),
    ],
    create(id, name, gridPos) {
      return { kind: 'switch', id, name, gridPos, rotation: 0, ports: makePorts(this.ports), health: freshHealth(), macTable: {}, stp: true };
    },
  },
  firewall: {
    kind: 'firewall',
    label: 'Firewall',
    namePrefix: 'Firewall',
    blurb: 'Routed firewall: zones, ACL, NAT',
    price: DEVICE_PRICE.firewall,
    upkeepPerSec: DEVICE_UPKEEP.firewall,
    placeable: true,
    // 4 ports, nameif outside (W), inside (E), dmz (S), spare (N)
    ports: [
      side('W', 0.5, 'eth0'),
      side('E', 0.5, 'eth1'),
      side('S', 0.5, 'eth2'),
      side('N', 0.5, 'eth3'),
    ],
    create(id, name, gridPos) {
      const ports = makePorts(this.ports);
      return {
        kind: 'firewall', id, name, gridPos, rotation: 0, ports, health: freshHealth(),
        interfaces: defaultFwInterfaces(id, ports),
        rules: [], defaultPolicy: 'deny', routes: [], nat: [], ospf: false, capacityMbps: FIREWALL_CAPACITY_MBPS, usage: zeroUsage(),
        sw: freshSw(), compromised: null,
      };
    },
  },
  ddos_scrubber: {
    kind: 'ddos_scrubber',
    label: 'Scrubber',
    namePrefix: 'Scrubber',
    blurb: 'Inline anti-DDoS appliance',
    price: DEVICE_PRICE.ddos_scrubber,
    upkeepPerSec: DEVICE_UPKEEP.ddos_scrubber,
    placeable: true,
    // 2 ports: upstream (W) and downstream (E), inline transparent device
    ports: [side('W', 0.5, 'upstream'), side('E', 0.5, 'downstream')],
    create(id, name, gridPos) {
      return {
        kind: 'ddos_scrubber', id, name, gridPos, rotation: 0,
        ports: makePorts(this.ports), health: freshHealth(),
        rateLimits: [], capacityMbps: DDOS_SCRUBBER_CAPACITY_MBPS,
        synProtection: false, autoMitigation: false, autoThresholdMbps: 50, usage: zeroUsage(),
      };
    },
  },
  tower: {
    kind: 'tower',
    label: 'Access uplink',
    namePrefix: 'Cell',
    blurb: 'Customers whose traffic you carry to the ISP',
    price: DEVICE_PRICE.tower,
    upkeepPerSec: DEVICE_UPKEEP.tower,
    placeable: true,
    ports: [side('E', 0.5, 'eth0')],
    create(id, name, gridPos) {
      return {
        kind: 'tower', access: 'cell', id, name, gridPos, rotation: 0, ports: makePorts(this.ports), health: freshHealth(),
        addressing: 'static', ip: '', mask: '255.255.255.0', gateway: '', mac: macFor(id, 9),
        subs: { demand: 1, reputation: 1, availability: 0, upTicks: 0, downSinceTick: null, flowId: null, spikeUntil: 0 },
        sw: freshSw(), compromised: null,
      };
    },
  },
  badge: {
    kind: 'badge',
    label: 'Smart door',
    namePrefix: 'Door',
    blurb: 'Badge controller built into a smart door',
    price: DEVICE_PRICE.badge,
    upkeepPerSec: DEVICE_UPKEEP.badge,
    placeable: false,
    ports: [side('N', 0.5, 'eth0')],
    create(id, name, gridPos) {
      return {
        kind: 'badge', id, name, gridPos, rotation: 0, ports: makePorts(this.ports), health: freshHealth(),
        addressing: 'static', ip: '', mask: '255.255.255.0', gateway: '', mac: macFor(id, 11), authIp: '', failMode: 'open',
        sw: freshSw(), compromised: null,
      };
    },
  },
  ac: {
    kind: 'ac',
    label: 'AC unit',
    namePrefix: 'AC',
    blurb: 'Pumps heat out of the room it stands in',
    price: DEVICE_PRICE.ac,
    upkeepPerSec: DEVICE_UPKEEP.ac,
    placeable: true,
    ports: [],
    create(id, name, gridPos) {
      return { kind: 'ac', id, name, gridPos, rotation: 0, ports: [], health: freshHealth(), on: true };
    },
  },
  desk: {
    kind: 'desk',
    label: 'Desk + PC',
    namePrefix: 'Desk',
    blurb: 'Workstation: an engineer sits here and patches devices over the network',
    price: DEVICE_PRICE.desk,
    upkeepPerSec: DEVICE_UPKEEP.desk,
    placeable: true,
    ports: [side('S', 0.5, 'eth0')],
    create(id, name, gridPos) {
      return {
        kind: 'desk', id, name, gridPos, rotation: 0, ports: makePorts(this.ports), health: freshHealth(),
        addressing: 'static', ip: '', mask: '255.255.255.0', gateway: '', mac: macFor(id, 7), ownerId: null,
        sw: freshSw(), compromised: null,
      };
    },
  },
};

export const NETWORK_KINDS = ['server', 'router', 'switch', 'firewall', 'ddos_scrubber'] as const;

export const PLACEABLE_KINDS = (Object.keys(DEVICE_DEFS) as DeviceKind[]).filter((k) => DEVICE_DEFS[k].placeable);

/** Typed lookup that keeps the kind ↔ def correlation. */
export function defOf<K extends DeviceKind>(kind: K): DeviceDef<K> {
  return DEVICE_DEFS[kind] as DeviceDef<K>;
}

/** Ports a server gains as you buy them: eth1 east, eth2 north, eth3 south. */
export const SERVER_PORT_LAYOUT: { side: Side; label: string }[] = [
  { side: 'W', label: 'eth0' }, { side: 'E', label: 'eth1' }, { side: 'N', label: 'eth2' }, { side: 'S', label: 'eth3' },
];
