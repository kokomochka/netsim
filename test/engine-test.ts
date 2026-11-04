import { initSimulation, tick } from '../src/sim/engine';
import { engineerActivity } from '../src/sim/staff';
import { sampleWorld } from '../src/state/sample';
import { setPortMedia, addRole, connect, editDevice, newWorld, placeDevice, resetRuntime, runtime, world, buyPart, paintTile, testFlags } from '../src/state/world';
testFlags.instantParts = true;
import type { WorldState } from '../src/state/types';

const run = (s: WorldState, n: number) => { for (let i = 0; i < n; i++) tick(s, runtime); };
const svcLine = (s: WorldState) => Object.values(s.services).map((v) => `${v.kind}@${v.publicIp}=${v.availability.toFixed(2)}`).join(' ');
const staffLine = (s: WorldState) => Object.values(s.staff.engineers).map((e) => `${e.name}[${e.x.toFixed(1)},${e.y.toFixed(1)}] ${engineerActivity(s, e)}`).join(' | ');

// 1. Example
resetRuntime();
world.replace(sampleWorld(), 'load');
let w = world.get();
initSimulation(w, runtime);
run(w, 200);
console.log('[example]', svcLine(w), '|', staffLine(w));

// 2. Career start: room, uplink, server, one engineer
resetRuntime();
world.replace(newWorld(), 'load');
w = world.get();
initSimulation(w, runtime);
const up = Object.values(w.devices).find((d) => d.kind === 'uplink')!;
const srv = Object.values(w.devices).find((d) => d.kind === 'server')!;
connect({ deviceId: up.id, port: 0 }, { deviceId: srv.id, port: 0 }, 'ethernet');
editDevice(srv.id, 'server', (d) => { d.ip = '203.0.113.2'; d.mask = '/28'; d.gateway = '203.0.113.1'; });
console.log('add web:', addRole(srv.id, 'web', '203.0.113.2'));
console.log('add gpu (no gpu):', addRole(srv.id, 'gpu', '203.0.113.2'));
w.economy.balance += 5000;
console.log('buy gpu:', buyPart(srv.id, 'gpu', 1), 'buy ram:', buyPart(srv.id, 'ram', 1), 'cpu:', buyPart(srv.id, 'cpu', 1));
console.log('add gpu worker:', addRole(srv.id, 'gpu'), 'orch:', addRole(srv.id, 'orchestrator'), 'frontend:', addRole(srv.id, 'ai_frontend', '203.0.113.2'));
console.log('links', JSON.stringify((srv as any).roles.map((r: any) => [r.role, r.links.length])));
run(w, 300);
console.log('[career]', svcLine(w), 'rev', w.economy.revenuePerSec.toFixed(2), 'upkeep', w.economy.upkeepPerSec.toFixed(2));
console.log('[career]', staffLine(w));

// hardware failure → auto preventive job → engineer walks
srv.health.fault = 'overheat'; srv.health.state = 'warning'; srv.health.hp = 55; srv.health.degradeRatePerTick = 0.02;
run(w, 30);
console.log('[repair] jobs', Object.values(w.staff.jobs).map((j) => `${j.kind}:${j.engineerId ? 'assigned' : 'open'}`), '|', staffLine(w));
run(w, 20 * 15);
console.log('[repair] after 15s', srv.health.state, srv.health.hp.toFixed(0), '|', staffLine(w));

// desk placement: engineer goes to sit
const desk = placeDevice('desk', { gx: 11, gy: 3 });
run(w, 20 * 8);
console.log('[desk]', staffLine(w), 'owner', (w.devices[desk!] as { ownerId: string }).ownerId);

// trespasser
w.events = [{ kind: 'trespass', triggerAt: w.time.tick + 1 }];
run(w, 2);
console.log('[trespass] count', Object.keys(w.staff.trespassers).length, w.logs.slice(-1)[0]?.msg);
run(w, 20 * 40);
console.log('[trespass] after 40s', Object.keys(w.staff.trespassers).length, 'caught', w.stats.trespassersCaught, 'compromised', Object.values(w.devices).filter((d) => d.compromised).map((d) => d.name));
console.log('[log]', w.logs.slice(-5).map((l) => l.msg));

