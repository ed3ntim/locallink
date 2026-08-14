// Der Kern von LocalLink: eine Verbindung zwischen zwei Geraeten.
//
// Die Klasse weiss nichts ueber Bluetooth, WLAN oder Schiffe. Sie bekommt eine
// Sendefunktion und rohe Pakete herein, und liefert vollstaendige Nachrichten
// heraus. Alles darunter ist Transportsache, alles darueber App-Sache.
//
// Zustellung ohne eigene ACK-Pakete: Jedes Paket traegt im Kopf die hoechste
// gesehene Gegennummer plus ein Bitfeld der 32 Pakete davor. Wer 30-mal pro
// Sekunde sendet, bestaetigt damit 30-mal pro Sekunde nebenbei. Ein verlorenes
// Paket faellt spaetestens auf, wenn 32 neuere bestaetigt wurden - dann wandern
// seine zuverlaessigen Nachrichten zurueck in die Warteschlange.

import {
  Writer,
  encodePacket,
  decodePacket,
  seqGreaterThan,
  seqDistance,
  nextSeq,
  varintSize,
  PACKET_HEADER_MAX_BYTES,
  MESSAGE_HEADER_BYTES,
  MESSAGE_HEADER_BYTES_FRAGMENT,
} from './wire.mjs';

import {
  UNRELIABLE,
  SEQUENCED,
  RELIABLE_ORDERED,
  isReliable,
  DEFAULT_CHANNELS,
} from './channel.mjs';

const ACK_WINDOW = 32;          // so viele Pakete deckt das Bitfeld ab
const DEDUPE_WINDOW = 1024;     // so weit zurueck erkennen wir Doppel
const MIN_RTO_US = 40_000;      // 40 ms - unter der BLE-Verbindungsintervall-Grenze sinnlos
const MAX_RTO_US = 2_000_000;   // 2 s

