// World state schema — Phase 3.
// Learning-by-doing model: every L3 device is configured by hand (IP, mask,
// gateway, static routes, static NAT, ACLs). Automation (MAC learning, DHCP,
// dynamic routing, scrubber auto-mitigation, monitoring) unlocks through
// achievements.

// ─── Id types ───────────────────────────────────────────────────────────────

export type DeviceId   = string;   // dev_N
export type CableId    = string;   // cab_N
export type FlowId     = string;   // flw_N
export type ServiceId  = string;   // svc_N
export type IncidentId = string;   // inc_N

// ─── Primitives ─────────────────────────────────────────────────────────────

export type Side     = 'N' | 'E' | 'S' | 'W';
export type Rotation = 0 | 1 | 2 | 3;

export interface GridPos { gx: number; gy: number }
export interface Vec2    { x: number; y: number }

// ─── Devices ────────────────────────────────────────────────────────────────

export type DeviceKind =
  | 'uplink'
  | 'server'
  | 'router'
  | 'switch'
  | 'firewall'
  | 'ddos_scrubber'
  | 'desk'
  | 'tower'
  | 'ac'
  | 'badge';

export interface Port {
  index: number;
  side: Side;       // side before rotation
  offset: number;   // 0..1 position along that side
  label: string;    // eth0, Gi0/1, outside…
  up: boolean;      // false when a NIC fault kills it
  media: Media;     // copper takes ethernet/crossover, fibre takes fibre cables
}

export type Media = 'copper' | 'fibre';

// ─── Health ─────────────────────────────────────────────────────────────────

export type FaultMode = 'disk' | 'nic' | 'overheat' | 'board';

export interface Health {
  hp: number;                           // 0–100
  state: 'ok' | 'degrading' | 'warning' | 'critical' | 'failed' | 'repairing';
  fault: FaultMode | null;
  faultPort: number | null;             // for nic fault
  degradeRatePerTick: number;           // 0 when healthy
  repairEndsAt: number | null;          // tick
  repairKind: 'preventive' | 'full' | null;
}

export interface Usage {
  cpu: number;
  ram: number;
  storage: number;
  bandwidth: number;   // 0–1: share of capacity in use (never above 1; the rest is dropped)
  offered?: number;    // Mbps that tried to get through
  io?: number;         // servers: disk array busy share
  nic?: number;        // servers: network card busy share
  gpu?: number;        // servers: GPU busy share
  bottleneck?: string; // servers: which resource limits the traffic
  capMbps?: number;    // servers: traffic the box can serve right now
}

/** Patch state of anything running an OS (servers, desk PCs, routers, firewalls). */
export interface Software {
  patch: number;                // release installed
  outdatedSince: number | null; // tick a newer release appeared
}

export interface Compromise {
  since: number;
  by: 'trespasser' | 'remote' | 'lateral';
  label: string;
}

interface DeviceBase {
  id: DeviceId;
  name: string;
  gridPos: GridPos;
  rotation: Rotation;
  ports: Port[];
  health: Health;
  sw?: Software;
  updateSrc?: string;           // where patches are downloaded from: a mirror's IP, or empty for the internet
  compromised?: Compromise | null;
  temp?: number;                // °C, hottest point of the device
  wear?: number;                // 0–1 ageing of non-server devices (servers track each component)
  age?: number;                 // seconds in service since new or replaced
}

// ─── Shared L3 config ───────────────────────────────────────────────────────

/** Static route. The exit interface is derived from the next hop (recursive lookup). */
export interface Route {
  id: string;
  dest: string;      // CIDR
  nextHop: string;   // IP on a connected subnet
  metric: number;
}

/** Static one-to-one NAT (Cisco "static (inside,outside)" / iptables DNAT+SNAT). */
/** A site-to-site VPN on a firewall: traffic for `remote` is encrypted to `peer`. */
export interface Vpn { id: string; peer: string; local: string; remote: string; key: string; enabled: boolean }

/** Somebody else's office out in the world (a customer): reachable only through a VPN. */
export interface RemoteSite { id: string; name: string; publicIp: string; net: string; key: string }

