package dev.salvo.locallink

import kotlin.math.max
import kotlin.math.roundToLong

/**
 * Simulationstransport. Weder der iOS-Simulator noch der Android-Emulator
 * koennen Bluetooth - ohne einen simulierten Transport liesse sich das
 * Protokoll also nie automatisch testen. Virtuelle Uhr, deterministischer
 * Zufall, nachgebildete Transportprofile.
 */

/** Deterministischer mulberry32-Generator - gleiche Saat, gleicher Lauf. */
class Rng(seed: Int) {
    private var a = seed

    fun next(): Double {
        a += 0x6d2b79f5
        var t = a
        t = (t xor (t ushr 15)) * (t or 1)
        t = t xor (t + ((t xor (t ushr 7)) * (t or 61)))
        val u = t xor (t ushr 14)
        return (u.toLong() and 0xFFFFFFFFL).toDouble() / 4294967296.0
    }
}

/**
 * Ein Transportprofil. Der entscheidende Wert ist nicht die Bandbreite, sondern
 * ratePps: wie viele Pakete pro Sekunde der Transport durchlaesst. Bei BLE
 * bestimmt das Verbindungsintervall diese Zahl.
 */
data class Profile(
    val label: String,
    val owdUs: Int,
    val jitterUs: Int,
    val loss: Double,
    val reorder: Double,
    val dup: Double,
    val ratePps: Int,
    val mtu: Int,
)

val PROFILES: Map<String, Profile> = mapOf(
    "ble-default" to Profile("BLE, Standardintervall", 35_000, 15_000, 0.02, 0.01, 0.002, 25, 180),
    "ble-fast" to Profile("BLE, hohe Prioritaet", 18_000, 8_000, 0.02, 0.01, 0.002, 60, 244),
    "wifi-lan" to Profile("WLAN ueber Router", 6_000, 4_000, 0.01, 0.005, 0.001, 500, 1200),
    "wifi-direct" to Profile("WLAN direkt (Hotspot)", 3_000, 2_000, 0.005, 0.002, 0.001, 1000, 1200),
    "hostile" to Profile("Stoerumgebung", 60_000, 40_000, 0.15, 0.05, 0.02, 20, 180),
)

private class Event(val timeUs: Long, val order: Int, val fn: () -> Unit)

/** Virtuelle Uhr mit Ereigniswarteschlange. */
class Sim(seed: Int = 1) {
    var nowUs = 0L
    val rand = Rng(seed)
    private val queue = ArrayList<Event>()
    private var seq = 0

    fun at(timeUs: Long, fn: () -> Unit) {
        queue.add(Event(timeUs, seq++, fn))
    }

    fun after(delayUs: Long, fn: () -> Unit) = at(nowUs + delayUs, fn)

    /** Arbeitet alle Ereignisse bis untilUs ab. */
    fun runUntil(untilUs: Long) {
        while (queue.isNotEmpty()) {
            queue.sortWith(compareBy({ it.timeUs }, { it.order }))
            if (queue[0].timeUs > untilUs) break
            val ev = queue.removeAt(0)
            nowUs = ev.timeUs
            ev.fn()
        }
        nowUs = untilUs
    }
}

/**
 * Eine Richtung einer simulierten Strecke: Laufzeit, Schwankung, Verlust,
 * Vertauschung, Verdopplung und - am wichtigsten - die Taktgrenze des
 * Transports.
 */
class Link(
    private val sim: Sim,
    private var p: Profile,
    private val deliver: (ByteArray) -> Unit,
) {
    private var nextSlotUs = 0L
    private val slotUs = (1_000_000.0 / p.ratePps).roundToLong()

    var sent = 0
    var dropped = 0
    var delivered = 0

    fun send(bytes: ByteArray) {
        sent++

        // Taktgrenze: fruehestens im naechsten freien Zeitfenster auf die Strecke.
        val departUs = max(sim.nowUs, nextSlotUs)
        nextSlotUs = departUs + slotUs

        if (sim.rand.next() < p.loss) {
            dropped++
            return
        }

        var travelUs = p.owdUs + (sim.rand.next() * 2 - 1) * p.jitterUs
        if (sim.rand.next() < p.reorder) travelUs += p.owdUs * (0.5 + sim.rand.next())
        if (travelUs < 0) travelUs = 0.0

        val copy = bytes.copyOf()
        val arriveUs = departUs + travelUs.roundToLong()
        sim.at(arriveUs) {
            delivered++
            deliver(copy)
        }

        if (sim.rand.next() < p.dup) {
            val dupCopy = bytes.copyOf()
            sim.at(arriveUs + 1500) {
                delivered++
                deliver(dupCopy)
            }
        }
    }

    /** Kappt die Strecke - fuer Abbruchszenarien. */
    fun cut() {
        p = p.copy(loss = 1.0)
    }

    fun restore(profile: Profile) {
        p = profile
    }
}
