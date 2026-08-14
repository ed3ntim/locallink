package dev.salvo.locallink

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

private const val ACK_WINDOW = 32
private const val DEDUPE_WINDOW = 1024
private const val MIN_RTO_US = 40_000.0
private const val MAX_RTO_US = 2_000_000.0

/** Laufzeitzustand eines Kanals auf Sende- und Empfangsseite. */
private class ChannelState(val id: Int, val mode: Int, val coalesce: Boolean) {
    var outSeq = 0
    var lastDelivered = -1                       // fuer SEQUENCED
    var nextExpected = 0                          // fuer RELIABLE_ORDERED
    val orderBuffer = HashMap<Int, ByteArray>()
    val seen = HashSet<String>()
    var seenHigh = -1
}

private class SentPacket(val sentAtUs: Long, val msgIds: List<String>)

private class FragmentEntry(val count: Int) {
    val parts = arrayOfNulls<ByteArray>(count)
    var have = 0
    var bytes = 0
}

private class Arrival(val remoteSend: Long, val localRecv: Long)

class ConnectionStats {
    var packetsSent = 0
    var packetsReceived = 0
    var packetsLost = 0
    var bytesSent = 0L
    var bytesReceived = 0L
    var messagesQueued = 0
    var messagesDelivered = 0
    var messagesDroppedStale = 0
    var retransmits = 0
    var duplicatesIgnored = 0
}

/** Momentaufnahme fuer das Diagnose-Overlay und die Tests. */
class Quality(
    val rttMs: Double?,
    val minRttMs: Double?,
    val jitterMs: Double,
    val rtoMs: Double,
    val clockOffsetMs: Double?,
    val inFlight: Int,
    val unackedMessages: Int,
    val pending: Int,
)

/**
 * Eine Verbindung zwischen zwei Geraeten. Weiss nichts ueber Bluetooth, WLAN
 * oder Schiffe: bekommt eine Sendefunktion und rohe Pakete herein, liefert
 * vollstaendige Nachrichten heraus.
 *
 * @param mtu               Nutzbare Bytes pro Transportpaket
 * @param send              Rohausgang zum Transport
 * @param onMessage         (Kanal, Nutzdaten) fuer jede zugestellte Nachricht
 * @param channels          Kanalkonfiguration
 * @param timeMaster        Wer die Sitzung eroeffnet, gibt die gemeinsame Zeit vor
 * @param minSendIntervalUs Sendetaktung auf die Paketrate des Transports
 */