/** Dynamic source NAT: inside sources leaving through one port take that port's address. */
export interface PatRule { id: string; src: string; outPort: number }

export interface NatEntry {
  id: string;
  publicIp: string;   // address visitors use
  privateIp: string;  // real address of the server
  proto?: 'tcp' | 'udp';   // port forwarding: only this protocol and port…
  publicPort?: number;
  privatePort?: number;    // …sent on to this port (default: the same one)
}

/** How a switch port treats VLANs. Access: one VLAN, untagged. Trunk: tagged VLANs,
 *  with VLAN 1 untagged (native). Ports with no entry are access ports in VLAN 1. */
export interface PortVlan { mode: 'access' | 'trunk'; vid: number; allowed: string }   // allowed: 'all' or '10,20,30-35'

/** A VLAN sub-interface on a router or firewall port (router-on-a-stick). */
export interface SubIf { id: string; port: number; vlan: number; ip: string; mask: string; dhcp: DhcpPool; name?: string; securityLevel?: number }

export interface DhcpPool {
  enabled: boolean;   // requires the DHCP unlock
}

// ─── Uplink ─────────────────────────────────────────────────────────────────

export type UplinkTier = 'basic' | 'business' | 'carrier';

export interface UpstreamFilter {
  id: string;
  src: string;        // CIDR the ISP drops before it reaches your pipe
  enabled: boolean;
}

export interface UplinkDevice extends DeviceBase {
  kind: 'uplink';
  publicSubnet: string;      // e.g. '203.0.113.0/28'
  uplinkIp: string;          // ISP gateway on the WAN link, e.g. 203.0.113.1
  bandwidthMbps: number;
  uplinkTier: UplinkTier;
  upstreamFilters: UpstreamFilter[];
}

// ─── Server ─────────────────────────────────────────────────────────────────

export type RoleKind =
  | 'web' | 'cloud' | 'ai_frontend' | 'orchestrator' | 'gpu' | 'nas' | 'san' | 'auth' | 'mirror'
  | 'proxy' | 'fwd_proxy' | 'dns_local' | 'dns_public' | 'monitor';

export interface ProxyRule { id: string; fqdn: string; backend: string }   // backend: internal name or IP
export interface DnsRecord { id: string; name: string; ip: string }
/** One address a monitoring master polls: a server's agent, or SNMP on network gear. */
export interface MonTarget { id: string; ip: string; method: 'agent' | 'snmp' }

export interface ServerRole {
  role: RoleKind;
  serviceId: ServiceId | null;
  port: number;
  links: DeviceId[];             // back ends this role talks to (storage, orchestrator, GPU workers)
  rules?: ProxyRule[];           // reverse proxy: which name goes to which back end
  records?: DnsRecord[];         // local DNS: internal names
  targets?: MonTarget[];         // monitoring master: addresses it polls
  upstream?: DeviceId | 'direct';  // update mirror: how it reaches the internet
  cachedRelease?: number;        // update mirror: newest release it holds
  fetchLeft?: number;            // update mirror: ticks left on the current download
}

export type DiskType = 'hdd' | 'ssd' | 'nvme';
export type RaidLevel = 'single' | 'raid0' | 'raid1' | 'raid6' | 'raid10';
/** Each value is an index into the matching catalogue in balance.ts. */
export interface ServerParts {
  cpu: number; ram: number; disk: number; diskType: DiskType; disks: number; gpu: number; nic: number; ports: number;
  chassis: number;               // 1U / 2U / 4U
  gpus: number;                  // GPU cards of the chosen model
  psu2: boolean;                 // redundant second power supply
  raid: RaidLevel;
}
export type PartSlot = 'cpu' | 'ram' | 'disk' | 'diskType' | 'disks' | 'gpu' | 'gpus' | 'nic' | 'ports' | 'chassis' | 'psu2' | 'raid';

export interface ServerSpecs { cpuCores: number; ramGB: number; storageGB: number; nicMbps: number; gpuTflops: number; gpuName: string; diskType: DiskType }

