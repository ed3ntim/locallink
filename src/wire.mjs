// Drahtformat von LocalLink.
//
// Ein Paket ist die Einheit, die der Transport traegt (ein BLE-Write, ein
// UDP-Datagramm). Es enthaelt beliebig viele Nachrichten aus beliebig vielen
// Kanaelen. Bestaetigungen reisen im Kopf jedes Pakets mit; es gibt keine
// eigenen ACK-Pakete. Genau das haelt die Latenz niedrig, wenn 30-mal pro
// Sekunde etwas zu senden ist.
//
//   Paketkopf                                     9 Byte, 13 mit Zeitstempel
//   +------+---------------------------------------------------------------+
//   | u8   | Version (2 Bit) | Flags (6 Bit)                                |
//   | u16  | seq      laufende Paketnummer des Senders                      |
//   | u16  | ack      hoechste vom Sender gesehene Paketnummer der Gegenseite|
//   | u32  | ackBits  die 32 Pakete davor, Bit 0 = ack-1                    |
//   |      |          beide nur gueltig, wenn FLAG_ACK gesetzt ist - sonst  |
//   |      |          bestaetigt der Sender ungewollt ein Paket 0, das er   |
//   |      |          nie gesehen hat, und dessen Inhalt geht verloren      |
//   | u16  | ackDelay wie lange der Sender das Ack liegen liess, in 64-us-  |
//   |      |          Schritten          (nur bei FLAG_ACK)                 |
//   | u32  | sendTime Mikrosekunden der Senderuhr   (nur bei FLAG_TIME)     |
//   +------+---------------------------------------------------------------+
//
//   Nachricht                                     4 Byte, 8 als Fragment
//   +------+---------------------------------------------------------------+
//   | u8   | Modus (4 Bit) | Kanal (4 Bit)                                  |
//   | u16  | msgSeq   laufende Nachrichtennummer je Kanal                   |
//   | u8   | Flags    0x01 = Fragment                                       |
//   | u16  | fragIndex                              (nur bei Fragment)      |
//   | u16  | fragCount                              (nur bei Fragment)      |
//   | var  | Laenge der Nutzdaten                                           |
//   | ...  | Nutzdaten                                                      |
//   +------+---------------------------------------------------------------+
//
// Keine Pruefsumme: L2CAP unter BLE und UDP tragen bereits eine. Vier Byte pro
// Paket sind bei 30 Hz kein Drama, aber bei einer BLE-MTU von 185 Byte ist
// jedes Byte Kopf ein Byte weniger Nutzlast.

export const PROTOCOL_VERSION = 1;

export const FLAG_TIME = 0x01; // Paket traegt einen Sendezeitstempel
export const FLAG_ACK = 0x02;  // ack/ackBits sind gueltig
export const MSG_FLAG_FRAGMENT = 0x01;

export const PACKET_HEADER_BYTES = 9;         // ohne Flags
export const PACKET_HEADER_MAX_BYTES = 15;    // mit Zeitstempel und Ack-Verzug
export const MESSAGE_HEADER_BYTES = 4;
export const MESSAGE_HEADER_BYTES_FRAGMENT = 8;

/** Ack-Verzug wird in 64-us-Schritten uebertragen: 2 Byte reichen bis 4,1 s. */
export const ACK_DELAY_UNIT_US = 64;
export const ACK_DELAY_MAX_US = 65535 * ACK_DELAY_UNIT_US;

const SEQ_MODULO = 0x10000;
const SEQ_HALF = 0x8000;

/** Vergleicht Paket-/Nachrichtennummern korrekt ueber den Ueberlauf hinweg. */
export function seqGreaterThan(a, b) {
  return (a > b && a - b <= SEQ_HALF) || (a < b && b - a > SEQ_HALF);
}

/** Abstand a - b in Sequenzraum, vorzeichenbehaftet. */
export function seqDistance(a, b) {
  let d = (a - b) % SEQ_MODULO;
  if (d > SEQ_HALF) d -= SEQ_MODULO;
  if (d < -SEQ_HALF) d += SEQ_MODULO;
  return d;
}

export function nextSeq(seq) {
  return (seq + 1) % SEQ_MODULO;
}

export class Writer {
  constructor(capacity = 512) {
    this.buf = new Uint8Array(capacity);
    this.pos = 0;
  }

  #ensure(extra) {
    if (this.pos + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + extra) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.buf.subarray(0, this.pos));
    this.buf = grown;
  }

  u8(v) {
    this.#ensure(1);
    this.buf[this.pos++] = v & 0xff;
    return this;
  }

  u16(v) {
    this.#ensure(2);
    this.buf[this.pos++] = (v >>> 8) & 0xff;
    this.buf[this.pos++] = v & 0xff;
    return this;
  }

  u32(v) {
    this.#ensure(4);
    this.buf[this.pos++] = (v >>> 24) & 0xff;
    this.buf[this.pos++] = (v >>> 16) & 0xff;
    this.buf[this.pos++] = (v >>> 8) & 0xff;
    this.buf[this.pos++] = v & 0xff;
    return this;
  }

  /** LEB128, unsigned. Laengen unter 128 Byte kosten damit ein einziges Byte. */
  varint(v) {
    let n = v >>> 0;
    do {
      let byte = n & 0x7f;
      n >>>= 7;
      if (n !== 0) byte |= 0x80;
      this.u8(byte);
    } while (n !== 0);
    return this;
  }

  bytes(src) {
    this.#ensure(src.length);
    this.buf.set(src, this.pos);
    this.pos += src.length;
    return this;
  }

  finish() {
    return this.buf.subarray(0, this.pos);
  }
}