class Connection(
    val mtu: Int,
    private val send: (ByteArray) -> Unit,
    private val onMessage: (Int, ByteArray) -> Unit,
    channels: List<ChannelConfig> = DEFAULT_CHANNELS,
    val name: String = "peer",
    val timeMaster: Boolean = false,
    private val minSendIntervalUs: Long = 0,
) {
    private val channels = LinkedHashMap<Int, ChannelState>()

    // Sendeseite
    private var outSeq = 0
    private val pending = ArrayList<WireMessage>()
    private val sentPackets = LinkedHashMap<Int, SentPacket>()
    private val unacked = LinkedHashMap<String, WireMessage>()
    private var lastSendUs = Long.MIN_VALUE / 4

    // Empfangsseite
    private var remoteSeq = -1
    private var remoteBits = 0
    private var remoteSeqAtUs: Long? = null
    private var ackPending = false
    private val fragments = LinkedHashMap<String, FragmentEntry>()

    // Zeitmessung
    private var srttUs: Double? = null
    private var rttVarUs = 0.0
    private var rtoUs = 500_000.0
    private var minRttUs = Double.POSITIVE_INFINITY
    private var jitterUs = 0.0
    private var clockOffsetUs: Double? = null
    private var minRawOffsetUs = Double.POSITIVE_INFINITY
    private var lastArrival: Arrival? = null
    private var peerAckDelayUs = 0.0

    val stats = ConnectionStats()

    init {
        for (c in channels) {
            this.channels[c.id] = ChannelState(c.id, c.mode, c.coalesce)
        }
    }

    // ---------------------------------------------------------------- senden

    /**
     * Stellt eine Nachricht in die Warteschlange. Sie geht beim naechsten
     * update() hinaus, nicht sofort - so passen mehrere kleine Nachrichten in
     * ein Paket. Liefert die Nachrichtennummer im Kanal.
     */
    fun queue(channelId: Int, payload: ByteArray): Int {
        val ch = channels[channelId]
            ?: throw IllegalArgumentException("Kanal $channelId ist nicht konfiguriert")

        // Zusammenfassende Kanaele: das Neue ersetzt das noch nicht gesendete Alte.
        if (ch.coalesce) {
            val before = pending.size
            pending.removeAll { it.channel == channelId }
            stats.messagesDroppedStale += before - pending.size
        }

        val msgSeq = ch.outSeq
        ch.outSeq = nextSeq(ch.outSeq)
        stats.messagesQueued++

        if (payload.size <= wholePayloadBudget()) {
            pending.add(WireMessage(ch.mode, channelId, msgSeq, null, null, payload))
            return msgSeq
        }

        // Zu gross fuer ein Paket: in Fragmente zerlegen.
        val budget = fragmentPayloadBudget()
        val fragCount = (payload.size + budget - 1) / budget
        if (fragCount > 0xffff) throw IllegalArgumentException("Nachricht zu gross")
        for (i in 0 until fragCount) {
            val from = i * budget
            val to = min((i + 1) * budget, payload.size)
            pending.add(WireMessage(ch.mode, channelId, msgSeq, i, fragCount, payload.copyOfRange(from, to)))
        }
        return msgSeq
    }

    private fun wholePayloadBudget() = mtu - PACKET_HEADER_MAX_BYTES - MESSAGE_HEADER_BYTES - 3
    private fun fragmentPayloadBudget() = mtu - PACKET_HEADER_MAX_BYTES - MESSAGE_HEADER_BYTES_FRAGMENT - 3

    /**
     * Packt und sendet hoechstens ein Paket. Wird im Takt des Transports
     * gerufen. force = true sendet auch ohne anstehende Nutzlast (Lebenszeichen).
     */
    fun update(nowUs: Long, force: Boolean = false): Boolean {
        detectLoss(nowUs)

        if (pending.isEmpty() && !force && !ackPending) return false
        if (nowUs - lastSendUs < minSendIntervalUs) return false

        val seq = outSeq
        var used = PACKET_HEADER_MAX_BYTES
        val carried = ArrayList<WireMessage>()
        val msgIds = ArrayList<String>()

        // FIFO. Wiederholungen stehen bereits vorn (siehe detectLoss).
        val keep = ArrayList<WireMessage>()
        for (m in pending) {
            val overhead =
                (if (m.fragCount == null) MESSAGE_HEADER_BYTES else MESSAGE_HEADER_BYTES_FRAGMENT) +
                    varintSize(m.payload.size)
            if (used + overhead + m.payload.size > mtu) {
                keep.add(m)
                continue
            }
            used += overhead + m.payload.size
            carried.add(m)
            if (ChannelMode.isReliable(m.mode)) {
                val id = msgId(m)
                unacked[id] = m
                msgIds.add(id)
            }
        }
        pending.clear()
        pending.addAll(keep)

        if (carried.isEmpty() && !force && !ackPending) return false
        ackPending = false

        val ackDelay = remoteSeqAtUs?.let {
            (nowUs - it).coerceIn(0, ACK_DELAY_MAX_US.toLong()).toInt()
        } ?: 0

        val bytes = encodePacket(
            seq = seq,
            ack = if (remoteSeq < 0) 0 else remoteSeq,
            ackBits = remoteBits,
            hasAck = remoteSeq >= 0,
            ackDelayUs = ackDelay,
            sendTimeUs = nowUs,
            messages = carried,
        )

        sentPackets[seq] = SentPacket(nowUs, msgIds)
        outSeq = nextSeq(outSeq)
        lastSendUs = nowUs
        stats.packetsSent++
        stats.bytesSent += bytes.size
        send(bytes)
        return true
    }

    // -------------------------------------------------------------- empfangen

    /** Nimmt ein rohes Paket vom Transport entgegen. */
    fun onPacket(bytes: ByteArray, nowUs: Long) {
        val pkt = try {
            decodePacket(bytes)
        } catch (e: Exception) {
            return // Verstuemmeltes Paket stillschweigend verwerfen.
        }

        stats.packetsReceived++
        stats.bytesReceived += bytes.size

        recordArrival(pkt, nowUs)
        processAcks(pkt, nowUs)

        for (m in pkt.messages) {
            if (ChannelMode.isReliable(m.mode)) ackPending = true
            receiveMessage(m, nowUs)
        }
    }

    private fun recordArrival(pkt: DecodedPacket, nowUs: Long) {
        when {
            remoteSeq < 0 -> {
                remoteSeq = pkt.seq
                remoteBits = 0
                remoteSeqAtUs = nowUs
            }
            seqGreaterThan(pkt.seq, remoteSeq) -> {
                val shift = seqDistance(pkt.seq, remoteSeq)
                remoteBits = if (shift >= 32) 0 else (remoteBits shl shift) or (1 shl (shift - 1))
                remoteSeq = pkt.seq
                remoteSeqAtUs = nowUs
            }
            else -> {
                val back = seqDistance(remoteSeq, pkt.seq)
                if (back in 1..ACK_WINDOW) remoteBits = remoteBits or (1 shl (back - 1))
            }
        }

        val sendTime = pkt.sendTimeUs ?: return

        // Jitter nach RFC 3550: Schwankung des Abstands Senden-Ankommen.
        lastArrival?.let { la ->
            val d = (nowUs - la.localRecv) - (sendTime - la.remoteSend)
            jitterUs += (abs(d).toDouble() - jitterUs) / 16.0
        }
        lastArrival = Arrival(sendTime, nowUs)

        // Uhrenversatz: Minimum ueber viele Pakete kommt der Wahrheit am naechsten.
        val rawOffset = (nowUs - sendTime).toDouble()
        if (rawOffset < minRawOffsetUs) minRawOffsetUs = rawOffset
        if (minRttUs != Double.POSITIVE_INFINITY) {
            clockOffsetUs = minRawOffsetUs - minRttUs / 2.0
        }
    }

    private fun processAcks(pkt: DecodedPacket, nowUs: Long) {
        // Ohne gueltiges Ack sind ack/ackBits Fuellwerte - nicht auswerten.
        if (!pkt.hasAck) return

        // Spitzenwert halten, zuegig loslassen (siehe Kommentar in der Referenz).
        peerAckDelayUs =
            if (pkt.ackDelayUs.toDouble() > peerAckDelayUs) pkt.ackDelayUs.toDouble()
            else peerAckDelayUs * 0.9 + pkt.ackDelayUs * 0.1

        fun confirm(seq: Int, measureRtt: Boolean) {
            val rec = sentPackets.remove(seq) ?: return
            if (measureRtt) {
                val rttUs = nowUs - rec.sentAtUs - pkt.ackDelayUs
                if (rttUs >= 0) updateRtt(rttUs.toDouble())
            }
            for (id in rec.msgIds) unacked.remove(id)
        }

        confirm(pkt.ack, true)
        for (i in 0 until ACK_WINDOW) {
            if (pkt.ackBits and (1 shl i) != 0) {
                confirm((pkt.ack - (i + 1) + 0x10000) % 0x10000, false)
            }
        }
    }

    /** Jacobson/Karels, wie bei TCP. Bedenkzeit der Gegenseite fliesst in die Schranke, nicht in die Schaetzung. */
    private fun updateRtt(rttUs: Double) {
        if (rttUs < minRttUs) minRttUs = rttUs
        val s = srttUs
        if (s == null) {
            srttUs = rttUs
            rttVarUs = rttUs / 2.0
        } else {
            val delta = abs(s - rttUs)
            rttVarUs = 0.75 * rttVarUs + 0.25 * delta
            srttUs = 0.875 * s + 0.125 * rttUs
        }
        val budget = srttUs!! + 4.0 * rttVarUs + peerAckDelayUs
        rtoUs = min(MAX_RTO_US, max(MIN_RTO_US, budget))
    }

    /**
     * Erkennt Verlust ueber das Bestaetigungsfenster (schnell) und eine
     * Zeitschranke (langsam, greift wenn es still wird).
     */
    private fun detectLoss(nowUs: Long) {
        if (sentPackets.isEmpty()) return

        val lost = ArrayList<Pair<Int, SentPacket>>()
        for ((seq, rec) in sentPackets) {
            val tooOld = seqDistance(outSeq, seq) > ACK_WINDOW + 1
            val timedOut = (nowUs - rec.sentAtUs).toDouble() > rtoUs
            if (tooOld || timedOut) lost.add(seq to rec)
        }
        if (lost.isEmpty()) return

        val requeue = ArrayList<WireMessage>()
        for ((seq, rec) in lost) {
            sentPackets.remove(seq)
            stats.packetsLost++
            for (id in rec.msgIds) {
                val m = unacked[id] ?: continue
                unacked.remove(id)
                requeue.add(m)
                stats.retransmits++
            }
        }

        if (requeue.isNotEmpty()) {
            requeue.sortWith { a, b -> seqDistance(a.msgSeq, b.msgSeq) }
            pending.addAll(0, requeue)
        }
    }

    // ------------------------------------------------------------- zustellung

    private fun receiveMessage(m: WireMessage, nowUs: Long) {
        val ch = channels[m.channel] ?: return

        if (ChannelMode.isReliable(ch.mode)) {
            val key = if (m.fragCount == null) "${m.msgSeq}" else "${m.msgSeq}#${m.fragIndex}"
            if (ch.seen.contains(key)) {
                stats.duplicatesIgnored++
                return
            }
            ch.seen.add(key)
            if (seqGreaterThan(m.msgSeq, ch.seenHigh) || ch.seenHigh < 0) ch.seenHigh = m.msgSeq
            if (ch.seen.size > DEDUPE_WINDOW * 2) {
                val stale = ch.seen.filter {
                    seqDistance(ch.seenHigh, it.substringBefore('#').toInt()) > DEDUPE_WINDOW
                }
                ch.seen.removeAll(stale.toSet())
            }
        }

        val payload = if (m.fragCount == null) m.payload else reassemble(m) ?: return
        deliver(ch, m.msgSeq, payload)
    }

    private fun reassemble(m: WireMessage): ByteArray? {
        val key = "${m.channel}:${m.msgSeq}"
        val entry = fragments.getOrPut(key) { FragmentEntry(m.fragCount!!) }
        val idx = m.fragIndex!!
        if (entry.parts[idx] != null) return null // Doppel
        entry.parts[idx] = m.payload
        entry.have++
        entry.bytes += m.payload.size
        if (entry.have < entry.count) return null

        fragments.remove(key)
        val out = ByteArray(entry.bytes)
        var pos = 0
        for (part in entry.parts) {
            part!!.copyInto(out, pos)
            pos += part.size
        }
        return out
    }

    private fun deliver(ch: ChannelState, msgSeq: Int, payload: ByteArray) {
        when (ch.mode) {
            ChannelMode.UNRELIABLE -> emit(ch, payload)

            ChannelMode.SEQUENCED -> {
                if (ch.lastDelivered >= 0 && !seqGreaterThan(msgSeq, ch.lastDelivered)) {
                    stats.messagesDroppedStale++
                    return
                }
                ch.lastDelivered = msgSeq
                emit(ch, payload)
            }

            ChannelMode.RELIABLE_ORDERED -> {
                if (seqDistance(msgSeq, ch.nextExpected) < 0) return // laengst geliefert
                ch.orderBuffer[msgSeq] = payload
                while (ch.orderBuffer.containsKey(ch.nextExpected)) {
                    val next = ch.orderBuffer.remove(ch.nextExpected)!!
                    ch.nextExpected = nextSeq(ch.nextExpected)
                    emit(ch, next)
                }
            }

            else -> emit(ch, payload) // RELIABLE_UNORDERED
        }
    }

    private fun emit(ch: ChannelState, payload: ByteArray) {
        stats.messagesDelivered++
        onMessage(ch.id, payload)
    }

    // ------------------------------------------------------------- diagnostik

    fun quality(): Quality = Quality(
        rttMs = srttUs?.let { it / 1000.0 },
        minRttMs = if (minRttUs == Double.POSITIVE_INFINITY) null else minRttUs / 1000.0,
        jitterMs = jitterUs / 1000.0,
        rtoMs = rtoUs / 1000.0,
        clockOffsetMs = clockOffsetUs?.let { it / 1000.0 },
        inFlight = sentPackets.size,
        unackedMessages = unacked.size,
        pending = pending.size,
    )

    /** Gemeinsame Zeitbasis beider Geraete - beide liefern die Uhr des Zeitgebers. */
    fun sharedNowUs(localNowUs: Long): Long? {
        if (timeMaster) return localNowUs
        val off = clockOffsetUs ?: return null
        return (localNowUs.toDouble() - off).roundToLong()
    }

    private fun msgId(m: WireMessage): String =
        if (m.fragCount == null) "${m.channel}:${m.msgSeq}" else "${m.channel}:${m.msgSeq}#${m.fragIndex}"
}
