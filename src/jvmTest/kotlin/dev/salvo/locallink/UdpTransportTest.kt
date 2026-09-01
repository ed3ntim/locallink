package dev.salvo.locallink

import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Erster nicht simulierter Transport: zwei [Connection]s reden über zwei echte
 * UDP-Sockets auf localhost. Belegt, dass die Zuverlässigkeits-/Fragment-Schicht
 * auch über echtes UDP (verlustbehaftet, unsortiert) trägt - nicht nur über den
 * Sim-Transport. BLE bleibt Hardware-gebunden; UDP ist hier voll testbar.
 */
class UdpTransportTest {

    private fun nowUs() = System.nanoTime() / 1000

    @Test
    fun reliableAndFragmentedMessagesOverLocalhostUdp() {
        val mtu = 1200
        val ta = UdpTransport(mtu = mtu)
        val tb = UdpTransport(mtu = mtu)
        ta.connectTo("127.0.0.1", tb.boundPort)
        tb.connectTo("127.0.0.1", ta.boundPort)

        val gotA = ArrayList<String>()
        val gotB = ArrayList<String>()

        val a = Connection(
            mtu = mtu,
            send = { ta.send(it) },
            onMessage = { _, p -> gotA.add(p.decodeToString()) },
            name = "A",
            timeMaster = true,
        )
        val b = Connection(
            mtu = mtu,
            send = { tb.send(it) },
            onMessage = { _, p -> gotB.add(p.decodeToString()) },
            name = "B",
        )

        try {
            a.queue(SystemChannels.EVENTS, "hallo von A".encodeToByteArray())
            b.queue(SystemChannels.EVENTS, "servus von B".encodeToByteArray())
            // Über die MTU hinaus -> wird fragmentiert und über echtes UDP wieder zusammengesetzt.
            val big = "x".repeat(5000)
            a.queue(SystemChannels.EVENTS, big.encodeToByteArray())

            val deadline = System.currentTimeMillis() + 5000
            while (System.currentTimeMillis() < deadline) {
                val t = nowUs()
                a.pump(ta, t, force = true)
                b.pump(tb, t, force = true)
                if (gotA.size >= 1 && gotB.size >= 2) break
                Thread.sleep(3)
            }

            assertTrue("B empfängt A's Nachricht; got=$gotB") { "hallo von A" in gotB }
            assertTrue("A empfängt B's Nachricht; got=$gotA") { "servus von B" in gotA }
            assertTrue("B setzt die fragmentierte Nachricht (${big.length} B) zusammen") { big in gotB }
        } finally {
            ta.close()
            tb.close()
        }
    }
}
