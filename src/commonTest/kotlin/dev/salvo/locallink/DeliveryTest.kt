package dev.salvo.locallink

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DeliveryTest {

    @Test
    fun reliableOrderedLiefertAllesGenauEinmalInReihenfolge() {
        val h = duo("hostile", seed = 7)
        for (i in 0 until 60) h.a.queue(2, text("zug-$i"))
        h.run(30_000_000)

        val got = h.receivedB.filter { it.ch == 2 }.map { readText(it.payload) }
        assertEquals(60, got.size, "Anzahl zugestellter Nachrichten")
        for (i in 0 until 60) assertEquals("zug-$i", got[i], "Reihenfolge bei $i")
        assertTrue(h.a.stats.retransmits > 0, "bei 15 % Verlust muss wiederholt worden sein")
    }

    @Test
    fun reliableUnorderedLiefertAlles() {
        val h = duo("hostile", seed = 11, channels = listOf(ChannelConfig(2, ChannelMode.RELIABLE_UNORDERED)))
        for (i in 0 until 40) h.a.queue(2, text("e$i"))
        h.run(30_000_000)

        val got = h.receivedB.map { readText(it.payload) }.toSet()
        assertEquals(40, got.size, "jede Nachricht genau einmal")
    }

    @Test
    fun sequencedVerwirftUeberholtes() {
        val h = duo("hostile", seed = 3, channels = listOf(ChannelConfig(3, ChannelMode.SEQUENCED, coalesce = false)))

        var n = 0
        fun push() {
            if (n < 100) {
                h.a.queue(3, text(n.toString()))
                n++
                h.sim.after(h.tickUs) { push() }
            }
        }
        h.sim.after(h.tickUs) { push() }
        h.run(30_000_000)

        val got = h.receivedB.map { readText(it.payload).toInt() }
        assertTrue(got.isNotEmpty(), "es muss etwas ankommen")
        for (i in 1 until got.size) {
            assertTrue(got[i] > got[i - 1], "Schnappschuss ${got[i]} nach ${got[i - 1]} - nie rueckwaerts")
        }
        assertTrue(got.size < 100, "bei 15 % Verlust darf nicht alles ankommen")
    }

    @Test
    fun unreliableWiederholtNiemals() {
        val h = duo("hostile", seed = 5, channels = listOf(ChannelConfig(1, ChannelMode.UNRELIABLE)))
        var n = 0
        fun push() {
            if (n < 120) {
                h.a.queue(1, text("x$n"))
                n++
                h.sim.after(h.tickUs) { push() }
            }
        }
        h.sim.after(h.tickUs) { push() }
        h.run(30_000_000)

        assertEquals(0, h.a.stats.retransmits, "keine Wiederholungen")
        assertTrue(h.receivedB.size > 60, "zu wenig angekommen: ${h.receivedB.size}")
        assertTrue(h.receivedB.size < 120, "bei 15 % Verlust darf nicht alles ankommen: ${h.receivedB.size}")
    }

    @Test
    fun doppeltePaketeWerdenErkannt() {
        val h = duo("hostile", seed = 21)
        for (i in 0 until 40) h.a.queue(2, text("d$i"))
        h.run(30_000_000)

        val got = h.receivedB.filter { it.ch == 2 }.map { readText(it.payload) }
        assertEquals(got.size, got.toSet().size, "keine Nachricht doppelt zugestellt")
        assertEquals(40, got.size, "aber alle da")
    }

    @Test
    fun coalesceVerwirftVeralteteSchnappschuesse() {
        val h = duo("ble-default", seed = 2, channels = listOf(ChannelConfig(3, ChannelMode.SEQUENCED, coalesce = true)))
        for (i in 0 until 10) h.a.queue(3, text("s$i"))
        h.run(2_000_000)

        val got = h.receivedB.map { readText(it.payload) }
        assertEquals(1, got.size, "nur ein Schnappschuss geht hinaus")
        assertEquals("s9", got[0], "und zwar der neueste")
        assertTrue(h.a.stats.messagesDroppedStale >= 9, "die anderen neun wurden verworfen")
    }
}
