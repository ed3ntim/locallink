# LocalLink — Referenzimplementierung

Ausführbares Vorbild für die Verbindungsschicht aus dem Salvo-Konzept. Kein
Produktcode: Diese Fassung existiert, damit die Algorithmen **vor** dem Port
nach Kotlin Multiplatform belegt sind statt vermutet.

Warum überhaupt: Weder der iOS-Simulator noch der Android-Emulator können
Bluetooth. Ein Protokoll, das nur auf echten Geräten läuft, wird faktisch nie
automatisch getestet. Diese Referenz löst das mit virtueller Uhr und
simuliertem Transport — 23 Protokolltests laufen in unter einer Sekunde,
vollständig ohne Hardware.

```
node test/run.mjs        # 23 Tests
node bench/run.mjs       # Messläufe über fünf Transportprofile
node tools/vectors.mjs   # Referenzdaten fürs Drahtformat -> vectors.json
```

## Was der Echtzeit-Anspruch am Entwurf geändert hat

Die erste Konzeptfassung sah eine zuverlässige, geordnete Zustellung vor. Für
Schiffeversenken reicht das. Für ein reaktionsintensives Spiel ist es genau
falsch: Geht ein Paket verloren, wartet alles Nachfolgende auf die Wiederholung,
obwohl es längst überholt ist. Vier Änderungen:

| | Vorher | Jetzt |
|---|---|---|
| **Zustellung** | eine Zusage für alles | vier Kanalmodi, die App wählt je Kanal |
| **WLAN-Transport** | mDNS + TCP | mDNS + **UDP**, TCP nur für Massentransfer |
| **Bestätigungen** | eigene ACK-Pakete | reisen im Kopf jedes Pakets mit |
| **Zeit** | nicht vorgesehen | Uhrenabgleich, RTT, Jitter als Erstklassenbürger |

TCP fällt für Echtzeit aus demselben Grund weg wie die eine Zusage: Es stellt
strikt der Reihe nach zu und blockiert damit alles hinter einem verlorenen
Segment. Deshalb bringt LocalLink seine eigene Zuverlässigkeit mit — und kann
sie dort abschalten, wo sie schadet.

### Die vier Kanalmodi

| Modus | Zusage | Wofür |
|---|---|---|
| `UNRELIABLE` | keine | Lebenszeichen, Zielvorschauen |
| `SEQUENCED` | neuestes gewinnt, nie rückwärts | Zustandsschnappschüsse |
| `RELIABLE_UNORDERED` | kommt an | unabhängige Einzelereignisse |
| `RELIABLE_ORDERED` | kommt an, der Reihe nach | Handshake, Spielzüge, Lobby |

`coalesce: true` verwirft beim Einreihen die noch nicht gesendeten älteren
Nachrichten desselben Kanals. Ein Schnappschuss von vor 30 ms interessiert
niemanden mehr.

## Drahtformat

Paketkopf 9 Byte, 15 mit Zeitstempel und Bestätigung. Nachrichtenkopf 4 Byte,
8 als Fragment. Bei einer BLE-MTU von 180 Byte bleiben damit 160 Byte Nutzlast.

```
Paket   u8  Version(2) | Flags(6)        Flags: 0x01 Zeit, 0x02 Ack gültig
        u16 seq
        u16 ack                          nur gültig bei Flag 0x02
        u32 ackBits                      die 32 Pakete vor ack
        u16 ackDelay                     in 64-µs-Schritten, nur bei Flag 0x02
        u32 sendTime                     Mikrosekunden, nur bei Flag 0x01
        Nachricht*

Nachricht u8  Modus(4) | Kanal(4)
          u16 msgSeq
          u8  Flags                      0x01 = Fragment
          u16 fragIndex, u16 fragCount   nur bei Fragment
          var Länge
          …   Nutzdaten
```

Keine Prüfsumme: L2CAP unter BLE und UDP tragen bereits eine.

`vectors.json` enthält acht Referenzfälle mit erwarteten Bytes. Der Kotlin- und
der Swift-Port müssen sie Byte für Byte reproduzieren.

## Drei Fehler, die die Tests aufgedeckt haben

Alle drei hätten auf echter Hardware Tage gekostet, weil sie nur unter Verlust
oder auf ruhigen Kanälen auftreten.

**1 · Die stille Bestätigung von Paket 0.** Vor dem ersten empfangenen Paket
wurde `ack: 0` gesendet — eine Behauptung, Paket 0 bereits erhalten zu haben.
Die Gegenseite strich es daraufhin aus der Wiederholungsliste. Ging es
verloren, war es für immer weg und ein geordneter Kanal blockierte ab da
vollständig: *0 von 60 Nachrichten zugestellt.* Behoben mit einem
Gültigkeitsbit (`FLAG_ACK`).

**2 · Zwei Zeitachsen statt einer.** Beide Seiten schätzten den Uhrenversatz
der jeweils anderen und rechneten darauf um — mit dem Ergebnis, dass ihre
„gemeinsame" Zeit exakt um den Versatz auseinanderlag. Eine gemeinsame
Zeitachse braucht einen Bezugspunkt: Wer die Sitzung eröffnet, gibt die Zeit
vor, die Gegenseite rechnet um.

