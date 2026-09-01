package dev.salvo.locallink

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketException
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Echter WLAN-Transport per UDP - der erste nicht simulierte Transport (P0).
 * Ein Datagramm = ein Paket; genau das erwartet die [Connection] darüber.
 *
 * Ein Hintergrund-Thread liest blockierend vom Socket und legt jedes Paket in
 * eine nebenläufige Queue; [poll] leert sie auf dem Treiber-Thread. Damit ist
 * die nicht thread-sichere [Connection] sauber auf einen Thread gebündelt.
 *
 * UDP selbst bringt keine Zuverlässigkeit/Reihenfolge mit - die liefert die
 * [Connection]. UDP verliert, vertauscht und verdoppelt, also genau das, wogegen
 * das Protokoll ohnehin gebaut ist.
 *
 * Ablauf: erst binden (Konstruktor), dann per [connectTo] auf den Peer zeigen -
 * dessen Port kennt man erst nach der Discovery, und beim direkten Wiring zweier
 * Sockets vermeidet das die Henne-Ei-Reihenfolge.
 *
 * @param localPort eigener Port (0 = frei wählen lassen; [boundPort] verrät ihn)
 * @param mtu       nutzbare Bytes/Paket; LAN verträgt ~1200 problemlos
 */
class UdpTransport(
    localPort: Int = 0,
    override val mtu: Int = 1200,
) : PacketTransport {

    private val socket = DatagramSocket(localPort)
    private val inbox = ConcurrentLinkedQueue<ByteArray>()
    private val running = AtomicBoolean(true)

    @Volatile
    private var remote: InetSocketAddress? = null

    /** Tatsächlich gebundener Port - nützlich, wenn 0 übergeben wurde. */
    val boundPort: Int get() = socket.localPort

    /** Ziel-Peer festlegen (oder wechseln). Vor dem ersten [send] aufrufen. */
    fun connectTo(host: String, port: Int) {
        remote = InetSocketAddress(InetAddress.getByName(host), port)
    }

    private val reader = Thread({
        // Empfangspuffer großzügig über der MTU, damit nichts abgeschnitten wird.
        val buf = ByteArray(maxOf(mtu, 2048))
        while (running.get()) {
            try {
                val dp = DatagramPacket(buf, buf.size)
                socket.receive(dp)
                inbox.add(dp.data.copyOfRange(0, dp.length))
            } catch (_: SocketException) {
                break // Socket geschlossen - Thread beenden.
            } catch (_: Exception) {
                if (!running.get()) break // sonst: verstümmeltes Paket ignorieren
            }
        }
    }, "locallink-udp-recv").apply {
        isDaemon = true
        start()
    }

    override fun send(bytes: ByteArray) {
        val target = remote ?: return
        if (!running.get()) return
        try {
            socket.send(DatagramPacket(bytes, bytes.size, target))
        } catch (_: Exception) {
            // Sende-Fehler (Netz weg) schlucken; die Connection erkennt Verlust selbst.
        }
    }

    override fun poll(): ByteArray? = inbox.poll()

    override fun close() {
        running.set(false)
        socket.close()
    }
}
