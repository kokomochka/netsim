// Reception: the visitor at the desk, and the deals you have running.

import { TICKS_PER_SEC, TRAITS } from '../balance';
import { acceptVisitor, atReception, dealLabel, dealNeed, declineVisitor, receptionDesk, skipTutorial } from '../sim/deals';
import { toast, world } from '../state/world';
import type { Contract, WorldState } from '../state/types';
import { baseStyle } from './styles';

const money = (n: number) => `$${n >= 100 || Math.abs(n - Math.round(n)) < 0.005 ? Math.round(n).toLocaleString() : n.toFixed(2)}`;
const perMin = (r: number) => `${money(r * 60)}/min`;
const mins = (ticks: number) => `${Math.max(0, Math.ceil(ticks / (60 * TICKS_PER_SEC)))} min`;

function mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** The terms of a deal, as a client puts them. */
export function termsOf(c: Contract, pending: boolean): string {
  const pay = c.termS ? `${money(c.upfront)} when it first works, then ${perMin(c.rate)} while it works, for ${Math.round(c.termS / 60)} minutes of service` : `${money(c.upfront)} when it first works, then ${perMin(c.rate)} for as long as they stay`;
  const setup = pending ? `${Math.round(c.setupBy / (60 * TICKS_PER_SEC))} minutes to set it up` : '';
  return [pay, setup].filter(Boolean).join(' · ');
}

const CARD_CSS = `
  :host { position: absolute; z-index: 16; left: 50%; bottom: 16px; transform: translateX(-50%); width: min(460px, calc(100% - 24px)); display: none; }
  :host([open]) { display: block; }
  .card { background: var(--paper); border-radius: var(--radius); box-shadow: var(--shadow-lg); padding: 14px 16px; display: grid; gap: 8px; border-top: 4px solid var(--accent); }
  .who { display: flex; gap: 10px; align-items: baseline; justify-content: space-between; }
  .who b { font-size: 15px; }
  .who span { font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-faint); }
  .ask { margin: 0; font-size: 14px; line-height: 1.5; font-style: italic; }
  .need, .terms, .note { margin: 0; font-size: 12.5px; line-height: 1.45; color: var(--ink-dim); }
  .terms { color: var(--ink); }
  .note.bad { color: var(--bad, #c0392b); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row .grow { flex: 1; }
  .yes { background: var(--accent); border-color: var(--accent); color: #fff; }
  .yes:hover { background: var(--accent-strong); color: #fff; }
  .yes:disabled { opacity: .5; }
  .skip { border: 0; background: transparent; color: var(--ink-faint); font-size: 12px; text-decoration: underline; padding: 0 4px; min-height: 0; }
  .tag { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: var(--well); color: var(--ink-dim); }
`;

export class NsReception extends HTMLElement {
  private shadow = this.attachShadow({ mode: 'open' });
  private box!: HTMLElement;
  private last = '';
  connectedCallback(): void {
    this.shadow.appendChild(baseStyle());
    const st = document.createElement('style');
    st.textContent = CARD_CSS;
    this.shadow.appendChild(st);
    this.box = document.createElement('div');
    this.shadow.appendChild(this.box);
    world.subscribe((_s, r) => { if (r !== 'camera') this.render(); });
    this.render();
  }

