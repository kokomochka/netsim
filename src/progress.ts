// Achievements and the unlock tree. Early game is configured entirely by hand;
// each achievement proves a skill and unlocks the automation that replaces it.

import { MINUTE, TICKS_PER_SEC } from './balance';
import { notify } from './sim/engine';
import { pathMatches } from './sim/net';
import type { AchievementId, AchievementState, RuntimeCache, Unlocks, WorldState } from './state/types';

export interface AchievementDef {
  id: AchievementId;
  title: string;
  goal: string;
  how: string[];               // step-by-step hints for apprentices
  reward: string;
  cash?: number;
  unlocks?: (keyof Unlocks)[];
  requires?: AchievementId[];  // shown as locked until these are done
  target?: number;             // for a progress bar
  progress(s: WorldState, c: RuntimeCache): number;   // 0..target (or 0/1)
}

const liveServices = (s: WorldState) => Object.values(s.services).filter((v) => v.availability >= 0.95);

export const ACHIEVEMENTS: AchievementDef[] = [
  {
    id: 'hello_world',
    title: 'Hello, world',
    goal: 'Get one website answering visitors from the internet for 10 seconds.',
    how: [
      'Pick the Cable tool and run a cable from the ISP uplink to Server-1.',
      'Open Server-1. Give it a free address from your public block, e.g. 203.0.113.2, mask /28 (255.255.255.240).',
      'Set its gateway to the ISP router, 203.0.113.1.',
      'Under Roles, add Website.',
      'Open the Internet tab, add 203.0.113.2 under Public IPs and tick Server-1\'s website.',
    ],
    reward: '$100',
    cash: 100,
    target: 10,
    progress: (s) => Math.min(10, Math.max(0, ...Object.values(s.services).map((v) => v.upTicks / TICKS_PER_SEC), 0)),
  },
  {
    id: 'locked_down',
    title: 'Locked down',
    goal: 'Serve a site through a firewall with default policy deny and an explicit allow rule.',
    how: [
      'Put a firewall between the uplink and your server: outside port to the ISP, inside port to the server side.',
      'Outside interface: a public IP like 203.0.113.2/28. Inside: a private network like 192.168.10.1/24.',
      'Move the server to 192.168.10.10/24 with gateway 192.168.10.1.',
      'Note: the firewall ports are eth0 (outside), eth1 (inside), eth2 (dmz), eth3 (spare).',
      'Firewall: static route 0.0.0.0/0 via 203.0.113.1 for replies.',
      'Firewall NAT: public 203.0.113.5 → private 192.168.10.10. In the Internet tab, put the website on 203.0.113.5.',
      'ACL: allow tcp from outside to inside, destination 192.168.10.10, port 80.',
    ],
    reward: '$150',
    cash: 150,
    requires: ['hello_world'],
    progress: (s, c) => (liveServices(s).some((v) => {
      const p = v.flowId ? c.paths[v.flowId] : undefined;
      if (!p) return false;
      return p.hops.some((h) => {
        const d = s.devices[h.deviceId];
        if (d?.kind !== 'firewall' || d.defaultPolicy !== 'deny') return false;
        return pathMatches(p).some((m) => {
          const [dev, rule] = m.split(':');
          return dev === d.id && d.rules.find((r) => r.id === rule)?.action === 'allow';
        });
      });
    }) ? 1 : 0),
  },
  {
    id: 'patch_panel',
    title: 'Patch panel',
    goal: 'Run live site traffic through a switch with at least 3 cables for 60 seconds.',
    how: [
      'Put a switch on your inside network. Everything on one switch shares one subnet.',
      'Cable the router/firewall inside port and two or more servers to it.',
      'Without MAC learning, the switch floods every frame out of every port. Watch the extra load on the cables.',
    ],
    reward: 'Unlocks MAC learning: switches send frames only where they need to go.',
    unlocks: ['macLearning'],
    target: 60,
    progress: (s) => Math.min(60, s.stats.switchTicks / TICKS_PER_SEC),
  },
  {
    id: 'two_hops',
    title: 'Two hops',
    goal: 'Serve a site whose traffic crosses two routing devices, using a static route you wrote.',
    how: [
      'Chain firewall → router → servers, with a small transfer network between them, e.g. 10.0.0.0/30.',
      'Firewall: static route to the server subnet via the router (e.g. 192.168.20.0/24 via 10.0.0.2).',
      'Router: default route 0.0.0.0/0 via the firewall (10.0.0.1) so replies find their way out.',
    ],
    reward: 'Unlocks dynamic routing (OSPF): routers share their networks automatically.',
    unlocks: ['dynamicRouting'],
    requires: ['locked_down'],
    progress: (s, c) => (liveServices(s).some((v) => {
      const p = v.flowId ? c.paths[v.flowId] : undefined;
      if (!p) return false;
      const l3 = p.hops.filter((h) => { const k = s.devices[h.deviceId]?.kind; return k === 'router' || k === 'firewall'; });
      return l3.length >= 2 && [...p.hops, ...(p.ret?.hops ?? [])].some((h) => h.note.includes('static route'));
    }) ? 1 : 0),
  },
  {
    id: 'address_book',
    title: 'Address book',
    goal: 'Run public services on 4 servers at once, all addressed by hand.',
    how: ['Every server needs a unique IP, the right mask and a gateway. Keep a list: duplicates break things.'],
    reward: 'Unlocks DHCP: routers and firewalls can hand out addresses.',
    unlocks: ['dhcp'],
    target: 4,
    progress: (s) => Math.min(4, new Set(liveServices(s).filter((v) => { const d = s.devices[v.serverId]; return d?.kind === 'server' && d.addressing === 'static'; }).map((v) => v.serverId)).size),
  },
  {
    id: 'first_k',
    title: 'First thousand',
    goal: 'Earn $1,000 in total.',
    how: ['More sites, better reputation. Reputation rises while sites stay up.'],
    reward: 'Unlocks pro server parts: 8–16 cores, 64 GB RAM, 4 TB disks, NVMe, pro GPU, 10 Gbps NIC.',
    unlocks: ['serverM'],
    target: 1000,
    progress: (s) => Math.min(1000, s.economy.totalEarned),
  },
  {
    id: 'fix_early',
    title: 'Ounce of prevention',
    goal: 'Replace 3 failed parts while the server keeps running.',
    how: [
      'Give a server two or more drives and a RAID level that survives a failure (RAID 1, 6 or 10).',
      'A 2U chassis can take a second, redundant power supply.',
      'When a drive or PSU dies the server keeps serving. Order the spare part: an engineer hot-swaps it without downtime.',
      'Engineers only notice a dead part when they walk past it, or when a monitoring master alerts them.',
    ],
    reward: 'Unlocks predictive alerts: monitored parts report wear before they fail (SMART).',
    unlocks: ['monitoring'],
    target: 3,
    progress: (s) => Math.min(3, s.stats.preventiveRepairs),
  },
  {
    id: 'ddos_1',
    title: 'Hold the line',
    goal: 'Mitigate a DDoS attack: less than 20 % of it may reach your server.',
    how: [
      'When the port scan warning appears, note the source range.',
      'During the flood, open the firewall and read Top talkers: the attacking /24 stands out.',
      'Add a deny rule for that source above your allow rule, or put a scrubber inline and drop it there.',
      'Your 100 Mbps line still fills up. Upgrading the uplink to Business keeps visitors getting through.',
    ],
    reward: 'Unlocks scrubber auto-mitigation.',
    unlocks: ['autoMitigation'],
    progress: (s) => Math.min(1, s.stats.ddosBlocked),
  },
  {
    id: 'ddos_5',
    title: 'Battle tested',
    goal: 'Mitigate 5 DDoS attacks.',
    how: ['SYN floods: enable SYN protection on a scrubber. UDP floods: your firewall already drops UDP, but the line is still full.'],
    reward: 'Unlocks upstream filtering: the ISP drops ranges before they reach your line.',
    unlocks: ['upstreamFiltering'],
    requires: ['ddos_1'],
    target: 5,
    progress: (s) => Math.min(5, s.stats.ddosBlocked),
  },
  {
    id: 'ten_k',
    title: 'Data centre',
    goal: 'Earn $10,000 in total.',
    how: ['Scale out. Watch the uplink: at about 5 sites the Basic line is full.'],
    reward: 'Unlocks enterprise parts (32 cores, 256 GB, 16 TB, datacentre GPU) and the 10 Gbps Carrier uplink.',
    unlocks: ['serverL', 'carrierUplink'],
    requires: ['first_k'],
    target: 10000,
    progress: (s) => Math.min(10000, s.economy.totalEarned),
  },
  {
    id: 'caught',
    title: 'Caught red-handed',
    goal: 'Catch a trespasser before they reach a machine.',
    how: [
      'Strangers only go for machines no engineer is watching (2 cells around a person).',
      'An engineer who sees them within 5 cells gives chase. Spread desks so the floor is covered.',
      'Smart doors keep strangers out while a badge reader next to them can reach an Auth server.',
    ],
    reward: '$200',
    cash: 200,
    progress: (s) => Math.min(1, s.stats.trespassersCaught),
  },
  {
    id: 'safety_net',
    title: 'Safety net',
    goal: 'Keep a public service running through a server failure with a failover agent.',
    how: [
      'Put two servers on the same subnet and install the same roles on both.',
      'On the primary, enable the failover agent and pick the second server as standby.',
      'When the primary fails, the standby answers for its IP address and the site stays up.',
    ],
    reward: '$300',
    cash: 300,
    requires: ['hello_world'],
    progress: (s) => Math.min(1, s.stats.failoversSurvived),
  },
  {
    id: 'on_the_map',
    title: 'On the map',
    goal: 'Serve a website by name: buy a domain, add a record, and give the site that name.',
    how: [
      'Open the Domains tab and buy a domain, e.g. mysite.net.',
      'Add a record: name "www" → the public IP your site (or your reverse proxy) is reached on. Several records with the same name share the load and fail over.',
      'In the server\'s Website role, pick www.mysite.net as its domain name.',
      'Named sites get about 40 % more visitors.',
      'Idle engineers at a desk keep improving your apps: each release brings more visitors (5 % of releases need a quick patch).',
    ],
    reward: '$200',
    cash: 200,
    requires: ['hello_world'],
    progress: (s) => (Object.values(s.services).some((v) => v.fqdn && v.availability >= 0.95) ? 1 : 0),
  },
  {
    id: 'five_nines',
    title: 'Three nines',
    goal: 'Keep 99.9 % uptime across a full hour of play.',
    how: ['Preventive maintenance, a firewall and enough bandwidth.'],
    reward: '$2,000',
    cash: 2000,
    target: 60,
    progress: (s) => {
      const b = s.stats.uptimeBuckets;
      if (b.some((v) => v === null)) return b.filter((v) => v !== null).length * 0.99;
      const avg = (b as number[]).reduce((a, x) => a + x, 0) / b.length;
      return avg >= 0.999 ? 60 : 59;
    },
  },
  {
    id: 'cool_head',
    title: 'Feeling the heat',
    goal: 'Let a server run hot: 88 °C or more.',
    how: [
      'Load a server up (more visitors, or a GPU working for an orchestrator) in a room without much cooling.',
      'CPU temperature = room air + CPU watts × the chassis\' thermal resistance. Fans speed up as it heats.',
      'At 95 °C the hardware throttles itself, at 105 °C it shuts down. Heat also wears parts out faster: life halves every 10 °C.',
    ],
    reward: 'Unlocks throttling: cap a server\'s temperature. Near the cap it lowers its clock: power falls faster than performance.',
    unlocks: ['throttling'],
    progress: (s) => (Object.values(s.devices).some((d) => d.kind === 'server' && (d.temp ?? 0) >= 88) ? 1 : 0),
  },
];

export function freshAchievements(): Record<AchievementId, AchievementState> {
  const out = {} as Record<AchievementId, AchievementState>;
  for (const a of ACHIEVEMENTS) out[a.id] = { done: false, at: null, progress: 0 };
  return out;
}

export function checkAchievements(s: WorldState, c: RuntimeCache): void {
  if (s.meta.sandbox) return;
  for (const a of ACHIEVEMENTS) {
    const st = (s.achievements[a.id] ??= { done: false, at: null, progress: 0 });
    if (st.done) continue;
    if (a.requires?.some((r) => !s.achievements[r]?.done)) { st.progress = 0; continue; }
    st.progress = a.progress(s, c);
    if (st.progress >= (a.target ?? 1)) {
      st.done = true;
      st.at = s.time.tick;
      if (a.cash) { s.economy.balance += a.cash; s.economy.totalEarned += a.cash; }
      for (const u of a.unlocks ?? []) s.unlocks[u] = true;
      notify(`Achievement: ${a.title}. ${a.reward}`, 'good');
      c.topologyDirty = true;
    }
  }
}

export { MINUTE };
