import { initSimulation, tick } from '../src/sim/engine';
import { addRole, connect, editDevice, newWorld, resetRuntime, runtime, testFlags, world } from '../src/state/world';
testFlags.fixedPublicBlock = true;
resetRuntime();
world.replace(newWorld(), 'load');
const w = world.get();
initSimulation(w, runtime);
const up = Object.values(w.devices).find((d) => d.kind === 'uplink')!;
const srv = Object.values(w.devices).find((d) => d.kind === 'server')!;
connect({ deviceId: up.id, port: 0 }, { deviceId: srv.id, port: 0 }, 'ethernet');
editDevice(srv.id, 'server', (d) => { d.ip = '203.0.113.2'; d.mask = '/28'; d.gateway = '203.0.113.1'; });
addRole(srv.id, 'web');
const { addPublicAddr, togglePublicService } = require('../src/state/world');
addPublicAddr('203.0.113.2');
const a = Object.values(world.get().publicAddrs)[0]!;
togglePublicService(a.id, Object.values(world.get().services)[0]!.id, true);
for (let i = 0; i < 400; i++) tick(w, runtime);
const svc = Object.values(w.services)[0]!;
console.log('t', w.time.tick / 20, 'avail', svc.availability.toFixed(2), 'rev', w.economy.revenuePerSec.toFixed(2), 'temp', srv.temp?.toFixed(1), srv.kind === 'server' ? Math.round(srv.hw.watts) + 'W ' + srv.usage.bottleneck + ' cap ' + Math.round(srv.usage.capMbps ?? 0) : '');
// kill the board: nobody monitors; does Ada notice?
if (srv.kind === 'server') srv.hw.comps.find((c) => c.kind === 'board')!.failed = true;
for (let s = 0; s < 120; s += 10) {
  for (let i = 0; i < 200; i++) tick(w, runtime);
  const e = Object.values(w.staff.engineers)[0]!;
  console.log(`+${s + 10}s avail ${svc.availability.toFixed(2)} known ${JSON.stringify(Object.keys(w.known ?? {}))} jobs ${Object.values(w.staff.jobs).map((j) => j.kind).join(',')} Ada@${e.x.toFixed(1)},${e.y.toFixed(1)} srv@${srv.gridPos.gx},${srv.gridPos.gy}`);
  if (!svc.availability && Object.keys(w.known ?? {}).length) break;
}
