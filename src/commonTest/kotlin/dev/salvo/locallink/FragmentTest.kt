package dev.salvo.locallink

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class FragmentTest {

    @Test
    fun achtKbUeber180ByteMtu() {
        val h = duo("ble-default", seed = 13)
        val big = ByteArray(8192) { ((it * 31) and 0xff).toByte() }

        h.a.queue(2, big)
        h.run(60_000_000)

        val got = h.receivedB.filter { it.ch == 2 }
        assertEquals(1, got.size, "genau eine Nachricht")
        assertEquals(8192, got[0].payload.size, "Laenge")
        for (i in 0 until 8192) {
            assertEquals(big[i], got[0].payload[i], "Byte $i verfaelscht")
        }
    }

    @Test
    fun fragmentiertUeberlebtStoerumgebung() {
        val h = duo("hostile", seed = 17)
        val big = ByteArray(3000) { 0xab.toByte() }
        h.a.queue(2, big)
        h.run(60_000_000)

        val got = h.receivedB.filter { it.ch == 2 }
        assertEquals(1, got.size, "genau eine Nachricht")
        assertEquals(3000, got[0].payload.size, "Laenge")
        assertTrue(got[0].payload.all { it == 0xab.toByte() }, "Inhalt unveraendert")
    }
}
