package dev.salvo.locallink

import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertTrue

class TimingTest {

    @Test
    fun rttSchaetzungNaehertDoppelteLaufzeit() {
        val h = duo("wifi-lan", seed = 4)
        h.run(10_000_000)
        val q = h.a.quality()
        assertTrue(q.rttMs != null, "es muss eine Schaetzung geben")
        assertTrue(q.rttMs!! > 8 && q.rttMs!! < 40, "RTT ${q.rttMs} ms liegt ausserhalb des Erwartbaren")
        assertTrue(q.minRttMs!! <= q.rttMs!! + 0.01, "minRtt darf nicht ueber srtt liegen")
    }

    @Test
    fun uhrenversatzWirdErkannt() {
        val h = duo("wifi-lan", seed = 9, skewUs = 250_000)
        h.run(20_000_000)

        val q = h.a.quality()
        assertTrue(q.clockOffsetMs != null, "Versatz muss geschaetzt werden")
        val errMs = abs(abs(q.clockOffsetMs!!) - 250.0)
        assertTrue(errMs < 12, "Schaetzfehler ${errMs} ms ist zu gross")
    }

    @Test
    fun gemeinsameZeitbasisStimmtAufBeidenSeiten() {
        val h = duo("wifi-direct", seed = 6, skewUs = 120_000)
        h.run(20_000_000)

        val sharedA = h.a.sharedNowUs(h.clockA())
        val sharedB = h.b.sharedNowUs(h.clockB())
        assertTrue(sharedA != null && sharedB != null, "beide Seiten brauchen eine Schaetzung")
        val spreadMs = abs(sharedA!! - sharedB!!) / 1000.0
        assertTrue(spreadMs < 12, "gemeinsame Zeit weicht um ${spreadMs} ms ab")
    }

    @Test
    fun jitterKleinerBeiWlanAlsBle() {
        val lan = duo("wifi-lan", seed = 8)
        lan.run(20_000_000)
        val ble = duo("ble-default", seed = 8)
        ble.run(20_000_000)

        val j1 = lan.a.quality().jitterMs
        val j2 = ble.a.quality().jitterMs
        assertTrue(j1 > 0 && j2 > 0, "beide messen Jitter")
        assertTrue(j2 > j1, "BLE-Jitter $j2 muss ueber WLAN-Jitter $j1 liegen")
    }
}