// 3. failover in the example
resetRuntime();
world.replace(sampleWorld(), 'load');
w = world.get();
initSimulation(w, runtime);
const [w1, w2] = Object.values(w.devices).filter((d) => d.kind === 'server');
console.log('add web on standby:', addRole(w2!.id, 'web', '203.0.113.9'));
editDevice(w1!.id, 'server', (d) => { d.agents.failover = { enabled: true, partnerId: w2!.id, sanId: null }; });
run(w, 100);
if (w1!.kind === 'server') w1!.hw.comps.find((c) => c.kind === 'board')!.failed = true; runtime.topologyDirty = true;
runtime.topologyDirty = true;
run(w, 60);
console.log('[failover] takeover', runtime.takeover, svcLine(w));
const p = runtime.paths[Object.values(w.services)[0]!.flowId!]!;
console.log('[failover]', p.explain, p.ret?.explain);
void paintTile;

// 4. migrate a v3-shaped save
import { deserialize } from '../src/state/persist';
{
  const v3: any = JSON.parse(JSON.stringify(sampleWorld()));
  v3.meta.version = 3;
  delete v3.floor; delete v3.staff;
  for (const d of Object.values(v3.devices) as any[]) {
    if (d.kind === 'server') { d.tier = 'M'; delete d.parts; delete d.agents; d.roles = d.roles.map((r: any) => ({ role: 'web_static', serviceId: r.serviceId, port: 80 })); }
    if (d.kind === 'desk') delete v3.devices[d.id];
  }
  const m = deserialize(JSON.stringify(v3));
  console.log('[migrate]', !!m, m && Object.keys(m.staff.engineers).length, m && Object.values(m.devices).filter((d: any) => d.kind === 'server').map((d: any) => `${d.specs.cpuCores}c/${d.specs.ramGB}GB/${d.specs.diskType}`), m && Object.keys(m.floor.tiles).length);
  if (m) { resetRuntime(); world.replace(m, 'load'); initSimulation(m, runtime); run(m, 100); console.log('[migrate] services', svcLine(m)); }
}

// 5. phone tower (ISP mode)
{
  resetRuntime();
  world.replace(sampleWorld(), 'load');
  const s5 = world.get();
  initSimulation(s5, runtime);
  console.log('[tower] place in parking:', placeDevice('tower', { gx: 5, gy: 15 }), 'outdoors:', placeDevice('tower', { gx: 20, gy: 6 }));
  const t = placeDevice('tower', { gx: 3, gy: 9 }, 'cell')!;
  const rt = Object.values(s5.devices).find((d) => d.kind === 'router')!;
  const fw = Object.values(s5.devices).find((d) => d.kind === 'firewall')!;
  console.log('[media] copper→fibre refused:', connect({ deviceId: t, port: 0 }, { deviceId: rt.id, port: 0 }, 'fibre'));
  setPortMedia(rt.id, 0, 'fibre');
  connect({ deviceId: t, port: 0 }, { deviceId: rt.id, port: 0 }, 'fibre');
  editDevice(rt.id, 'router', (r) => { r.interfaces[0]!.ip = '192.168.30.1'; r.interfaces[0]!.mask = '/24'; });
  editDevice(t, 'tower', (d) => { d.ip = '192.168.30.10'; d.mask = '/24'; d.gateway = '192.168.30.1'; });
  run(s5, 40);
  const tw = s5.devices[t] as any;
  console.log('[tower] no NAT:', tw.subs.availability.toFixed(2), runtime.paths[tw.subs.flowId].explain);
  editDevice(fw.id, 'firewall', (f) => { f.nat.push({ id: 'nat_t', publicIp: '203.0.113.7', privateIp: '192.168.30.10' }); });
  run(s5, 60);
  console.log('[tower] with NAT:', tw.subs.availability.toFixed(2), runtime.paths[tw.subs.flowId].explain, 'rev/s', s5.economy.revenuePerSec.toFixed(2), 'uplink', runtime.uplinkMbps.toFixed(0));
  for (const h of runtime.paths[tw.subs.flowId].hops) console.log('   →', s5.devices[h.deviceId]?.name, '|', h.note);
  console.log('[tower] web still:', svcLine(s5));
}

