package dev.salvo.locallink

import kotlin.test.Test
import kotlin.test.assertEquals

class ResumeTest {

    @Test
    fun keineNachrichtGehtBeiFunkabrissVerloren() {
        val h = duo("ble-fast", seed = 23)

        for (i in 0 until 10) h.a.queue(2, text("vor-$i"))
        h.run(3_000_000)
        assertEquals(10, h.receivedB.size, "vor dem Abriss muessen 10 da sein")

        // Funk weg.
        h.linkAB.cut()
        h.linkBA.cut()
        for (i in 0 until 10) h.a.queue(2, text("waehrend-$i"))
        h.run(5_000_000)
        assertEquals(10, h.receivedB.size, "waehrend des Abrisses kommt nichts an")

        // Funk zurueck.
        h.linkAB.restore(h.profile)
        h.linkBA.restore(h.profile)
        h.run(20_000_000)

        val got = h.receivedB.filter { it.ch == 2 }.map { readText(it.payload) }
        assertEquals(20, got.size, "nach der Wiederaufnahme sind alle 20 da")
        for (i in 0 until 10) assertEquals("waehrend-$i", got[10 + i], "Reihenfolge nach Abriss bei $i")
    }

    @Test
    fun letzteNachrichtVorPauseBleibtNichtHaengen() {
        val h = duo("hostile", seed = 31)
        h.a.queue(2, text("das-letzte-wort"))
        h.run(30_000_000)
        val got = h.receivedB.filter { it.ch == 2 }.map { readText(it.payload) }
        assertEquals(1, got.size, "die einzelne Nachricht muss ankommen")
        assertEquals("das-letzte-wort", got[0])
    }
}
