// Visitors at reception: clients with jobs, and people looking for work.
//
// Someone walks in from the street now and then and waits at the reception
// desk. An engineer has to be there to talk to them. A client's deal pays a
// share up front the moment their service first works, then by the second
// while it keeps working, for a fixed term or until they decide to leave.
// Long outages make clients walk away. The first three visitors are a short,
// skippable tutorial for your first website.

import { ENGINEER_SALARY, TICKS_PER_SEC, WALK_SPEED } from '../balance';
import { ACHIEVEMENTS } from '../progress';
import { random } from '../rng';
import { cheb, edgeSpawns, workSpots } from '../state/floor';
import type { Applicant, Contract, DealKind, Deals, Device, RuntimeCache, Service, Visitor, WorldState, Trait } from '../state/types';
import { env, goHome, routeTo, step } from './staff';

let hooks: {
  notify: (m: string, l: 'info' | 'warn' | 'alert' | 'good') => void;
} | null = null;
export function setDealHooks(h: typeof hooks): void { hooks = h; }

const MIN = 60 * TICKS_PER_SEC;
const PATIENCE_S = 150;
const COVER_RADIUS = 3;          // an engineer this close to the reception desk can talk to visitors
const OUTAGE_LIMIT_S = 150;      // a client walks away after this long without service

export function freshDeals(): Deals {
  return { contracts: {}, visitors: {}, nextVisit: 40 * TICKS_PER_SEC, tutorial: 0, served: 0 };
}

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
const FIRST = ['Rosa', 'Tom', 'Mia', 'Jamal', 'Ewa', 'Hugo', 'Lena', 'Omar', 'Greta', 'Paolo', 'Sara', 'Kenji', 'Asha', 'Felix', 'Nora', 'Viktor', 'Lucia', 'Ade', 'Maja', 'Sam', 'Ingrid', 'Rafael', 'Chloe', 'Yusuf'];
const LAST = ['Duarte', 'Berg', 'Okoro', 'Lindgren', 'Moreno', 'Kaplan', 'Weiss', 'Haddad', 'Quinn', 'Sato', 'Novak', 'Rahman', 'Costa', 'Byrne', 'Meyer', 'Adeyemi'];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20);

interface Template {
  kind: DealKind;
  minMin: number;                         // minutes of play before it turns up
  rate: number;                           // $/s, roughly
  setupMin: number;                       // minutes to get it working
  can?: (s: WorldState) => boolean;       // only offered when you could pull it off
  orgs: { org: string; ask: string }[];
}

const hasGpu = (s: WorldState) => Object.values(s.devices).some((d) => d.kind === 'server' && (d.parts?.gpus ?? 0) > 0);

