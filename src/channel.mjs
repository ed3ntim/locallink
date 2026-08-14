// Kanalmodi.
//
// Der wichtigste Unterschied zur ersten Konzeptfassung: LocalLink liefert
// nicht mehr nur "zuverlaessig und der Reihe nach". Ein reaktionsintensives
// Spiel, das seinen Zustand 30-mal pro Sekunde schickt, wird von genau dieser
// Zusage ruiniert - geht ein Paket verloren, wartet alles Nachfolgende auf die
// Wiederholung, obwohl es laengst ueberholt ist. Das ist Head-of-Line-Blocking,
// und es ist der Grund, warum Echtzeitspiele kein TCP sprechen.
//
// Deshalb waehlt die App den Modus pro Kanal.

/** Feuern und vergessen. Verlust ist egal, Reihenfolge ist egal. */
export const UNRELIABLE = 0;

/** Neuestes gewinnt. Veraltete Nachrichten werden verworfen statt zugestellt. */
export const SEQUENCED = 1;

/** Kommt an, Reihenfolge egal. Fuer unabhaengige Einzelereignisse. */
export const RELIABLE_UNORDERED = 2;

/** Kommt an, in Reihenfolge. Fuer Spielzuege, Lobby, Handshake. */
export const RELIABLE_ORDERED = 3;

export const MODE_NAMES = {
  [UNRELIABLE]: 'UNRELIABLE',
  [SEQUENCED]: 'SEQUENCED',
  [RELIABLE_UNORDERED]: 'RELIABLE_UNORDERED',
  [RELIABLE_ORDERED]: 'RELIABLE_ORDERED',
};

export function isReliable(mode) {
  return mode === RELIABLE_UNORDERED || mode === RELIABLE_ORDERED;
}

/**
 * Empfohlener Zuschnitt fuer ein Spiel. Kanal 0 bis 3 sind reserviert, damit
 * jede App auf denselben Steuerkanaelen redet und die Bibliothek sie kennt.
 */
export const SYSTEM_CHANNELS = {
  CONTROL: 0,   // Handshake, Faehigkeiten, Sitzungsverwaltung  RELIABLE_ORDERED
  HEARTBEAT: 1, // Lebenszeichen und Uhrenabgleich              UNRELIABLE
  EVENTS: 2,    // Spielereignisse, die ankommen muessen        RELIABLE_ORDERED
  STATE: 3,     // Zustandsschnappschuesse, neuestes gewinnt     SEQUENCED
};

export const DEFAULT_CHANNELS = [
  { id: SYSTEM_CHANNELS.CONTROL, mode: RELIABLE_ORDERED, coalesce: false },
  { id: SYSTEM_CHANNELS.HEARTBEAT, mode: UNRELIABLE, coalesce: true },
  { id: SYSTEM_CHANNELS.EVENTS, mode: RELIABLE_ORDERED, coalesce: false },
  { id: SYSTEM_CHANNELS.STATE, mode: SEQUENCED, coalesce: true },
];
