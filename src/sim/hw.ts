// Server and device hardware: power draw, temperatures, fan control,
// throttling (DVFS), thermal protection, component wear and failures, RAID.
//
//  • Every part draws watts. CPU power = TDP × (0.3 + 0.7·load) × clock^2.5,
//    so lowering the clock saves power faster than it costs performance.
//  • CPU temperature = inlet air + CPU watts × the chassis' thermal
//    resistance (°C/W). Fans speed up as it gets hot; a dead fan bakes it.
//  • At 95 °C the hardware throttles itself, at 105 °C it powers off.
//  • Parts wear with load and heat (life halves every +10 °C) and fail with
//    a bathtub-shaped hazard: brand-new and worn-out parts fail most.
//  • Drives sit in a RAID array: a failure leaves it degraded until an
//    engineer swaps the drive and it rebuilds. Lose more than it tolerates
//    and the data is gone unless a backup exists.

import { random } from '../rng';
import {
  BASE_HAZARD, BOARD_WATTS, CHASSIS, CLOCK_MIN, CPU_PARTS, DEVICE_WATTS, DISK_TYPES, FAILURE_GRACE_TICKS, FAN_WATTS, GPU_PARTS, INFANT_MUL,
  INFANT_S, LIFE_S, LIFE_S_DEVICE, NIC_PARTS, PSU_EFFICIENCY, RAID, RAM_CRASH_S, RAM_PARTS, REBOOT_S, REBUILD_S, RESTART_C, SHUTDOWN_C,
  THROTTLE_C, TICKS_PER_SEC, WEAR_HAZARD, WEAR_REF_C,
} from '../balance';
import type { Component, Device, DeviceId, RuntimeCache, ServerDevice, WorldState } from '../state/types';

type Hooks = {
  notify: (m: string, l: 'info' | 'warn' | 'alert' | 'good') => void;
  log: (s: WorldState, id: DeviceId, m: string, l: 'info' | 'warn' | 'alert') => void;
};
let hooks: Hooks | null = null;
export function setHwHooks(h: Hooks): void { hooks = h; }

const rand = (a: number, b: number) => a + random() * (b - a);
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

export const COMP_LABEL: Record<Component['kind'], string> = {
  disk: 'drive', psu: 'power supply', fan: 'fans', ram: 'memory', cpu: 'CPU', gpu: 'GPU', nic: 'network port', board: 'mainboard',
};
export function compName(d: ServerDevice, c: Component): string {
  if (c.kind === 'disk') return `Drive ${c.slot + 1}`;
  if (c.kind === 'psu') return d.parts.psu2 ? `PSU ${c.slot + 1}` : 'Power supply';
  if (c.kind === 'gpu') return d.parts.gpus > 1 ? `GPU ${c.slot + 1}` : 'GPU';
  if (c.kind === 'nic') return `NIC ${d.ports[c.slot]?.label ?? `eth${c.slot}`}`;
  if (c.kind === 'fan') return 'Fans';
  if (c.kind === 'ram') return 'Memory';
  if (c.kind === 'cpu') return 'CPU';
  return 'Mainboard';
}

// ─── Status helpers ─────────────────────────────────────────────────────────

const working = (d: ServerDevice, k: Component['kind']) => d.hw.comps.filter((c) => c.kind === k && !c.failed).length;
export const failedComps = (d: ServerDevice) => d.hw.comps.filter((c) => c.failed);

/** Powered off or rebooting: answers nothing. */
export function serverDown(d: ServerDevice, tick: number): boolean {
  return d.hw.off !== null || tick < d.hw.crashUntil;
}

/** GPU compute it delivers right now (working cards × clock). */
export function effTflops(d: ServerDevice): number {
  if (d.hw.off) return 0;
  return GPU_PARTS[d.parts.gpu]!.tflops * working(d, 'gpu') * d.hw.clock;
}

export const OFF_LABEL: Record<NonNullable<ServerDevice['hw']['off']>, string> = {
  thermal: 'thermal shutdown (over 105 °C)',
  psu: 'no working power supply',
  cpu: 'CPU failed',
  board: 'mainboard failed',
  array: 'disk array lost: the operating system is gone',
};

// ─── Power ──────────────────────────────────────────────────────────────────

export interface Power { cpu: number; gpu: number; other: number; total: number }