/** A physical part inside a server that wears out and can fail on its own. */
export type CompKind = 'disk' | 'psu' | 'fan' | 'ram' | 'cpu' | 'gpu' | 'nic' | 'board';
export interface Component {
  id: string;                    // e.g. disk1, psu2, nic0
  kind: CompKind;
  slot: number;
  wear: number;                  // 0 new … 1 end of rated life (can go past 1)
  age: number;                   // seconds in service
  failed: boolean;
}

/** Live hardware state of a server. */
export interface ServerHw {
  comps: Component[];
  array: 'ok' | 'degraded' | 'rebuilding' | 'lost';
  rebuild: number;               // 0–1 progress while rebuilding
  clock: number;                 // 0.4–1: CPU/GPU clock after throttling (DVFS)
  cpuTemp: number;
  gpuTemp: number;
  fan: number;                   // 0–1 fan speed
  watts: number;                 // power drawn from the wall (all of it ends up as heat)
  off: 'thermal' | 'psu' | 'cpu' | 'board' | 'array' | null;   // powered down, and why
  offSince: number;
  crashAt: number;               // RAM fault: next crash (tick)
  crashUntil: number;            // rebooting until this tick
  tempCap: number | null;        // throttling target set by the player (unlock)
}

export interface ServerAgents {
  backup: { enabled: boolean; targetId: DeviceId | null; lastOk?: number };   // NAS to back up to; tick of the last good copy
  failover: { enabled: boolean; partnerId: DeviceId | null; sanId: DeviceId | null };
  monitor?: { enabled: boolean; masterIp: string };              // agent on tcp/10050, answers polls only from this master IP
}

export interface ServerDevice extends DeviceBase {
  kind: 'server';
  addressing: 'static' | 'dhcp';
  ip: string;
  mask: string;
  gateway: string;
  extra: { ip: string; mask: string }[];   // eth1…eth3: extra networks without a gateway
  dns: string;                   // resolver this host asks for names
  mac: string;
  parts: ServerParts;
  specs: ServerSpecs;            // derived from parts
  roles: ServerRole[];
  agents: ServerAgents;
  usage: Usage;
  hw: ServerHw;
  cert?: boolean;                // TLS certificate installed: visitors answered here trust the site
}

// ─── Phone tower (you become an ISP for mobile subscribers) ─────────────────

export interface Subscribers {
  demand: number;          // random walk
  reputation: number;      // grows with uptime
  availability: number;    // share of traffic that reached the ISP this tick
  upTicks: number;
  downSinceTick: number | null;
  flowId: FlowId | null;
  spikeUntil: number;      // tick a traffic spike ends (concert, match day…)
  live?: boolean;          // has been in service at least once (SLA applies from then on)
}

export type AccessKind = 'cell' | 'home';

/** Access uplink: a cell site or a street of home networks whose traffic you carry to the ISP. */
export interface TowerDevice extends DeviceBase {
  kind: 'tower';
  access: AccessKind;
  addressing: 'static' | 'dhcp';
  ip: string;
  mask: string;
  gateway: string;
  mac: string;
  subs: Subscribers;
}

// ─── Desk (workstation PC) ──────────────────────────────────────────────────

export interface DeskDevice extends DeviceBase {
  kind: 'desk';
  addressing: 'static' | 'dhcp';
  ip: string;
  mask: string;
  gateway: string;
  mac: string;
  ownerId: string | null;        // engineer sitting here
  reception?: boolean;           // the front-desk PC by the entrance
}

// ─── Router ─────────────────────────────────────────────────────────────────

export interface RouterInterface {
  port: number;
  ip: string;
  mask: string;
  mac: string;
  dhcp: DhcpPool;
}

export interface RouterDevice extends DeviceBase {
  kind: 'router';
  interfaces: RouterInterface[];
  routes: Route[];
  nat: NatEntry[];
  pat?: PatRule[];               // dynamic source NAT (unlock: dynamicNat)
  subifs?: SubIf[];              // VLAN sub-interfaces
  ospf: boolean;
  usage: Usage;
}

// ─── Switch ─────────────────────────────────────────────────────────────────

export interface SwitchDevice extends DeviceBase {
  kind: 'switch';
  macTable: Record<string, number>;  // MAC → port, filled while learning is unlocked
  stack?: string;                    // multi-floor switch: one per storey, joined by a backplane
  vlans?: Record<number, PortVlan>;  // per port; missing = access VLAN 1
  stp: boolean;                      // spanning tree: blocks redundant links, fails over when one dies
}

