package dev.salvo.locallink

/**
 * Drahtformat von LocalLink. Portiert aus der JS-Referenz (reference/src/wire.mjs)
 * und byte-genau mit deren vectors.json abgeglichen (siehe WireVectorsTest).
 *
 *   Paketkopf                                     9 Byte, bis 15 mit Flags
 *   u8   Version (2 Bit) | Flags (6 Bit)          Flags: 0x01 Zeit, 0x02 Ack
 *   u16  seq       laufende Paketnummer
 *   u16  ack       hoechste gesehene Gegennummer  (nur gueltig bei FLAG_ACK)
 *   u32  ackBits   die 32 Pakete davor            (nur gueltig bei FLAG_ACK)
 *   u16  ackDelay  Ack-Verzug in 64-us-Schritten  (nur bei FLAG_ACK)
 *   u32  sendTime  Mikrosekunden (untere 32 Bit)  (nur bei FLAG_TIME)
 *
 *   Nachricht                                     4 Byte, 8 als Fragment
 *   u8   Modus (4 Bit) | Kanal (4 Bit)
 *   u16  msgSeq
 *   u8   Flags                                    0x01 = Fragment
 *   u16  fragIndex, u16 fragCount                 (nur bei Fragment)
 *   var  Laenge, dann Nutzdaten
 */

const val PROTOCOL_VERSION = 1

const val FLAG_TIME = 0x01
const val FLAG_ACK = 0x02
const val MSG_FLAG_FRAGMENT = 0x01

const val PACKET_HEADER_BYTES = 9
const val PACKET_HEADER_MAX_BYTES = 15
const val MESSAGE_HEADER_BYTES = 4
const val MESSAGE_HEADER_BYTES_FRAGMENT = 8

const val ACK_DELAY_UNIT_US = 64
const val ACK_DELAY_MAX_US = 65535 * ACK_DELAY_UNIT_US

private const val SEQ_MODULO = 0x10000
private const val SEQ_HALF = 0x8000

/** Vergleicht Paket-/Nachrichtennummern korrekt ueber den Ueberlauf hinweg. */
fun seqGreaterThan(a: Int, b: Int): Boolean =
    (a > b && a - b <= SEQ_HALF) || (a < b && b - a > SEQ_HALF)

/** Abstand a - b im Sequenzraum, vorzeichenbehaftet. */
fun seqDistance(a: Int, b: Int): Int {
    var d = (a - b) % SEQ_MODULO
    if (d > SEQ_HALF) d -= SEQ_MODULO
    if (d < -SEQ_HALF) d += SEQ_MODULO
    return d
}

fun nextSeq(seq: Int): Int = (seq + 1) % SEQ_MODULO

/** LEB128-Groesse einer nicht-negativen Zahl. Werte unter 128 kosten ein Byte. */
fun varintSize(v: Int): Int {
    var n = v
    var size = 1
    while (n >= 0x80) {
        n = n ushr 7
        size++
    }
    return size
}

class Writer(capacity: Int = 512) {
    var buf = ByteArray(capacity)
    var pos = 0

    private fun ensure(extra: Int) {
        if (pos + extra <= buf.size) return
        var size = buf.size * 2
        while (size < pos + extra) size *= 2
        buf = buf.copyOf(size)
    }

    fun u8(v: Int): Writer {
        ensure(1)
        buf[pos++] = (v and 0xff).toByte()
        return this
    }

    fun u16(v: Int): Writer {
        ensure(2)
        buf[pos++] = ((v ushr 8) and 0xff).toByte()
        buf[pos++] = (v and 0xff).toByte()
        return this
    }

    fun u32(v: Int): Writer {
        ensure(4)
        buf[pos++] = ((v ushr 24) and 0xff).toByte()
        buf[pos++] = ((v ushr 16) and 0xff).toByte()
        buf[pos++] = ((v ushr 8) and 0xff).toByte()
        buf[pos++] = (v and 0xff).toByte()
        return this
    }

    fun varint(v: Int): Writer {
        var n = v
        do {
            var byte = n and 0x7f
            n = n ushr 7
            if (n != 0) byte = byte or 0x80
            u8(byte)
        } while (n != 0)
        return this
    }

    fun bytes(src: ByteArray, from: Int = 0, to: Int = src.size): Writer {
        val len = to - from
        ensure(len)
        src.copyInto(buf, pos, from, to)
        pos += len
        return this
    }

    fun finish(): ByteArray = buf.copyOf(pos)
}

class Reader(private val buf: ByteArray) {
    var pos = 0

    val remaining: Int get() = buf.size - pos

    fun u8(): Int {
        if (remaining < 1) throw IllegalArgumentException("Paket zu kurz: u8")
        return buf[pos++].toInt() and 0xff
    }

    fun u16(): Int {
        if (remaining < 2) throw IllegalArgumentException("Paket zu kurz: u16")
        val a = buf[pos++].toInt() and 0xff
        val b = buf[pos++].toInt() and 0xff
        return (a shl 8) or b
    }

