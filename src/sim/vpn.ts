// Site-to-site VPNs: which tunnels are up, and why not.
//
// A tunnel comes up when the firewall's IKE (udp/500) reaches the peer address,
// and the other end agrees: your own firewall in another building needs the
// mirror-image VPN (peer = this firewall's public address, networks swapped,
// same key); a customer's office just needs the right key and network.

import { formatCidr, parseCidr } from '../state/ip';
import type { RuntimeCache, WorldState } from '../state/types';
import { buildCtx, resolveFromL3 } from './net';
import { parseIp } from '../state/ip';

const sameNet = (a: string, b: string) => { const x = parseCidr(a), y = parseCidr(b); return !!x && !!y && formatCidr(x) === formatCidr(y); };

export function refreshVpns(s: WorldState, cache: RuntimeCache): void {
  cache.vpnUp = {};
  const ctx = buildCtx(s, cache);
  const out: NonNullable<RuntimeCache['vpnUp']> = {};
  for (const fw of Object.values(s.devices)) {
    if (fw.kind !== 'firewall') continue;
    for (const v of fw.vpns ?? []) {
      const key = `${fw.id}:${v.id}`;
      if (!v.enabled) { out[key] = { up: false, why: 'Switched off.' }; continue; }
      const peer = parseIp(v.peer);
      if (peer === null || !parseCidr(v.local) || !parseCidr(v.remote)) { out[key] = { up: false, why: 'Fill in the peer address and both networks (like 10.20.0.0/24).' }; continue; }
      if (!v.key.trim()) { out[key] = { up: false, why: 'Set a shared key; both ends must use the same one.' }; continue; }
      if (fw.health.state === 'failed' || fw.compromised) { out[key] = { up: false, why: `${fw.name} is down.` }; continue; }
      const p = resolveFromL3(ctx, fw, peer, 'udp', 500);
      if (p.blocked) { out[key] = { up: false, why: `IKE can't reach ${v.peer}: ${p.explain}` }; continue; }
      const at = p.reachedServer ? s.devices[p.reachedServer] : undefined;
      const site = Object.values(s.sites ?? {}).find((x) => x.publicIp === v.peer.trim());
      if (at?.kind === 'firewall') {
        // your own firewall answered: it needs the same tunnel the other way round
        const mine = p.srcSeen;
        const back = (at.vpns ?? []).find((x) => x.enabled && parseIp(x.peer) === mine);
        if (!back) { out[key] = { up: false, why: `${at.name} has no VPN back to this firewall's public address.` }; continue; }
        if (back.key !== v.key) { out[key] = { up: false, why: `The shared key differs from ${at.name}'s.` }; continue; }
        if (!sameNet(back.local, v.remote) || !sameNet(back.remote, v.local)) { out[key] = { up: false, why: `Networks don't match: ${at.name} offers ${back.local} and expects ${back.remote}.` }; continue; }
        out[key] = { up: true, why: `Tunnel up to ${at.name}.`, peerFw: at.id };
      } else if (at?.kind === 'uplink' && site) {
        if (v.key !== site.key) { out[key] = { up: false, why: `${site.name} rejects the key.` }; continue; }
        if (!sameNet(v.remote, site.net)) { out[key] = { up: false, why: `${site.name}'s network is ${site.net}, not ${v.remote}.` }; continue; }
        out[key] = { up: true, why: `Tunnel up to ${site.name}.`, site: site.id };
      } else {
        out[key] = { up: false, why: `Nothing answers IKE at ${v.peer}.` };
      }
    }
  }
  cache.vpnUp = out;
}
