// Messlauf. Beantwortet die Frage, die ueber dem Projekt steht:
// Traegt diese Verbindungsschicht auch ein reaktionsintensives Spiel,
// oder nur rundenbasierte Zuege?
//
// Gemessen wird nicht Bandbreite - die ist bei Spielen fast nie das Problem -
// sondern das Alter der Information: Wie alt ist der neueste Zustand, den ein
// Geraet gerade auf dem Bildschirm hat? Das ist der Wert, den Spielende
// tatsaechlich als Traegheit spueren.

import { pair, text } from '../src/harness.mjs';
import { PROFILES } from '../src/sim.mjs';
import { SEQUENCED, RELIABLE_ORDERED } from '../src/channel.mjs';

const CH_STATE = 3;
const CH_EVENTS = 2;

function pct(sorted, p) {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function ms(us) {
  return (us / 1000).toFixed(1);
}

function pad(s, n, right = false) {
  s = String(s);
  return right ? s.padStart(n) : s.padEnd(n);
}

// Ein Zustandspaket, wie es ein Actionspiel schicken wuerde: laufende Nummer,
// Sendezeit und ein bisschen Nutzlast fuer Position, Winkel, Eingaben.
function snapshot(seq, timeUs) {
  const b = new Uint8Array(24);
  const v = new DataView(b.buffer);
  v.setUint32(0, seq);
  v.setUint32(4, timeUs >>> 0);
  return b;
}

function readSnapshot(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { seq: v.getUint32(0), timeUs: v.getUint32(4) };
}

// ------------------------------------------------- Szenario 1: Echtzeitspiel

/**
 * Beide Seiten senden Zustaende mit der Zielrate. Die Verbindung ist auf die
 * Paketrate des Transports gebremst; ueberzaehlige Schnappschuesse fallen weg,
 * statt sich aufzustauen.
 */
function realtime(profileKey, targetHz, seconds = 20) {
  const profile = PROFILES[profileKey];
  const appTickUs = Math.round(1_000_000 / targetHz);
  const paceUs = Math.round(1_000_000 / profile.ratePps);

  const h = pair({
    profile: profileKey,
    seed: 42,
    tickUs: appTickUs,
    paceUs,
    channels: [{ id: CH_STATE, mode: SEQUENCED, coalesce: true }],
  });

  const latencies = [];
  let deliveredToB = 0;

  // Zustellungen von A nach B mit echter Laufzeit vergleichen.
  const origPush = h.received.b.push.bind(h.received.b);
  h.received.b.push = (m) => {
    if (m.ch === CH_STATE) {
      const s = readSnapshot(m.payload);
      latencies.push(h.sim.nowUs - s.timeUs);
      deliveredToB++;
      lastArrivalUs = h.sim.nowUs;
      lastStateTimeUs = s.timeUs;
    }
    return origPush(m);
  };

  let seq = 0;
  let produced = 0;
  const produce = () => {
    h.a.queue(CH_STATE, snapshot(seq++, h.sim.nowUs));
    h.b.queue(CH_STATE, snapshot(seq++, h.sim.nowUs));
    produced++;
    h.sim.after(appTickUs, produce);
  };
  h.sim.after(appTickUs, produce);

  // Alter der Information: alle 5 ms nachsehen, wie alt der neueste bei B
  // angekommene Zustand gerade ist.
  let lastArrivalUs = null;
  let lastStateTimeUs = null;
  const ages = [];
  const sample = () => {
    if (lastStateTimeUs !== null) ages.push(h.sim.nowUs - lastStateTimeUs);
    h.sim.after(5_000, sample);
  };
  h.sim.after(1_000_000, sample); // erste Sekunde ist Einschwingen

  h.run(seconds * 1_000_000);

  latencies.sort((a, b) => a - b);
  ages.sort((a, b) => a - b);

  return {
    profile: profile.label,
    targetHz,
    effectiveHz: +(deliveredToB / seconds).toFixed(1),
    latP50: pct(latencies, 50),
    latP95: pct(latencies, 95),
    ageP50: pct(ages, 50),
    ageP95: pct(ages, 95),
    kbPerSec: +((h.a.stats.bytesSent / seconds) / 1024).toFixed(1),
    quality: h.a.quality(),
  };
}

// ------------------------------------------------ Szenario 2: Salvo, Zug fuer Zug

/** Schuss raus, Ergebnis zurueck. Das ist die einzige Latenz, die Salvo spuert. */
function turnBased(profileKey, shots = 60) {
  const profile = PROFILES[profileKey];
  const paceUs = Math.round(1_000_000 / profile.ratePps);

  const h = pair({
    profile: profileKey,
    seed: 77,
    tickUs: paceUs,
    paceUs,
    channels: [{ id: CH_EVENTS, mode: RELIABLE_ORDERED }],
  });

  const rtts = [];
  let outstandingAtUs = null;
  let done = 0;
  let bytesAtFinish = null;
  let finishedAtUs = null;

  h.b.onMessage = (ch, payload) => {
    if (ch !== CH_EVENTS) return;
    // Gegenseite antwortet sofort mit dem Ergebnis.
    h.b.queue(CH_EVENTS, text('treffer'));
  };

  h.a.onMessage = (ch) => {
    if (ch !== CH_EVENTS || outstandingAtUs === null) return;
    rtts.push(h.sim.nowUs - outstandingAtUs);
    outstandingAtUs = null;
    done++;
    if (done < shots) {
      fire();
    } else {
      // Ab hier laeuft nur noch das Lebenszeichen - was danach an Bytes
      // dazukommt, gehoert nicht zur Partie.
      bytesAtFinish = h.a.stats.bytesSent + h.b.stats.bytesSent;
      finishedAtUs = h.sim.nowUs;
    }
  };

  const fire = () => {
    outstandingAtUs = h.sim.nowUs;
    h.a.queue(CH_EVENTS, text('feuer b4'));
  };
  h.sim.after(paceUs, fire);

  h.run(120_000_000);
  rtts.sort((a, b) => a - b);

  return {
    profile: profile.label,
    shots: done,
    rttP50: pct(rtts, 50),
    rttP95: pct(rtts, 95),
    rttMax: rtts[rtts.length - 1],
    bytesTotal: bytesAtFinish ?? h.a.stats.bytesSent + h.b.stats.bytesSent,
    durationUs: finishedAtUs,
    retransmits: h.a.stats.retransmits + h.b.stats.retransmits,
  };
}

function verdict(ageP95Us) {
  const m = ageP95Us / 1000;
  if (m < 50) return 'schnelle Action';
  if (m < 100) return 'Action, Reaktion';
  if (m < 180) return 'Party, Puzzle mit Zeitdruck';
  return 'nur rundenbasiert';
}

// ------------------------------------------------------------------ Ausgabe

const order = ['ble-default', 'ble-fast', 'wifi-lan', 'wifi-direct', 'hostile'];

console.log('\nSZENARIO 1  Echtzeitspiel, beide Seiten senden Zustaende');
console.log('            Alter = wie alt der neueste angekommene Zustand ist\n');
console.log(
  '  ' + pad('Transport', 24) + pad('Ziel', 7, true) + pad('Ist', 8, true) +
  pad('Alter p50', 12, true) + pad('Alter p95', 12, true) + pad('kB/s', 8, true) +
  '   Reicht fuer'
);
console.log('  ' + '-'.repeat(96));

for (const key of order) {
  const targetHz = key.startsWith('ble') || key === 'hostile' ? 30 : 60;
  const r = realtime(key, targetHz);
  console.log(
    '  ' + pad(r.profile, 24) +
    pad(`${r.targetHz} Hz`, 7, true) +
    pad(`${r.effectiveHz} Hz`, 8, true) +
    pad(`${ms(r.ageP50)} ms`, 12, true) +
    pad(`${ms(r.ageP95)} ms`, 12, true) +
    pad(r.kbPerSec, 8, true) +
    '   ' + verdict(r.ageP95)
  );
}

console.log('\n\nSZENARIO 2  Salvo: Schuss raus, Ergebnis zurueck (60 Schuesse)\n');
console.log(
  '  ' + pad('Transport', 24) + pad('RTT p50', 11, true) + pad('RTT p95', 11, true) +
  pad('RTT max', 11, true) + pad('Partie gesamt', 15, true) + pad('Dauer', 10, true) +
  pad('Wiederhol.', 12, true)
);
console.log('  ' + '-'.repeat(96));

for (const key of order) {
  const r = turnBased(key);
  console.log(
    '  ' + pad(r.profile, 24) +
    pad(`${ms(r.rttP50)} ms`, 11, true) +
    pad(`${ms(r.rttP95)} ms`, 11, true) +
    pad(`${ms(r.rttMax)} ms`, 11, true) +
    pad(`${(r.bytesTotal / 1024).toFixed(1)} kB`, 15, true) +
    pad(`${(r.durationUs / 1e6).toFixed(1)} s`, 10, true) +
    pad(r.retransmits, 12, true)
  );
}

// ------------------------------------- Gegenprobe: was ohne Sendetaktung passiert

console.log('\n\nGEGENPROBE  60 Hz in einen BLE-Transport, der 25 Pakete/s durchlaesst\n');

function unpaced() {
  const h = pair({
    profile: 'ble-default',
    seed: 42,
    tickUs: 16_667,
    paceUs: 0, // keine Bremse
    channels: [{ id: CH_STATE, mode: SEQUENCED, coalesce: true }],
  });
  const ages = [];
  let lastStateTimeUs = null;
  const orig = h.received.b.push.bind(h.received.b);
  h.received.b.push = (m) => {
    if (m.ch === CH_STATE) lastStateTimeUs = readSnapshot(m.payload).timeUs;
    return orig(m);
  };
  let seq = 0;
  const produce = () => {
    h.a.queue(CH_STATE, snapshot(seq++, h.sim.nowUs));
    h.sim.after(16_667, produce);
  };
  h.sim.after(16_667, produce);
  const sample = () => {
    if (lastStateTimeUs !== null) ages.push(h.sim.nowUs - lastStateTimeUs);
    h.sim.after(5_000, sample);
  };
  h.sim.after(1_000_000, sample);
  h.run(20_000_000);
  ages.sort((a, b) => a - b);
  return { p50: pct(ages, 50), p95: pct(ages, 95), last: ages[ages.length - 1] };
}

const u = unpaced();
const p = realtime('ble-default', 60);
console.log(`  ohne Bremse     Alter p50 ${ms(u.p50)} ms   p95 ${ms(u.p95)} ms   schlechtester ${ms(u.last)} ms`);
console.log(`  mit Bremse      Alter p50 ${ms(p.ageP50)} ms   p95 ${ms(p.ageP95)} ms`);
console.log('');
