package play.ott.foss

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream

/** Text returned across the WebView bridge must fit in the app's small heap. */
internal object ProviderHttpResponse {
    const val MAX_BYTES = 8 * 1024 * 1024

    class TooLarge : IOException("Provider response exceeds the 8 MiB limit")

    fun read(stream: InputStream?, declaredLength: Long): String {
        // Close even on an oversized Content-Length. Never allocate from an
        // untrusted length, and also count bytes when it is absent or compressed.
        return stream?.use { input ->
            if (declaredLength > MAX_BYTES) throw TooLarge()
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer, 0, minOf(buffer.size, MAX_BYTES - output.size() + 1))
                if (count == -1) break
                if (count > MAX_BYTES - output.size()) throw TooLarge()
                output.write(buffer, 0, count)
            }
            output.toString("UTF-8")
        } ?: ""
    }
}