export function serverPower(d: ServerDevice): Power {
  const p = d.parts;
  if (d.hw.off) return { cpu: 0, gpu: 0, other: 6, total: 6 };   // BMC on standby
  const k = Math.pow(d.hw.clock, 2.5);
  const cpu = CPU_PARTS[p.cpu]!.tdp * (0.3 + 0.7 * clamp(d.usage.cpu, 0, 1)) * k;
  const gpu = GPU_PARTS[p.gpu]!.watts * working(d, 'gpu') * (0.12 + 0.88 * clamp(d.usage.gpu ?? 0, 0, 1)) * k;
  const fan = FAN_WATTS[0] + (FAN_WATTS[1] - FAN_WATTS[0]) * (working(d, 'fan') ? d.hw.fan : 0);
  const other = RAM_PARTS[p.ram]!.watts + DISK_TYPES[p.diskType].watts * working(d, 'disk') * (0.6 + 0.4 * (d.usage.io ?? 0))
    + NIC_PARTS[p.nic]!.watts + BOARD_WATTS + fan;
  return { cpu, gpu, other, total: (cpu + gpu + other) / PSU_EFFICIENCY };
}

/** Watts a device turns into heat right now. */
export function wattsOf(d: Device): number {
  if (d.kind === 'server') return d.hw.watts;
  if (d.kind === 'ac' || d.kind === 'uplink') return d.kind === 'uplink' ? DEVICE_WATTS.uplink.idle : 0;
  if (d.health.state === 'failed') return 0;
  const w = DEVICE_WATTS[d.kind];
  return w.idle + w.load * deviceLoad(d);
}

function deviceLoad(d: Device): number {
  if ('usage' in d) return clamp(d.usage.bandwidth, 0, 1);
  if (d.kind === 'tower') return clamp(d.subs.availability, 0, 1);
  return 0.3;
}

// ─── Per tick: crashes and the health summary the network code reads ───────

export function hwFastTick(s: WorldState, c: RuntimeCache): void {
  const t = s.time.tick;
  for (const d of Object.values(s.devices)) {
    if (d.kind !== 'server') continue;
    const hw = d.hw;
    // a bad memory module crashes the box every so often
    if (!hw.off && d.hw.comps.some((x) => x.kind === 'ram' && x.failed)) {
      if (!hw.crashAt) hw.crashAt = t + Math.round(rand(...RAM_CRASH_S) * TICKS_PER_SEC);
      if (t >= hw.crashAt) {
        hw.crashUntil = t + REBOOT_S * TICKS_PER_SEC;
        hw.crashAt = hw.crashUntil + Math.round(rand(...RAM_CRASH_S) * TICKS_PER_SEC);
      }
    } else hw.crashAt = 0;
    syncHealth(s, c, d);
  }
}

/** Map the component state onto the shared health record (what routing and the UI read). */
export function syncHealth(s: WorldState, c: RuntimeCache, d: ServerDevice): void {
  const h = d.health;
  const worst = Math.max(0, ...d.hw.comps.map((x) => (x.failed ? 1 : x.wear)));
  h.hp = Math.round(100 * (1 - clamp(worst, 0, 1)));
  if (h.state === 'repairing') return;
  const down = serverDown(d, s.time.tick);
  const bad = failedComps(d);
  const next = down ? 'failed' : bad.length || d.hw.array !== 'ok' ? 'warning' : 'ok';
  if ((next === 'failed') !== (h.state === 'failed')) c.topologyDirty = true;
  h.state = next;
  const f = bad[0];
  h.fault = d.hw.off === 'thermal' ? 'overheat' : !f ? null : f.kind === 'disk' ? 'disk' : f.kind === 'nic' ? 'nic' : 'board';
  h.faultPort = f?.kind === 'nic' ? f.slot : null;
  h.degradeRatePerTick = 0;
}

// ─── Per second: temperatures, throttling, wear, failures, RAID ────────────

const warnedHot = new Set<string>();