const TEMPLATES: Template[] = [
  { kind: 'web', minMin: 0, rate: 0.3, setupMin: 8, orgs: [
    { org: 'Northside School', ask: 'Parents keep phoning to ask about term dates. We need a school website.' },
    { org: 'the Hill Street Café', ask: 'Just our menu and opening hours online, nothing fancy.' },
    { org: 'the Football Club', ask: 'Fixtures, results and a photo of the team. The old site died with the volunteer who built it.' },
    { org: 'the Public Library', ask: 'A catalogue page and our events. The council stopped hosting it.' },
    { org: 'a dental practice', ask: 'A page with our address and how to book.' },
    { org: 'the Animal Shelter', ask: 'A website with the dogs and cats looking for a home.' },
    { org: 'a wedding photographer', ask: 'A portfolio site. It has to load fast, the photos are big.' },
    { org: 'the Community Choir', ask: 'Rehearsal times and concert dates, please.' },
  ] },
  { kind: 'shop', minMin: 6, rate: 0.5, setupMin: 10, orgs: [
    { org: 'Green Leaf Florist', ask: 'We want to sell bouquets online. Customers pay on it, so it must be HTTPS.' },
    { org: 'a bike repair shop', ask: 'An online shop for parts. Card payments, so it needs the padlock.' },
    { org: 'a vinyl record store', ask: 'Our web shop. Payment provider says HTTPS or nothing.' },
    { org: 'a tea merchant', ask: 'A small web shop with checkout. Has to be encrypted.' },
  ] },
  { kind: 'files', minMin: 6, rate: 0.4, setupMin: 10, orgs: [
    { org: 'a law firm', ask: 'A file server for the office. Our case files can\'t sit on a USB stick any more.' },
    { org: 'an accounting office', ask: 'Nightly backups of our books. Somewhere that isn\'t our own office.' },
    { org: 'a photo studio', ask: 'An archive for raw photos. Terabytes, eventually.' },
    { org: 'a medical practice', ask: 'Off-site backups of our records.' },
    { org: 'an indie game studio', ask: 'Somewhere to keep our builds and art files.' },
  ] },
  { kind: 'dns', minMin: 15, rate: 0.35, setupMin: 10, orgs: [
    { org: 'a marketing agency', ask: 'Our registrar\'s DNS keeps falling over. Can you answer for our domain yourself?' },
    { org: 'a small web designer', ask: 'Run the name servers for my domain, please. I don\'t trust the registrar\'s.' },
  ] },
  { kind: 'vpn', minMin: 12, rate: 0.45, setupMin: 12, orgs: [
    { org: 'a family business with a warehouse', ask: 'Connect our warehouse network to the NAS you look after for us. A VPN, I think it\'s called.' },
    { org: 'the school\'s second campus', ask: 'Link our campus network to yours so teachers reach the shared drive.' },
    { org: 'an architect working from home', ask: 'I need my home office joined to your network, encrypted.' },
    { org: 'a dental clinic', ask: 'Our branch office needs a tunnel to the main network you host.' },
  ] },
  { kind: 'gpu', minMin: 20, rate: 1.5, setupMin: 15, can: (s) => hasGpu(s) || s.economy.balance >= 3500, orgs: [
    { org: 'an AI startup', ask: 'We need an inference API on proper GPUs. Our cloud bill is eating us alive.' },
    { org: 'a cloud-gaming start-up', ask: 'Game streaming needs GPUs close to our players. Yours are.' },
    { org: 'an animation studio', ask: 'Render jobs, every night. GPUs, as many as you can spare.' },
    { org: 'a university lab', ask: 'Training runs for our research group. GPU time, with an API.' },
  ] },
  { kind: 'shield', minMin: 25, rate: 0.8, setupMin: 10, can: (s) => s.economy.balance >= 1500 || Object.values(s.devices).some((d) => d.kind === 'ddos_scrubber'), orgs: [
    { org: 'an online game shop', ask: 'Somebody floods our shop every sale. Host it behind your scrubber.' },
    { org: 'a ticket seller', ask: 'Big concert sale next week and we got knocked offline last time. We need DDoS protection.' },
    { org: 'an independent news site', ask: 'We publish something, we get flooded. Can you keep us up?' },
  ] },
];

const KIND_LABEL: Record<DealKind, string> = { web: 'Website', shop: 'Web shop (HTTPS)', files: 'File storage', gpu: 'GPU service', dns: 'DNS hosting', vpn: 'Site-to-site VPN', shield: 'Website behind DDoS protection' };
export const dealLabel = (k: DealKind) => KIND_LABEL[k];

/** What the client needs, in a line. */
export function dealNeed(c: Contract): string {
  switch (c.kind) {
    case 'web': return c.fqdn ? `A website answering as ${c.fqdn}.` : 'A website reachable from the internet.';
    case 'shop': return `A website answering as ${c.fqdn} over HTTPS (a TLS certificate on its server).`;
    case 'files': return `Cloud storage answering as ${c.fqdn}.`;
    case 'gpu': return `An AI/GPU service answering as ${c.fqdn}.`;
    case 'dns': return `Your own public DNS answering for ${c.domain} (hosting set to self).`;
    case 'vpn': return `A firewall VPN up to their office.`;
    case 'shield': return `A website as ${c.fqdn}, with its visitors coming through a DDoS scrubber.`;
  }
}

