// Erzeugt Referenzdaten fuer das Drahtformat (Backlog NP-02).
//
// Der Kotlin- und der Swift-Port muessen fuer dieselben Eingaben Byte fuer Byte
// dasselbe Paket erzeugen. Ohne solche Vektoren faellt eine Abweichung erst
// auf, wenn ein iPhone und ein Pixel im Raum stehen und sich nicht verstehen -
// und dann sucht man sie im Funk statt im Test.

import { writeFileSync } from 'node:fs';
import { encodePacket, decodePacket } from '../src/wire.mjs';
import { UNRELIABLE, SEQUENCED, RELIABLE_ORDERED, RELIABLE_UNORDERED } from '../src/channel.mjs';

const enc = (s) => new TextEncoder().encode(s);
const hex = (b) => Buffer.from(b).toString('hex');

const cases = [
  {
    name: 'leeres-paket-ohne-flags',
    zweck: 'Kleinstes gueltiges Paket. Prueft den nackten Kopf.',
    header: { seq: 0, ack: 0, ackBits: 0, sendTimeUs: null },
    messages: [],
  },
  {
    name: 'nur-bestaetigung',
    zweck: 'Reines Ack-Paket, wie es ein ruhiger Kanal schickt.',
    header: { seq: 7, ack: 5, ackBits: 0x0000000f, hasAck: true, ackDelayUs: 3200, sendTimeUs: null },
    messages: [],
  },
  {
    name: 'zustand-sequenced',
    zweck: 'Ein Schnappschuss, wie ihn ein Echtzeitspiel 30-mal je Sekunde sendet.',
    header: { seq: 1024, ack: 1020, ackBits: 0xffffffff, hasAck: true, ackDelayUs: 0, sendTimeUs: 1_000_000 },
    messages: [
      { mode: SEQUENCED, channel: 3, msgSeq: 900, fragIndex: null, fragCount: null, payload: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
    ],
  },
  {
    name: 'salvo-schuss',
    zweck: 'Ein Spielzug auf dem Ereigniskanal.',
    header: { seq: 42, ack: 41, ackBits: 0x00000001, hasAck: true, ackDelayUs: 12_800, sendTimeUs: 987_654 },
    messages: [
      { mode: RELIABLE_ORDERED, channel: 2, msgSeq: 17, fragIndex: null, fragCount: null, payload: enc('feuer b4') },
    ],
  },
  {
    name: 'mehrere-kanaele-in-einem-paket',
    zweck: 'Buendelung. Prueft, dass Nachrichten hintereinander korrekt gelesen werden.',
    header: { seq: 300, ack: 299, ackBits: 0x00000003, hasAck: true, ackDelayUs: 64, sendTimeUs: 55_555 },
    messages: [
      { mode: RELIABLE_ORDERED, channel: 0, msgSeq: 2, fragIndex: null, fragCount: null, payload: enc('caps') },
      { mode: UNRELIABLE, channel: 1, msgSeq: 3, fragIndex: null, fragCount: null, payload: new Uint8Array([0xaa]) },
      { mode: RELIABLE_UNORDERED, channel: 2, msgSeq: 4, fragIndex: null, fragCount: null, payload: enc('ereignis') },
      { mode: SEQUENCED, channel: 3, msgSeq: 5, fragIndex: null, fragCount: null, payload: new Uint8Array([0, 0, 0, 1]) },
    ],
  },
  {
    name: 'fragment-mitte',
    zweck: 'Ein Teilstueck einer grossen Nachricht.',
    header: { seq: 8, ack: 7, ackBits: 0, hasAck: true, ackDelayUs: 0, sendTimeUs: 4242 },
    messages: [
      { mode: RELIABLE_ORDERED, channel: 2, msgSeq: 99, fragIndex: 3, fragCount: 12, payload: new Uint8Array(16).fill(0xcd) },
    ],
  },
  {
    name: 'laenge-ueber-127',
    zweck: 'Nutzlast jenseits der Ein-Byte-Grenze des varint.',
    header: { seq: 1, ack: 0, ackBits: 0, hasAck: true, ackDelayUs: 0, sendTimeUs: 1 },
    messages: [
      { mode: RELIABLE_ORDERED, channel: 2, msgSeq: 1, fragIndex: null, fragCount: null, payload: new Uint8Array(200).fill(0x5a) },
    ],
  },
  {
    name: 'sequenznummern-am-ueberlauf',
    zweck: 'Nummern kurz vor dem Umschlag von 65535 auf 0.',
    header: { seq: 65535, ack: 65534, ackBits: 0x80000000, hasAck: true, ackDelayUs: 65535 * 64, sendTimeUs: 0xffffffff },
    messages: [
      { mode: RELIABLE_ORDERED, channel: 2, msgSeq: 65535, fragIndex: null, fragCount: null, payload: enc('rand') },
    ],
  },
];

const out = { protokoll: 1, erzeugt: 'tools/vectors.mjs', faelle: [] };
let ok = 0;

for (const c of cases) {
  const bytes = encodePacket(c.header, c.messages);

  // Gegenprobe: Was wir schreiben, muessen wir auch wieder lesen koennen.
  const back = decodePacket(bytes);
  if (back.seq !== c.header.seq) throw new Error(`${c.name}: seq weicht ab`);
  if (back.messages.length !== c.messages.length) throw new Error(`${c.name}: Nachrichtenzahl weicht ab`);
  for (let i = 0; i < c.messages.length; i++) {
    const a = c.messages[i];
    const b = back.messages[i];
    if (a.mode !== b.mode || a.channel !== b.channel || a.msgSeq !== b.msgSeq) {
      throw new Error(`${c.name}: Nachrichtenkopf ${i} weicht ab`);
    }
    if (hex(a.payload) !== hex(b.payload)) throw new Error(`${c.name}: Nutzlast ${i} weicht ab`);
  }
  ok++;

  out.faelle.push({
    name: c.name,
    zweck: c.zweck,
    eingabe: {
      header: { ...c.header, hasAck: c.header.hasAck === true },
      messages: c.messages.map((m) => ({ ...m, payload: hex(m.payload) })),
    },
    erwartet: hex(bytes),
    laenge: bytes.length,
  });
}

const path = new URL('../vectors.json', import.meta.url);
writeFileSync(path, JSON.stringify(out, null, 2) + '\n');

console.log(`${ok} Referenzfaelle erzeugt und gegengeprueft.`);
console.log(`geschrieben nach vectors.json`);
for (const f of out.faelle) {
  console.log(`  ${f.name.padEnd(34)} ${String(f.laenge).padStart(3)} Byte  ${f.erwartet.slice(0, 40)}...`);
}
