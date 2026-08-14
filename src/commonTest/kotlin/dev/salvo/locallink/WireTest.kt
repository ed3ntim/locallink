package dev.salvo.locallink

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class WireTest {

    @Test
    fun paketUeberlebtKodierenUndDekodieren() {
        val bytes = encodePacket(
            seq = 4242, ack = 4200, ackBits = 0xdeadbeef.toInt(),
            hasAck = false, ackDelayUs = 0, sendTimeUs = 123456789L,
            messages = listOf(
                WireMessage(ChannelMode.RELIABLE_ORDERED, 2, 7, null, null, text("feuer b4")),
                WireMessage(ChannelMode.SEQUENCED, 3, 9, null, null, text("zustand")),
            ),
        )
        val p = decodePacket(bytes)
        assertEquals(4242, p.seq, "seq")
        assertEquals(4200, p.ack, "ack")
        assertEquals(0xdeadbeef.toInt(), p.ackBits, "ackBits")
        assertEquals(123456789L, p.sendTimeUs, "sendTime")
        assertEquals(2, p.messages.size, "Anzahl Nachrichten")
        assertEquals("feuer b4", readText(p.messages[0].payload))
        assertEquals(3, p.messages[1].channel, "Kanal")
        assertEquals(ChannelMode.SEQUENCED, p.messages[1].mode, "Modus")
    }

    @Test
    fun fragmentkopfUeberlebt() {
        val bytes = encodePacket(
            seq = 1, ack = 0, ackBits = 0, hasAck = false, ackDelayUs = 0, sendTimeUs = null,
            messages = listOf(WireMessage(ChannelMode.RELIABLE_ORDERED, 0, 3, 5, 9, text("teil"))),
        )
        val p = decodePacket(bytes)
        assertEquals(null, p.sendTimeUs, "kein Zeitstempel")
        assertEquals(5, p.messages[0].fragIndex, "fragIndex")
        assertEquals(9, p.messages[0].fragCount, "fragCount")
    }

    @Test
    fun kopfgroesseImBudgetFuerBle() {
        val leer = listOf(WireMessage(0, 0, 1, null, null, ByteArray(0)))
        // Ohne Ack, mit Zeit: 13 Byte Kopf + 4 Nachrichtenkopf + 1 Laenge
        assertEquals(18, encodePacket(1, 1, 0, false, 0, 1L, leer).size, "ohne Ack")
        // Voll bestueckt: 15 Byte Kopf + 4 + 1
        assertEquals(20, encodePacket(1, 1, 0, true, 3200, 1L, leer).size, "mit Ack und Zeit")
    }

    @Test
    fun ackVerzugUeberlebt() {
        val p = decodePacket(encodePacket(1, 2, 0, true, 100_000, 5L, emptyList()))
        assertTrue(p.hasAck, "Ack-Flag gesetzt")
        // 64-us-Raster: 100000/64 = 1562,5 -> 1563 -> 100032
        assertTrue(kotlin.math.abs(p.ackDelayUs - 100_000) <= 64, "Verzug ${p.ackDelayUs} zu ungenau")
    }

    @Test
    fun ohneAckFlagKeinVerzug() {
        val p = decodePacket(encodePacket(1, 0, 0, false, 0, 5L, emptyList()))
        assertFalse(p.hasAck, "kein Ack-Flag")
        assertEquals(0, p.ackDelayUs, "Verzug ist null")
    }

    @Test
    fun varintKleinIstEinByte() {
        assertEquals(1, varintSize(0))
        assertEquals(1, varintSize(127))
        assertEquals(2, varintSize(128))
        assertEquals(2, varintSize(16383))
        assertEquals(3, varintSize(16384))
    }

    @Test
    fun varintSchreibtUndLiest() {
        for (v in listOf(0, 1, 127, 128, 300, 65535, 1 shl 20, (1 shl 28) - 1)) {
            val w = Writer(8)
            w.varint(v)
            assertEquals(v, Reader(w.finish()).varint(), "varint $v")
        }
    }

    @Test
    fun sequenzvergleichUeberDenUeberlauf() {
        assertTrue(seqGreaterThan(1, 0), "1 > 0")
        assertTrue(seqGreaterThan(0, 65535), "0 > 65535 nach Ueberlauf")
        assertFalse(seqGreaterThan(65535, 0), "65535 nicht > 0")
        assertEquals(1, seqDistance(0, 65535), "Abstand ueber den Ueberlauf")
        assertEquals(-1, seqDistance(65535, 0), "Abstand rueckwaerts")
    }

    @Test
    fun verstuemmeltesPaketWirft() {
        var threw = false
        try {
            decodePacket(byteArrayOf(0x40.toByte(), 0x00.toByte()))
        } catch (e: Exception) {
            threw = true
        }
        assertTrue(threw, "zu kurzes Paket muss auffallen")
    }
}
