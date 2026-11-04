# NetSim

A learning-by-doing network engineering game for apprentices. Build a server room, cable it,
configure every IP, route, NAT rule and firewall ACL by hand, and keep services alive through
hardware wear, heat, DDoS attacks and trespassers.

**Play:** open `docs/index.html` in a browser, or the GitHub Pages site for this repository.

## Features
- Packet-level path engine: ARP, switching (flooding / MAC learning), static and OSPF routing,
  ASA-style firewall with zones, static NAT and ACLs, DDoS scrubber, STP and broadcast storms
- Servers with roles (web, cloud, AI frontend / orchestrator / GPU, NAS, SAN, auth, DNS, proxies,
  update mirror, monitoring master), agents (backup, failover, monitoring) and TLS certificates
- Realistic hardware: 1U/2U/4U chassis, power budget, RAID 0/1/6/10, per-part wear and failures,
  watt-based temperatures, fan curves, throttling and thermal shutdown
- Building floor with rooms, climate, vents and AC; engineers, desks, smart doors and trespassers
- ISP mode: cell sites and home networks; domains and DNS

## Build
```bash
npm install
node build.mjs        # writes dist/netsim.html and docs/index.html (self-contained, Pixi inlined)
```
