// All tunable numbers live here (architecture v2, §9). Phase 3 edition.
import type { CableType, CompKind, DeviceKind, DiskType, RaidLevel, RoleKind, Tile, UplinkTier } from './state/types';

// ─── Grid ───────────────────────────────────────────────────────────────────
export const CELL = 48;
export const BODY = 40;
export const PORT_STUB = 12;
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;

// ─── Simulation timing ──────────────────────────────────────────────────────
export const TICKS_PER_SEC = 20;
export const TICK_MS = 1000 / TICKS_PER_SEC;
export const MINUTE = 60 * TICKS_PER_SEC;

// ─── Economy ────────────────────────────────────────────────────────────────
export const START_BALANCE = 500;

export const DEVICE_PRICE: Record<DeviceKind, number> = {
  uplink: 0,
  server: 250,
  router: 150,
  switch: 100,
  firewall: 400,
  ddos_scrubber: 600,
  desk: 300,
  ac: 700,
  badge: 120,
  tower: 1800,  // see ACCESS for the real price per variant
};

export const DEVICE_UPKEEP: Record<DeviceKind, number> = {
  uplink: 0,
  server: 0.03,
  router: 0.01,
  switch: 0.01,
  firewall: 0.02,
  ddos_scrubber: 0.04,
  desk: 0.01,
  ac: 0.05,
  badge: 0.004,
  tower: 0.06,
};

// ─── Server hardware: every part upgrades on its own ───────────────────────
/** base = available from the start, pro = "First thousand", enterprise = "Data centre". */
export type PartGate = 'base' | 'pro' | 'enterprise';
export interface Part { label: string; price: number; upkeep: number; gate: PartGate }

export const SERVER_BASE_PRICE = 250;      // chassis + the first part of every slot
export const SERVER_BASE_UPKEEP = 0.02;

export const CPU_PARTS: (Part & { cores: number; tdp: number })[] = [
  { label: '2 cores', cores: 2, tdp: 35, price: 0, upkeep: 0, gate: 'base' },
  { label: '4 cores', cores: 4, tdp: 65, price: 150, upkeep: 0.01, gate: 'base' },
  { label: '8 cores', cores: 8, tdp: 125, price: 450, upkeep: 0.03, gate: 'pro' },
  { label: '16 cores', cores: 16, tdp: 180, price: 1100, upkeep: 0.06, gate: 'pro' },
  { label: '32 cores', cores: 32, tdp: 280, price: 2400, upkeep: 0.12, gate: 'enterprise' },
];
export const RAM_PARTS: (Part & { gb: number; watts: number })[] = [
  { label: '4 GB', gb: 4, watts: 3, price: 0, upkeep: 0, gate: 'base' },
  { label: '16 GB', gb: 16, watts: 6, price: 120, upkeep: 0.005, gate: 'base' },
  { label: '64 GB', gb: 64, watts: 12, price: 450, upkeep: 0.015, gate: 'pro' },
  { label: '256 GB', gb: 256, watts: 30, price: 1500, upkeep: 0.04, gate: 'enterprise' },
];
export const DISK_PARTS: (Part & { gb: number })[] = [
  { label: '250 GB', gb: 250, price: 0, upkeep: 0, gate: 'base' },
  { label: '1 TB', gb: 1000, price: 100, upkeep: 0.003, gate: 'base' },
  { label: '4 TB', gb: 4000, price: 350, upkeep: 0.008, gate: 'pro' },
  { label: '16 TB', gb: 16000, price: 1200, upkeep: 0.02, gate: 'enterprise' },
];
/** speed: Mbps of requests one drive can feed (× IO_MBPS_PER_DRIVE). */
export const DISK_TYPES: Record<DiskType, { label: string; priceMul: number; speed: number; faultMul: number; watts: number; gate: PartGate }> = {
  hdd:  { label: 'HDD',  priceMul: 1,   speed: 1,   faultMul: 2,   watts: 8, gate: 'base' },
  ssd:  { label: 'SSD',  priceMul: 2.5, speed: 2.5, faultMul: 1,   watts: 3, gate: 'base' },
  nvme: { label: 'NVMe', priceMul: 5,   speed: 5,   faultMul: 0.8, watts: 6, gate: 'pro' },
};
export const GPU_PARTS: (Part & { tflops: number; watts: number })[] = [
  { label: 'No GPU', tflops: 0, watts: 0, price: 0, upkeep: 0, gate: 'base' },
  { label: 'Entry GPU · 8 TFLOPS', tflops: 8, watts: 75, price: 900, upkeep: 0.05, gate: 'base' },
  { label: 'Pro GPU · 40 TFLOPS', tflops: 40, watts: 300, price: 3000, upkeep: 0.15, gate: 'pro' },
  { label: 'Datacentre GPU · 200 TFLOPS', tflops: 200, watts: 700, price: 9000, upkeep: 0.4, gate: 'enterprise' },
];
export const NIC_PARTS: (Part & { mbps: number; watts: number })[] = [
  { label: '1 Gbps', mbps: 1000, watts: 3, price: 0, upkeep: 0, gate: 'base' },
  { label: '10 Gbps', mbps: 10000, watts: 12, price: 400, upkeep: 0.01, gate: 'pro' },
];