export class Connection {
  /**
   * @param {object} opts
   * @param {number} opts.mtu            Nutzbare Bytes pro Transportpaket
   * @param {(bytes:Uint8Array)=>void} opts.send   Rohausgang zum Transport
   * @param {(channel:number, payload:Uint8Array)=>void} opts.onMessage
   * @param {Array<{id:number,mode:number,coalesce?:boolean}>} [opts.channels]
   * @param {string} [opts.name]         Nur fuer Diagnose
   */
  constructor(opts) {
    this.name = opts.name ?? 'peer';
    this.mtu = opts.mtu;
    this.transportSend = opts.send;
    this.onMessage = opts.onMessage;

    // Eine gemeinsame Zeitachse braucht einen Bezugspunkt. Zwei Geraete, die
    // sich gegenseitig schaetzen, landen sonst bei zwei Zeitachsen, die genau
    // um den Uhrenversatz auseinanderliegen. Wer die Sitzung eroeffnet, gibt
    // die Zeit vor; die Gegenseite rechnet um.
    this.timeMaster = opts.timeMaster ?? false;

    // Sendetaktung. Ein Spiel, das mit 60 Hz laeuft, ruft update() 60-mal pro
    // Sekunde - aber BLE laesst bei 30-ms-Verbindungsintervall nur rund 25
    // Pakete pro Sekunde durch. Ohne Bremse stauen sich die ueberzaehligen
    // Pakete im Transport auf und die Latenz waechst unbegrenzt. Mit Bremse
    // faellt stattdessen der veraltete Schnappschuss weg, und die Latenz
    // bleibt flach. Das ist der Unterschied zwischen "BLE ist zu langsam" und
    // "BLE laeuft mit 25 Hz".
    this.minSendIntervalUs = opts.minSendIntervalUs ?? 0;
    this.lastSendUs = -Infinity;

    this.channels = new Map();
    for (const c of opts.channels ?? DEFAULT_CHANNELS) {
      this.channels.set(c.id, {
        id: c.id,
        mode: c.mode,
        coalesce: c.coalesce ?? false,
        outSeq: 0,
        // Empfangsseite
        lastDelivered: -1,          // fuer SEQUENCED
        nextExpected: 0,            // fuer RELIABLE_ORDERED
        orderBuffer: new Map(),     // msgSeq -> payload
        seen: new Set(),            // Doppelerkennung
        seenHigh: -1,
      });
    }

    // Sendeseite
    this.outSeq = 0;
    this.pending = [];              // noch nicht verpackte Nachrichten
    this.sentPackets = new Map();   // seq -> { sentAtUs, msgIds }
    this.unacked = new Map();       // msgId -> Nachricht (nur zuverlaessige)

    // Empfangsseite
    this.remoteSeq = -1;
    this.remoteBits = 0;
    this.remoteSeqAtUs = null; // wann das Paket mit remoteSeq eintraf
    // Kam etwas Zuverlaessiges an, geht die Bestaetigung beim naechsten Takt
    // hinaus statt beim naechsten Lebenszeichen. Das kuerzt die Schwanzlatenz
    // erheblich und haelt nebenbei die Wiederholungsschranke niedrig.
    this.ackPending = false;
    this.fragments = new Map();     // "kanal:seq" -> { count, parts, bytes }

    // Zeitmessung
    this.srttUs = null;
    this.rttVarUs = 0;
    this.rtoUs = 500_000;
    this.minRttUs = Infinity;
    this.jitterUs = 0;
    // Groesster beobachteter Ack-Verzug der Gegenseite, langsam vergessend.
    // Fliesst in die Wiederholungsschranke ein, sonst feuert sie auf einem
    // ruhigen Kanal gegen die Bedenkzeit der Gegenseite statt gegen Verlust.
    this.peerAckDelayUs = 0;
    this.clockOffsetUs = null;
    this.minRawOffsetUs = Infinity;
    this.lastArrival = null;        // { remoteSend, localRecv }

    this.stats = {
      packetsSent: 0,
      packetsReceived: 0,
      packetsLost: 0,
      bytesSent: 0,
      bytesReceived: 0,
      messagesQueued: 0,
      messagesDelivered: 0,
      messagesDroppedStale: 0,
      retransmits: 0,
      duplicatesIgnored: 0,
    };
  }

  // ---------------------------------------------------------------- senden

  /**
   * Stellt eine Nachricht in die Warteschlange. Sie geht beim naechsten
   * update() hinaus - nicht sofort, damit mehrere kleine Nachrichten in ein
   * Paket passen. Bei BLE ist die Anzahl der Schreibvorgaenge pro
   * Verbindungsintervall der eigentliche Engpass, nicht die Byteanzahl.
   */
  queue(channelId, payload) {
    const ch = this.channels.get(channelId);
    if (!ch) throw new Error(`Kanal ${channelId} ist nicht konfiguriert`);
    if (!(payload instanceof Uint8Array)) {
      throw new TypeError('Nutzdaten muessen ein Uint8Array sein');
    }

    // Bei zusammenfassenden Kanaelen ersetzt das Neue das noch nicht gesendete
    // Alte. Ein Schnappschuss von vor 30 ms interessiert niemanden mehr.
    if (ch.coalesce) {
      const before = this.pending.length;
      this.pending = this.pending.filter((m) => m.channel !== channelId);
      this.stats.messagesDroppedStale += before - this.pending.length;
    }

    const msgSeq = ch.outSeq;
    ch.outSeq = nextSeq(ch.outSeq);
    this.stats.messagesQueued++;

    const budget = this.#fragmentPayloadBudget();
    if (payload.length <= this.#wholePayloadBudget()) {
      this.pending.push({
        channel: channelId,
        mode: ch.mode,
        msgSeq,
        fragIndex: null,
        fragCount: null,
        payload,
      });
      return msgSeq;
    }

    // Zu gross fuer ein Paket: in Fragmente zerlegen. Alle Fragmente erben den
    // Modus; unzuverlaessige Fragmente sind zulaessig, aber die App bekommt die
    // Nachricht dann nur, wenn zufaellig alle Teile ankommen.
    const fragCount = Math.ceil(payload.length / budget);
    if (fragCount > 0xffff) throw new RangeError('Nachricht zu gross');
    for (let i = 0; i < fragCount; i++) {
      this.pending.push({
        channel: channelId,
        mode: ch.mode,
        msgSeq,
        fragIndex: i,
        fragCount,
        payload: payload.subarray(i * budget, Math.min((i + 1) * budget, payload.length)),
      });
    }
    return msgSeq;
  }

