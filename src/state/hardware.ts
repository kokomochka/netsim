// Server hardware: derive specs from individually upgraded parts, price
// upgrades, and check whether a set of roles fits the machine.
import {
  BOARD_WATTS, CHASSIS, CPU_PARTS, DEGRADED_IO, DISK_PARTS, DISK_TYPES, FAN_WATTS, GPU_PARTS, IO_MBPS_PER_DRIVE, MBPS_PER_CORE, NIC_PARTS,
  OS_RAM_GB, PART_TRADE_IN, PORT_PRICE, PSU2_PRICE, RAID, RAM_GB_PER_MBPS, RAM_PARTS, REBUILD_IO, ROLES,
  SERVER_BASE_PRICE, SERVER_BASE_UPKEEP, type Part, type PartGate,
} from '../balance';
import type { Component, DiskType, PartSlot, RoleKind, ServerDevice, ServerHw, ServerParts, ServerSpecs, Unlocks } from './types';

export const BASE_PARTS: ServerParts = { cpu: 0, ram: 0, disk: 0, diskType: 'hdd', disks: 1, gpu: 0, gpus: 0, nic: 0, ports: 1, chassis: 0, psu2: false, raid: 'single' };

/** Fill in fields older saves and templates leave out. */
export function normParts(p: Partial<ServerParts>): ServerParts {
  const o = { ...BASE_PARTS, ...p } as ServerParts;
  if (o.gpu > 0 && !o.gpus) o.gpus = 1;
  if (o.gpu === 0) o.gpus = 0;
  return o;
}

export function specsFor(p0: ServerParts): ServerSpecs {
  const p = normParts(p0);
  return {
    cpuCores: CPU_PARTS[p.cpu]!.cores,
    ramGB: RAM_PARTS[p.ram]!.gb,
    storageGB: DISK_PARTS[p.disk]!.gb * RAID[p.raid].cap(p.disks),
    nicMbps: NIC_PARTS[p.nic]!.mbps,
    gpuTflops: GPU_PARTS[p.gpu]!.tflops * p.gpus,
    gpuName: p.gpus > 1 ? `${p.gpus} × ${GPU_PARTS[p.gpu]!.label}` : GPU_PARTS[p.gpu]!.label,
    diskType: p.diskType,
  };
}

/** Peak power the configuration can draw (W): must fit the power supply. */
export function peakWatts(p: ServerParts): number {
  return CPU_PARTS[p.cpu]!.tdp + GPU_PARTS[p.gpu]!.watts * p.gpus + RAM_PARTS[p.ram]!.watts
    + DISK_TYPES[p.diskType].watts * p.disks + NIC_PARTS[p.nic]!.watts + BOARD_WATTS + FAN_WATTS[1];
}

/** Why this configuration cannot be built, or null. */
export function partsProblem(p: ServerParts): string | null {
  const ch = CHASSIS[p.chassis]!;
  const r = RAID[p.raid];
  if (p.disks > ch.bays) return `A ${ch.label} chassis has ${ch.bays} drive bays`;
  if (p.gpus > ch.gpuSlots) return `A ${ch.label} chassis has ${ch.gpuSlots} GPU slot${ch.gpuSlots === 1 ? '' : 's'}`;
  if (p.psu2 && !ch.redundantOk) return `A ${ch.label} chassis has room for one power supply`;
  if (p.disks < r.min) return `${r.label} needs at least ${r.min} drives`;
  if (r.even && p.disks % 2) return `${r.label} needs an even number of drives`;
  const w = peakWatts(p);
  if (w > ch.psuW) return `Peak draw ${w} W is more than the ${ch.psuW} W power supply of a ${ch.label} chassis`;
  return null;
}

/** Brand-new components for a configuration. */
export function freshComps(p: ServerParts): Component[] {
  const c: Component[] = [];
  const add = (kind: Component['kind'], slot: number, id: string) => c.push({ id, kind, slot, wear: 0, age: 0, failed: false });
  add('board', 0, 'board');
  add('cpu', 0, 'cpu');
  add('ram', 0, 'ram');
  add('psu', 0, 'psu1');
  if (p.psu2) add('psu', 1, 'psu2');
  add('fan', 0, 'fans');
  for (let i = 0; i < p.disks; i++) add('disk', i, `disk${i + 1}`);
  for (let i = 0; i < p.gpus; i++) add('gpu', i, `gpu${i + 1}`);
  for (let i = 0; i < p.ports; i++) add('nic', i, `nic${i}`);
  return c;
}