function terms(s: WorldState, kind: DealKind, rate: number, setupMin: number): Pick<Contract, 'upfront' | 'rate' | 'termS' | 'setupBy'> {
  const share = 0.25 + random() * 0.25;
  const fixed = random() < 0.6;
  const termS = fixed ? Math.round((8 + random() * 14) * 60) : null;
  const total = rate * (termS ?? 600);
  const upfront = Math.round(total * share / 5) * 5;
  const r = fixed ? (total - upfront) / termS! : rate;
  void kind;
  void s;
  // setupBy holds the time allowed until the deal is struck, then becomes a tick
  return { upfront, rate: Math.round(r * 1000) / 1000, termS, setupBy: Math.round(setupMin * MIN) };
}

function newContract(s: WorldState, client: string, org: string, kind: DealKind, pitch: string, rate: number, setupMin: number): Contract {
  const id = `deal_${s.nextId++}`;
  const domain = `${slug(org.replace(/^(the|a|an) /, ''))}.${random() < 0.5 ? 'net' : 'com'}`;
  const named = kind !== 'vpn';
  const c: Contract = {
    id, client, org, kind, pitch, ...terms(s, kind, rate * (0.8 + random() * 0.5), setupMin),
    state: 'setup', servedS: 0, downS: 0, paid: 0, status: 'Not set up yet.',
  };
  if (named) { c.domain = domain; c.fqdn = kind === 'dns' ? undefined : `${kind === 'files' ? 'files' : kind === 'gpu' ? 'api' : 'www'}.${domain}`; }
  return c;
}

/** The scripted first three: one website, then a name for it, then HTTPS. */
function tutorialOffer(s: WorldState, n: number): Visitor['offer'] {
  if (n === 0) {
    const c = newContract(s, 'Rosa Duarte', 'Rosa\'s Bakery', 'web', 'We need a little website: opening hours, a photo of the bread. Can you put it online?', 0.3, 15);
    delete c.fqdn; delete c.domain;
    c.termS = null; c.upfront = 60; c.rate = 0.25;
    const how = ACHIEVEMENTS.find((a) => a.id === 'hello_world')?.how;
    c.how = [...(typeof how === 'function' ? how(s) : how ?? []), 'The bakery pays as soon as visitors see the page, then by the second while it stays up.'];
    return c;
  }
  if (n === 1) {
    const c = newContract(s, 'Tom Berg', 'the Chess Club', 'web', 'Could you host our club page under our own name? We registered chessclub.net years ago.', 0.35, 15);
    c.domain = 'chessclub.net'; c.fqdn = 'www.chessclub.net';
    c.termS = 15 * 60; c.upfront = 80; c.rate = 0.3;
    c.how = [
      'They hand you their domain: it appears in the Internet tab under Domains.',
      'Add a record there: "www" → the public IP of a server with the Website role.',
      'Open that server and pick www.chessclub.net as its website\'s domain name.',
      'A second server for them is fine too; any website answering as www.chessclub.net counts.',
    ];
    return c;
  }
  const c = newContract(s, 'Mia Okoro', 'Green Leaf Florist', 'shop', 'We want to take orders online. Customers pay on the site, so it has to be HTTPS.', 0.5, 15);
  c.domain = 'greenleaf.net'; c.fqdn = 'www.greenleaf.net';
  c.termS = null; c.upfront = 150; c.rate = 0.45;
  c.how = [
    'Add a record for www.greenleaf.net pointing at a public IP, and give a website that name, like before.',
    'In that server\'s Hardware tab, tick TLS certificate. The site then answers on tcp/443.',
    'If a firewall stands in front, allow tcp/443 to it.',
  ];
  return c;
}

function generatedOffer(s: WorldState): Contract | null {
  const minutes = (s.meta.playTimeTicks ?? s.time.tick) / MIN;
  const open = TEMPLATES.filter((t) => minutes >= t.minMin && (!t.can || t.can(s)));
  // no more than two deals waiting to be set up at once
  if (Object.values(s.deals!.contracts).filter((c) => c.state === 'setup').length >= 2) return null;
  if (!open.length) return null;
  const t = pick(open);
  const o = pick(t.orgs);
  const client = `${pick(FIRST)} ${pick(LAST)}`;
  if (Object.values(s.deals!.contracts).some((c) => c.org === o.org && (c.state === 'setup' || c.state === 'live'))) return null;
  return newContract(s, client, o.org, t.kind, o.ask, t.rate, t.setupMin);
}