  private render(): void {
    const s = world.get();
    const v = Object.values(s.deals?.visitors ?? {}).find((x) => x.state === 'waiting');
    const who = v ? atReception(s) : null;
    const covering = v && !who ? Object.values(s.staff.engineers).find((e) => e.deskId === receptionDesk(s)?.id) : undefined;
    const key = v ? `${v.id}|${who}|${covering?.name}|${Math.floor((v.leaveAt - s.time.tick) / (10 * TICKS_PER_SEC))}|${s.deals?.tutorial}` : '';
    if (key === this.last) return;
    this.last = key;
    this.toggleAttribute('open', !!v);
    this.box.innerHTML = '';
    if (!v) return;
    const card = mk('div', 'card');
    const head = mk('div', 'who');
    const org = v.offer ? v.offer.org : 'looking for work';
    head.appendChild(mk('b', '', `${v.name} · ${org}`));
    head.appendChild(mk('span', '', v.offer ? dealLabel(v.offer.kind) : 'Job seeker'));
    card.appendChild(head);
    if (v.offer) {
      const c = v.offer;
      card.appendChild(mk('p', 'ask', `“${c.pitch}”`));
      card.appendChild(mk('p', 'need', dealNeed(c)));
      card.appendChild(mk('p', 'terms', termsOf(c, true)));
      if (c.kind === 'vpn') card.appendChild(mk('p', 'need', 'Their network and key come with the deal; you set up the VPN on one of your firewalls.'));
    } else if (v.applicant) {
      const a = v.applicant;
      card.appendChild(mk('p', 'ask', `“${a.pitch}”`));
      const tr = a.traits.map((t) => `${TRAITS[t]?.label}: ${TRAITS[t]?.blurb}`).join('; ');
      card.appendChild(mk('p', 'need', tr || 'No particular strengths yet.'));
      card.appendChild(mk('p', 'terms', `Wants ${perMin(a.salary)}. No hiring fee.`));
    }
    const left = v.leaveAt - s.time.tick;
    card.appendChild(mk('p', `note ${who ? '' : 'bad'}`, who
      ? `${who} is at reception. They'll wait about ${mins(left)} more.`
      : covering ? `${covering.name} is on the way to reception…` : 'Nobody is at reception to talk to them. Free up an engineer.'));
    const row = mk('div', 'row');
    const yes = mk('button', 'yes', v.offer ? 'Take the job' : 'Hire');
    yes.disabled = !who;
    yes.addEventListener('click', () => {
      let err: string | null = null;
      world.update((w) => { err = acceptVisitor(w, v.id); }, 'sim');
      if (err) toast(err, 'error');
    });
    const no = mk('button', '', 'No, thanks');
    no.disabled = !who;
    no.addEventListener('click', () => world.update((w) => declineVisitor(w, v.id), 'sim'));
    row.append(yes, no, mk('span', 'grow'));
    if (v.offer?.how && (s.deals?.tutorial ?? 3) <= 3) {
      const sk = mk('button', 'skip', 'Skip tutorial');
      sk.addEventListener('click', () => world.update((w) => { skipTutorial(w); const x = w.deals?.visitors[v.id]; if (x?.offer) delete x.offer.how; }, 'sim'));
      row.appendChild(sk);
    }
    card.appendChild(row);
    this.box.appendChild(card);
  }
}
customElements.define('ns-reception', NsReception);

/** The Deals tab: what each client wants, whether it works, what they paid. */
export function renderDeals(body: HTMLElement, s: WorldState): void {
  const list = Object.values(s.deals?.contracts ?? {});
  const order: Record<Contract['state'], number> = { setup: 0, live: 1, done: 2, ended: 3, failed: 4 };
  list.sort((a, b) => order[a.state] - order[b.state] || (b.endedAt ?? 0) - (a.endedAt ?? 0));
  const live = list.filter((c) => c.state === 'live');
  const intro = mk('p', 'intro', list.length
    ? !live.length ? 'Nobody is paying yet: each deal starts paying once its service works.' : `${live.length} client${live.length === 1 ? '' : 's'} paying ${perMin(live.reduce((a, c) => a + c.rate, 0))} while their services work.`
    : receptionDesk(s) ? 'No deals yet. Clients walk in to reception now and then; an engineer has to be there to talk to them.' : 'You need a reception desk for clients to come in.');
  body.appendChild(intro);
  for (const c of list) {
    const a = mk('div', `a ${c.state === 'live' ? 'done' : c.state === 'setup' ? '' : 'locked'}`);
    const t = mk('div', 't');
    t.appendChild(mk('b', '', `${c.org}`));
    const tag = c.state === 'setup' ? `set up · ${mins(c.setupBy - s.time.tick)} left` : c.state === 'live' ? (c.termS ? `${Math.round((c.termS - c.servedS) / 60)} min to go` : 'ongoing') : c.state;
    t.appendChild(mk('span', '', tag));
    a.appendChild(t);
    a.appendChild(mk('p', '', `${dealLabel(c.kind)} for ${c.client}. ${dealNeed(c)}`));
    if (c.state === 'setup' || c.state === 'live') {
      a.appendChild(mk('p', c.status === 'Working.' || c.status.startsWith('Tunnel up') || c.status.startsWith('Your DNS') ? 'rw' : '', c.status));
      a.appendChild(mk('p', '', c.state === 'setup' ? termsOf({ ...c, setupBy: 0 }, false) : `Paid so far ${money(c.paid)}. ${perMin(c.rate)} while it works.`));
    } else {
      a.appendChild(mk('p', '', `${c.endWhy ?? ''} Paid ${money(c.paid)} in all.`));
    }
    if (c.how && c.state === 'setup') {
      const ol = mk('ol');
      for (const h of c.how) ol.appendChild(mk('li', '', h));
      a.appendChild(ol);
    }
    body.appendChild(a);
  }
}
