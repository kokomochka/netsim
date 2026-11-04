import { initSimulation, tick } from '../src/sim/engine';
import { showcaseWorld } from '../src/state/showcase';
import { resetRuntime, runtime, world } from '../src/state/world';
resetRuntime();
world.replace(showcaseWorld(), 'load');
const w = world.get();
initSimulation(w, runtime);
const t0 = Date.now();
const seen = new Set<string>();
for (let m = 1; m <= 40; m++) {
  for (let i = 0; i < 1200; i++) { tick(w, runtime); if (i % 20 === 0) for (const k of Object.keys(w.known ?? {})) seen.add(k); }
  if (m % 10 === 0) {
    const worn = Object.values(w.devices).flatMap((d) => d.kind === 'server' ? d.hw.comps.map((c) => c.wear) : [d.wear ?? 0]);
    console.log(`${m} min: alerts ${w.logs.filter((l) => l.msg.startsWith('Monitoring alert')).length}, max wear ${(Math.max(...worn) * 100).toFixed(0)}%, uptime ${(Object.values(w.services).reduce((a, v) => a + v.availability, 0) / Object.keys(w.services).length).toFixed(2)}, bal ${Math.round(w.economy.balance)}, ${((Date.now() - t0) / 1000).toFixed(0)}s cpu`);
  }
}
console.log('problems seen', [...seen].map((k) => `${w.devices[k.split(':')[0]!]?.name}:${k.split(':').slice(1).join(':')}`).join(' '));
console.log(w.logs.filter((l) => /alert|noticed|replaced|lost|restored|thermal/i.test(l.msg)).map((l) => `${(l.tick / 1200).toFixed(1)}m ${l.msg}`).slice(-25).join('\n'));