// ─── Is it working? ─────────────────────────────────────────────────────────

const working = (v: Service) => v.availability >= 0.9;

function bindable(s: WorldState, c: Contract, kind: Service['kind']): Service[] {
  return Object.values(s.services).filter((v) => v.kind === kind && (!v.contractId || v.contractId === c.id || !s.deals?.contracts[v.contractId] || ['done', 'failed', 'ended'].includes(s.deals.contracts[v.contractId]!.state)) && (!c.fqdn || v.fqdn === c.fqdn));
}

/** Check a contract against the network as it stands. */
export function checkContract(s: WorldState, cache: RuntimeCache, c: Contract): { ok: boolean; why: string; svc?: Service } {
  const svcKind: Service['kind'] = c.kind === 'files' ? 'cloud' : c.kind === 'gpu' ? 'ai' : c.kind === 'dns' ? 'dns' : 'web';
  if (c.kind === 'vpn') {
    const up = Object.values(cache.vpnUp ?? {}).some((v) => v.up && v.site === c.siteId);
    const site = c.siteId ? s.sites?.[c.siteId] : undefined;
    return up ? { ok: true, why: `Tunnel up to ${c.org}.` } : { ok: false, why: site ? `No tunnel to ${site.publicIp} yet. Their side: network ${site.net}, key "${site.key}".` : 'Their office is gone.' };
  }
  if (c.kind === 'dns') {
    const d = Object.values(s.domains).find((x) => x.name === c.domain);
    if (!d) return { ok: false, why: `You no longer manage ${c.domain}.` };
    if (d.hosting !== 'self') return { ok: false, why: `${c.domain} is still answered by the registrar. Switch it to your own DNS in the Internet tab.` };
    const dns = Object.values(s.services).filter((v) => v.kind === 'dns' && working(v));
    return dns.length ? { ok: true, why: `Your DNS answers for ${c.domain}.`, svc: dns[0] } : { ok: false, why: 'No public DNS server of yours is answering.' };
  }
  const cands = bindable(s, c, svcKind);
  if (!cands.length) return { ok: false, why: c.fqdn ? `No ${svcKind === 'cloud' ? 'cloud storage' : svcKind === 'ai' ? 'AI service' : 'website'} answers as ${c.fqdn} yet.` : 'No website of yours is up yet.' };
  const resolved = (v: Service) => !c.fqdn || !!cache.resolve[v.id]?.ip;
  const viaScrubber = (v: Service) => (v.flowIds ?? (v.flowId ? [v.flowId] : [])).some((f) => cache.paths[f]?.hops.some((h) => s.devices[h.deviceId]?.kind === 'ddos_scrubber'));
  const tls = (v: Service) => { const d = s.devices[v.serverId]; return d?.kind === 'server' && !!d.cert; };
  for (const v of cands) {
    if (!working(v)) continue;
    if (!resolved(v)) continue;
    if (c.kind === 'shop' && !tls(v)) continue;
    if (c.kind === 'shield' && !viaScrubber(v)) continue;
    return { ok: true, why: 'Working.', svc: v };
  }
  const v = cands[0]!;
  if (!working(v)) return { ok: false, why: `${s.devices[v.serverId]?.name ?? 'Its server'} isn't reachable from the internet right now.` };
  if (!resolved(v)) return { ok: false, why: `${c.fqdn} doesn't resolve: add a record for it in the Internet tab.` };
  if (c.kind === 'shop') return { ok: false, why: 'It works, but not over HTTPS: put a TLS certificate on its server.' };
  return { ok: false, why: 'Its visitors don\'t pass a DDoS scrubber yet.' };
}

// ─── Accept / decline ───────────────────────────────────────────────────────

export function receptionDesk(s: WorldState): Device | undefined {
  return Object.values(s.devices).find((d) => d.kind === 'desk' && d.reception);
}