export function serverSecond(s: WorldState, c: RuntimeCache, d: ServerDevice, inlet: number): void {
  const hw = d.hw;
  const ch = CHASSIS[d.parts.chassis] ?? CHASSIS[0]!;
  const t = s.time.tick;
  // power state from the parts
  const why = hw.comps.some((x) => x.kind === 'board' && x.failed) ? 'board'
    : hw.comps.some((x) => x.kind === 'cpu' && x.failed) ? 'cpu'
    : working(d, 'psu') === 0 ? 'psu'
    : hw.array === 'lost' ? 'array' : null;
  if (why && hw.off !== why && hw.off !== 'thermal') { hw.off = why; hw.offSince = t; c.topologyDirty = true; }
  if (!why && hw.off && hw.off !== 'thermal') { hw.off = null; c.topologyDirty = true; hooks?.log(s, d.id, `${d.name} powered on`, 'info'); }

  const pw = serverPower(d);
  hw.watts = pw.total;
  const gpus = working(d, 'gpu');
  const fansOk = working(d, 'fan') > 0;
  // fan curve follows the hottest sensor
  const hot0 = Math.max(hw.cpuTemp, gpus ? hw.gpuTemp : 0);
  const fanTarget = fansOk && !hw.off ? clamp((hot0 - 45) / 30, 0.2, 1) : 0;
  hw.fan += (fanTarget - hw.fan) * 0.4;
  const rMul = fansOk ? 1.3 - 0.5 * hw.fan : 2.4;
  const internal = inlet + (pw.gpu + pw.other) * 0.012 * (fansOk ? 1 : 2);
  const cpuTarget = internal + pw.cpu * ch.cpuR * rMul;
  const gpuTarget = gpus ? internal + (pw.gpu / gpus) * ch.gpuR * rMul : internal;
  hw.cpuTemp += (cpuTarget - hw.cpuTemp) / 8;
  hw.gpuTemp += (gpuTarget - hw.gpuTemp) / 12;
  const hot = Math.max(hw.cpuTemp, gpus ? hw.gpuTemp : -99);
  d.temp = hot;

  if (!hw.off) {
    // DVFS: the hardware limit always applies; a player cap needs the unlock
    const cap = s.unlocks.throttling && hw.tempCap ? hw.tempCap : THROTTLE_C;
    if (hot > THROTTLE_C) hw.clock -= 0.08;
    else if (hot > cap) hw.clock -= hot > cap + 4 ? 0.05 : 0.02;
    else if (hot < cap - 3) hw.clock += 0.01;
    hw.clock = clamp(hw.clock, CLOCK_MIN, 1);
    if (hot > THROTTLE_C - 3 && !warnedHot.has(d.id)) {
      warnedHot.add(d.id);
      hooks?.notify(`${d.name} is at ${hot.toFixed(0)} °C and throttling itself. At ${SHUTDOWN_C} °C it powers off. Cool the room, fix its fans or use a bigger chassis.`, 'warn');
    }
    if (hot < THROTTLE_C - 15) warnedHot.delete(d.id);
    if (hot >= SHUTDOWN_C) {
      hw.off = 'thermal';
      hw.offSince = t;
      c.topologyDirty = true;
      hooks?.log(s, d.id, `${d.name}: thermal shutdown at ${hot.toFixed(0)} °C`, 'alert');
      hooks?.notify(`${d.name} hit ${hot.toFixed(0)} °C and switched itself off to protect the hardware.`, 'alert');
    }
  } else if (hw.off === 'thermal' && hot < RESTART_C && t - hw.offSince > 10 * TICKS_PER_SEC) {
    hw.off = null;
    hw.clock = 0.7;
    c.topologyDirty = true;
    hooks?.log(s, d.id, `${d.name} cooled down and powered back on`, 'info');
  }

  // wear and failures
  const running = !hw.off;
  for (const x of hw.comps) {
    if (x.failed || !running) continue;
    const temp = x.kind === 'cpu' ? hw.cpuTemp : x.kind === 'gpu' ? hw.gpuTemp : internal + (x.kind === 'disk' ? 8 : 5);
    const load = x.kind === 'disk' ? d.usage.io ?? 0 : x.kind === 'cpu' ? d.usage.cpu : x.kind === 'gpu' ? d.usage.gpu ?? 0
      : x.kind === 'ram' ? d.usage.ram : x.kind === 'nic' ? d.usage.nic ?? 0 : x.kind === 'fan' ? hw.fan
      : x.kind === 'psu' ? hw.watts / ch.psuW / Math.max(1, working(d, 'psu')) : 0.5;
    const rate = (0.5 + clamp(load, 0, 1)) / LIFE_S[x.kind] * Math.pow(2, (temp - WEAR_REF_C) / 10);
    x.wear += rate;
    x.age += 1;
    if (t < FAILURE_GRACE_TICKS) continue;
    const hz = BASE_HAZARD * (x.age < INFANT_S ? INFANT_MUL : 1) * (1 + WEAR_HAZARD * Math.pow(x.wear, 4))
      * (x.kind === 'disk' ? DISK_TYPES[d.parts.diskType].faultMul : 1);
    if (random() < hz) failComp(s, c, d, x);
  }

  // RAID
  const n = d.parts.disks;
  const lostDisks = hw.comps.filter((x) => x.kind === 'disk' && x.failed).length;
  if (hw.array !== 'lost') {
    if (lostDisks > RAID[d.parts.raid].tol(n)) {
      hw.array = 'lost';
      hooks?.log(s, d.id, `${d.name}: disk array lost (${lostDisks} of ${n} drives dead, ${RAID[d.parts.raid].label})`, 'alert');
    } else if (lostDisks > 0) hw.array = 'degraded';
    else if (hw.array === 'rebuilding' && running) {
      hw.rebuild += DISK_TYPES[d.parts.diskType].speed ** 0.5 / (REBUILD_S[d.parts.disk] ?? 40);
      if (hw.rebuild >= 1) { hw.array = 'ok'; hw.rebuild = 0; hooks?.log(s, d.id, `${d.name}: array rebuilt, redundant again`, 'info'); }
    } else if (hw.array === 'degraded') { hw.array = 'rebuilding'; hw.rebuild = 0; }
  }
}