// ─── Badge reader (controls the smart doors next to it) ────────────────────

export interface BadgeDevice extends DeviceBase {
  kind: 'badge';
  addressing: 'static' | 'dhcp';
  ip: string;
  mask: string;
  gateway: string;
  mac: string;
  authIp: string;                // Auth server it checks badges against (LDAP tcp/389)
  failMode: 'open' | 'closed';   // what the doors do when the Auth server cannot be reached
}

// ─── AC unit (cools its room) ───────────────────────────────────────────────

export interface AcDevice extends DeviceBase {
  kind: 'ac';
  on: boolean;
}

// ─── Firewall (routed mode, ASA style) ──────────────────────────────────────

export interface FirewallInterface {
  port: number;
  name: string;             // nameif: outside | inside | dmz | …
  securityLevel: number;    // 0–100
  ip: string;
  mask: string;
  mac: string;
  dhcp: DhcpPool;
}

export type FwAction   = 'allow' | 'deny';
export type FwProtocol = 'any' | 'tcp' | 'udp' | 'icmp';

export interface FirewallRule {
  id: string;
  action: FwAction;
  protocol: FwProtocol;
  srcZone: string;     // interface name or 'any' (where the packet came in)
  dstZone: string;     // interface name or 'any' (where it leaves)
  src: string;         // 'any' | IP | CIDR
  dst: string;         // matched against the real (post-NAT) address
  ports: string;       // 'any' | '80' | '1000-2000'
  log: boolean;
}

export interface FirewallDevice extends DeviceBase {
  kind: 'firewall';
  interfaces: FirewallInterface[];
  rules: FirewallRule[];
  vpns?: Vpn[];
  defaultPolicy: FwAction;
  routes: Route[];
  nat: NatEntry[];
  pat?: PatRule[];               // dynamic source NAT (unlock: dynamicNat)
  subifs?: SubIf[];              // VLAN sub-interfaces
  ospf: boolean;
  capacityMbps: number;
  usage: Usage;
}

// ─── DDoS scrubber (transparent L2 appliance) ───────────────────────────────

export interface RateLimit {
  id: string;
  src: string;         // CIDR or 'any'
  maxMbps: number;     // shared by everything matching this rule
  action: 'limit' | 'drop';
  enabled: boolean;
}

export interface DdosScrubberDevice extends DeviceBase {
  kind: 'ddos_scrubber';
  rateLimits: RateLimit[];
  capacityMbps: number;
  synProtection: boolean;
  autoMitigation: boolean;    // requires unlock
  autoThresholdMbps: number;  // per source range
  usage: Usage;
}

export type Device =
  | UplinkDevice
  | ServerDevice
  | RouterDevice
  | SwitchDevice
  | FirewallDevice
  | DdosScrubberDevice
  | DeskDevice
  | TowerDevice
  | AcDevice
  | BadgeDevice;

export type DeviceOf<K extends DeviceKind> = Extract<Device, { kind: K }>;
export type L3Device = RouterDevice | FirewallDevice;

// ─── Cable ──────────────────────────────────────────────────────────────────

export type CableType = 'ethernet' | 'fibre' | 'crossover';

export interface CableEnd { deviceId: DeviceId; port: number }

export interface Cable {
  id: CableId;
  a: CableEnd;
  b: CableEnd;
  type: CableType;
  bandwidthMbps: number;
  path: Vec2[];
}

// ─── Flow ───────────────────────────────────────────────────────────────────

export type FlowKind = 'http' | 'attack' | 'probe' | 'backup' | 'transit' | 'backend' | 'proxied' | 'control';
export type AttackType = 'http_flood' | 'syn_flood' | 'udp_amp';