/** The engineer close enough to the reception desk to talk to visitors. */
export function atReception(s: WorldState): string | null {
  const d = receptionDesk(s);
  if (!d) return null;
  const e = Object.values(s.staff.engineers).find((x) => cheb(x.x - 0.5, x.y - 0.5, d.gridPos.gx, d.gridPos.gy) <= COVER_RADIUS);
  return e?.name ?? null;
}

export function acceptVisitor(s: WorldState, id: string): string | null {
  const v = s.deals?.visitors[id];
  if (!v || v.state !== 'waiting') return 'They already left.';
  const who = atReception(s);
  if (!who) return 'Nobody is at reception to talk to them.';
  if (v.applicant) {
    hooks?.notify(`${v.applicant.name} starts today, at $${(v.applicant.salary * 60).toFixed(2)}/min.`, 'good');
    v.state = 'leaving';
    hire(s, v);
    delete s.deals!.visitors[id];
    s.deals!.served++;
    return null;
  }
  const c = v.offer!;
  c.setupBy += s.time.tick;
  if (c.domain && !Object.values(s.domains).some((d) => d.name === c.domain)) {
    const did = `dom_${s.nextId++}`;
    s.domains[did] = { id: did, name: c.domain, hosting: 'registrar', nsIp: '', records: [], client: c.id };
  }
  if (c.kind === 'vpn') {
    const sid = `site_${s.nextId++}`;
    const a = 18 + Math.floor(random() * 2), b = Math.floor(random() * 250) + 2, h = Math.floor(random() * 250) + 2;
    const net = `10.${50 + Math.floor(random() * 150)}.${Math.floor(random() * 250)}.0/24`;
    const key = pick(['chalk', 'walnut', 'harbour', 'copper', 'meadow', 'lantern', 'thistle', 'granite']) + Math.floor(random() * 90 + 10);
    (s.sites ??= {})[sid] = { id: sid, name: c.org.replace(/^(the|a|an) /, ''), publicIp: `198.${a}.${b}.${h}`, net, key };
    c.siteId = sid;
  }
  s.deals!.contracts[c.id] = c;
  s.deals!.served++;
  delete v.offer;
  v.state = 'leaving';
  hooks?.notify(`${who} shook hands with ${c.client}. Deal: ${dealLabel(c.kind)} for ${c.org}. It has to work within ${Math.round((c.setupBy - s.time.tick) / MIN)} minutes.`, 'good');
  leave(s, v);
  return null;
}

export function declineVisitor(s: WorldState, id: string): void {
  const v = s.deals?.visitors[id];
  if (!v || v.state !== 'waiting') return;
  v.state = 'leaving';
  s.deals!.served++;
  delete v.offer;
  leave(s, v);
}

export function skipTutorial(s: WorldState): void {
  if (!s.deals) return;
  s.deals.tutorial = 3;
  for (const c of Object.values(s.deals.contracts)) delete c.how;
}

/** Someone asking for a job: cheap and green, or strong and pricey. */
function applicantOffer(): Applicant {
  const traits: Trait[] = ['fastHands', 'scripter', 'sharpEyes', 'quickFeet', 'tidy'];
  const name = `${pick(FIRST)} ${pick(LAST)}`;
  if (random() < 0.5) return { name, traits: [], salary: Math.round(ENGINEER_SALARY * (0.55 + random() * 0.1) * 1000) / 1000, pitch: 'Fresh out of school and keen to learn. Asks for little.' };
  const a = traits.splice(Math.floor(random() * traits.length), 1)[0]!, b = pick(traits);
  return { name, traits: [a, b], salary: Math.round(ENGINEER_SALARY * (1.7 + random() * 0.5) * 1000) / 1000, pitch: 'Ten years in data centres. Knows their stuff, and knows what it is worth.' };
}

function hire(s: WorldState, v: Visitor): void {
  const a = v.applicant!;
  const id = `eng_${s.nextId++}`;
  s.staff.engineers[id] = { id, name: a.name.split(' ')[0]!, x: v.x, y: v.y, path: [], state: 'idle', deskId: null, jobId: null, idleUntil: 0, chaseId: null, traits: a.traits as Trait[], salary: a.salary };
}

// ─── People ─────────────────────────────────────────────────────────────────