/** Chassis: how many drives and GPUs fit, how much power the PSU gives, how well air moves through. */
export interface ChassisDef extends Part { bays: number; gpuSlots: number; psuW: number; cpuR: number; gpuR: number; hotFans: boolean; redundantOk: boolean }
export const CHASSIS: ChassisDef[] = [
  { label: '1U', bays: 4, gpuSlots: 1, psuW: 500, cpuR: 0.32, gpuR: 0.16, hotFans: false, redundantOk: false, price: 0, upkeep: 0, gate: 'base' },
  { label: '2U', bays: 8, gpuSlots: 2, psuW: 1100, cpuR: 0.22, gpuR: 0.11, hotFans: true, redundantOk: true, price: 300, upkeep: 0.01, gate: 'base' },
  { label: '4U', bays: 12, gpuSlots: 4, psuW: 2400, cpuR: 0.14, gpuR: 0.08, hotFans: true, redundantOk: true, price: 900, upkeep: 0.03, gate: 'pro' },
];
export const PSU2_PRICE = 250;               // redundant PSU (2U/4U)
export const BOARD_WATTS = 20;               // mainboard, BMC, chipset
export const FAN_WATTS: [number, number] = [8, 45];   // at slowest / full speed
export const PSU_EFFICIENCY = 0.9;

/** RAID: n = drives. cap = drives' worth of space, tol = drives that may fail, io = speed multiplier. */
export interface RaidDef { label: string; min: number; even?: boolean; cap: (n: number) => number; tol: (n: number) => number; io: (n: number) => number; blurb: string }
export const RAID: Record<RaidLevel, RaidDef> = {
  single: { label: 'No RAID', min: 1, cap: (n) => n, tol: () => 0, io: () => 1, blurb: 'Every drive on its own. Any drive that dies takes its data with it.' },
  raid0:  { label: 'RAID 0', min: 2, cap: (n) => n, tol: () => 0, io: (n) => n, blurb: 'Striped: fastest and all the space, but one dead drive loses everything.' },
  raid1:  { label: 'RAID 1', min: 2, cap: () => 1, tol: (n) => n - 1, io: (n) => Math.min(n, 2) * 0.9, blurb: 'Mirrored: every drive holds the same data. Survives all but one drive failing.' },
  raid6:  { label: 'RAID 6', min: 4, cap: (n) => n - 2, tol: () => 2, io: (n) => (n - 2) * 0.7, blurb: 'Double parity: loses two drives of space, survives any two failing.' },
  raid10: { label: 'RAID 10', min: 4, even: true, cap: (n) => n / 2, tol: () => 1, io: (n) => n / 2, blurb: 'Mirrored pairs, striped: fast and safe, half the space. Survives one drive (often more).' },
};
/** Seconds to rebuild an array onto a new drive, per drive size (÷ drive speed). */
export const REBUILD_S = [25, 40, 70, 120];
export const DEGRADED_IO = 0.6;
export const REBUILD_IO = 0.5;