export interface Flow {
  id: FlowId;
  kind: FlowKind;
  origin: 'external' | DeviceId;  // internal flows start at a host
  srcCidr: string;               // '0.0.0.0/0' = visitors from everywhere
  dstIp: string;
  protocol: 'tcp' | 'udp' | 'icmp';
  srcPort: number;
  dstPort: number;
  host?: string;                 // HTTP Host / SNI name, read by reverse proxies
  tag?: string;                  // identity of internal control traffic (ssh:job, ldap:door…)
  syn: boolean;                  // half-open SYN flood
  rateMbps: number;
  healthCheck?: boolean;         // trickle to a dead endpoint while healthy ones carry the load
  serviceId: ServiceId | null;
  incidentId: IncidentId | null;
}

// ─── Service ────────────────────────────────────────────────────────────────

export interface Service {
  id: ServiceId;
  serverId: DeviceId;
  kind: 'web' | 'cloud' | 'ai' | 'dns';
  fqdn: string | null;           // name visitors type; resolved through your domain's DNS
  port: number;                  // 80 website, 443 cloud / AI API
  usedGB: number;                // cloud storage: data customers keep with you
  appVersion?: number;           // releases your engineers shipped
  quality?: number;              // ×visitors and ×revenue, grows with each release (cap 2)
  devProgress?: number;          // 0–1 toward the next release
  publicIp: string;              // legacy, unused: public IPs live in WorldState.publicAddrs
  flowIds?: FlowId[];            // one visitor flow per public IP the service is reached on
  demand: number;                // random walk 0.7–1.3
  reputation: number;            // 0.5–2.5
  availability: number;          // 0–1, this tick
  downSinceTick: number | null;
  downPenalised: boolean;        // reputation hit taken for the current outage
  upTicks: number;               // consecutive ticks ≥ 99 %
  live?: boolean;                // has served visitors at least once: only then it counts toward uptime
  flowId: FlowId | null;
  contractId?: string;           // serving a client under contract: paid by them, not per visitor
}

// ─── Deals ──────────────────────────────────────────────────────────────────

export type DealKind = 'web' | 'shop' | 'files' | 'gpu' | 'dns' | 'vpn' | 'shield';

/** A client's job: what they want online, and how they pay for it. */
export interface Contract {
  id: string;
  client: string;                // the person who came in
  org: string;                   // who they work for
  kind: DealKind;
  pitch: string;
  fqdn?: string;                 // the name their service must answer on
  domain?: string;               // their domain, handed to you to manage
  siteId?: string;               // vpn: their office
  upfront: number;               // paid the moment it first works
  rate: number;                  // $/s while it works, afterwards
  termS: number | null;          // seconds of service; null = until they leave
  setupBy: number;               // tick: must be working by then
  state: 'setup' | 'live' | 'done' | 'failed' | 'ended';
  serviceId?: string;
  liveAt?: number;               // tick it first worked
  servedS: number;               // seconds of service so far (only counts while it works)
  downS: number;                 // current outage, seconds
  paid: number;
  status: string;                // why it does / does not work right now
  how?: string[];                // tutorial steps
  endedAt?: number;
  endWhy?: string;
}

export interface Applicant { name: string; traits: Trait[]; salary: number; pitch: string }

export interface Visitor extends Walker {
  id: string;
  name: string;
  state: 'arriving' | 'waiting' | 'leaving';
  offer?: Contract;
  applicant?: Applicant;
  leaveAt: number;               // tick they give up waiting
}

export interface Deals {
  contracts: Record<string, Contract>;
  visitors: Record<string, Visitor>;
  nextVisit: number;             // tick
  tutorial: number;              // next scripted visitor (0–2); 3 = done or skipped
  served: number;                // visitors spoken to
}

// ─── Economy ────────────────────────────────────────────────────────────────

export interface Economy {
  balance: number;
  totalEarned: number;
  totalSpent: number;
  revenuePerSec: number;
  upkeepPerSec: number;
  repairsCount: number;
  preventiveRepairs: number;
}

// ─── Events & incidents ─────────────────────────────────────────────────────

export type EventKind = 'hardware_failure' | 'ddos' | 'trespass' | 'intrusion' | 'patch_release';

export interface ScheduledEvent {
  triggerAt: number;
  kind: EventKind;
}

export type IncidentPhase = 'recon' | 'flood' | 'resolved';

