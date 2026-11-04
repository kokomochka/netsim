import { initSimulation, tick } from '../src/sim/engine';
import { showcaseWorld } from '../src/state/showcase';
import { resetRuntime, runtime, world } from '../src/state/world';
import type { WorldState } from '../src/state/types';

const run = (s: WorldState, n: number) => { for (let i = 0; i < n; i++) tick(s, runtime); };
for (const capped of [false, true]) {
  resetRuntime();
  world.replace(showcaseWorld(), 'load');
  const w = world.get();
  for (const d of Object.values(w.devices)) if (d.kind === 'ac') d.on = false;
  for (const [k, t] of Object.entries(w.floor.tiles)) if (t === 'vent') w.floor.tiles[k] = 'wall';
  if (capped) for (const d of Object.values(w.devices)) if (d.kind === 'server') d.hw.tempCap = 60;
  initSimulation(w, runtime);
  const g = Object.values(w.devices).find((d) => d.name === 'gpu-01')!;
  const web = Object.values(w.devices).find((d) => d.name === 'web-01')!;
  for (let m = 1; m <= 14; m += 1) {
    run(w, 20 * 60);
    if (g.kind !== 'server' || web.kind !== 'server') break;
    const room = Math.max(...Object.values(w.climate.rooms));
    console.log(`[${capped ? 'cap 60' : 'no cap'}] ${m} min room ${room.toFixed(1)} | gpu-01 cpu ${g.hw.cpuTemp.toFixed(0)} gpu ${g.hw.gpuTemp.toFixed(0)} clk ${g.hw.clock.toFixed(2)} ${Math.round(g.hw.watts)}W off=${g.hw.off} wear gpu ${(g.hw.comps.find((c) => c.kind === 'gpu')!.wear * 100).toFixed(1)}% | web-01 cpu ${web.hw.cpuTemp.toFixed(0)} clk ${web.hw.clock.toFixed(2)} | rev ${w.economy.revenuePerSec.toFixed(2)} ai ${Object.values(w.services).find((v) => v.kind === 'ai')!.availability.toFixed(2)}`);
  }
  console.log('logs', w.logs.filter((l) => /thermal|throttl|cooled|failed/i.test(l.msg)).slice(-6).map((l) => l.msg));
}
