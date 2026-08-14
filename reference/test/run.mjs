// Protokolltests. Laufen ohne jede Hardware, in unter einer Sekunde.
// Das ist der Punkt: Diese Suite kann in der CI laufen, echte Geraete nicht.

import { pair, text, readText } from '../src/harness.mjs';
import {
  encodePacket, decodePacket, seqGreaterThan, seqDistance, varintSize, Writer, Reader,
} from '../src/wire.mjs';
import {
  UNRELIABLE, SEQUENCED, RELIABLE_ORDERED, RELIABLE_UNORDERED,
} from '../src/channel.mjs';

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? 'Zusicherung verletzt');
}

function equal(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg ?? 'ungleich'}: erwartet ${expected}, war ${actual}`);
  }
}

function group(name) {
  console.log(`\n${name}`);
}

// --------------------------------------------------------------- Drahtformat

group('Drahtformat');

test('Paket ueberlebt Kodieren und Dekodieren', () => {
  const bytes = encodePacket(
    { seq: 4242, ack: 4200, ackBits: 0xdeadbeef, sendTimeUs: 123456789 },
    [
      { mode: RELIABLE_ORDERED, channel: 2, msgSeq: 7, fragIndex: null, fragCount: null, payload: text('feuer b4') },
      { mode: SEQUENCED, channel: 3, msgSeq: 9, fragIndex: null, fragCount: null, payload: text('zustand') },
    ]
  );
  const p = decodePacket(bytes);
  equal(p.seq, 4242, 'seq');
  equal(p.ack, 4200, 'ack');
  equal(p.ackBits >>> 0, 0xdeadbeef, 'ackBits');
  equal(p.sendTimeUs, 123456789, 'sendTime');
  equal(p.messages.length, 2, 'Anzahl Nachrichten');
  equal(readText(p.messages[0].payload), 'feuer b4');
  equal(p.messages[1].channel, 3, 'Kanal');
  equal(p.messages[1].mode, SEQUENCED, 'Modus');
});

test('Fragmentkopf ueberlebt Kodieren und Dekodieren', () => {
  const bytes = encodePacket(
    { seq: 1, ack: 0, ackBits: 0, sendTimeUs: null },
    [{ mode: RELIABLE_ORDERED, channel: 0, msgSeq: 3, fragIndex: 5, fragCount: 9, payload: text('teil') }]
  );
  const p = decodePacket(bytes);
  equal(p.sendTimeUs, null, 'kein Zeitstempel');
  equal(p.messages[0].fragIndex, 5, 'fragIndex');
  equal(p.messages[0].fragCount, 9, 'fragCount');
});

test('Kopfgroesse bleibt im Budget fuer BLE', () => {
  const leer = [{ mode: 0, channel: 0, msgSeq: 1, fragIndex: null, fragCount: null, payload: new Uint8Array(0) }];

  // Ohne Bestaetigung: 13 Byte Paketkopf + 4 Nachrichtenkopf + 1 Laenge
  equal(encodePacket({ seq: 1, ack: 1, ackBits: 0, sendTimeUs: 1 }, leer).length, 18, 'ohne Ack');

  // Voll bestueckt: 15 Byte Paketkopf + 4 + 1. Bei einer BLE-MTU von 180 Byte
  // bleiben damit 160 Byte Nutzlast - reichlich fuer einen Spielzustand.
  const voll = encodePacket(
    { seq: 1, ack: 1, ackBits: 0, hasAck: true, ackDelayUs: 3200, sendTimeUs: 1 }, leer
  );
  equal(voll.length, 20, 'mit Ack und Zeitstempel');
});

test('Ack-Verzug ueberlebt Kodieren und Dekodieren', () => {
  const p = decodePacket(encodePacket(
    { seq: 1, ack: 2, ackBits: 0, hasAck: true, ackDelayUs: 100_000, sendTimeUs: 5 }, []
  ));
  assert(p.hasAck, 'Ack-Flag gesetzt');
  // 64-us-Raster: 100000 / 64 = 1562,5 -> 1563 -> 100032
  assert(Math.abs(p.ackDelayUs - 100_000) <= 64, `Verzug ${p.ackDelayUs} zu ungenau`);
});

test('Ohne Ack-Flag traegt das Paket keinen Verzug', () => {
  const p = decodePacket(encodePacket({ seq: 1, ack: 0, ackBits: 0, sendTimeUs: 5 }, []));
  assert(!p.hasAck, 'kein Ack-Flag');
  equal(p.ackDelayUs, 0, 'Verzug ist null');
});

test('varint ist bei kleinen Laengen ein Byte', () => {
  equal(varintSize(0), 1);
  equal(varintSize(127), 1);
  equal(varintSize(128), 2);
  equal(varintSize(16383), 2);
  equal(varintSize(16384), 3);
});

test('varint schreibt und liest bis 2^28', () => {
  for (const v of [0, 1, 127, 128, 300, 65535, 1 << 20, (1 << 28) - 1]) {
    const w = new Writer(8);
    w.varint(v);
    equal(new Reader(w.finish()).varint(), v, `varint ${v}`);
  }
});

test('Sequenzvergleich funktioniert ueber den Ueberlauf', () => {
  assert(seqGreaterThan(1, 0), '1 > 0');
  assert(seqGreaterThan(0, 65535), '0 > 65535 nach Ueberlauf');
  assert(!seqGreaterThan(65535, 0), '65535 nicht > 0');
  equal(seqDistance(0, 65535), 1, 'Abstand ueber den Ueberlauf');
  equal(seqDistance(65535, 0), -1, 'Abstand rueckwaerts');
});

test('Verstuemmeltes Paket wirft statt still Unsinn zu liefern', () => {
  let threw = false;
  try {
    decodePacket(new Uint8Array([0x40, 0x00]));
  } catch {
    threw = true;
  }
  assert(threw, 'zu kurzes Paket muss auffallen');
});

// ----------------------------------------------------------------- Zustellung

group('Zustellung unter Verlust');

test('RELIABLE_ORDERED liefert alles genau einmal in Reihenfolge (15 % Verlust)', () => {
  const h = pair({ profile: 'hostile', seed: 7 });
  for (let i = 0; i < 60; i++) h.a.queue(2, text(`zug-${i}`));
  h.run(30_000_000);

  const got = h.received.b.filter((m) => m.ch === 2).map((m) => readText(m.payload));
  equal(got.length, 60, 'Anzahl zugestellter Nachrichten');
  for (let i = 0; i < 60; i++) equal(got[i], `zug-${i}`, `Reihenfolge bei ${i}`);
  assert(h.a.stats.retransmits > 0, 'bei 15 % Verlust muss wiederholt worden sein');
});

test('RELIABLE_UNORDERED liefert alles, Reihenfolge egal', () => {
  const h = pair({
    profile: 'hostile',
    seed: 11,
    channels: [{ id: 2, mode: RELIABLE_UNORDERED }],
  });
  for (let i = 0; i < 40; i++) h.a.queue(2, text(`e${i}`));
  h.run(30_000_000);

  const got = new Set(h.received.b.map((m) => readText(m.payload)));
  equal(got.size, 40, 'jede Nachricht genau einmal');
});

test('SEQUENCED verwirft Ueberholtes statt es nachzureichen', () => {
  const h = pair({
    profile: 'hostile',
    seed: 3,
    channels: [{ id: 3, mode: SEQUENCED, coalesce: false }],
  });

  // Ein Zustandsstrom: 100 Schnappschuesse im Takt.
  let n = 0;
  const push = () => {
    if (n < 100) {
      h.a.queue(3, text(String(n++)));
      h.sim.after(h.tickUs, push);
    }
  };
  h.sim.after(h.tickUs, push);
  h.run(30_000_000);

  const got = h.received.b.map((m) => parseInt(readText(m.payload), 10));
  assert(got.length > 0, 'es muss etwas ankommen');
  for (let i = 1; i < got.length; i++) {
    assert(got[i] > got[i - 1], `Schnappschuss ${got[i]} nach ${got[i - 1]} - nie rueckwaerts`);
  }
  assert(got.length < 100, 'bei 15 % Verlust darf nicht alles ankommen - sonst wird wiederholt');
});

test('UNRELIABLE wiederholt niemals', () => {
  const h = pair({
    profile: 'hostile',
    seed: 5,
    channels: [{ id: 1, mode: UNRELIABLE }],
  });
  // Ueber viele Takte verteilt, damit die Nachrichten in eigenen Paketen
  // reisen - sonst ueberleben sie zufaellig gemeinsam und der Test sagt nichts.
  let n = 0;
  const push = () => {
    if (n < 120) {
      h.a.queue(1, text(`x${n++}`));
      h.sim.after(h.tickUs, push);
    }
  };
  h.sim.after(h.tickUs, push);
  h.run(30_000_000);

  equal(h.a.stats.retransmits, 0, 'keine Wiederholungen');
  assert(h.received.b.length > 60, `zu wenig angekommen: ${h.received.b.length}`);
  assert(h.received.b.length < 120, `bei 15 % Verlust darf nicht alles ankommen: ${h.received.b.length}`);
});

test('Doppelte Pakete werden erkannt und nicht zweimal geliefert', () => {
  const h = pair({ profile: 'hostile', seed: 21 });
  for (let i = 0; i < 40; i++) h.a.queue(2, text(`d${i}`));
  h.run(30_000_000);

  const got = h.received.b.filter((m) => m.ch === 2).map((m) => readText(m.payload));
  equal(new Set(got).size, got.length, 'keine Nachricht doppelt zugestellt');
  equal(got.length, 40, 'aber alle da');
});

test('Zusammenfassender Kanal verwirft veraltete Schnappschuesse vor dem Senden', () => {
  const h = pair({
    profile: 'ble-default',
    seed: 2,
    channels: [{ id: 3, mode: SEQUENCED, coalesce: true }],
  });
  // Zehn Schnappschuesse in denselben Takt gedraengt - nur der letzte zaehlt.
  for (let i = 0; i < 10; i++) h.a.queue(3, text(`s${i}`));
  h.run(2_000_000);

  const got = h.received.b.map((m) => readText(m.payload));
  equal(got.length, 1, 'nur ein Schnappschuss geht hinaus');
  equal(got[0], 's9', 'und zwar der neueste');
  assert(h.a.stats.messagesDroppedStale >= 9, 'die anderen neun wurden verworfen');
});

// -------------------------------------------------------------- Fragmentierung

group('Fragmentierung');

test('8-KB-Nachricht kommt ueber 180-Byte-MTU unversehrt an', () => {
  const h = pair({ profile: 'ble-default', seed: 13 });
  const big = new Uint8Array(8192);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;

  h.a.queue(2, big);
  h.run(60_000_000);

  const got = h.received.b.filter((m) => m.ch === 2);
  equal(got.length, 1, 'genau eine Nachricht');
  equal(got[0].payload.length, 8192, 'Laenge');
  for (let i = 0; i < big.length; i++) {
    if (got[0].payload[i] !== big[i]) throw new Error(`Byte ${i} verfaelscht`);
  }
});

test('Fragmentierte Nachricht ueberlebt auch die Stoerumgebung', () => {
  const h = pair({ profile: 'hostile', seed: 17 });
  const big = new Uint8Array(3000).fill(0xab);
  h.a.queue(2, big);
  h.run(60_000_000);

  const got = h.received.b.filter((m) => m.ch === 2);
  equal(got.length, 1, 'genau eine Nachricht');
  equal(got[0].payload.length, 3000, 'Laenge');
  assert(got[0].payload.every((v) => v === 0xab), 'Inhalt unveraendert');
});

// ------------------------------------------------------------------- Zeit

group('Zeitmessung und Uhrenabgleich');

test('RTT-Schaetzung naehert sich der doppelten Laufzeit', () => {
  const h = pair({ profile: 'wifi-lan', seed: 4 });
  h.run(10_000_000);
  const q = h.a.quality();
  assert(q.rttMs !== null, 'es muss eine Schaetzung geben');
  // Einweg 6 ms plus bis zu einem Sendetakt Wartezeit auf beiden Seiten.
  assert(q.rttMs > 8 && q.rttMs < 40, `RTT ${q.rttMs} ms liegt ausserhalb des Erwartbaren`);
  assert(q.minRttMs <= q.rttMs + 0.01, 'minRtt darf nicht ueber srtt liegen');
});

test('Uhrenversatz wird trotz 250 ms Skew erkannt', () => {
  const skewUs = 250_000;
  const h = pair({ profile: 'wifi-lan', seed: 9, skewUs });
  h.run(20_000_000);

  const est = h.a.clockOffsetUs;
  assert(est !== null, 'Versatz muss geschaetzt werden');
  // A sieht B als um +skew voraus; A schaetzt daher -skew als eigenen Versatz.
  const errMs = Math.abs(Math.abs(est) - skewUs) / 1000;
  assert(errMs < 12, `Schaetzfehler ${errMs.toFixed(2)} ms ist zu gross`);
});

test('Gemeinsame Zeitbasis liefert auf beiden Seiten fast denselben Wert', () => {
  const skewUs = 120_000;
  const h = pair({ profile: 'wifi-direct', seed: 6, skewUs });
  h.run(20_000_000);

  const sharedFromA = h.a.sharedNowUs(h.clockA());
  const sharedFromB = h.b.sharedNowUs(h.clockB());
  assert(sharedFromA !== null && sharedFromB !== null, 'beide Seiten brauchen eine Schaetzung');
  const spreadMs = Math.abs(sharedFromA - sharedFromB) / 1000;
  assert(spreadMs < 12, `gemeinsame Zeit weicht um ${spreadMs.toFixed(2)} ms ab`);
});

test('Jitter wird gemessen und ist bei WLAN kleiner als bei BLE', () => {
  const lan = pair({ profile: 'wifi-lan', seed: 8 });
  lan.run(20_000_000);
  const ble = pair({ profile: 'ble-default', seed: 8 });
  ble.run(20_000_000);

  const j1 = lan.a.quality().jitterMs;
  const j2 = ble.a.quality().jitterMs;
  assert(j1 > 0 && j2 > 0, 'beide messen Jitter');
  assert(j2 > j1, `BLE-Jitter ${j2} muss ueber WLAN-Jitter ${j1} liegen`);
});

// ------------------------------------------------------------- Verbindungsabriss

group('Abriss und Wiederaufnahme');

test('Nach 5 s Funkabriss geht keine zuverlaessige Nachricht verloren', () => {
  const h = pair({ profile: 'ble-fast', seed: 23 });

  for (let i = 0; i < 10; i++) h.a.queue(2, text(`vor-${i}`));
  h.run(3_000_000);
  const beforeCut = h.received.b.length;
  assert(beforeCut === 10, `vor dem Abriss muessen 10 da sein, waren ${beforeCut}`);

  // Funk weg.
  h.linkAB.cut();
  h.linkBA.cut();
  for (let i = 0; i < 10; i++) h.a.queue(2, text(`waehrend-${i}`));
  h.run(5_000_000);
  equal(h.received.b.length, 10, 'waehrend des Abrisses kommt nichts an');

  // Funk zurueck.
  h.linkAB.restore(h.profile);
  h.linkBA.restore(h.profile);
  h.run(20_000_000);

  const got = h.received.b.filter((m) => m.ch === 2).map((m) => readText(m.payload));
  equal(got.length, 20, 'nach der Wiederaufnahme sind alle 20 da');
  for (let i = 0; i < 10; i++) equal(got[10 + i], `waehrend-${i}`, `Reihenfolge nach Abriss bei ${i}`);
});

test('Letzte Nachricht vor einer Sendepause bleibt nicht haengen', () => {
  // Ohne Zeitschranke wuerde sie nur durch neuen Verkehr bestaetigt werden -
  // und wenn keiner kommt, nie.
  const h = pair({ profile: 'hostile', seed: 31 });
  h.a.queue(2, text('das-letzte-wort'));
  h.run(30_000_000);
  const got = h.received.b.filter((m) => m.ch === 2).map((m) => readText(m.payload));
  equal(got.length, 1, 'die einzelne Nachricht muss ankommen');
  equal(got[0], 'das-letzte-wort');
});

// ------------------------------------------------------------------ Bilanz

console.log(`\n${'-'.repeat(64)}`);
if (failures.length === 0) {
  console.log(`${passed} Tests bestanden.`);
  process.exit(0);
} else {
  console.log(`${passed} bestanden, ${failures.length} fehlgeschlagen:`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
  process.exit(1);
}