export class Reader {
  constructor(bytes) {
    this.buf = bytes;
    this.pos = 0;
  }

  get remaining() {
    return this.buf.length - this.pos;
  }

  u8() {
    if (this.remaining < 1) throw new RangeError('Paket zu kurz: u8');
    return this.buf[this.pos++];
  }

  u16() {
    if (this.remaining < 2) throw new RangeError('Paket zu kurz: u16');
    return (this.buf[this.pos++] << 8) | this.buf[this.pos++];
  }

  u32() {
    if (this.remaining < 4) throw new RangeError('Paket zu kurz: u32');
    return (
      ((this.buf[this.pos++] << 24) >>> 0) +
      (this.buf[this.pos++] << 16) +
      (this.buf[this.pos++] << 8) +
      this.buf[this.pos++]
    ) >>> 0;
  }

  varint() {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.remaining < 1) throw new RangeError('Paket zu kurz: varint');
      const byte = this.buf[this.pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) throw new RangeError('varint zu lang');
    }
    return result >>> 0;
  }

  bytes(len) {
    if (this.remaining < len) throw new RangeError('Paket zu kurz: Nutzdaten');
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
}

/** Groesse des Nachrichtenkopfs fuer eine konkrete Nutzlast. */
export function messageOverhead(payloadLength, fragmented) {
  const base = fragmented ? MESSAGE_HEADER_BYTES_FRAGMENT : MESSAGE_HEADER_BYTES;
  return base + varintSize(payloadLength);
}

export function varintSize(v) {
  let n = v >>> 0;
  let size = 1;
  while (n >= 0x80) {
    n >>>= 7;
    size++;
  }
  return size;
}

/**
 * Serialisiert ein Paket.
 * @param {{seq:number, ack:number, ackBits:number, sendTimeUs:number|null}} header
 * @param {Array<{mode:number, channel:number, msgSeq:number, fragIndex:number|null, fragCount:number|null, payload:Uint8Array}>} messages
 */
export function encodePacket(header, messages) {
  const timed = header.sendTimeUs !== null && header.sendTimeUs !== undefined;
  const hasAck = header.hasAck === true;
  const w = new Writer(256);
  w.u8(((PROTOCOL_VERSION & 0x03) << 6) | (timed ? FLAG_TIME : 0) | (hasAck ? FLAG_ACK : 0));
  w.u16(header.seq);
  w.u16(header.ack);
  w.u32(header.ackBits >>> 0);
  if (hasAck) {
    const raw = Math.max(0, Math.min(ACK_DELAY_MAX_US, header.ackDelayUs ?? 0));
    w.u16(Math.round(raw / ACK_DELAY_UNIT_US));
  }
  if (timed) w.u32(header.sendTimeUs >>> 0);

  for (const m of messages) {
    const fragmented = m.fragCount !== null && m.fragCount !== undefined;
    w.u8(((m.mode & 0x0f) << 4) | (m.channel & 0x0f));
    w.u16(m.msgSeq);
    w.u8(fragmented ? MSG_FLAG_FRAGMENT : 0);
    if (fragmented) {
      w.u16(m.fragIndex);
      w.u16(m.fragCount);
    }
    w.varint(m.payload.length);
    w.bytes(m.payload);
  }
  return w.finish();
}

/** Gegenstueck zu encodePacket. Wirft bei verstuemmelten Paketen. */
export function decodePacket(bytes) {
  const r = new Reader(bytes);
  const b0 = r.u8();
  const version = (b0 >>> 6) & 0x03;
  if (version !== PROTOCOL_VERSION) {
    throw new RangeError(`Unbekannte Protokollversion ${version}`);
  }
  const flags = b0 & 0x3f;
  const seq = r.u16();
  const ack = r.u16();
  const ackBits = r.u32();
  const hasAck = (flags & FLAG_ACK) !== 0;
  const ackDelayUs = hasAck ? r.u16() * ACK_DELAY_UNIT_US : 0;
  const sendTimeUs = flags & FLAG_TIME ? r.u32() : null;

  const messages = [];
  while (r.remaining > 0) {
    const m0 = r.u8();
    const mode = (m0 >>> 4) & 0x0f;
    const channel = m0 & 0x0f;
    const msgSeq = r.u16();
    const mflags = r.u8();
    let fragIndex = null;
    let fragCount = null;
    if (mflags & MSG_FLAG_FRAGMENT) {
      fragIndex = r.u16();
      fragCount = r.u16();
    }
    const len = r.varint();
    const payload = r.bytes(len);
    messages.push({ mode, channel, msgSeq, fragIndex, fragCount, payload });
  }

  return { version, flags, seq, ack, ackBits, hasAck, ackDelayUs, sendTimeUs, messages };
}