export function freshHw(p: ServerParts, comps = freshComps(p)): ServerHw {
  return { comps, array: 'ok', rebuild: 0, clock: 1, cpuTemp: 25, gpuTemp: 25, fan: 0.2, watts: 0, off: null, offSince: 0, crashAt: 0, crashUntil: 0, tempCap: null };
}

/** Components after an upgrade: parts that did not change keep their age. */
export function carryComps(old: Component[], from: ServerParts, to: ServerParts): Component[] {
  const next = freshComps(to);
  const same = (k: Component['kind']) => {
    if (k === 'disk') return from.disk === to.disk && from.diskType === to.diskType;
    if (k === 'cpu') return from.cpu === to.cpu;
    if (k === 'ram') return from.ram === to.ram;
    if (k === 'gpu') return from.gpu === to.gpu;
    if (k === 'nic') return from.nic === to.nic;
    return from.chassis === to.chassis;
  };
  return next.map((c) => {
    const o = old.find((x) => x.id === c.id);
    return o && same(c.kind) ? { ...o } : c;
  });
}

const HOT_SLOTS: PartSlot[] = ['disks', 'psu2'];
/** Does going from one configuration to another need the server switched off? */
export function needsDowntime(from: ServerParts, to: ServerParts): boolean {
  return (Object.keys(to) as PartSlot[]).some((k) => to[k] !== from[k] && !HOT_SLOTS.includes(k));
}
/** Does it wipe the disk array (new drive model, type or RAID level)? */
export function wipesArray(from: ServerParts, to: ServerParts): boolean {
  return from.raid !== to.raid || from.disk !== to.disk || from.diskType !== to.diskType || (to.disks < from.disks);
}

/** Price of a disk of a given size and type. */
export function diskPrice(size: number, type: DiskType): number {
  const base = DISK_PARTS[size]!.price + (size === 0 ? 40 : 0);
  return type === 'hdd' && size === 0 ? 0 : Math.round(base * DISK_TYPES[type].priceMul);
}

export function gateOpen(g: PartGate, u: Unlocks): boolean {
  return g === 'base' || (g === 'pro' && u.serverM) || (g === 'enterprise' && u.serverL);
}

export const GATE_NAME: Record<PartGate, string> = { base: '', pro: 'First thousand', enterprise: 'Data centre' };

function slotValues(p: ServerParts): Record<string, number> {
  return {
    cpu: CPU_PARTS[p.cpu]!.price,
    ram: RAM_PARTS[p.ram]!.price,
    disk: diskPrice(p.disk, p.diskType) * (p.disks ?? 1),
    gpu: GPU_PARTS[p.gpu]!.price * (p.gpus ?? (p.gpu ? 1 : 0)),
    nic: NIC_PARTS[p.nic]!.price,
    ports: ((p.ports ?? 1) - 1) * PORT_PRICE,
    chassis: CHASSIS[p.chassis ?? 0]!.price,
    psu2: p.psu2 ? PSU2_PRICE : 0,
  };
}

export function partValue(p: ServerParts): number {
  return Object.values(slotValues(p)).reduce((x, y) => x + y, 0);
}

export function serverPrice(d: ServerDevice): number {
  return SERVER_BASE_PRICE + partValue(d.parts);
}

export function serverUpkeep(p: ServerParts): number {
  const parts: Part[] = [CPU_PARTS[p.cpu]!, RAM_PARTS[p.ram]!, NIC_PARTS[p.nic]!, CHASSIS[p.chassis ?? 0]!];
  return SERVER_BASE_UPKEEP + parts.reduce((a, x) => a + x.upkeep, 0) + GPU_PARTS[p.gpu]!.upkeep * (p.gpus ?? (p.gpu ? 1 : 0))
    + DISK_PARTS[p.disk]!.upkeep * DISK_TYPES[p.diskType].priceMul * (p.disks ?? 1);
}

/**
 * Cost of changing parts. Swapping a component (other CPU, other disk model…)
 * gives half the old one back; adding more of the same (ports, extra drives)
 * just costs the extra.
 */