**3 · Bedenkzeit als Laufzeit gemessen.** Reisen Bestätigungen huckepack,
enthält die gemessene RTT die Zeit, die die Gegenseite das Ack liegen ließ —
auf einem Kanal mit 100 ms Herzschlag also bis zu 100 ms Phantomlatenz. Das
verzerrte RTT und Uhrenabgleich und trieb die Wiederholungsschranke hoch.
Behoben mit einem `ackDelay`-Feld, wie QUIC es führt. Nebenwirkung: Die
Bedenkzeit gehört in die *Schranke*, nicht in die *Schätzung* — sonst
wiederholt ein ruhiger Kanal ständig gegen Verluste, die es nie gab.
Wiederholungen bei 2 % Verlust: **von 49 auf 2**.

## Messergebnisse

Alle Werte aus `bench/run.mjs`, deterministisch reproduzierbar. Gemessen wird
das *Alter der Information*: wie alt der neueste angekommene Zustand gerade
ist. Das ist der Wert, den Spielende als Trägheit spüren.

### Echtzeitspiel, beide Seiten senden Zustände

| Transport | Ziel | Tatsächlich | Alter p50 | Alter p95 | kB/s | Trägt |
|---|---|---|---|---|---|---|
| BLE, Standardintervall | 30 Hz | 14,6 Hz | 102 ms | 140 ms | 0,6 | Party, Puzzle mit Zeitdruck |
| BLE, hohe Priorität | 30 Hz | 29,1 Hz | 68 ms | 87 ms | 1,3 | Action, Reaktion |
| WLAN über Router | 60 Hz | 59,5 Hz | 31 ms | 40 ms | 2,6 | schnelle Action |
| WLAN direkt (Hotspot) | 60 Hz | 59,8 Hz | 28 ms | 36 ms | 2,6 | schnelle Action |
| Störumgebung | 30 Hz | 12,3 Hz | 133 ms | 217 ms | 0,6 | nur rundenbasiert |

### Salvo: Schuss raus, Ergebnis zurück

| Transport | RTT p50 | RTT p95 | Partie gesamt | Dauer | Wiederholungen |
|---|---|---|---|---|---|
| BLE, Standardintervall | 121 ms | 178 ms | 4,6 kB | 7,6 s | 2 |
| BLE, hohe Priorität | 56 ms | 172 ms | 3,9 kB | 3,9 s | 8 |
| WLAN über Router | 13 ms | 21 ms | 3,5 kB | 0,9 s | 2 |
| WLAN direkt (Hotspot) | 7 ms | 9 ms | 3,3 kB | 0,4 s | 0 |
| Störumgebung | 191 ms | 630 ms | 7,5 kB | 16,3 s | 18 |

Eine vollständige Partie kostet **3,3 bis 7,5 kB**. Die Byte-Schätzung aus dem
Konzept hält.

### Warum Sendetaktung nicht verhandelbar ist

Ein Spiel mit 60 Hz schreibt in einen BLE-Transport, der rund 25 Pakete pro
Sekunde durchlässt:

| | Alter p50 | Alter p95 | schlechtester Wert |
|---|---|---|---|
| ohne Bremse | 6144 ms | 11128 ms | 11690 ms |
| mit Bremse | 78 ms | 108 ms | — |

Ohne Bremse stauen sich die überzähligen Pakete im Transport und die Latenz
wächst unbegrenzt — nach 20 Sekunden liegt der Zustand elf Sekunden zurück.
Mit Bremse fällt stattdessen der veraltete Schnappschuss weg. Das ist der
Unterschied zwischen „BLE ist zu langsam für Echtzeit" und „BLE läuft mit
25 Hz".

## Folgerungen für die Architektur

1. **BLE trägt Reaktion, aber nur mit hoher Priorität.** Beim
   Standardintervall bleiben rund 15 Hz übrig — genug für Salvo und
   Party-Spiele, zu wenig für Action. `CONNECTION_PRIORITY_HIGH` unter Android
   und ein kurzes Verbindungsintervall unter iOS sind Pflicht, nicht Feinschliff.
2. **Für alles Schnellere führt kein Weg an WLAN vorbei.** Der Aufstieg von BLE
   auf WLAN rutscht damit von SHOULD auf **MUST** — er ist die einzige Art, wie
   ein reaktionsintensives Spiel plattformübergreifend auf 60 Hz kommt.
3. **Die Sendetaktung muss sich am Transport ausrichten**, nicht an der
   Bildrate des Spiels. Die Verbindung kennt ihre Paketrate und bremst selbst;
   die App darf so oft senden, wie sie mag.
4. **Das Alter der Information gehört ins Diagnose-Overlay**, nicht die
   Bandbreite. Bandbreite war in keinem Profil der Engpass.

## Was hier bewusst fehlt

Vorhersage, Rollback und Interpolation. Das ist Sache des Spiels, nicht der
Verbindung. LocalLink liefert die Grundlage dafür — gemeinsame Zeitbasis,
Zeitstempel je Paket, Sequenznummern, RTT- und Jitter-Schätzung — und hört
dort auf. Ein optionales Modul `locallink-realtime` mit Interpolationspuffer
und Eingaberingpuffer wäre der nächste sinnvolle Schritt, aber erst nachdem
ein echtes Spiel den Bedarf gezeigt hat.

## Stand

| | |
|---|---|
| Kern, Kanäle, Zuverlässigkeit, Fragmentierung | fertig, 23 Tests grün |
| Uhrenabgleich, RTT, Jitter, Sendetaktung | fertig, gemessen |
| Simulationstransport mit Störungsinjektion | fertig |
| Referenzdaten fürs Drahtformat | fertig, 8 Fälle |
| Kotlin-Multiplatform-Port | offen |
| BLE- und UDP-Transport auf echten Geräten | offen — braucht Hardware (P0) |
