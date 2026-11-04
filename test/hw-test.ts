import { initSimulation, tick } from '../src/sim/engine';
import { showcaseWorld } from '../src/state/showcase';
import { resetRuntime, runtime, world } from '../src/state/world';
import type { WorldState } from '../src/state/types';

const run = (s: WorldState, n: number) => { for (let i = 0; i < n; i++) tick(s, runtime); };
resetRuntime();
world.replace(showcaseWorld(), 'load');
const w = world.get();
initSimulation(w, runtime);
const rows = () => Object.values(w.devices).filter((d) => d.kind === 'server').map((d) => d.kind === 'server'
  ? `${d.name.padEnd(9)} ${d.parts.raid.padEnd(6)} ${String(Math.round(d.hw.watts)).padStart(4)}W cpu ${d.hw.cpuTemp.toFixed(0)}°C gpu ${d.hw.gpuTemp.toFixed(0)} fan ${d.hw.fan.toFixed(2)} clk ${d.hw.clock.toFixed(2)} load ${(d.usage.bandwidth*100).toFixed(0)}% ${d.usage.bottleneck} cap ${Math.round(d.usage.capMbps ?? 0)} off=${d.hw.off} st=${d.health.state} mon=${!!runtime.monitored?.[d.id]}` : '').join('\n');
for (const t of [60, 600, 3000]) {
  run(w, t);
  console.log(`--- t=${(w.time.tick / 20).toFixed(0)} s, rooms`, Object.values(w.climate.rooms).map((x) => x.toFixed(1)).join(' '), 'rev', w.economy.revenuePerSec.toFixed(2));
  console.log(rows());
}
console.log('services', Object.values(w.services).map((v) => `${v.kind}=${v.availability.toFixed(2)}`).join(' '));
console.log('monitored', Object.keys(runtime.monitored ?? {}).length, 'of', Object.keys(w.devices).length, 'consoles', JSON.stringify(runtime.consoles));
console.log('why', JSON.stringify(runtime.monWhy));
// force failures
const web = Object.values(w.devices).find((d) => d.name === 'web-02')!;
const nas = Object.values(w.devices).find((d) => d.name === 'nas-01')!;
if (web.kind === 'server' && nas.kind === 'server') {
  web.hw.comps.find((c) => c.kind === 'disk')!.failed = true;
  nas.hw.comps.find((c) => c.kind === 'psu')!.failed = true;
  run(w, 100);
  console.log('known', JSON.stringify(w.known));
  console.log('jobs', JSON.stringify(Object.values(w.staff.jobs).map((j) => [j.kind, w.devices[j.deviceId]?.name, j.comps, j.cold, j.engineerId])));
  run(w, 1200);
  console.log('after: web-02 array', web.hw.array, web.hw.rebuild.toFixed(2), 'disk failed', web.hw.comps.some((c) => c.failed), 'nas psu', nas.hw.comps.filter((c) => c.kind === 'psu').map((c) => c.failed));
  console.log('jobs', JSON.stringify(Object.values(w.staff.jobs).map((j) => [j.kind, w.devices[j.deviceId]?.name])));
  // array loss on single-disk raid0? web-01 raid1 with 2 disks -> kill both
  const w1 = Object.values(w.devices).find((d) => d.name === 'web-01')!;
  if (w1.kind === 'server') { w1.hw.comps.filter((c) => c.kind === 'disk').forEach((c) => (c.failed = true)); run(w, 60); console.log('web-01 both disks dead:', w1.hw.array, w1.hw.off, w1.health.state); run(w, 1600); console.log('web-01 after:', w1.hw.array, w1.hw.off, w1.health.state); }
}
console.log('logs', w.logs.slice(-14).map((l) => l.msg).join('\n  '));
