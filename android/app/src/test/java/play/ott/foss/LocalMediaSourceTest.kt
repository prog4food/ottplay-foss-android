package play.ott.foss

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream

class LocalMediaSourceTest {
    @Test fun seeksWithinOriginalWithoutWritingIt() {
        val original = File.createTempFile("original-media", ".mp4")
        try {
            val bytes = ByteArray(200000) { (it % 251).toByte() }
            original.writeBytes(bytes)
            val before = original.lastModified()
            LocalMediaSource(FileInputStream(original), bytes.size.toLong()).use { source ->
                val output = ByteArrayOutputStream()
                source.copyRange(output, 65530, 70000)
                assertArrayEquals(bytes.copyOfRange(65530, 135530), output.toByteArray())
                val again = ByteArrayOutputStream()
                source.copyRange(again, 2, 7)
                assertArrayEquals(bytes.copyOfRange(2, 9), again.toByteArray())
            }
            assertArrayEquals(bytes, original.readBytes())
            assertEquals(before, original.lastModified())
        } finally { original.delete() }
    }
    @Test fun assetDescriptorOffsetNeverLeaksAdjacentBytes() {
        val original = File.createTempFile("asset-media", ".bin")
        try {
            original.writeBytes("prefixVIDEOsuffix".toByteArray())
            LocalMediaSource(FileInputStream(original), 5, 6).use { source ->
                val output = ByteArrayOutputStream()
                source.copyRange(output, 0, 5)
                assertEquals("VIDEO", output.toString("UTF-8"))
                assertThrows(IllegalArgumentException::class.java) { source.copyRange(output, 4, 2) }
            }
            assertEquals("prefixVIDEOsuffix", original.readText())
        } finally { original.delete() }
    }
    @Test fun truncatedSourceFailsInsteadOfPretendingSuccess() {
        val original = File.createTempFile("changed-media", ".mp4")
        try {
            original.writeText("video")
            LocalMediaSource(FileInputStream(original), 5).use { source ->
                original.writeText("x")
                assertThrows(java.io.EOFException::class.java) { source.copyRange(ByteArrayOutputStream(), 0, 5) }
            }
        } finally { original.delete() }
    }
}