    /** Liefert das 32-Bit-Muster als Int (kann negativ sein - als Bitfeld gedacht). */
    fun u32(): Int {
        if (remaining < 4) throw IllegalArgumentException("Paket zu kurz: u32")
        val a = buf[pos++].toInt() and 0xff
        val b = buf[pos++].toInt() and 0xff
        val c = buf[pos++].toInt() and 0xff
        val d = buf[pos++].toInt() and 0xff
        return (a shl 24) or (b shl 16) or (c shl 8) or d
    }

    fun varint(): Int {
        var result = 0
        var shift = 0
        while (true) {
            if (remaining < 1) throw IllegalArgumentException("Paket zu kurz: varint")
            val byte = buf[pos++].toInt() and 0xff
            result = result or ((byte and 0x7f) shl shift)
            if (byte and 0x80 == 0) break
            shift += 7
            if (shift > 28) throw IllegalArgumentException("varint zu lang")
        }
        return result
    }

    fun bytes(len: Int): ByteArray {
        if (remaining < len) throw IllegalArgumentException("Paket zu kurz: Nutzdaten")
        val out = buf.copyOfRange(pos, pos + len)
        pos += len
        return out
    }
}

/** Eine Nachricht innerhalb eines Pakets. fragIndex/fragCount null = kein Fragment. */
class WireMessage(
    val mode: Int,
    val channel: Int,
    val msgSeq: Int,
    val fragIndex: Int?,
    val fragCount: Int?,
    val payload: ByteArray,
)

/** Ergebnis von decodePacket. */
class DecodedPacket(
    val version: Int,
    val flags: Int,
    val seq: Int,
    val ack: Int,
    val ackBits: Int,
    val hasAck: Boolean,
    val ackDelayUs: Int,
    val sendTimeUs: Long?,
    val messages: List<WireMessage>,
)

/** Groesse des Nachrichtenkopfs fuer eine konkrete Nutzlast. */
fun messageOverhead(payloadLength: Int, fragmented: Boolean): Int {
    val base = if (fragmented) MESSAGE_HEADER_BYTES_FRAGMENT else MESSAGE_HEADER_BYTES
    return base + varintSize(payloadLength)
}

/**
 * Serialisiert ein Paket. sendTimeUs != null setzt FLAG_TIME, hasAck setzt
 * FLAG_ACK samt ack/ackBits/ackDelay.
 */
fun encodePacket(
    seq: Int,
    ack: Int,
    ackBits: Int,
    hasAck: Boolean,
    ackDelayUs: Int,
    sendTimeUs: Long?,
    messages: List<WireMessage>,
): ByteArray {
    val timed = sendTimeUs != null
    val w = Writer(256)
    w.u8(((PROTOCOL_VERSION and 0x03) shl 6) or (if (timed) FLAG_TIME else 0) or (if (hasAck) FLAG_ACK else 0))
    w.u16(seq)
    w.u16(ack)
    w.u32(ackBits)
    if (hasAck) {
        val raw = ackDelayUs.coerceIn(0, ACK_DELAY_MAX_US)
        w.u16(((raw.toDouble() / ACK_DELAY_UNIT_US) + 0.5).toInt())
    }
    if (timed) w.u32((sendTimeUs!! and 0xFFFFFFFFL).toInt())

    for (m in messages) {
        val fragmented = m.fragCount != null
        w.u8(((m.mode and 0x0f) shl 4) or (m.channel and 0x0f))
        w.u16(m.msgSeq)
        w.u8(if (fragmented) MSG_FLAG_FRAGMENT else 0)
        if (fragmented) {
            w.u16(m.fragIndex!!)
            w.u16(m.fragCount!!)
        }
        w.varint(m.payload.size)
        w.bytes(m.payload)
    }
    return w.finish()
}

/** Gegenstueck zu encodePacket. Wirft bei verstuemmelten Paketen. */
fun decodePacket(bytes: ByteArray): DecodedPacket {
    val r = Reader(bytes)
    val b0 = r.u8()
    val version = (b0 ushr 6) and 0x03
    if (version != PROTOCOL_VERSION) {
        throw IllegalArgumentException("Unbekannte Protokollversion $version")
    }
    val flags = b0 and 0x3f
    val seq = r.u16()
    val ack = r.u16()
    val ackBits = r.u32()
    val hasAck = (flags and FLAG_ACK) != 0
    val ackDelayUs = if (hasAck) r.u16() * ACK_DELAY_UNIT_US else 0
    val sendTimeUs = if (flags and FLAG_TIME != 0) r.u32().toLong() and 0xFFFFFFFFL else null

    val messages = ArrayList<WireMessage>()
    while (r.remaining > 0) {
        val m0 = r.u8()
        val mode = (m0 ushr 4) and 0x0f
        val channel = m0 and 0x0f
        val msgSeq = r.u16()
        val mflags = r.u8()
        var fragIndex: Int? = null
        var fragCount: Int? = null
        if (mflags and MSG_FLAG_FRAGMENT != 0) {
            fragIndex = r.u16()
            fragCount = r.u16()
        }
        val len = r.varint()
        val payload = r.bytes(len)
        messages.add(WireMessage(mode, channel, msgSeq, fragIndex, fragCount, payload))
    }

    return DecodedPacket(version, flags, seq, ack, ackBits, hasAck, ackDelayUs, sendTimeUs, messages)
}