  #wholePayloadBudget() {
    // Konservativ mit Zeitstempel gerechnet, damit ein Paket nie zu gross wird.
    return this.mtu - PACKET_HEADER_MAX_BYTES - MESSAGE_HEADER_BYTES - 3;
  }

  #fragmentPayloadBudget() {
    return this.mtu - PACKET_HEADER_MAX_BYTES - MESSAGE_HEADER_BYTES_FRAGMENT - 3;
  }

  /**
   * Packt und sendet hoechstens ein Paket. Wird im Takt des Transports
   * gerufen - bei BLE einmal pro Verbindungsintervall, bei WLAN im Spieltakt.
   *
   * @param {number} nowUs Lokale Uhr in Mikrosekunden
   * @param {boolean} [force] Auch senden, wenn nichts ansteht (Lebenszeichen)
   */
  update(nowUs, force = false) {
    this.#detectLoss(nowUs);

    if (this.pending.length === 0 && !force && !this.ackPending) return false;
    if (nowUs - this.lastSendUs < this.minSendIntervalUs) return false;

    const seq = this.outSeq;
    let used = PACKET_HEADER_MAX_BYTES;
    const carried = [];
    const msgIds = [];

    // FIFO. Wiederholungen stehen bereits vorn, weil #detectLoss sie dort
    // einsortiert - so ueberholt kein frischer Schnappschuss eine Wiederholung,
    // die schon einmal verloren ging.
    const keep = [];
    for (const m of this.pending) {
      const overhead =
        (m.fragCount === null ? MESSAGE_HEADER_BYTES : MESSAGE_HEADER_BYTES_FRAGMENT) +
        varintSize(m.payload.length);
      if (used + overhead + m.payload.length > this.mtu) {
        keep.push(m);
        continue;
      }
      used += overhead + m.payload.length;
      carried.push(m);
      if (isReliable(m.mode)) {
        const id = msgId(m);
        this.unacked.set(id, m);
        msgIds.push(id);
      }
    }
    this.pending = keep;

    if (carried.length === 0 && !force && !this.ackPending) return false;
    this.ackPending = false;

    const bytes = encodePacket(
      {
        seq,
        ack: this.remoteSeq < 0 ? 0 : this.remoteSeq,
        ackBits: this.remoteBits,
        hasAck: this.remoteSeq >= 0,
        // Wie lange das Ack bei uns lag. Ohne diesen Wert misst die Gegenseite
        // unsere Bedenkzeit als Laufzeit mit - bei einem ruhigen Kanal, der nur
        // alle 100 ms ein Lebenszeichen schickt, sind das 100 ms Phantomlatenz.
        ackDelayUs: this.remoteSeqAtUs === null ? 0 : nowUs - this.remoteSeqAtUs,
        sendTimeUs: nowUs,
      },
      carried
    );

    this.sentPackets.set(seq, { sentAtUs: nowUs, msgIds });
    this.outSeq = nextSeq(this.outSeq);
    this.lastSendUs = nowUs;
    this.stats.packetsSent++;
    this.stats.bytesSent += bytes.length;
    this.transportSend(bytes);
    return true;
  }

  // -------------------------------------------------------------- empfangen

  /** Nimmt ein rohes Paket vom Transport entgegen. */
  onPacket(bytes, nowUs) {
    let pkt;
    try {
      pkt = decodePacket(bytes);
    } catch {
      return; // Verstuemmeltes Paket wird stillschweigend verworfen.
    }

    this.stats.packetsReceived++;
    this.stats.bytesReceived += bytes.length;

    this.#recordArrival(pkt, nowUs);
    this.#processAcks(pkt, nowUs);

    for (const m of pkt.messages) {
      if (isReliable(m.mode)) this.ackPending = true;
      this.#receiveMessage(m, nowUs);
    }
  }

  /** Pflegt ack und ackBits fuer unsere eigenen ausgehenden Pakete. */
  #recordArrival(pkt, nowUs) {
    if (this.remoteSeq < 0) {
      this.remoteSeq = pkt.seq;
      this.remoteBits = 0;
      this.remoteSeqAtUs = nowUs;
    } else if (seqGreaterThan(pkt.seq, this.remoteSeq)) {
      const shift = seqDistance(pkt.seq, this.remoteSeq);
      // Das bisherige Spitzenpaket rutscht ins Bitfeld nach.
      this.remoteBits = shift >= 32 ? 0 : ((this.remoteBits << shift) | (1 << (shift - 1))) >>> 0;
      this.remoteSeq = pkt.seq;
      this.remoteSeqAtUs = nowUs;
    } else {
      const back = seqDistance(this.remoteSeq, pkt.seq);
      if (back >= 1 && back <= ACK_WINDOW) {
        this.remoteBits = (this.remoteBits | (1 << (back - 1))) >>> 0;
      }
    }

    if (pkt.sendTimeUs === null) return;

    // Jitter nach RFC 3550: Schwankung des Abstands zwischen Senden und
    // Ankommen. Fuer ein Spiel ist Jitter oft wichtiger als die reine
    // Laufzeit - gleichmaessige 80 ms fuehlen sich besser an als 20 bis 90 ms.
    if (this.lastArrival) {
      const d =
        (nowUs - this.lastArrival.localRecv) -
        (((pkt.sendTimeUs - this.lastArrival.remoteSend) >>> 0) | 0);
      this.jitterUs += (Math.abs(d) - this.jitterUs) / 16;
    }
    this.lastArrival = { remoteSend: pkt.sendTimeUs, localRecv: nowUs };

    // Uhrenversatz. Der Rohversatz enthaelt die halbe Laufzeit; das Minimum
    // ueber viele Pakete kommt der Wahrheit am naechsten, weil das schnellste
    // beobachtete Paket am wenigsten Warteschlange gesehen hat.
    const rawOffset = nowUs - pkt.sendTimeUs;
    if (rawOffset < this.minRawOffsetUs) this.minRawOffsetUs = rawOffset;
    if (this.minRttUs !== Infinity) {
      this.clockOffsetUs = this.minRawOffsetUs - this.minRttUs / 2;
    }
  }

  /** Wertet die mitgereisten Bestaetigungen der Gegenseite aus. */
  #processAcks(pkt, nowUs) {
    // Hat die Gegenseite noch nie etwas von uns gesehen, sind ack und ackBits
    // Fuellwerte. Wer sie trotzdem auswertet, streicht Paket 0 aus der
    // Wiederholungsliste, ohne dass es je angekommen waere.
    if (!pkt.hasAck) return;

    // Spitzenwert halten, aber zuegig wieder loslassen. Waehrend eines
    // Schlagabtauschs antwortet die Gegenseite sofort; die traegen Werte aus
    // der Leerlaufphase davor duerfen die Schranke nicht dauerhaft hochhalten.
    this.peerAckDelayUs =
      pkt.ackDelayUs > this.peerAckDelayUs
        ? pkt.ackDelayUs
        : this.peerAckDelayUs * 0.9 + pkt.ackDelayUs * 0.1;

    const confirm = (seq, measureRtt) => {
      const rec = this.sentPackets.get(seq);
      if (!rec) return;
      this.sentPackets.delete(seq);

      // Nur das direkt bestaetigte Paket taugt zur Zeitmessung: Fuer die
      // Eintraege im Bitfeld kennen wir den Verzug der Gegenseite nicht, und
      // eine zu hoch geschaetzte RTT treibt die Wiederholungsschranke hoch.
      if (measureRtt) {
        const rttUs = nowUs - rec.sentAtUs - pkt.ackDelayUs;
        if (rttUs >= 0) this.#updateRtt(rttUs);
      }

      for (const id of rec.msgIds) this.unacked.delete(id);
    };

    confirm(pkt.ack, true);
    for (let i = 0; i < ACK_WINDOW; i++) {
      if (pkt.ackBits & (1 << i)) confirm((pkt.ack - (i + 1) + 0x10000) % 0x10000, false);
    }
  }

  /** Jacobson/Karels, wie bei TCP - bewaehrt und billig. */
  #updateRtt(rttUs) {
    if (rttUs < this.minRttUs) this.minRttUs = rttUs;
    if (this.srttUs === null) {
      this.srttUs = rttUs;
      this.rttVarUs = rttUs / 2;
    } else {
      const delta = Math.abs(this.srttUs - rttUs);
      this.rttVarUs = 0.75 * this.rttVarUs + 0.25 * delta;
      this.srttUs = 0.875 * this.srttUs + 0.125 * rttUs;
    }
    // Die Bedenkzeit der Gegenseite gehoert in die Schranke, nicht in die
    // RTT-Schaetzung: Sie verzoegert die Bestaetigung real, ist aber keine
    // Laufzeit. Ohne diesen Summanden wiederholt ein ruhiger Kanal staendig.
    const budget = this.srttUs + 4 * this.rttVarUs + this.peerAckDelayUs;
    this.rtoUs = Math.min(MAX_RTO_US, Math.max(MIN_RTO_US, budget));
  }

  /**
   * Erkennt verlorene Pakete auf zwei Wegen: ueber das Bestaetigungsfenster
   * (schnell, greift solange Verkehr fliesst) und ueber eine Zeitschranke
   * (langsam, greift wenn es still wird). Ohne den zweiten Weg bliebe die
   * letzte Nachricht vor einer Pause fuer immer haengen.
   */
  #detectLoss(nowUs) {
    if (this.sentPackets.size === 0) return;
    const requeue = [];

    for (const [seq, rec] of this.sentPackets) {
      const tooOld = this.sentPackets.size > 0 && seqDistance(this.outSeq, seq) > ACK_WINDOW + 1;
      const timedOut = nowUs - rec.sentAtUs > this.rtoUs;
      if (!tooOld && !timedOut) continue;

      this.sentPackets.delete(seq);
      this.stats.packetsLost++;

      for (const id of rec.msgIds) {
        const m = this.unacked.get(id);
        if (!m) continue; // war schon bestaetigt
        this.unacked.delete(id);
        requeue.push(m);
        this.stats.retransmits++;
      }
    }

    // Wiederholungen nach vorn: aeltestes zuerst.
    if (requeue.length > 0) {
      requeue.sort((a, b) => seqDistance(a.msgSeq, b.msgSeq));
      this.pending.unshift(...requeue);
    }
  }

  // ------------------------------------------------------------- zustellung

  #receiveMessage(m, nowUs) {
    const ch = this.channels.get(m.channel);
    if (!ch) return; // Kanal kennt diese Seite nicht - verwerfen.

    // Doppel abfangen, bevor irgendetwas anderes passiert.
    if (isReliable(ch.mode)) {
      const key = m.fragCount === null ? `${m.msgSeq}` : `${m.msgSeq}#${m.fragIndex}`;
      if (ch.seen.has(key)) {
        this.stats.duplicatesIgnored++;
        return;
      }
      ch.seen.add(key);
      if (seqGreaterThan(m.msgSeq, ch.seenHigh) || ch.seenHigh < 0) ch.seenHigh = m.msgSeq;
      if (ch.seen.size > DEDUPE_WINDOW * 2) {
        for (const k of ch.seen) {
          const s = parseInt(k, 10);
          if (seqDistance(ch.seenHigh, s) > DEDUPE_WINDOW) ch.seen.delete(k);
        }
      }
    }

    const payload = m.fragCount === null ? m.payload : this.#reassemble(m);
    if (payload === null) return; // Fragment fehlt noch.

    this.#deliver(ch, m.msgSeq, payload);
  }

  #reassemble(m) {
    const key = `${m.channel}:${m.msgSeq}`;
    let entry = this.fragments.get(key);
    if (!entry) {
      entry = { count: m.fragCount, parts: new Array(m.fragCount).fill(null), have: 0, bytes: 0 };
      this.fragments.set(key, entry);
    }
    if (entry.parts[m.fragIndex] !== null) return null; // Doppel
    entry.parts[m.fragIndex] = m.payload;
    entry.have++;
    entry.bytes += m.payload.length;
    if (entry.have < entry.count) return null;

    this.fragments.delete(key);
    const out = new Uint8Array(entry.bytes);
    let pos = 0;
    for (const part of entry.parts) {
      out.set(part, pos);
      pos += part.length;
    }
    return out;
  }

  #deliver(ch, msgSeq, payload) {
    switch (ch.mode) {
      case UNRELIABLE:
        this.#emit(ch, payload);
        return;

      case SEQUENCED:
        // Neuestes gewinnt. Ueberholtes wird verworfen, nicht nachgereicht.
        if (ch.lastDelivered >= 0 && !seqGreaterThan(msgSeq, ch.lastDelivered)) {
          this.stats.messagesDroppedStale++;
          return;
        }
        ch.lastDelivered = msgSeq;
        this.#emit(ch, payload);
        return;

      case RELIABLE_ORDERED: {
        if (seqDistance(msgSeq, ch.nextExpected) < 0) return; // laengst geliefert
        ch.orderBuffer.set(msgSeq, payload);
        while (ch.orderBuffer.has(ch.nextExpected)) {
          const next = ch.orderBuffer.get(ch.nextExpected);
          ch.orderBuffer.delete(ch.nextExpected);
          ch.nextExpected = nextSeq(ch.nextExpected);
          this.#emit(ch, next);
        }
        return;
      }

      default: // RELIABLE_UNORDERED
        this.#emit(ch, payload);
    }
  }

  #emit(ch, payload) {
    this.stats.messagesDelivered++;
    this.onMessage(ch.id, payload);
  }

  // ------------------------------------------------------------- diagnostik

  /** Momentaufnahme fuer das Diagnose-Overlay und die Tests. */
  quality() {
    return {
      rttMs: this.srttUs === null ? null : +(this.srttUs / 1000).toFixed(2),
      minRttMs: this.minRttUs === Infinity ? null : +(this.minRttUs / 1000).toFixed(2),
      jitterMs: +(this.jitterUs / 1000).toFixed(2),
      rtoMs: +(this.rtoUs / 1000).toFixed(2),
      clockOffsetMs: this.clockOffsetUs === null ? null : +(this.clockOffsetUs / 1000).toFixed(2),
      inFlight: this.sentPackets.size,
      unackedMessages: this.unacked.size,
      pending: this.pending.length,
    };
  }

  /**
   * Gemeinsame Zeitbasis beider Geraete - Grundlage jeder Lag-Kompensation.
   * Beide Seiten liefern denselben Wert: die Uhr des Zeitgebers.
   */
  sharedNowUs(localNowUs) {
    if (this.timeMaster) return localNowUs;
    if (this.clockOffsetUs === null) return null;
    return localNowUs - this.clockOffsetUs;
  }
}

function msgId(m) {
  return m.fragCount === null
    ? `${m.channel}:${m.msgSeq}`
    : `${m.channel}:${m.msgSeq}#${m.fragIndex}`;
}

export { Writer };