// 6. AI chain over eth1 + cloud storage on a NAS (example network)
{
  resetRuntime();
  world.replace(sampleWorld(), 'load');
  const s6 = world.get();
  s6.economy.balance = 50000; s6.unlocks.serverM = true;
  initSimulation(s6, runtime);
  const [a, b] = Object.values(s6.devices).filter((d) => d.kind === 'server') as any[];
  const g = placeDevice('server', { gx: 11, gy: 9 })!;
  buyPart(g, 'gpu', 2); buyPart(g, 'ram', 2); buyPart(g, 'cpu', 2);
  console.log('[ai] gpu role:', addRole(g, 'gpu'));
  // web-01 becomes frontend + orchestrator; back-end net 10.10.0.0/24 on eth1 straight to the GPU box
  buyPart(a.id, 'ram', 2); buyPart(a.id, 'cpu', 2);
  console.log('[ai] orch:', addRole(a.id, 'orchestrator'), 'front:', addRole(a.id, 'ai_frontend', '203.0.113.5'));
  buyPart(a.id, 'ports', 2); buyPart(g, 'ports', 2);
  editDevice(a.id, 'server', (x) => { x.extra[0]!.ip = '10.10.0.1'; x.extra[0]!.mask = '/24'; });
  editDevice(g, 'server', (x) => { x.extra[0]!.ip = '10.10.0.2'; x.extra[0]!.mask = '/24'; });
  connect({ deviceId: a.id, port: 1 }, { deviceId: g, port: 1 }, 'ethernet');
  const { setRoleLinks } = require('../src/state/world');
  setRoleLinks(a.id, 'orchestrator', [g]);
  setRoleLinks(a.id, 'ai_frontend', [a.id]);
  // fw allows only port 80 to inside → add 443
  const fw = Object.values(s6.devices).find((d) => d.kind === 'firewall')! as any;
  editDevice(fw.id, 'firewall', (f) => { f.rules.push({ id: 'r443', action: 'allow', protocol: 'tcp', srcZone: 'outside', dstZone: 'inside', src: 'any', dst: '192.168.10.0/24', ports: '443', log: false }); });
  // cloud on web-02 with storage on web-02's own NAS role
  buyPart(b.id, 'disk', 2); buyPart(b.id, 'ram', 1); buyPart(b.id, 'cpu', 2);
  console.log('[cloud] nas:', addRole(b.id, 'nas'), 'cloud:', addRole(b.id, 'cloud', '203.0.113.6'));
  run(s6, 400);
  for (const v of Object.values(s6.services)) console.log(`[svc] ${v.kind}@${v.publicIp}:${v.port} avail=${v.availability.toFixed(2)} used=${v.usedGB.toFixed(0)}GB`);
  console.log('[ai] links', JSON.stringify(runtime.roleLinks));
  const be = Object.values(s6.flows).filter((f) => f.kind === 'backend').map((f) => `${f.dstIp}:${f.dstPort} ${runtime.paths[f.id]?.explain}`);
  console.log('[ai] backend flows', be);
  console.log('[ai] rev/s', s6.economy.revenuePerSec.toFixed(2));
}

// 7. climate: a closed room full of busy servers, then vents and AC
{
  resetRuntime();
  world.replace(newWorld(), 'load');
  const s7 = world.get();
  s7.economy.balance = 1e6;
  initSimulation(s7, runtime);
  const ids: string[] = [];
  for (let x = 3; x <= 12; x += 1) for (const y of [3, 4]) ids.push(placeDevice('server', { gx: x, gy: y })!);
  for (const id of ids) (s7.devices[id] as any).usage.bandwidth = 1;
  const temp = () => Object.values(s7.climate.rooms).map((t) => t.toFixed(1)).join(',');
  const hot = () => Math.max(...ids.map((i) => s7.devices[i]!.temp ?? 0)).toFixed(1);
  for (let i = 0; i < 6; i++) { for (const id of ids) (s7.devices[id] as any).usage.bandwidth = 1; run(s7, 20 * 30); }
  console.log('[climate] after 3 min room', temp(), 'hottest server', hot(), 'failed', ids.filter((i) => s7.devices[i]!.health.state === 'failed').length);
  for (const [x, y] of [[1, 4], [1, 6], [14, 4], [14, 6]]) paintTile(x!, y!, 'vent');
  placeDevice('ac', { gx: 3, gy: 9 }); placeDevice('ac', { gx: 5, gy: 9 }); placeDevice('ac', { gx: 7, gy: 9 });
  for (let i = 0; i < 6; i++) { for (const id of ids) (s7.devices[id] as any).usage.bandwidth = 1; run(s7, 20 * 30); }
  console.log('[climate] with 4 vents + 3 AC room', temp(), 'hottest', hot());
}