export interface Incident {
  id: IncidentId;
  kind: 'ddos';
  attackType: AttackType;
  phase: IncidentPhase;
  startTick: number;
  floodAt: number;               // tick the flood starts
  endAt: number;                 // tick the flood stops
  endTick: number | null;
  targetServiceId: ServiceId | null;
  targetIp: string;
  probeFlowId: FlowId | null;
  attackFlowIds: FlowId[];
  srcRanges: string[];
  totalVolumeMbps: number;
  offeredSum: number;            // Σ offered attack Mbps over the flood
  deliveredSum: number;          // Σ attack Mbps that reached the server
  mitigated: boolean | null;     // decided at the end
}

// ─── Progression ────────────────────────────────────────────────────────────

export interface Unlocks {
  macLearning: boolean;          // switches learn MACs instead of flooding every port
  dhcp: boolean;                 // routers/firewalls hand out addresses
  dynamicRouting: boolean;       // OSPF-style route sharing
  serverM: boolean;
  serverL: boolean;
  carrierUplink: boolean;
  monitoring: boolean;           // see degradation early, alerts
  autoMitigation: boolean;       // scrubber blocks heavy sources by itself
  upstreamFiltering: boolean;    // ask the ISP to drop ranges before your pipe
  throttling?: boolean;          // per-server temperature cap (DVFS)
  dynamicNat?: boolean;          // many inside hosts share the outside address (PAT)
}

export type AchievementId =
  | 'hello_world' | 'locked_down' | 'patch_panel' | 'two_hops' | 'address_book'
  | 'first_k' | 'fix_early' | 'ddos_1' | 'ddos_5' | 'ten_k' | 'five_nines' | 'caught' | 'safety_net' | 'on_the_map' | 'cool_head' | 'way_out';

export interface AchievementState { done: boolean; at: number | null; progress: number }

export interface Stats {
  uptimeBuckets: (number | null)[];  // 60 one-minute buckets, null = no data yet
  currentBucket: number;
  bucketTickCount: number;
  bucketAvailSum: number;
  ddosBlocked: number;
  ddosTotal: number;
  devicesRepaired: number;
  preventiveRepairs: number;
  totalDowntimeTicks: number;
  switchTicks: number;           // ticks a switch with ≥3 hosts carried live traffic
  trespassersCaught: number;
  failoversSurvived: number;
}

// ─── Runtime cache (not saved) ──────────────────────────────────────────────

export type BlockReason =
  | 'link_down' | 'device_failed' | 'arp_fail' | 'no_route' | 'no_ip' | 'no_gateway'
  | 'fw_deny' | 'scrubbed' | 'port_closed' | 'ttl' | 'bogon_src' | 'upstream_filtered'
  | 'not_for_me' | 'storm';

export interface Hop {
  deviceId: DeviceId;
  inPort: number | null;
  outPort: number | null;
  cableId: CableId | null;       // cable leaving this hop toward the next
  note: string;                  // human explanation for the trace
}

export interface ResolvedPath {
  hops: Hop[];
  blocked: boolean;
  blockedAt: number | null;      // hop index where it stopped
  reason: BlockReason | null;
  explain: string;               // one-line explanation of the result
  ruleId: string | null;
  /** extra cables that carried flooded copies (switch without MAC learning) */
  floodCables: CableId[];
  /** capacity resources this flow consumed: cables, devices, rate-limit rules */
  resources: string[];
  /** reply traffic check (service flows only) */
  ret: ResolvedPath | null;
  /** destination reached (true even if the port was closed) */
  reachedServer: DeviceId | null;
  /** addresses as the destination saw them (after NAT): who to answer, and from where */
  srcSeen?: number;
  dstSeen?: number;
  /** went through a VPN tunnel (encrypted on the way) */
  viaTunnel?: boolean;
  /** ended at a remote site through a VPN */
  reachedSite?: string;
}

export interface Carrier {
  flowId: FlowId;
  kind: FlowKind;
  pathIndex: number;
  progress: number;
  age: number;
  size: number;
  dying: number;                 // >0 = flashing out at a block point
}

export interface TalkerRow { flowId: FlowId; kind: FlowKind; src: string; dst: string; proto: string; mbps: number; verdict: string; ok: boolean }

