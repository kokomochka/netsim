// Showcase campus: a big, fully configured template. Sandbox (no goals).
//
//   Server room (raised floor, x1–14)      Office (x16–26)
//   uplink → Edge-FW → Core-RT → Rack-SW-A ═╗  six desks on Office-SW
//                         │      Rack-SW-B ═╝ (double link, STP blocks one)
//                         └ Cell site (fibre)
//   12 servers: 6 websites, NAS + cloud, SAN, AI frontend/orchestrator, 2 GPU workers
//   Vents in the partition and to the outside, two AC units, parking below.
import { CABLE_BANDWIDTH } from '../balance';
import { DEVICE_DEFS } from './devices';
import { addRoom } from './floor';
import { cellKey, recomputeAllPaths } from './geometry';
import { freshHw, normParts, specsFor } from './hardware';
import type { CableType, DeviceKind, DeviceOf, RoleKind, ServerParts, WorldState } from './types';
import { makeEngineer, newWorld } from './world';

export function showcaseWorld(): WorldState {
  const s = newWorld();
  s.meta.sandbox = true;
  for (const k of Object.keys(s.unlocks) as (keyof typeof s.unlocks)[]) s.unlocks[k] = true;
  s.unlocks.throttling = true;
  s.economy.balance = 25000;
  for (const d of Object.values(s.devices)) if (d.kind !== 'uplink') delete s.devices[d.id];
  s.staff.engineers = {};
  const f = s.floor;
  f.tiles = {};
  addRoom(f, 0, 1, 27, 15, 'raised');
  for (let y = 1; y <= 15; y++) f.tiles[cellKey(15, y)] = 'wall';
  for (let x = 16; x <= 26; x++) for (let y = 2; y <= 14; y++) f.tiles[cellKey(x, y)] = 'floor';
  f.tiles[cellKey(15, 8)] = 'door';
  f.tiles[cellKey(21, 15)] = 'smartdoor';
  f.tiles[cellKey(8, 15)] = 'door';
  for (const [x, y] of [[15, 4], [15, 12], [0, 6], [0, 11], [7, 1], [11, 1]] as const) f.tiles[cellKey(x, y)] = 'vent';
  f.parking = { x0: 0, y0: 17, x1: 27, y1: 22 };

  const id = () => `dev_${s.nextId++}`;
  const rid = (p: string) => `${p}_${s.nextId++}`;
  const place = <K extends DeviceKind>(kind: K, name: string, gx: number, gy: number): DeviceOf<K> => {
    const d = DEVICE_DEFS[kind].create(id(), name, { gx, gy }) as DeviceOf<K>;
    s.devices[d.id] = d;
    return d;
  };
  const cable = (a: string, ap: number, b: string, bp: number, type: CableType = 'ethernet') => {
    const cid = `cab_${s.nextId++}`;
    s.cables[cid] = { id: cid, a: { deviceId: a, port: ap }, b: { deviceId: b, port: bp }, type, bandwidthMbps: CABLE_BANDWIDTH[type], path: [] };
  };

  const up = Object.values(s.devices)[0]!;
  up.gridPos = { gx: 1, gy: 3 };
  if (up.kind === 'uplink') { up.uplinkTier = 'business'; up.bandwidthMbps = 1000; }
  up.ports[0]!.media = 'fibre';

  // edge firewall
  const fw = place('firewall', 'Edge-FW', 3, 3);
  fw.ports[0]!.media = 'fibre';
  fw.interfaces[0]!.ip = '203.0.113.2'; fw.interfaces[0]!.mask = '/28';
  fw.interfaces[1]!.ip = '10.0.0.1'; fw.interfaces[1]!.mask = '/30';
  fw.routes = [
    { id: rid('rt'), dest: '0.0.0.0/0', nextHop: '203.0.113.1', metric: 1 },
    { id: rid('rt'), dest: '192.168.0.0/16', nextHop: '10.0.0.2', metric: 1 },
  ];
  fw.rules = [
    { id: rid('fw'), action: 'allow', protocol: 'tcp', srcZone: 'outside', dstZone: 'inside', src: 'any', dst: '192.168.10.0/24', ports: '80', log: false },
    { id: rid('fw'), action: 'allow', protocol: 'tcp', srcZone: 'outside', dstZone: 'inside', src: 'any', dst: '192.168.10.0/24', ports: '443', log: false },
  ];

  // core router
  const rt = place('router', 'Core-RT', 6, 3);
  rt.interfaces[3]!.ip = '10.0.0.2'; rt.interfaces[3]!.mask = '/30';
  rt.interfaces[1]!.ip = '192.168.10.1'; rt.interfaces[1]!.mask = '/24';
  rt.interfaces[2]!.ip = '192.168.20.1'; rt.interfaces[2]!.mask = '/24';
  rt.interfaces[0]!.ip = '192.168.30.1'; rt.interfaces[0]!.mask = '/24';
  rt.ports[0]!.media = 'fibre';
  rt.routes = [{ id: rid('rt'), dest: '0.0.0.0/0', nextHop: '10.0.0.1', metric: 1 }];
  cable(up.id, 0, fw.id, 0, 'fibre');
  cable(fw.id, 1, rt.id, 3);

  // two rack switches with a redundant double link (STP blocks one)
  const swA = place('switch', 'Rack-SW-A', 10, 3);
  const swB = place('switch', 'Rack-SW-B', 11, 10);
  cable(rt.id, 1, swA.id, 0);
  cable(swA.id, 5, swB.id, 1);
  cable(swA.id, 6, swB.id, 2);

  // cell site on fibre
  const cell = place('tower', 'Cell-1', 6, 13);
  cell.ports[0]!.media = 'fibre';
  cell.ip = '192.168.30.10'; cell.mask = '/24'; cell.gateway = '192.168.30.1';
  cable(cell.id, 0, rt.id, 0, 'fibre');

  // servers
  const parts = (p: Partial<ServerParts>): ServerParts => normParts({ cpu: 1, ram: 1, disk: 1, diskType: 'ssd', disks: 2, raid: 'raid1', gpu: 0, nic: 0, ports: 1, ...p });
  const nat: { pub: string; priv: string }[] = [];
  const server = (name: string, gx: number, gy: number, host: number, p: ServerParts, sw: { id: string }, port: number) => {
    const d = place('server', name, gx, gy);
    d.parts = p; d.specs = specsFor(p); d.hw = freshHw(p);
    d.ip = `192.168.10.${host}`; d.gateway = '192.168.10.1';
    cable(d.id, 0, sw.id, port);
    return d;
  };
  const addRole = (d: DeviceOf<'server'>, role: RoleKind, port: number, pub?: string, kind?: 'web' | 'cloud' | 'ai') => {
    let sid: string | null = null;
    if (pub && kind) {
      sid = rid('svc');
      const pid = `pip_${s.nextId++}`;
      s.publicAddrs[pid] = { id: pid, ip: pub, services: [sid] };
      s.services[sid] = { id: sid, serverId: d.id, kind, port, usedGB: 0, fqdn: null, publicIp: '', flowIds: [], demand: 1, reputation: 1.2, availability: 0, downSinceTick: null, downPenalised: false, upTicks: 0, flowId: null };
      if (!nat.some((n) => n.pub === pub)) nat.push({ pub, priv: d.ip });
    }
    d.roles.push({ role, serviceId: sid, port, links: [] });
  };
  const webs = [];
  for (let i = 0; i < 6; i++) {
    const onA = i < 3;
    const d = server(`web-0${i + 1}`, 2 + i * 2, onA ? 6 : 8, 10 + i, parts({}), onA ? swA : swB, onA ? 1 + i : 3 + (i - 3));
    addRole(d, 'web', 80, `203.0.113.${5 + i}`, 'web');
    webs.push(d);
  }
  // storage
  const nas = server('nas-01', 2, 11, 30, parts({ cpu: 2, ram: 2, disk: 2, diskType: 'hdd', disks: 6, raid: 'raid6', chassis: 1, psu2: true }), swB, 6);
  addRole(nas, 'nas', 445);
  addRole(nas, 'cloud', 80, '203.0.113.11', 'cloud');
  nas.roles.find((r) => r.role === 'cloud')!.links = [nas.id];
  const san = server('san-01', 4, 11, 31, parts({ cpu: 2, ram: 2, disk: 2, diskType: 'nvme', disks: 4, raid: 'raid10', chassis: 1, psu2: true }), swB, 7);
  addRole(san, 'san', 3260);
  // AI: frontend + orchestrator with a back-end network on eth1 to two GPU boxes
  const ai = server('ai-front', 8, 11, 40, parts({ cpu: 2, ram: 2, ports: 3 }), swA, 4);
  addRole(ai, 'ai_frontend', 80, '203.0.113.12', 'ai');
  addRole(ai, 'orchestrator', 7000);
  ai.roles.find((r) => r.role === 'ai_frontend')!.links = [ai.id];
  const gpus = [];
  for (let i = 0; i < 2; i++) {
    const g = place('server', `gpu-0${i + 1}`, 11 + i * 2, 12);
    g.parts = parts({ cpu: 2, ram: 2, gpu: 2, gpus: 2, ports: 2, chassis: 1 }); g.specs = specsFor(g.parts); g.hw = freshHw(g.parts);
    // gpu-01 also has eth0 on the rack for management; gpu-02 lives only on the back-end network
    if (i === 0) { g.ip = '192.168.10.50'; g.gateway = '192.168.10.1'; cable(g.id, 0, swA.id, 7); }
    addRole(g, 'gpu', 7001);
    gpus.push(g);
  }
  // sync ports for multi-port servers and wire the back-end network
  for (const d of [ai, ...gpus]) {
    d.hw = freshHw(d.parts);
    while (d.ports.length < d.parts.ports) {
      const i = d.ports.length;
      const l = [{ side: 'E', label: 'eth1' }, { side: 'N', label: 'eth2' }, { side: 'S', label: 'eth3' }][i - 1]!;
      d.ports.push({ index: i, side: l.side as 'E', offset: 0.5, label: l.label, up: true, media: 'copper' });
      d.extra.push({ ip: '', mask: '/24' });
    }
  }
  ai.extra[0] = { ip: '10.10.0.1', mask: '/24' };
  ai.extra[1] = { ip: '10.10.1.1', mask: '/24' };
  gpus[0]!.extra[0] = { ip: '10.10.0.2', mask: '/24' };
  gpus[1]!.extra[0] = { ip: '10.10.1.2', mask: '/24' };
  cable(ai.id, 1, gpus[0]!.id, 1);
  cable(ai.id, 2, gpus[1]!.id, 1);
  ai.roles.find((r) => r.role === 'orchestrator')!.links = gpus.map((g) => g.id);
  // backups to the NAS, TLS certificates on the public sites
  for (const w of webs) { w.agents.backup = { enabled: true, targetId: nas.id }; w.cert = true; }
  ai.cert = true;
  nas.cert = true;
  // monitoring master: every server runs an agent, network gear is polled over SNMP
  const mon = server('mon-01', 13, 6, 60, parts({ cpu: 1, ram: 1 }), swB, 0);
  addRole(mon, 'monitor', 80);
  const targets: { id: string; ip: string; method: 'agent' | 'snmp' }[] = [];
  for (const d of Object.values(s.devices)) {
    if (d.kind === 'server' && d.id !== mon.id) { d.agents.monitor = { enabled: true, masterIp: mon.ip }; if (d.ip) targets.push({ id: rid('mt'), ip: d.ip, method: 'agent' }); }
    else if (d.kind === 'router' || d.kind === 'firewall') { const ip = (d.kind === 'firewall' ? d.interfaces.find((i) => i.ip && i.name !== 'outside')?.ip : undefined) ?? d.interfaces.find((i) => i.ip)?.ip; if (ip) targets.push({ id: rid('mt'), ip, method: 'snmp' }); }
    else if ((d.kind === 'desk' || d.kind === 'badge' || d.kind === 'tower') && d.ip) targets.push({ id: rid('mt'), ip: d.ip, method: 'snmp' });
  }
  mon.roles.find((r) => r.role === 'monitor')!.targets = targets;

  // NAT for every public service and for the cell site
  fw.nat = nat.map((n) => ({ id: rid('nat'), publicIp: n.pub, privateIp: n.priv }));
  fw.nat.push({ id: rid('nat'), publicIp: '203.0.113.14', privateIp: '192.168.30.10' });

  // cooling
  place('ac', 'AC-1', 1, 14);
  place('ac', 'AC-2', 14, 14);

  // office
  const osw = place('switch', 'Office-SW', 21, 13);
  cable(rt.id, 2, osw.id, 3);
  let p = 0;
  for (const [x, y] of [[17, 4], [20, 4], [23, 4], [17, 9], [20, 9], [23, 9]] as const) {
    const d = place('desk', `Desk-${p + 1}`, x, y);
    d.ip = `192.168.20.${10 + p}`; d.mask = '/24'; d.gateway = '192.168.20.1';
    cable(d.id, 0, osw.id, p < 3 ? p : p + 1);
    p++;
  }
  // badge reader at the entrance, checking badges against the Auth role on nas-01
  addRole(nas, 'auth', 389);
  delete s.devices[Object.values(s.devices).find((d) => d.kind === 'badge')?.id ?? ''];
  const rd = place('badge', 'Door-1', 21, 15);
  rd.ip = '192.168.20.60'; rd.mask = '/24'; rd.gateway = '192.168.20.1'; rd.authIp = '192.168.10.30';
  cable(rd.id, 0, osw.id, 7);
  for (const [x, y] of [[18.5, 6.5], [21.5, 6.5], [24.5, 6.5], [19.5, 11.5], [9.5, 7.5]] as const) {
    const e = makeEngineer(s, x, y);
    s.staff.engineers[e.id] = e;
  }
  recomputeAllPaths(s);
  return s;
}