// ─── Load: requests need CPU, memory, disk and network ─────────────────────
export const IO_MBPS_PER_DRIVE = 80;         // × drive speed × RAID multiplier
export const RAM_GB_PER_MBPS = 0.02;         // buffers and sessions per Mbps served
export const OS_RAM_GB = 0.5;
export const SWAP_PENALTY = 0.3;             // memory short: what is left runs this fast
export const LATENCY_KNEE = 0.8;             // above this utilisation responses slow down
export const LATENCY_LOSS = 0.3;             // availability lost at 100 %

// ─── Heat, wear, failures ──────────────────────────────────────────────────
export const THROTTLE_C = 95;                // hardware throttles here no matter what
export const SHUTDOWN_C = 105;               // and powers off here
export const RESTART_C = 60;                 // BMC powers it back on once cooled
export const CLOCK_MIN = 0.4;
export const TEMP_CAP_RANGE: [number, number] = [60, 90];
/** Seconds of rated life at 50 °C and half load. */
export const LIFE_S: Record<CompKind, number> = { disk: 8100, psu: 10800, fan: 8100, ram: 21600, cpu: 32400, gpu: 32400, nic: 21600, board: 21600 };
export const WEAR_REF_C = 50;               // rated life applies at this temperature; +10 °C halves it
export const LIFE_S_DEVICE = 16200;          // routers, switches, firewalls…
export const BASE_HAZARD = 1 / (25 * 3600);  // failures/s of a part at zero wear
export const INFANT_S = 120;                 // brand-new parts fail more often…
export const INFANT_MUL = 4;
export const WEAR_HAZARD = 30;               // …and worn ones: hazard × (1 + 30·wear⁴)
export const WORN = 0.75;                    // predictive alert threshold
/** Spare parts and what an engineer charges to fit them. */
export const COMP_PRICE: Record<CompKind, number> = { disk: 0, psu: 60, fan: 25, ram: 0, cpu: 0, gpu: 0, nic: 40, board: 150 };
export const SWAP_SECONDS = { hot: 6, cold: 15 };
export const RAM_CRASH_S: [number, number] = [15, 40];
export const REBOOT_S = 8;
/** Non-server devices: watts at idle and at full load, and °C per watt over the room. */
export const DEVICE_WATTS: Record<DeviceKind, { idle: number; load: number; r: number }> = {
  uplink: { idle: 20, load: 10, r: 0.3 },
  server: { idle: 0, load: 0, r: 0 },
  router: { idle: 40, load: 30, r: 0.4 },
  switch: { idle: 30, load: 20, r: 0.4 },
  firewall: { idle: 70, load: 60, r: 0.35 },
  ddos_scrubber: { idle: 150, load: 120, r: 0.25 },
  desk: { idle: 150, load: 0, r: 0.15 },
  tower: { idle: 250, load: 200, r: 0.1 },
  ac: { idle: 0, load: 0, r: 0 },
  badge: { idle: 5, load: 0, r: 1 },
};

// ─── Monitoring and certificates ───────────────────────────────────────────
export const MON_AGENT_PORT = 10050;         // master polls the server agent (tcp)
export const MON_CONSOLE_PORT = 80;          // engineers open the master's web console
export const SNMP_PORT = 161;                // master polls network devices (udp)
export const POLL_TIMEOUT_S = 6;
/** Share of a flow's rate on the request leg and on the reply leg.
 *  Visitors download pages (small request, big reply); cloud customers upload. */
export const FLOW_SHAPE = {
  page: { req: 0.1, resp: 1 },
  upload: { req: 1, resp: 0.1 },
  download: { req: 0.05, resp: 1 },
  even: { req: 1, resp: 1 },
} as const;
/** Visitor demand grows ever slower: reputation × quality × name × TLS saturates near 1 + this. */
export const DEMAND_SOFT_CAP = 2.5;
export const PATCH_FETCH_MBPS = 8;           // a device downloading a release
export const MIRROR_FETCH_S = 20;            // a mirror pulling a new release from the internet
export const MIRROR_FETCH_MBPS = 25;             // silent this long → "stopped answering" alert
export const NOTICE_RADIUS = 2;              // cells: an engineer this close sees blinking LEDs
export const CERT_PRICE = 60;
export const CERT_UPKEEP = 0.004;
export const CERT_BONUS = 1.2;               // visitors and revenue for services answered with a certificate
/** Extra network ports (eth1…eth3) and extra drive bays, bought one at a time. */
export const PORT_PRICE = 80;
export const MAX_SERVER_PORTS = 4;
export const MAX_DISKS = 12;
/** Swapping a port between copper and fibre (an SFP transceiver). */
export const MEDIA_SWAP_PRICE = 20;
/** Mbps of web traffic one free CPU core serves (× disk speed). */
export const MBPS_PER_CORE = 30;
/** Trade-in: you get back this share of the part you replace. */
export const PART_TRADE_IN = 0.5;

