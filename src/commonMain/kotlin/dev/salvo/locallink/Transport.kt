package dev.salvo.locallink

/**
 * Roher Paket-Transport zwischen zwei Geräten: bewegt Datagramme, sonst nichts.
 * Kennt weder Kanäle noch Zuverlässigkeit - das macht die [Connection] darüber.
 * Die konkreten Impls liefern das Wie (UDP über WLAN, GATT über BLE …) je
 * Plattform.
 *
 * Zustellung läuft über [poll]: der Transport sammelt ankommende Pakete in einer
 * eigenen (ggf. nebenläufigen) Warteschlange, der Treiber-Thread holt sie hier
 * ab und reicht sie an [Connection.onPacket]. So bleibt die nicht thread-sichere
 * [Connection] auf genau einem Thread - Empfang und [Connection.update] wechseln
 * sich dort ab.
 */
interface PacketTransport {
    /** Nutzbare Bytes pro Paket - deckt sich mit [Connection.mtu]. */
    val mtu: Int

    /** Ein rohes Paket zum Peer schicken. */
    fun send(bytes: ByteArray)

    /** Nächstes empfangenes Rohpaket, oder null wenn nichts anliegt. Nicht blockierend. */
    fun poll(): ByteArray?

    /** Strecke schließen und Ressourcen (Sockets, Threads) freigeben. */
    fun close()
}

/**
 * Treibt eine [Connection] gegen einen [PacketTransport] für einen Tick weiter:
 * erst alle wartenden Pakete einspeisen, dann höchstens ein Paket senden. Der
 * Aufrufer bestimmt den Takt (Coroutine-Schleife in der App, Testschleife im
 * Test) und die Uhr [nowUs]. Auf demselben Thread aufrufen, auf dem die
 * [Connection] lebt.
 */
fun Connection.pump(transport: PacketTransport, nowUs: Long, force: Boolean = false) {
    var pkt = transport.poll()
    while (pkt != null) {
        onPacket(pkt, nowUs)
        pkt = transport.poll()
    }
    update(nowUs, force)
}