function leave(s: WorldState, v: Visitor): void {
  v.state = 'leaving';
  if (!routeTo(s, v, 'trespasser', edgeSpawns(s.floor))) delete s.deals!.visitors[v.id];
}

function spawnVisitor(s: WorldState): void {
  const d = s.deals!;
  const desk = receptionDesk(s);
  if (!desk) return;
  let offer: Contract | undefined;
  let applicant: Applicant | undefined;
  if (d.tutorial < 3) {
    // the next scripted visitor waits for the previous one's site to work
    const prev = Object.values(d.contracts).filter((c) => c.how);
    if (prev.some((c) => c.state === 'setup')) return;
    offer = tutorialOffer(s, d.tutorial)!;
    d.tutorial++;
  } else {
    const minutes = (s.meta.playTimeTicks ?? s.time.tick) / MIN;
    if (minutes > 5 && random() < 0.25) applicant = applicantOffer();
    else offer = generatedOffer(s) ?? undefined;
    if (!offer && !applicant) return;
  }
  const spawns = edgeSpawns(s.floor).filter((p) => Math.abs(p.gy - desk.gridPos.gy) < 40);
  if (!spawns.length) return;
  const start = pick(spawns);
  const name = offer?.client ?? applicant!.name;
  const v: Visitor = { id: `vis_${s.nextId++}`, name, x: start.gx + 0.5, y: start.gy + 0.5, path: [], state: 'arriving', offer, applicant, leaveAt: 0 };
  const spots = workSpots(s.floor, env(s), 'trespasser', desk.gridPos);
  if (!routeTo(s, v, 'trespasser', spots)) return;
  d.visitors[v.id] = v;
  hooks?.notify(applicant ? `${name} came in asking about a job. They're heading to reception.` : `${name} from ${offer!.org} walked in and is heading to reception.`, 'info');
}

/** Someone covers the reception desk while a visitor is in; back to their own desk after. */
function coverReception(s: WorldState): void {
  const desk = receptionDesk(s);
  if (!desk || desk.kind !== 'desk') return;
  const anyone = Object.values(s.deals!.visitors).some((v) => v.state !== 'leaving');
  const engineers = Object.values(s.staff.engineers);
  if (anyone) {
    if (desk.ownerId && s.staff.engineers[desk.ownerId]) return;    // someone sits there anyway
    if (engineers.some((e) => cheb(e.x - 0.5, e.y - 0.5, desk.gridPos.gx, desk.gridPos.gy) <= COVER_RADIUS)) return;
    const free = engineers.filter((e) => !e.jobId && e.state !== 'chasing')
      .sort((a, b) => cheb(a.x, a.y, desk.gridPos.gx, desk.gridPos.gy) - cheb(b.x, b.y, desk.gridPos.gx, desk.gridPos.gy))[0];
    if (!free) return;
    free.homeDeskId = free.deskId;
    free.deskId = desk.id;
    desk.ownerId = free.id;
    goHome(s, free);
    return;
  }
  for (const e of engineers) {
    if (e.homeDeskId === undefined || e.deskId !== desk.id || e.jobId) continue;
    desk.ownerId = null;
    e.deskId = e.homeDeskId && s.devices[e.homeDeskId] ? e.homeDeskId : null;
    e.homeDeskId = undefined;
    goHome(s, e);
  }
}

function tickVisitor(s: WorldState, v: Visitor): void {
  if (v.state === 'arriving') {
    if (step(v, WALK_SPEED * 0.8)) { v.state = 'waiting'; v.leaveAt = s.time.tick + PATIENCE_S * TICKS_PER_SEC; }
    return;
  }
  if (v.state === 'waiting') {
    if (s.time.tick >= v.leaveAt) {
      hooks?.notify(`${v.name} waited at reception and nobody talked to them. They left.`, 'warn');
      s.deals!.served++;
      leave(s, v);
    }
    return;
  }
  if (step(v, WALK_SPEED)) delete s.deals!.visitors[v.id];
}

// ─── Money and endings ──────────────────────────────────────────────────────