// ─── Server roles ──────────────────────────────────────────────────────────
export interface RoleDef {
  label: string;
  blurb: string;
  port: number;
  ports?: number[];              // when it listens on more than one port
  proto: 'tcp' | 'udp';
  cores: number;
  ramGB: number;
  diskGB: number;
  needsGpu?: boolean;
  needsFastDisk?: boolean;
  public: boolean;               // reachable from the internet, earns money
  service?: 'web' | 'cloud' | 'ai' | 'dns';
  stateful: boolean;             // failover needs shared SAN storage
  linksTo?: RoleKind[];          // back-end roles it must reach
  multiLink?: boolean;           // may use several back ends at once
}
export const ROLES: Record<RoleKind, RoleDef> = {
  web:          { label: 'Website', blurb: 'A website. Plain HTTP on port 80, HTTPS on 443 once the server has a certificate. Brings in about $0.40/s and 20 Mbps of visitors.', port: 80, proto: 'tcp', cores: 1, ramGB: 1, diskGB: 10, public: true, service: 'web', stateful: false },
  cloud:        { label: 'Cloud storage', blurb: 'Customers keep their files here and pay by the gigabyte. Port 80, or 443 with a certificate. The files themselves live on a NAS or SAN you link it to.', port: 80, proto: 'tcp', cores: 2, ramGB: 4, diskGB: 20, public: true, service: 'cloud', stateful: false, linksTo: ['nas', 'san'] },
  ai_frontend:  { label: 'AI frontend', blurb: 'A public AI API (port 80, or 443 with a certificate). It hands each job to an orchestrator, and earns by how much GPU power stands behind it.', port: 80, proto: 'tcp', cores: 1, ramGB: 2, diskGB: 10, public: true, service: 'ai', stateful: false, linksTo: ['orchestrator'] },
  orchestrator: { label: 'Orchestrator', blurb: 'Splits AI jobs across GPU compute servers (tcp/7000). Best wired to them over a second, back-end network on eth1.', port: 7000, proto: 'tcp', cores: 2, ramGB: 8, diskGB: 50, public: false, stateful: false, linksTo: ['gpu'], multiLink: true },
  gpu:          { label: 'GPU compute', blurb: 'Worker that runs AI jobs for an orchestrator (tcp/7001). Needs a GPU.', port: 7001, proto: 'tcp', cores: 2, ramGB: 8, diskGB: 100, needsGpu: true, public: false, stateful: false },
  nas:          { label: 'NAS', blurb: 'File storage on tcp/445. Backup agents and cloud storage keep data here.', port: 445, proto: 'tcp', cores: 1, ramGB: 4, diskGB: 500, public: false, stateful: true },
  san:          { label: 'SAN', blurb: 'Fast shared block storage (iSCSI tcp/3260). Cloud storage and failover of stateful roles use it.', port: 3260, proto: 'tcp', cores: 2, ramGB: 8, diskGB: 2000, needsFastDisk: true, public: false, stateful: true },
  auth:         { label: 'Auth / directory', blurb: 'Logins and badge checks (LDAP tcp/389). Smart doors only lock while one runs.', port: 389, proto: 'tcp', cores: 1, ramGB: 2, diskGB: 20, public: false, stateful: true },
  mirror:       { label: 'Update mirror', blurb: 'Keeps a local copy of every new release (port 8080). Devices that use it as their update source patch from here: twice as fast, and without their own route to the internet.', port: 8080, proto: 'tcp', cores: 1, ramGB: 2, diskGB: 200, public: false, stateful: false },
  proxy:        { label: 'Reverse proxy', blurb: 'Answers web traffic on one public IP (ports 80 and 443) and hands each request to the server behind the name the visitor typed. Lots of sites, one address.', port: 443, ports: [80, 443], proto: 'tcp', cores: 1, ramGB: 2, diskGB: 10, public: false, stateful: false },
  fwd_proxy:    { label: 'Forward proxy', blurb: 'Lets internal servers reach the internet through it (tcp/3128), e.g. the update mirror fetching releases. Needs internet access itself.', port: 3128, proto: 'tcp', cores: 1, ramGB: 2, diskGB: 20, public: false, stateful: false },
  dns_local:    { label: 'Local DNS', blurb: 'Answers internal names such as app1.lan on udp/53. Hosts use it when you set it as their DNS server.', port: 53, proto: 'udp', cores: 1, ramGB: 1, diskGB: 5, public: false, stateful: false },
  monitor:      { label: 'Monitoring master', blurb: 'Checks on everything in its list: servers through their agent (tcp/10050), network gear over SNMP (udp/161). Staff at a desk that can open its web console (tcp/80) see the alerts.', port: 80, ports: [80], proto: 'tcp', cores: 1, ramGB: 2, diskGB: 20, public: false, stateful: false },
  dns_public:   { label: 'Public DNS', blurb: 'Public DNS service on udp/53: earns per query, and can host your own domains (self-hosted DNS).', port: 53, proto: 'udp', cores: 1, ramGB: 2, diskGB: 10, public: true, service: 'dns', stateful: false },
};
export const MGMT_PORT = 22;     // SSH: remote updates from a desk PC
export const GPU_REVENUE = (tflops: number) => 0.12 * Math.pow(tflops, 0.7);