export function failComp(s: WorldState, c: RuntimeCache, d: ServerDevice, x: Component): void {
  x.failed = true;
  if (x.kind === 'nic') { const p = d.ports[x.slot]; if (p) p.up = false; }
  c.topologyDirty = true;
  syncHealth(s, c, d);
}

/** Routers, switches, firewalls, desks…: one wear meter, one temperature. */
export function deviceSecond(s: WorldState, c: RuntimeCache, d: Device, inlet: number): void {
  if (d.kind === 'server') return;
  const w = DEVICE_WATTS[d.kind];
  const h = d.health;
  const target = inlet + wattsOf(d) * w.r;
  d.temp = (d.temp ?? inlet) + (target - (d.temp ?? inlet)) / 20;
  if (d.kind === 'uplink') return;   // the ISP's box
  // overheat protection
  if (d.temp > THROTTLE_C && h.state !== 'failed' && h.state !== 'repairing') {
    h.state = 'failed'; h.fault = 'overheat';
    c.topologyDirty = true;
    hooks?.log(s, d.id, `${d.name}: thermal shutdown at ${d.temp.toFixed(0)} °C`, 'alert');
    hooks?.notify(`${d.name} overheated (${d.temp.toFixed(0)} °C) and shut down. It restarts once the room cools.`, 'alert');
  } else if (h.state === 'failed' && h.fault === 'overheat' && d.temp < RESTART_C) {
    h.state = 'ok'; h.fault = null;
    c.topologyDirty = true;
    hooks?.log(s, d.id, `${d.name} cooled down and restarted`, 'info');
  }
  if (h.state === 'failed' || h.state === 'repairing') return;
  d.wear = (d.wear ?? 0) + (0.5 + deviceLoad(d)) / LIFE_S_DEVICE * Math.pow(2, (d.temp - WEAR_REF_C) / 10);
  d.age = (d.age ?? 0) + 1;
  h.hp = Math.round(100 * (1 - clamp(d.wear, 0, 1)));
  if (s.time.tick < FAILURE_GRACE_TICKS) return;
  const hz = BASE_HAZARD * 2 * ((d.age ?? 0) < INFANT_S ? INFANT_MUL : 1) * (1 + WEAR_HAZARD * Math.pow(d.wear, 4));
  if (random() >= hz) return;
  // a port dies, or the whole box
  const used = d.ports.filter((p) => p.up && Object.values(s.cables).some((cb) => (cb.a.deviceId === d.id && cb.a.port === p.index) || (cb.b.deviceId === d.id && cb.b.port === p.index)));
  if (used.length > 1 && random() < 0.35 && !h.fault) {
    const p = used[Math.floor(random() * used.length)]!;
    p.up = false;
    h.fault = 'nic'; h.faultPort = p.index; h.state = 'warning';
  } else {
    h.fault = 'board'; h.state = 'failed';
  }
  c.topologyDirty = true;
}