export function swapCost(from: ServerParts, to: ServerParts): number {
  const a = slotValues(from), b = slotValues(to);
  let cost = 0;
  for (const k of Object.keys(a)) {
    if (a[k] === b[k]) continue;
    const sameModel = k === 'ports' || k === 'psu2' || (k === 'gpu' && from.gpu === to.gpu) || (k === 'disk' && from.disk === to.disk && from.diskType === to.diskType);
    cost += sameModel ? Math.max(0, b[k]! - a[k]!) : b[k]! - a[k]! * PART_TRADE_IN;
  }
  return Math.max(0, Math.round(cost));
}

export interface Budget { cores: number; ramGB: number; diskGB: number }

export function roleUse(roles: RoleKind[]): Budget {
  const b = { cores: 0, ramGB: 0, diskGB: 0 };
  for (const r of roles) { const d = ROLES[r]; b.cores += d.cores; b.ramGB += d.ramGB; b.diskGB += d.diskGB; }
  return b;
}

/** Why a role cannot be added to this server, or null if it fits. */
export function roleBlocker(d: ServerDevice, role: RoleKind, specs = d.specs): string | null {
  const def = ROLES[role];
  if (d.roles.some((r) => r.role === role)) return 'Already installed';
  if (def.needsGpu && specs.gpuTflops <= 0) return 'Needs a GPU';
  if (def.needsFastDisk && specs.diskType === 'hdd') return 'Needs an SSD or NVMe disk';
  const use = roleUse([...d.roles.map((r) => r.role), role]);
  if (use.cores > specs.cpuCores) return `Needs ${use.cores} cores in total, server has ${specs.cpuCores}`;
  if (use.ramGB > specs.ramGB) return `Needs ${use.ramGB} GB RAM in total, server has ${specs.ramGB}`;
  if (use.diskGB > specs.storageGB) return `Needs ${use.diskGB} GB disk in total, server has ${specs.storageGB}`;
  return null;
}

/** Would these specs still carry the installed roles? */
export function specsCarry(d: ServerDevice, specs: ServerSpecs): string | null {
  const use = roleUse(d.roles.map((r) => r.role));
  if (use.cores > specs.cpuCores) return `Installed roles need ${use.cores} cores`;
  if (use.ramGB > specs.ramGB) return `Installed roles need ${use.ramGB} GB RAM`;
  if (use.diskGB > specs.storageGB) return `Installed roles need ${use.diskGB} GB disk`;
  if (d.roles.some((r) => ROLES[r.role].needsGpu) && specs.gpuTflops <= 0) return 'GPU compute needs a GPU';
  if (d.roles.some((r) => ROLES[r.role].needsFastDisk) && specs.diskType === 'hdd') return 'SAN needs SSD or NVMe';
  return null;
}

export interface Caps { cpu: number; io: number; ram: number; nic: number; total: number; bottleneck: 'CPU' | 'disk' | 'memory' | 'network' }

/**
 * What the box can serve, per resource. Requests need CPU time (free cores ×
 * clock), disk IO (drives × type × RAID), memory for buffers (what the roles
 * leave free) and network card bandwidth. The smallest one is the limit.
 */
export function serverCaps(d: ServerDevice): Caps {
  const reserved = roleUse(d.roles.filter((r) => r.role !== 'web').map((r) => r.role));
  const free = Math.max(0.5, d.specs.cpuCores - reserved.cores);
  const clock = d.hw?.clock ?? 1;
  const p = d.parts;
  const r = RAID[p.raid ?? 'single'];
  const arr = d.hw?.array ?? 'ok';
  const arrMul = arr === 'lost' ? 0 : arr === 'degraded' ? DEGRADED_IO : arr === 'rebuilding' ? REBUILD_IO : 1;
  const cpu = free * clock * MBPS_PER_CORE;
  const io = IO_MBPS_PER_DRIVE * DISK_TYPES[p.diskType].speed * r.io(p.disks) * arrMul;
  const ram = Math.max(5, (d.specs.ramGB - reserved.ramGB - OS_RAM_GB) / RAM_GB_PER_MBPS);
  const nic = d.specs.nicMbps;
  const all: [Caps['bottleneck'], number][] = [['CPU', cpu], ['disk', io], ['memory', ram], ['network', nic]];
  all.sort((a, b) => a[1] - b[1]);
  return { cpu, io, ram, nic, total: all[0]![1], bottleneck: all[0]![0] };
}

/** Old name kept for callers: traffic the server can serve right now. */
export function webCapacityMbps(d: ServerDevice): number {
  return serverCaps(d).total;
}