// ─── Staff and building ────────────────────────────────────────────────────
export const ENGINEER_HIRE = 400;
export const ENGINEER_SALARY = 0.04;       // $/s
export const DESK_PRICE = 300;
export const WALK_SPEED = 2.2;             // cells/s
export const RUSH_SPEED = 4;
export const SIGHT_RADIUS = 2;             // cells an engineer watches around them
export const SPOT_RADIUS = 5;              // cells at which an engineer notices a stranger
export const TILE_PRICE: Record<Tile, number> = { ground: 0, floor: 2, raised: 6, wall: 8, door: 40, smartdoor: 150, vent: 60, xwall: 0, lift: 0, street: 0, sidewalk: 0, void: 0 };
export const MULTIFLOOR_SWITCH_PRICE = 140;
/** Unencrypted traffic crossing your internet lines gets read now and then. */
export const MITM_MEAN_S = 420;
export const PLAINTEXT_PORTS = new Set([21, 23, 25, 80, 110, 143, 161, 389, 445, 3260, 7000, 7001, 8080, 10050]);   // per floor it spans
export const MAP_W = 40;
export const MAP_H = 26;

export const WORK_SECONDS = { preventive: 8, full: 25, replace: 6, update: 8, updateRemote: 6, reimage: 15 } as const;

// ─── Access uplinks: cell sites and home networks (ISP mode) ───────────────────────────────────────────────
export interface AccessDef { label: string; namePrefix: string; blurb: string; price: number; upkeep: number; mbps: number; payPerMbps: number; bonus: number; penalty: number; spikes: boolean }
export const ACCESS: Record<'cell' | 'home', AccessDef> = {
  cell: { label: 'Cell site', namePrefix: 'Cell', blurb: 'Mobile subscribers: heavy traffic, evening peaks, event spikes', price: 1800, upkeep: 0.06, mbps: 220, payPerMbps: 0.004, bonus: 0.15, penalty: 0.2, spikes: true },
  home: { label: 'Home networks', namePrefix: 'Homes', blurb: 'A street of home broadband customers', price: 450, upkeep: 0.015, mbps: 45, payPerMbps: 0.005, bonus: 0.04, penalty: 0.04, spikes: false },
};
export const TRANSIT_DST = '1.1.1.1';        // representative internet destination

// ─── AI and cloud roles ────────────────────────────────────────────────────
export const AI_MBPS = 8;                    // API traffic of the AI frontend
export const GPU_LINK_MBPS = 120;            // orchestrator ↔ each GPU worker (back-end traffic)
export const FRONTEND_LINK_MBPS = 15;        // frontend ↔ orchestrator
export const CLOUD_PAY_PER_GB = 0.0004;      // $/s for every GB customers store
export const CLOUD_GROWTH_GB_PER_S = 2;      // at demand 1, reputation 1
export const CLOUD_BASE_MBPS = 10;