export interface RuntimeCache {
  paths: Record<FlowId, ResolvedPath>;
  cableLoad: Record<CableId, number>;
  cableCap: Record<CableId, number>;
  delivery: Record<FlowId, number>;              // 0–1 after congestion
  talkers: Record<DeviceId, TalkerRow[]>;        // flows seen by each device
  ruleHits: Record<string, number>;              // `${devId}:${ruleId}` → Mbps matching now
  ruleHitCount?: Record<string, number>;        // sessions that have matched since load (like an ASA hitcnt)
  ruleLastHit?: Record<string, number>;         // tick of the most recent match
  ruleSeen?: Record<string, true>;              // `${flowId}|${rule}` already counted
  learned: Record<DeviceId, (Route & { via: string })[]>;  // OSPF routes
  carriers: Carrier[];
  topologyVersion: number;
  topologyDirty: boolean;
  uplinkMbps: number;
  rooms: Room[];
  cellRoom: Record<string, string>;
  resolve: Record<ServiceId, { ip: string | null; ips: string[]; why: string }>;   // visitors' DNS lookup
  doors: Record<string, { state: 'locked' | 'open' | 'sealed'; why: string }>;    // smart door cell → state
  proxyChk: Record<string, { ok: boolean; why: string; backends?: { id: DeviceId; ip: string }[] }>;   // "svc@proxy" → healthy back ends
  mirrorOk: Record<DeviceId, { ok: boolean; why: string }>;            // update mirror upstream              // "x,y" → room key
  stpBlocked: Record<CableId, DeviceId>;          // redundant link → switch port that blocks it
  storm: Record<DeviceId, true>;                 // switches caught in a loop without STP
  roleLinks: Record<string, { ok: DeviceId[]; bad: { id: DeviceId; why: string }[] }>;  // "serverId:role"
  takeover: Record<DeviceId, DeviceId>;          // primary server → standby answering for it
  reach: Record<string, boolean>;                // cached mgmt reachability "from>to"
  monitored?: Record<DeviceId, string>;          // device → master that hears from it
  consoles?: Record<DeviceId, DeviceId>;         // desk → master whose web console it can open
  monWhy?: Record<DeviceId, string>;             // why a device is not monitored
  vpnUp?: Record<string, { up: boolean; why: string; peerFw?: DeviceId; site?: string }>;   // `${fwId}:${vpnId}`
  monSeen?: Record<DeviceId, string>;           // device → master that has had an answer from it since load
  monSilent?: Record<DeviceId, true>;           // answered before, not now: the master raises an alert
  monTargets?: Record<string, { ok: boolean; msg: string }>;   // `${masterId}:${targetId}` → last poll
}

// ─── Floor plan and people ──────────────────────────────────────────────────

export type Tile = 'ground' | 'floor' | 'raised' | 'wall' | 'door' | 'smartdoor' | 'vent'
  | 'xwall'      // a building's outer wall: fixed
  | 'lift'       // the lift: the same cell on every storey
  | 'street' | 'sidewalk'
  | 'void';      // nothing here: upper storeys outside a building

/** A building in the city. Footprint in band-0 cells; storey k is the same cells k × STRIDE rows down. */
export interface Building {
  id: string;
  name: string;
  rects: Rect[];
  floors: number;
  front: 'n' | 's';            // which way the street side faces
  owned: boolean;
  forSale: boolean;
  price: number;
  door: GridPos;
  lift: GridPos;
  uplinkId: DeviceId | null;
}

export interface Rect { x0: number; y0: number; x1: number; y1: number }

export interface Floor {
  w: number;
  h: number;
  tiles: Record<string, Tile>;   // "x,y" → tile; missing = ground (outside)
  parking?: Rect;                // decorative, no-build
}

export interface Walker {
  x: number;                     // cell coordinates of the body centre (float)
  y: number;
  path: GridPos[];               // remaining waypoints
}

export type EngineerState = 'seated' | 'idle' | 'roaming' | 'walking' | 'working' | 'chasing';

