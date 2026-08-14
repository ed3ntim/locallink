package dev.salvo.locallink

/**
 * Kanalmodi. Die App waehlt pro Kanal, welche Zusage sie braucht - genau das
 * verhindert, dass ein reaktionsintensives Spiel an der Zuverlaessigkeit eines
 * einzelnen verlorenen Pakets haengen bleibt (Head-of-Line-Blocking).
 */
object ChannelMode {
    /** Feuern und vergessen. Verlust egal, Reihenfolge egal. */
    const val UNRELIABLE = 0

    /** Neuestes gewinnt. Veraltete Nachrichten werden verworfen. */
    const val SEQUENCED = 1

    /** Kommt an, Reihenfolge egal. */
    const val RELIABLE_UNORDERED = 2

    /** Kommt an, in Reihenfolge. */
    const val RELIABLE_ORDERED = 3

    fun isReliable(mode: Int): Boolean =
        mode == RELIABLE_UNORDERED || mode == RELIABLE_ORDERED

    fun name(mode: Int): String = when (mode) {
        UNRELIABLE -> "UNRELIABLE"
        SEQUENCED -> "SEQUENCED"
        RELIABLE_UNORDERED -> "RELIABLE_UNORDERED"
        RELIABLE_ORDERED -> "RELIABLE_ORDERED"
        else -> "UNKNOWN($mode)"
    }
}

/** Konfiguration eines Kanals. */
class ChannelConfig(
    val id: Int,
    val mode: Int,
    val coalesce: Boolean = false,
)

/**
 * Reservierte Steuerkanaele, damit jede App auf denselben Kanaelen redet und
 * die Bibliothek sie kennt.
 */
object SystemChannels {
    const val CONTROL = 0    // Handshake, Faehigkeiten       RELIABLE_ORDERED
    const val HEARTBEAT = 1  // Lebenszeichen, Uhrenabgleich  UNRELIABLE
    const val EVENTS = 2     // Spielereignisse               RELIABLE_ORDERED
    const val STATE = 3      // Zustandsschnappschuesse        SEQUENCED
}

val DEFAULT_CHANNELS: List<ChannelConfig> = listOf(
    ChannelConfig(SystemChannels.CONTROL, ChannelMode.RELIABLE_ORDERED, coalesce = false),
    ChannelConfig(SystemChannels.HEARTBEAT, ChannelMode.UNRELIABLE, coalesce = true),
    ChannelConfig(SystemChannels.EVENTS, ChannelMode.RELIABLE_ORDERED, coalesce = false),
    ChannelConfig(SystemChannels.STATE, ChannelMode.SEQUENCED, coalesce = true),
)
