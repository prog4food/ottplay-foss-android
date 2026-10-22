package play.ott.foss

import java.io.Closeable
import java.io.FileInputStream
import java.io.OutputStream

/** A seekable view over the original descriptor, including SAF asset subranges. Never copies to disk. */
internal class LocalMediaSource(
    private val input: FileInputStream,
    val size: Long,
    private val offset: Long = 0,
    private val owner: Closeable? = null
) : Closeable {
    init {
        require(offset >= 0 && size >= 0 && offset <= Long.MAX_VALUE - size)
        // Pipes cannot implement byte ranges. Reject them rather than quietly staging a copy.
        input.channel.position(offset)
        require(offset + size <= input.channel.size()) { "Source is shorter than its declared length" }
    }
    fun copyRange(output: OutputStream, first: Long, count: Long) {
        require(first >= 0 && count >= 0 && first <= size && count <= size - first)
        input.channel.position(offset + first)
        var remaining = count
        val buffer = ByteArray(65536)
        while (remaining > 0) {
            val read = input.read(buffer, 0, minOf(remaining, buffer.size.toLong()).toInt())
            if (read < 0) throw java.io.EOFException("Original media changed while playing")
            output.write(buffer, 0, read)
            remaining -= read
        }
    }
    override fun close() { try { input.close() } finally { owner?.close() } }
}