export interface Engineer extends Walker {
  id: string;
  name: string;
  state: EngineerState;
  deskId: DeviceId | null;
  jobId: string | null;
  idleUntil: number;
  chaseId: string | null;
  devOn?: string | null;         // service it is developing while idle at the desk
  traits?: Trait[];
  salary?: number;               // $/s
  homeDeskId?: string | null;    // their own desk while they cover reception
}

/** Small, realistic strengths. Nothing that bends physics. */
export type Trait = 'fastHands' | 'scripter' | 'sharpEyes' | 'quickFeet' | 'tidy';

export type JobKind = 'preventive' | 'full' | 'replace' | 'update' | 'reimage' | 'swap' | 'upgrade' | 'inspect';

export interface Job {
  id: string;
  kind: JobKind;
  deviceId: DeviceId;
  engineerId: string | null;
  remote: boolean;               // done from a desk PC over the network
  workLeft: number;              // ticks of hands-on work remaining
  started: boolean;
  createdAt: number;
  auto: boolean;
  comps?: string[];              // swap: server components to replace
  parts?: ServerParts;           // upgrade: the new configuration
  cold?: boolean;                // swap/upgrade needs the server switched off
  waitWhy?: string;              // update: why the download is not running
  waitSince?: number;            // update: tick the download got stuck
  retryAt?: number;              // update: engineer let go of it; try again from this tick
  paid?: number;                 // money already charged (refunded on cancel)
}

export interface Trespasser extends Walker {
  id: string;
  targetId: DeviceId;
  state: 'approach' | 'hacking' | 'leaving';
  progress: number;              // ticks spent hacking
  spotted: boolean;
}

export interface Staff {
  engineers: Record<string, Engineer>;
  jobs: Record<string, Job>;
  trespassers: Record<string, Trespasser>;
  autoMaintain: boolean;
  autoPatch: boolean;
  release: number;               // newest software release available
}

/** A public IP from your ISP block that you put to use, and the services visitors reach on it. */
export interface PublicAddr {
  id: string;
  ip: string;
  services: ServiceId[];
}

export interface Domain {
  id: string;
  name: string;                  // e.g. acme.net
  client?: string;               // a client's domain you manage under contract (they pay the renewal)
  hosting: 'registrar' | 'self'; // who answers DNS for it
  nsIp: string;                  // self-hosted: public IP of your Public DNS server
  records: DnsRecord[];          // A records: name ("www", "@") → IP
}

export interface Climate {
  rooms: Record<string, number>;   // room key (its first cell) → air °C
  outside: number;
}

export interface Room { key: string; cells: string[]; size: number }

/** A problem somebody knows about: picked up by monitoring or seen by an engineer. */
export interface KnownProblem {
  at: number;                    // tick it became known
  via: 'monitoring' | 'engineer';
  ack: boolean;                  // an engineer has seen it (console or on site): staff act on it
  by?: string;                   // engineer who saw it
}

export interface LogEntry {
  tick: number;
  deviceId: DeviceId;
  msg: string;
  level: 'info' | 'warn' | 'alert';
}

export interface Camera { x: number; y: number; scale: number }

export interface WorldState {
  meta: { version: number; seed: number; saveTimestamp: number; playTimeTicks: number; rng?: number; sandbox?: boolean };
  camera: Camera;
  speed: 0 | 1 | 2 | 4;
  economy: Economy;
  grid: { width: number; height: number };
  devices: Record<DeviceId, Device>;
  cables: Record<CableId, Cable>;
  flows: Record<FlowId, Flow>;
  services: Record<ServiceId, Service>;
  events: ScheduledEvent[];
  activeIncidents: Record<IncidentId, Incident>;
  unlocks: Unlocks;
  achievements: Record<AchievementId, AchievementState>;
  floor: Floor;
  buildings: Record<string, Building>;
  sites?: Record<string, RemoteSite>;
  deals?: Deals;
  staff: Staff;
  climate: Climate;
  domains: Record<string, Domain>;
  publicAddrs: Record<string, PublicAddr>;
  known?: Record<string, KnownProblem>;   // problem key → who knows
  stats: Stats;
  logs: LogEntry[];
  time: { tick: number };
  nextId: number;
}

export function assertNever(x: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(x)}`);
}