// ─── App development ───────────────────────────────────────────────────────
export const DEV_SECONDS_PER_RELEASE = 90;   // engineer-seconds per release
export const DEV_QUALITY_STEP = 0.05;
export const DEV_MAX_QUALITY = 2;
export const DEV_BUG_CHANCE = 0.05;          // share of rollouts with a security hole
export const DEV_BUG_WINDOW_S = 60;          // time to patch before it is exploitable

// ─── Patches and security ──────────────────────────────────────────────────
export const PATCH_FIRST_TICK = 4 * 60 * 20;
export const PATCH_INTERVAL_S: [number, number] = [360, 540];
export const VULNERABLE_AFTER_S = 180;
export const TRESPASS_FIRST_TICK = 6 * 60 * 20;
export const TRESPASS_INTERVAL_S: [number, number] = [420, 720];
export const HACK_SECONDS = 10;
export const INTRUSION_CHECK_S = 60;
export const LATERAL_MBPS = 40;
export const LATERAL_SECONDS = 15;

export const CABLE_PRICE: Record<CableType, number> = { ethernet: 5, fibre: 40, crossover: 5 };
export const CABLE_BANDWIDTH: Record<CableType, number> = { ethernet: 1000, fibre: 10000, crossover: 1000 };

/** First octets the ISP hands blocks out of (and attackers never come from). */
export const PLAYER_BLOCK_OCTETS = [45, 62, 81, 91, 103, 141, 185, 193, 195, 212, 217];
/** Bigger public blocks: each step doubles the block around the addresses you have. */
export const PUBLIC_BLOCK_UPGRADES: { prefix: number; price: number }[] = [
  { prefix: 27, price: 1500 },
  { prefix: 26, price: 4000 },
  { prefix: 25, price: 9000 },
];

export const UPLINK_START = {
  publicSubnet: '203.0.113.0/28',
  uplinkIp: '203.0.113.1',
  bandwidthMbps: 100,
  uplinkTier: 'basic' as UplinkTier,
};

export const UPLINK_TIER: Record<UplinkTier, { bandwidthMbps: number; costPerSec: number; label: string }> = {
  basic:    { bandwidthMbps: 100,   costPerSec: 0,    label: 'Basic' },
  business: { bandwidthMbps: 1000,  costPerSec: 0.15, label: 'Business' },
  carrier:  { bandwidthMbps: 10000, costPerSec: 1.0,  label: 'Carrier' },
};

// ─── Capacities ─────────────────────────────────────────────────────────────
export const FIREWALL_CAPACITY_MBPS = 1000;
export const DDOS_SCRUBBER_CAPACITY_MBPS = 4000;
export const ROUTER_CAPACITY_MBPS = 1000;
export const SWITCH_CAPACITY_MBPS = 8000;

// ─── Services ───────────────────────────────────────────────────────────────
/** $/s for a static site at demand 1, reputation 1, full availability. */
export const SITE_REVENUE = 0.4;
/** Mbps of visitor traffic at demand 1, reputation 1. */
export const SITE_MBPS = 20;
export const REPUTATION_GAIN_PER_MIN = 0.02;
export const REPUTATION_OUTAGE_HIT = 0.1;
export const OUTAGE_GRACE_TICKS = 10 * TICKS_PER_SEC;
export const DAY_TICKS = 20 * MINUTE;

// ─── Hardware failures ──────────────────────────────────────────────────────
export const FAILURE_GRACE_TICKS = 5 * MINUTE;      // none in the first 5 minutes
export const FAILURE_MIN_INTERVAL_S = 120;
export const FAILURE_BASE_INTERVAL_S = 600;
export const DEGRADE_MIN_S = 120;
export const DEGRADE_MAX_S = 240;
export const HP_WARNING = 60;
export const HP_CRITICAL = 25;

export const REPAIR = {
  preventive: { costFrac: 0.10, seconds: 8 },
  full:       { costFrac: 0.35, seconds: 25 },
  replace:    { costFrac: 1.00, seconds: 0 },
} as const;

