package dev.salvo.locallink

import kotlin.math.roundToLong

/** Eine bei einem Peer zugestellte Nachricht, mit Ankunftszeit. */
class Received(val ch: Int, val payload: ByteArray, val atUs: Long)

/** Zwei Verbindungen ueber eine simulierte Strecke, wie in reference/src/harness.mjs. */
class Duo(
    val sim: Sim,
    val a: Connection,
    val b: Connection,
    val linkAB: Link,
    val linkBA: Link,
    val receivedA: MutableList<Received>,
    val receivedB: MutableList<Received>,
    val clockA: () -> Long,
    val clockB: () -> Long,
    val profile: Profile,
    val tickUs: Long,
) {
    fun run(durationUs: Long) = sim.runUntil(sim.nowUs + durationUs)
}

fun duo(
    profileKey: String,
    seed: Int = 1,
    tickUs: Long? = null,
    skewUs: Long = 0,
    channels: List<ChannelConfig>? = null,
    paceUs: Long = 0,
    heartbeatUs: Long = 100_000,
): Duo {
    val profile = PROFILES[profileKey] ?: error("Unbekanntes Profil $profileKey")
    val sim = Sim(seed)
    val tick = tickUs ?: (1_000_000.0 / profile.ratePps).roundToLong()
    val receivedA = ArrayList<Received>()
    val receivedB = ArrayList<Received>()
    val clockA: () -> Long = { sim.nowUs }
    val clockB: () -> Long = { sim.nowUs + skewUs }

    lateinit var a: Connection
    lateinit var b: Connection
    val linkAB = Link(sim, profile) { bytes -> b.onPacket(bytes, clockB()) }
    val linkBA = Link(sim, profile) { bytes -> a.onPacket(bytes, clockA()) }

    a = Connection(
        mtu = profile.mtu,
        send = { linkAB.send(it) },
        onMessage = { ch, p -> receivedA.add(Received(ch, p, clockA())) },
        channels = channels ?: DEFAULT_CHANNELS,
        name = "A",
        timeMaster = true,
        minSendIntervalUs = paceUs,
    )
    b = Connection(
        mtu = profile.mtu,
        send = { linkBA.send(it) },
        onMessage = { ch, p -> receivedB.add(Received(ch, p, clockB())) },
        channels = channels ?: DEFAULT_CHANNELS,
        name = "B",
        minSendIntervalUs = paceUs,
    )

    fun tickFn() {
        a.update(clockA(), false)
        b.update(clockB(), false)
        sim.after(tick) { tickFn() }
    }
    sim.after(tick) { tickFn() }

    fun beat() {
        a.update(clockA(), true)
        b.update(clockB(), true)
        sim.after(heartbeatUs) { beat() }
    }
    sim.after(heartbeatUs) { beat() }

    return Duo(sim, a, b, linkAB, linkBA, receivedA, receivedB, clockA, clockB, profile, tick)
}

fun text(s: String): ByteArray = s.encodeToByteArray()
fun readText(b: ByteArray): String = b.decodeToString()

fun hex(b: ByteArray): String = b.joinToString("") { ((it.toInt() and 0xff) + 0x100).toString(16).substring(1) }