// 8. STP: two switches with a double link
{
  resetRuntime();
  world.replace(sampleWorld(), 'load');
  const s8 = world.get();
  s8.economy.balance = 1e6;
  initSimulation(s8, runtime);
  const rack = Object.values(s8.devices).find((d) => d.name === 'Rack-SW')!;
  const sw2 = placeDevice('switch', { gx: 10, gy: 9 })!;
  const c1 = connect({ deviceId: rack.id, port: 5 }, { deviceId: sw2, port: 0 }, 'ethernet')!;
  const c2 = connect({ deviceId: rack.id, port: 6 }, { deviceId: sw2, port: 1 }, 'ethernet')!;
  run(s8, 40);
  console.log('[stp] blocked', Object.keys(runtime.stpBlocked), 'storm', Object.keys(runtime.storm).length, svcLine(s8));
  const { deleteCable } = require('../src/state/world');
  deleteCable(Object.keys(runtime.stpBlocked)[0] === c1 ? c2 : c1);
  run(s8, 40);
  console.log('[stp] after cutting the active link: blocked', Object.keys(runtime.stpBlocked));
  connect({ deviceId: rack.id, port: 5 }, { deviceId: sw2, port: 2 }, 'ethernet');
  editDevice(sw2, 'switch', (x) => { x.stp = false; });
  run(s8, 60);
  console.log('[stp] stp off on a loop: storm', Object.keys(runtime.storm).map((i) => s8.devices[i]?.name), svcLine(s8));
  console.log('[stp] path', runtime.paths[Object.values(s8.services)[0]!.flowId!]!.explain);
}

// 9. domains, DNS, reverse proxy, forward-proxied mirror
{
  const W = require('../src/state/world');
  resetRuntime();
  world.replace(sampleWorld(), 'load');
  const s9 = world.get();
  s9.economy.balance = 1e5;
  initSimulation(s9, runtime);
  const [a, b] = Object.values(s9.devices).filter((d) => d.kind === 'server') as any[];
  for (const x of [a, b]) { buyPart(x.id, 'cpu', 1); buyPart(x.id, 'ram', 1); }
  console.log('[dns] buy:', W.buyDomain('acme.net'), 'bad:', W.buyDomain('acme'));
  const dom = Object.values(s9.domains)[0] as any;
  W.editDomain(dom.id, (d: any) => { d.records.push({ id: 'r1', name: 'www', ip: '203.0.113.5' }, { id: 'r2', name: 'shop', ip: '203.0.113.5' }); });
  // web-01: reverse proxy + its own site by name
  console.log('[dns] proxy role:', addRole(a.id, 'proxy'));
  const sa = Object.values(s9.services).find((v: any) => v.serverId === a.id) as any;
  W.setServiceFqdn(sa.id, 'www.acme.net');
  // web-02: site with no public IP of its own, reachable only through the proxy as shop.acme.net
  const sb = Object.values(s9.services).find((v: any) => v.serverId === b.id) as any;
  W.setServicePublicIp(sb.id, '203.0.113.9');
  W.setServiceFqdn(sb.id, 'shop.acme.net');
  console.log('[dns] local dns:', addRole(b.id, 'dns_local'));
  W.editRole(b.id, 'dns_local', (r: any) => r.records.push({ id: 'l1', name: 'shop.lan', ip: '192.168.10.11' }));
  editDevice(a.id, 'server', (x) => { x.dns = '192.168.10.11'; });
  W.editRole(a.id, 'proxy', (r: any) => r.rules.push({ id: 'p1', fqdn: 'www.acme.net', backend: '192.168.10.10' }, { id: 'p2', fqdn: 'shop.acme.net', backend: 'shop.lan' }));
  run(s9, 80);
  for (const v of Object.values(s9.services) as any[]) console.log(`[dns] ${v.kind} ${v.fqdn ?? v.publicIp} avail=${v.availability.toFixed(2)}`, runtime.resolve[v.id]?.why ?? '', JSON.stringify(Object.entries(runtime.proxyChk).filter(([k]) => k.startsWith(v.id)).map(([, x]) => x.why)));
  // self-hosted public DNS on web-02 at .6
  console.log('[dns] public dns:', addRole(b.id, 'dns_public', '203.0.113.6'));
  W.editDomain(dom.id, (d: any) => { d.hosting = 'self'; d.nsIp = '203.0.113.6'; });
  run(s9, 40);
  console.log('[dns] self-hosted, no udp rule:', runtime.resolve[sa.id]?.why);
  const fw = Object.values(s9.devices).find((d) => d.kind === 'firewall')!;
  editDevice(fw.id, 'firewall', (f) => { f.rules.push({ id: 'u53', action: 'allow', protocol: 'udp', srcZone: 'outside', dstZone: 'inside', src: 'any', dst: '192.168.10.11', ports: '53', log: false }); });
  run(s9, 60);
  console.log('[dns] self-hosted with rule:', runtime.resolve[sa.id]?.why);
  for (const v of Object.values(s9.services) as any[]) console.log(`[dns] ${v.kind} ${v.fqdn ?? v.publicIp} avail=${v.availability.toFixed(2)}`);
  console.log('[dns] mirror:', addRole(b.id, 'mirror'));
  run(s9, 40);
  console.log('[dns] mirror upstream:', JSON.stringify(runtime.mirrorOk), 'rev/s', s9.economy.revenuePerSec.toFixed(2));
}