// ─── DDoS ───────────────────────────────────────────────────────────────────
export const DDOS_FIRST_TICK = 12 * MINUTE;
export const DDOS_INTERVAL_MIN_S = 15 * 60;
export const DDOS_INTERVAL_MAX_S = 25 * 60;
export const DDOS_INTERVAL_FLOOR_S = 6 * 60;
export const DDOS_RECON_S: [number, number] = [20, 40];
export const DDOS_FLOOD_S: [number, number] = [60, 150];
export const DDOS_MITIGATED_FRACTION = 0.2;          // < 20 % reached the target
export const DDOS_REWARD_SECONDS = 60;               // bonus = 60 s of revenue

// ─── Visuals ────────────────────────────────────────────────────────────────
export const CARRIER_MAX = 400;
export const CARRIER_MAX_AGE = 400;

// ─── Stats ──────────────────────────────────────────────────────────────────
export const UPTIME_BUCKETS = 60;

// ─── Climate ───────────────────────────────────────────────────────────────
/** kW of heat: idle + per unit of load (load 0–1). */
export const HEAT_KW: Record<DeviceKind, { idle: number; load: number }> = {
  uplink: { idle: 0.05, load: 0.05 },
  server: { idle: 0.25, load: 0.75 },
  router: { idle: 0.08, load: 0.12 },
  switch: { idle: 0.05, load: 0.08 },
  firewall: { idle: 0.12, load: 0.18 },
  ddos_scrubber: { idle: 0.2, load: 0.3 },
  desk: { idle: 0.15, load: 0 },
  tower: { idle: 0.2, load: 0.4 },
  ac: { idle: 0, load: 0 },
  badge: { idle: 0.02, load: 0 },
};
export const GPU_HEAT_KW_PER_TFLOP = 0.012;  // a busy GPU adds this per TFLOPS
export const OUTSIDE_TEMP = 20;
export const ROOM_HEAT_CAPACITY = 0.25;      // kJ/°C per floor cell (arbitrary game units)
export const WALL_LEAK = 0.008;              // kW/°C per √cells lost through walls
export const VENT_ROOM_K = 0.2;              // kW/°C exchanged by a vent between two rooms
export const VENT_OUTSIDE_K = 0.06;          // kW/°C to the outside: helps, but not much
export const AC_COOLING_KW = 4;              // heat an AC unit removes while on
export const DEVICE_RISE_PER_KW = 18;        // (legacy) °C per kW
/** °C a device runs above the room air: idle + at full load. Temperature = room + this. */
export const SELF_HEAT_C: Record<DeviceKind, { idle: number; load: number }> = {
  uplink: { idle: 4, load: 6 },
  server: { idle: 8, load: 45 },
  router: { idle: 6, load: 22 },
  switch: { idle: 5, load: 12 },
  firewall: { idle: 7, load: 30 },
  ddos_scrubber: { idle: 8, load: 35 },
  desk: { idle: 6, load: 0 },
  tower: { idle: 8, load: 25 },
  ac: { idle: 0, load: 0 },
  badge: { idle: 2, load: 0 },
};
export const GPU_SELF_HEAT_C = 0.15;         // extra °C per TFLOPS on a busy GPU
export const DEVICE_TEMP_TAU_S = 20;         // how fast a device follows its target temperature
export const OVERHEAT_C = 80;                // devices take damage above this
export const OVERHEAT_HP_PER_S = 0.6;
export const DESK_MAX_ROOM_C = 40;           // engineers refuse to sit in rooms hotter than this

// ─── Domains and DNS ───────────────────────────────────────────────────────
export const TLDS: Record<string, number> = { net: 90, com: 120, io: 250, dev: 60 };
export const DOMAIN_RENEWAL = 0.008;        // $/s per domain
export const REGISTRAR_DNS_FEE = 0.02;      // $/s to let the registrar answer DNS for you
export const NAMED_DEMAND_BONUS = 1.4;      // visitors find a site by name more easily
export const DNS_REVENUE = 0.3;             // $/s for the public DNS service at demand 1
export const DNS_MBPS = 3;
export const INTERNET_IP = '1.1.1.1';
