// Simulationstransport.
//
// Weder der iOS-Simulator noch der Android-Emulator koennen Bluetooth. Ohne
// einen simulierten Transport laesst sich das Protokoll also nur auf echten
// Geraeten testen - und damit praktisch nie automatisch. Diese Datei loest das:
// virtuelle Uhr, deterministischer Zufall, nachgebildete Transportprofile.
//
// Die Profile sind an den Eigenschaften der realen Wege ausgerichtet. Der
// entscheidende Wert ist nicht die Bandbreite, sondern "ratePps": wie viele
// Pakete pro Sekunde ein Transport ueberhaupt durchlaesst. Bei BLE bestimmt
// das Verbindungsintervall diese Zahl, und sie ist der eigentliche Grund,
// warum BLE fuer schnelle Spiele knapp wird.

/** Kleiner deterministischer Generator (mulberry32) - gleiche Saat, gleicher Lauf. */
export function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PROFILES = {
  // Was iOS ohne Zutun aushandelt: Verbindungsintervall um die 30 ms.
  'ble-default': {
    label: 'BLE, Standardintervall',
    owdUs: 35_000, jitterUs: 15_000, loss: 0.02, reorder: 0.01, dup: 0.002,
    ratePps: 25, mtu: 180,
  },
  // Android mit CONNECTION_PRIORITY_HIGH, iOS mit kurzem Intervall.
  'ble-fast': {
    label: 'BLE, hohe Prioritaet',
    owdUs: 18_000, jitterUs: 8_000, loss: 0.02, reorder: 0.01, dup: 0.002,
    ratePps: 60, mtu: 244,
  },
  // Beide Geraete am selben Router.
  'wifi-lan': {
    label: 'WLAN ueber Router',
    owdUs: 6_000, jitterUs: 4_000, loss: 0.01, reorder: 0.005, dup: 0.001,
    ratePps: 500, mtu: 1200,
  },
  // Ein Geraet spannt den Hotspot auf, das andere haengt direkt daran.
  'wifi-direct': {
    label: 'WLAN direkt (Hotspot)',
    owdUs: 3_000, jitterUs: 2_000, loss: 0.005, reorder: 0.002, dup: 0.001,
    ratePps: 1000, mtu: 1200,
  },
  // Volles Cafe, Mikrowelle an, Geraete in der Hosentasche.
  hostile: {
    label: 'Stoerumgebung',
    owdUs: 60_000, jitterUs: 40_000, loss: 0.15, reorder: 0.05, dup: 0.02,
    ratePps: 20, mtu: 180,
  },
};

/** Virtuelle Uhr mit Ereigniswarteschlange. Laesst 60 Sekunden in Millisekunden verstreichen. */
export class Sim {
  constructor(seed = 1) {
    this.nowUs = 0;
    this.queue = [];
    this.rand = rng(seed);
    this.seq = 0;
  }

  at(timeUs, fn) {
    this.queue.push({ timeUs, order: this.seq++, fn });
  }

  after(delayUs, fn) {
    this.at(this.nowUs + delayUs, fn);
  }

  /** Arbeitet alle Ereignisse bis untilUs ab. */
  runUntil(untilUs) {
    for (;;) {
      if (this.queue.length === 0) break;
      this.queue.sort((a, b) => a.timeUs - b.timeUs || a.order - b.order);
      if (this.queue[0].timeUs > untilUs) break;
      const ev = this.queue.shift();
      this.nowUs = ev.timeUs;
      ev.fn();
    }
    this.nowUs = untilUs;
  }
}

/**
 * Eine Richtung einer simulierten Strecke. Modelliert Laufzeit, Schwankung,
 * Verlust, Vertauschung, Verdopplung und - am wichtigsten - die Taktgrenze
 * des Transports.
 */
export class Link {
  constructor(sim, profile, deliver) {
    this.sim = sim;
    this.p = profile;
    this.deliver = deliver;
    this.nextSlotUs = 0;
    this.slotUs = Math.round(1_000_000 / profile.ratePps);
    this.sent = 0;
    this.dropped = 0;
    this.delivered = 0;
  }

  send(bytes) {
    this.sent++;
    const p = this.p;

    // Taktgrenze: Ein Paket kann fruehestens im naechsten freien Zeitfenster
    // auf die Strecke. Wer schneller sendet, staut sich auf - genau das
    // passiert bei BLE, wenn eine App pro Frame schreiben will.
    const departUs = Math.max(this.sim.nowUs, this.nextSlotUs);
    this.nextSlotUs = departUs + this.slotUs;

    if (this.sim.rand() < p.loss) {
      this.dropped++;
      return;
    }

    let travelUs = p.owdUs + (this.sim.rand() * 2 - 1) * p.jitterUs;
    if (this.sim.rand() < p.reorder) travelUs += p.owdUs * (0.5 + this.sim.rand());
    if (travelUs < 0) travelUs = 0;

    const copy = bytes.slice();
    const arriveUs = departUs + Math.round(travelUs);
    this.sim.at(arriveUs, () => {
      this.delivered++;
      this.deliver(copy, arriveUs);
    });

    if (this.sim.rand() < p.dup) {
      this.sim.at(arriveUs + 1500, () => {
        this.delivered++;
        this.deliver(bytes.slice(), arriveUs + 1500);
      });
    }
  }

  /** Kappt die Strecke - fuer Abbruchszenarien. */
  cut() {
    this.p = { ...this.p, loss: 1 };
  }

  restore(profile) {
    this.p = profile;
  }
}
