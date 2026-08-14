package dev.salvo.locallink

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Der eigentliche Zweck der Referenz (Backlog NP-02): Der Kotlin-Encoder muss
 * fuer dieselben Eingaben Byte fuer Byte dieselben Pakete erzeugen wie die
 * JS-Referenz. Die erwarteten Bytes stammen aus reference/vectors.json.
 */
class WireVectorsTest {

    private fun bytesFromHex(s: String): ByteArray =
        ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun check(name: String, expected: String, bytes: ByteArray) {
        assertEquals(expected, hex(bytes), "Referenzfall '$name'")
    }

    @Test
    fun leeresPaketOhneFlags() {
        check(
            "leeres-paket-ohne-flags", "400000000000000000",
            encodePacket(0, 0, 0, false, 0, null, emptyList()),
        )
    }

    @Test
    fun nurBestaetigung() {
        check(
            "nur-bestaetigung", "42000700050000000f0032",
            encodePacket(7, 5, 15, true, 3200, null, emptyList()),
        )
    }

    @Test
    fun zustandSequenced() {
        check(
            "zustand-sequenced", "43040003fcffffffff0000000f424013038400080102030405060708",
            encodePacket(
                1024, 1020, 0xffffffff.toInt(), true, 0, 1_000_000L,
                listOf(WireMessage(1, 3, 900, null, null, bytesFromHex("0102030405060708"))),
            ),
        )
    }

    @Test
    fun salvoSchuss() {
        check(
            "salvo-schuss", "43002a00290000000100c8000f120632001100086665756572206234",
            encodePacket(
                42, 41, 1, true, 12800, 987654L,
                listOf(WireMessage(3, 2, 17, null, null, text("feuer b4"))),
            ),
        )
    }

    @Test
    fun mehrereKanaeleInEinemPaket() {
        check(
            "mehrere-kanaele-in-einem-paket",
            "43012c012b0000000300010000d9033000020004636170730100030001aa220004000865726569676e6973130005000400000001",
            encodePacket(
                300, 299, 3, true, 64, 55555L,
                listOf(
                    WireMessage(3, 0, 2, null, null, text("caps")),
                    WireMessage(0, 1, 3, null, null, byteArrayOf(0xaa.toByte())),
                    WireMessage(2, 2, 4, null, null, text("ereignis")),
                    WireMessage(1, 3, 5, null, null, bytesFromHex("00000001")),
                ),
            ),
        )
    }

    @Test
    fun fragmentMitte() {
        check(
            "fragment-mitte",
            "430008000700000000000000001092320063010003000c10cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
            encodePacket(
                8, 7, 0, true, 0, 4242L,
                listOf(WireMessage(3, 2, 99, 3, 12, ByteArray(16) { 0xcd.toByte() })),
            ),
        )
    }

    @Test
    fun laengeUeber127() {
        val expected = "43000100000000000000000000000132000100c801" + "5a".repeat(200)
        check(
            "laenge-ueber-127", expected,
            encodePacket(
                1, 0, 0, true, 0, 1L,
                listOf(WireMessage(3, 2, 1, null, null, ByteArray(200) { 0x5a.toByte() })),
            ),
        )
    }

    @Test
    fun sequenznummernAmUeberlauf() {
        check(
            "sequenznummern-am-ueberlauf", "43fffffffe80000000ffffffffffff32ffff000472616e64",
            encodePacket(
                65535, 65534, 0x80000000.toInt(), true, 4194240, 4294967295L,
                listOf(WireMessage(3, 2, 65535, null, null, text("rand"))),
            ),
        )
    }
}
