import fs from 'node:fs';
import { initSimulation, tick } from '../src/sim/engine';
import { importJson } from '../src/state/persist';
import { runtime, world } from '../src/state/world';
const s = importJson(fs.readFileSync('test/save-roundtrip.json', 'utf8'));
if (!s) { console.log('import failed'); process.exit(1); }
world.replace(s, 'load');
const w = world.get();
initSimulation(w, runtime);
for (let i = 0; i < 400; i++) tick(w, runtime);
console.log('version', w.meta.version, 'devices', Object.keys(w.devices).length, 'events', w.events.map((e) => e.kind).join(','));
console.log(Object.values(w.devices).filter((d) => d.kind === 'server').map((d) => d.kind === 'server' ? `${d.name} ch${d.parts.chassis} ${d.parts.raid} x${d.parts.disks} gpus${d.parts.gpus} ${Math.round(d.hw.watts)}W ${d.health.state}` : '').join('\n'));
console.log('services', Object.values(w.services).map((v) => v.availability.toFixed(2)).join(' '), 'rev', w.economy.revenuePerSec.toFixed(2));
