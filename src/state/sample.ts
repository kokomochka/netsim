// Reference network: two sites behind a routed firewall and a core router.
// Every value here is what an apprentice would type by hand. Loaded as a
// sandbox, so it does not award achievements.
import { CABLE_BANDWIDTH, UPLINK_START } from '../balance';
import { DEVICE_DEFS } from './devices';
import { addRoom } from './floor';
import { cellKey, recomputeAllPaths } from './geometry';
import type { CableType, DeviceKind, DeviceOf, WorldState } from './types';
import { makeEngineer, newWorld } from './world';

export function sampleWorld(): WorldState {
  const s = newWorld();
  // scripted with the documentation block: keep it instead of a random one
  for (const d of Object.values(s.devices)) if (d.kind === 'uplink') { d.publicSubnet = UPLINK_START.publicSubnet; d.uplinkIp = UPLINK_START.uplinkIp; }
  s.meta.sandbox = true;
  // keep only the uplink from the starter world
  for (const d of Object.values(s.devices)) if (d.kind !== 'uplink') delete s.devices[d.id];
  s.staff.engineers = {};
  s.floor.tiles = {};
  addRoom(s.floor, 0, 1, 17, 11, 'raised');
  for (let y = 1; y <= 11; y++) s.floor.tiles[cellKey(13, y)] = 'wall';
  for (let x = 14; x <= 16; x++) for (let y = 2; y <= 10; y++) s.floor.tiles[cellKey(x, y)] = 'floor';
  s.floor.tiles[cellKey(13, 9)] = 'door';
  s.floor.tiles[cellKey(15, 11)] = 'door';
  s.floor.parking = { x0: 0, y0: 13, x1: 17, y1: 18 };
  s.economy.balance = 2000;
  const id = () => `dev_${s.nextId++}`;
  const place = <K extends DeviceKind>(kind: K, name: string, gx: number, gy: number): DeviceOf<K> => {
    const d = DEVICE_DEFS[kind].create(id(), name, { gx, gy }) as DeviceOf<K>;
    s.devices[d.id] = d;
    return d;
  };
  const uplink = Object.values(s.devices)[0]!;
  uplink.gridPos = { gx: 1, gy: 4 };

  const fw = place('firewall', 'Edge-FW', 4, 4);
  fw.interfaces[0]!.ip = '203.0.113.2'; fw.interfaces[0]!.mask = '/28';
  fw.interfaces[1]!.ip = '10.0.0.1'; fw.interfaces[1]!.mask = '/30';
  fw.routes = [
    { id: `rt_${s.nextId++}`, dest: '0.0.0.0/0', nextHop: '203.0.113.1', metric: 1 },
    { id: `rt_${s.nextId++}`, dest: '192.168.10.0/24', nextHop: '10.0.0.2', metric: 1 },
  ];
  fw.nat = [
    { id: `nat_${s.nextId++}`, publicIp: '203.0.113.5', privateIp: '192.168.10.10' },
    { id: `nat_${s.nextId++}`, publicIp: '203.0.113.6', privateIp: '192.168.10.11' },
  ];
  fw.rules = [
    { id: `fw_${s.nextId++}`, action: 'allow', protocol: 'tcp', srcZone: 'outside', dstZone: 'inside', src: 'any', dst: '192.168.10.0/24', ports: '80', log: true },
  ];
  fw.defaultPolicy = 'deny';

  const rt = place('router', 'Core-RT', 7, 4);
  rt.interfaces[3]!.ip = '10.0.0.2'; rt.interfaces[3]!.mask = '/30';
  rt.interfaces[1]!.ip = '192.168.10.1'; rt.interfaces[1]!.mask = '/24';
  rt.routes = [{ id: `rt_${s.nextId++}`, dest: '0.0.0.0/0', nextHop: '10.0.0.1', metric: 1 }];

  const sw = place('switch', 'Rack-SW', 10, 4);
  const web1 = place('server', 'web-01', 9, 7);
  web1.ip = '192.168.10.10'; web1.mask = '/24'; web1.gateway = '192.168.10.1';
  const web2 = place('server', 'web-02', 12, 7);
  web2.ip = '192.168.10.11'; web2.mask = '/24'; web2.gateway = '192.168.10.1';

  const cable = (a: string, ap: number, b: string, bp: number, type: CableType = 'ethernet') => {
    const cid = `cab_${s.nextId++}`;
    s.cables[cid] = { id: cid, a: { deviceId: a, port: ap }, b: { deviceId: b, port: bp }, type, bandwidthMbps: CABLE_BANDWIDTH[type], path: [] };
  };
  uplink.ports[0]!.media = 'fibre';
  fw.ports[0]!.media = 'fibre';
  cable(uplink.id, 0, fw.id, 0, 'fibre');
  cable(fw.id, 1, rt.id, 3);
  cable(rt.id, 1, sw.id, 0);
  cable(sw.id, 4, web1.id, 0);
  cable(sw.id, 7, web2.id, 0);

  for (const [srv, ip] of [[web1, '203.0.113.5'], [web2, '203.0.113.6']] as const) {
    const sid = `svc_${s.nextId++}`;
    s.services[sid] = {
      id: sid, serverId: srv.id, kind: 'web', port: 80, usedGB: 0, fqdn: null, publicIp: '', flowIds: [], demand: 1, reputation: 1, availability: 0,
      downSinceTick: null, downPenalised: false, upTicks: 0, flowId: null,
    };
    srv.roles.push({ role: 'web', serviceId: sid, port: 80, links: [] });
    const pid = `pip_${s.nextId++}`;
    s.publicAddrs[pid] = { id: pid, ip, services: [sid] };
  }
  // office: two desks on their own subnet behind the core router
  rt.interfaces[2]!.ip = '192.168.20.1'; rt.interfaces[2]!.mask = '/24';
  const osw = place('switch', 'Office-SW', 15, 8);
  const d1 = place('desk', 'Desk-1', 14, 3);
  d1.ip = '192.168.20.10'; d1.gateway = '192.168.20.1';
  const d2 = place('desk', 'Desk-2', 14, 5);
  d2.ip = '192.168.20.11'; d2.gateway = '192.168.20.1';
  cable(rt.id, 2, osw.id, 3);
  cable(d1.id, 0, osw.id, 0);
  cable(d2.id, 0, osw.id, 1);
  const e1 = makeEngineer(s, 15.5, 3.5);
  s.staff.engineers[e1.id] = e1;
  const e2 = makeEngineer(s, 15.5, 6.5);
  s.staff.engineers[e2.id] = e2;
  recomputeAllPaths(s);
  return s;
}