function close(s: WorldState, c: Contract, state: Contract['state'], why: string): void {
  c.state = state;
  c.endedAt = s.time.tick;
  c.endWhy = why;
  if (c.serviceId && s.services[c.serviceId]?.contractId === c.id) delete s.services[c.serviceId]!.contractId;
  for (const [id, d] of Object.entries(s.domains)) if (d.client === c.id) delete s.domains[id];
  if (c.siteId && s.sites) delete s.sites[c.siteId];
}

function tickContract(s: WorldState, cache: RuntimeCache, c: Contract): void {
  const r = checkContract(s, cache, c);
  c.status = r.why;
  if (c.state === 'setup') {
    if (r.ok) {
      c.state = 'live';
      c.liveAt = s.time.tick;
      c.paid += c.upfront;
      s.economy.balance += c.upfront;
      s.economy.totalEarned += c.upfront;
      if (r.svc) { r.svc.contractId = c.id; c.serviceId = r.svc.id; }
      hooks?.notify(`${c.org}: it works! They paid $${c.upfront} up front${c.termS ? `, and $${(c.rate * 60).toFixed(2)}/min for the next ${Math.round(c.termS / 60)} minutes of service` : `, and $${(c.rate * 60).toFixed(2)}/min from now on`}.`, 'good');
      return;
    }
    if (s.time.tick >= c.setupBy) {
      close(s, c, 'failed', 'Not working in time. They went elsewhere.');
      hooks?.notify(`${c.org} gave up waiting: ${r.why} The deal is off.`, 'warn');
    }
    return;
  }
  if (c.state !== 'live') return;
  if (r.svc && r.svc.id !== c.serviceId) {
    if (c.serviceId && s.services[c.serviceId]?.contractId === c.id) delete s.services[c.serviceId]!.contractId;
    r.svc.contractId = c.id; c.serviceId = r.svc.id;
  }
  if (r.ok) {
    c.downS = 0;
    c.servedS++;
    c.paid += c.rate;
    s.economy.balance += c.rate;
    s.economy.totalEarned += c.rate;
    if (c.termS !== null && c.servedS >= c.termS) {
      close(s, c, 'done', 'Term served in full.');
      hooks?.notify(`${c.org}: contract complete, $${Math.round(c.paid)} in all. ${c.client} says thanks.`, 'good');
      return;
    }
    // ongoing clients move on now and then
    if (c.termS === null && c.servedS > 600 && random() < 1 / (45 * 60)) {
      close(s, c, 'ended', pick(['They moved it in-house.', 'They were bought by a bigger company.', 'The project wound down.', 'They\'re closing the business.']));
      hooks?.notify(`${c.org} is ending the deal: ${c.endWhy} $${Math.round(c.paid)} earned from them.`, 'info');
    }
  } else if (++c.downS >= OUTAGE_LIMIT_S) {
    close(s, c, 'ended', `Down for ${Math.round(OUTAGE_LIMIT_S / 60)} minutes straight.`);
    hooks?.notify(`${c.org} cancelled: their service was down too long (${r.why})`, 'alert');
  } else if (c.downS === 20) {
    hooks?.notify(`${c.org}'s service is down: ${r.why}`, 'warn');
  }
}

/** Called every tick by the engine. */
export function dealsTick(s: WorldState, cache: RuntimeCache): void {
  const d = (s.deals ??= freshDeals());
  for (const v of Object.values(d.visitors)) tickVisitor(s, v);
  if (s.time.tick % 10 === 4) coverReception(s);
  if (s.time.tick % TICKS_PER_SEC === 7) for (const c of Object.values(d.contracts)) tickContract(s, cache, c);
  // forget old finished deals
  if (s.time.tick % (60 * TICKS_PER_SEC) === 0) {
    const old = Object.values(d.contracts).filter((c) => c.endedAt !== undefined).sort((a, b) => b.endedAt! - a.endedAt!).slice(8);
    for (const c of old) delete d.contracts[c.id];
  }
  if (s.time.tick < d.nextVisit || Object.keys(d.visitors).length) return;
  spawnVisitor(s);
  // visitors come every 2–5 minutes; the scripted ones a little sooner
  d.nextVisit = s.time.tick + Math.round((d.tutorial < 3 ? 45 : 120 + random() * 180) * TICKS_PER_SEC);
}