// 10. badge readers, multi-IP names, proxy back-end lists
{
  const W = require('../src/state/world');
  resetRuntime();
  world.replace(sampleWorld(), 'load');
  const s10 = world.get();
  s10.economy.balance = 1e5;
  initSimulation(s10, runtime);
  const [a, b] = Object.values(s10.devices).filter((d) => d.kind === 'server') as any[];
  for (const x of [a, b]) { buyPart(x.id, 'cpu', 1); buyPart(x.id, 'ram', 1); }
  // smart door at the office door with a reader beside it
  console.log('[door] paint:', paintTile(13, 9, 'smartdoor'));
  const rd = Object.values(s10.devices).find((d) => d.kind === 'badge')!.id;
  const sw = Object.values(s10.devices).find((d) => d.name === 'Rack-SW')!;
  connect({ deviceId: rd, port: 0 }, { deviceId: sw.id, port: 2 }, 'ethernet');
  editDevice(rd, 'badge', (x) => { x.ip = '192.168.10.60'; x.mask = '/24'; x.gateway = '192.168.10.1'; x.authIp = '192.168.10.11'; });
  run(s10, 40);
  console.log('[door] no auth role:', JSON.stringify(runtime.doors));
  addRole(b.id, 'auth');
  run(s10, 40);
  console.log('[door] with auth:', JSON.stringify(runtime.doors));
  editDevice(rd, 'badge', (x) => { x.authIp = '10.9.9.9'; x.failMode = 'closed'; });
  run(s10, 40);
  console.log('[door] unreachable, fail-closed:', JSON.stringify(runtime.doors));
  // one name, two records (.5 → web-01, .6 → web-02): DNS round robin + failover
  W.buyDomain('acme.net');
  const dom = Object.values(s10.domains)[0] as any;
  W.editDomain(dom.id, (d: any) => { d.records.push({ id: 'r1', name: 'www', ip: '203.0.113.5' }, { id: 'r2', name: 'www', ip: '203.0.113.6' }); });
  const sa = Object.values(s10.services).find((v: any) => v.serverId === a.id) as any;
  W.setServiceFqdn(sa.id, 'www.acme.net');
  run(s10, 80);
  const fl = () => (sa.flowIds ?? []).map((id: string) => `${s10.flows[id]?.dstIp}:${s10.flows[id]?.rateMbps.toFixed(1)}`).join(' ');
  console.log('[rr] flows', fl(), 'avail', sa.availability.toFixed(2), runtime.resolve[sa.id]?.why);
  if (a.kind === 'server') a.hw.comps.find((c) => c.kind === 'board')!.failed = true; runtime.topologyDirty = true;
  run(s10, 80);
  console.log('[rr] web-01 failed → flows', fl(), 'avail', sa.availability.toFixed(2));
}

