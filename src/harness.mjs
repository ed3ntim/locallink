// Verdrahtet zwei Verbindungen ueber eine simulierte Strecke.
// Wird von den Tests und von den Messlaeufen benutzt.

import { Connection } from './connection.mjs';
import { Sim, Link, PROFILES } from './sim.mjs';

/**
 * @param {object} o
 * @param {string} o.profile   Schluessel aus PROFILES
 * @param {number} [o.seed]
 * @param {number} [o.tickUs]  Sendetakt beider Seiten
 * @param {number} [o.skewUs]  Uhrenversatz von B gegenueber A
 * @param {Array}  [o.channels]
 */
export function pair(o) {
  const profile = PROFILES[o.profile];
  if (!profile) throw new Error(`Unbekanntes Profil ${o.profile}`);

  const sim = new Sim(o.seed ?? 1);
  const skewUs = o.skewUs ?? 0;
  const tickUs = o.tickUs ?? Math.round(1_000_000 / profile.ratePps);

  const received = { a: [], b: [] };

  // B rechnet mit einer eigenen, verschobenen Uhr - so wie zwei echte Geraete,
  // deren Systemuhren nie exakt gleich stehen.
  const clockA = () => sim.nowUs;
  const clockB = () => sim.nowUs + skewUs;

  let a;
  let b;

  const linkAB = new Link(sim, profile, (bytes) => b.onPacket(bytes, clockB()));
  const linkBA = new Link(sim, profile, (bytes) => a.onPacket(bytes, clockA()));

  // A eroeffnet die Sitzung und gibt damit die gemeinsame Zeit vor.
  a = new Connection({
    name: 'A',
    mtu: profile.mtu,
    channels: o.channels,
    minSendIntervalUs: o.paceUs ?? 0,
    timeMaster: true,
    send: (bytes) => linkAB.send(bytes),
    onMessage: (ch, payload) => received.a.push({ ch, payload, atUs: clockA() }),
  });

  b = new Connection({
    name: 'B',
    mtu: profile.mtu,
    channels: o.channels,
    minSendIntervalUs: o.paceUs ?? 0,
    send: (bytes) => linkBA.send(bytes),
    onMessage: (ch, payload) => received.b.push({ ch, payload, atUs: clockB() }),
  });

  // Sendetakt und Lebenszeichen sind zweierlei. Der Takt raeumt aus, was
  // ansteht - liegt nichts an, geht auch nichts hinaus. Das Lebenszeichen
  // laeuft viel langsamer und traegt Bestaetigungen und Uhrenabgleich mit,
  // damit eine stille Verbindung nicht blind wird. Wer beides vermengt und
  // mit voller Transportrate Leerpakete schickt, misst hinterher seinen
  // eigenen Herzschlag statt des Spiels.
  const heartbeatUs = o.heartbeatUs ?? 100_000;

  const tick = () => {
    a.update(clockA(), false);
    b.update(clockB(), false);
    sim.after(tickUs, tick);
  };
  sim.after(tickUs, tick);

  const beat = () => {
    a.update(clockA(), true);
    b.update(clockB(), true);
    sim.after(heartbeatUs, beat);
  };
  sim.after(heartbeatUs, beat);

  return {
    sim,
    a,
    b,
    linkAB,
    linkBA,
    received,
    clockA,
    clockB,
    profile,
    tickUs,
    run(durationUs) {
      sim.runUntil(sim.nowUs + durationUs);
    },
  };
}

export function text(s) {
  return new TextEncoder().encode(s);
}

export function readText(bytes) {
  return new TextDecoder().decode(bytes);
}

export { Connection, PROFILES };