// 11. user's case: www → DNAT → reverse proxy with two rules (both servers); then app development
{
  const W = require('../src/state/world');
  resetRuntime();
  world.replace(sampleWorld(), 'load');
  const s11 = world.get();
  s11.economy.balance = 1e5;
  initSimulation(s11, runtime);
  const [a, b] = Object.values(s11.devices).filter((d) => d.kind === 'server') as any[];
  for (const x of [a, b]) { buyPart(x.id, 'cpu', 1); buyPart(x.id, 'ram', 1); }
  W.buyDomain('acme.net');
  const dom = Object.values(s11.domains)[0] as any;
  W.editDomain(dom.id, (d: any) => { d.records.push({ id: 'r1', name: 'www', ip: '203.0.113.5' }); });
  addRole(a.id, 'proxy');
  const sa = Object.values(s11.services).find((v: any) => v.serverId === a.id) as any;
  W.setServiceFqdn(sa.id, 'www.acme.net');
  W.editRole(a.id, 'proxy', (r: any) => r.rules.push({ id: 'p1', fqdn: 'www.acme.net', backend: '192.168.10.10' }, { id: 'p2', fqdn: 'www.acme.net', backend: '192.168.10.11' }));
  run(s11, 120);
  const legs = Object.values(s11.flows).filter((f: any) => f.kind === 'proxied').map((f: any) => `${f.dstIp} ${f.rateMbps.toFixed(1)} Mbps ${runtime.paths[f.id]?.explain}`);
  console.log('[lb] chk', JSON.stringify(runtime.proxyChk[`${sa.id}@${a.id}`]));
  console.log('[lb] legs', legs);
  console.log('[lb] web-01 load', (a.usage.bandwidth * 100).toFixed(0), '% web-02 load', (b.usage.bandwidth * 100).toFixed(0), '% avail', sa.availability.toFixed(2));
  // app development: give an engineer a desk that reaches the servers (example desks already do)
  s11.staff.autoPatch = false;
  run(s11, 20 * 200);
  console.log('[dev]', Object.values(s11.services).map((v: any) => `${v.fqdn ?? v.id} v${v.appVersion ?? 1} q${(v.quality ?? 1).toFixed(2)}`), Object.values(s11.staff.engineers).map((e: any) => require('../src/sim/staff').engineerActivity(s11, e)));
  console.log('[dev] rev/s', s11.economy.revenuePerSec.toFixed(2), 'last logs', s11.logs.slice(-3).map((l: any) => l.msg));
}

// 12. DDoS: load capped at 100 %, server heats up, control traffic visible
{
  resetRuntime();
  world.replace(sampleWorld(), 'load');
  const s12 = world.get();
  s12.meta.sandbox = false;
  initSimulation(s12, runtime);
  run(s12, 60);
  const web = Object.values(s12.devices).find((d) => d.name === 'web-01') as any;
  // open the firewall to everything so the flood reaches the server
  const fw = Object.values(s12.devices).find((d) => d.kind === 'firewall') as any;
  editDevice(fw.id, 'firewall', (f) => { f.defaultPolicy = 'allow'; });
  s12.events = [{ kind: 'ddos', triggerAt: s12.time.tick + 1 }];
  run(s12, 20 * 60);
  const up = Object.values(s12.devices).find((d) => d.kind === 'uplink') as any;
  console.log('[ddos] uplink offered', runtime.uplinkMbps.toFixed(0), 'of', up.bandwidthMbps, '| web-01 load', (web.usage.bandwidth * 100).toFixed(0), '% offered', web.usage.offered.toFixed(0), 'Mbps | temp', web.temp.toFixed(1), '°C room', Object.values(s12.climate.rooms).map((t) => t.toFixed(1)));
  const kinds: Record<string, number> = {};
  for (const f of Object.values(s12.flows)) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
  console.log('[ctl] flow kinds', JSON.stringify(kinds), 'control:', Object.values(s12.flows).filter((f) => f.kind === 'control').map((f) => `${f.tag} ${runtime.paths[f.id]?.explain}`));
}
