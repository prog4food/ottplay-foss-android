"""Small fixture adapters and bounded-heap Android XMLTV regression cases."""

KOTLIN_ADAPTERS = r'''
    private fun parseFixture(xml: String): Parsed = parseXmltv(xml.byteInputStream(Charsets.UTF_8))
    private fun expandedFixture(data: ByteArray): ByteArray? = try {
        if (data.size >= 2 && data[0] == 0x1f.toByte() && data[1] == 0x8b.toByte())
            java.util.zip.GZIPInputStream(data.inputStream()).use { it.readBytes() }
        else data
    } catch (_: Exception) { null }
    private fun readCacheText(source: String, allowStale: Boolean = false): String? {
        if (readCache(source, allowStale) == null) return null
        return String(expandedFixture(cacheFile.readBytes())!!, Charsets.UTF_8)
    }
    private fun writeCacheFixture(data: ByteArray, source: String) {
        val file = File.createTempFile("fixture-cache-", ".tmp", context.cacheDir)
        try { file.writeBytes(data); writeCache(file, source) } finally { file.delete() }
    }
'''

KOTLIN_RESOURCE_TESTS = r'''
    fun runResourceTests() {
        val dir = java.nio.file.Files.createTempDirectory("epg-resource-test").toFile()
        context = com.getcapacitor.Context(dir, dir)
        fun clean() = check(dir.listFiles()!!.none { it.name.startsWith("ott-xmltv-") })
        fun padded(size: Int): InputStream {
            val padding = object: InputStream() {
                var remaining = size
                override fun read(): Int = if (remaining-- > 0) 32 else -1
                override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                    if (length == 0) return 0
                    if (remaining <= 0) return -1
                    val count = minOf(length, remaining)
                    java.util.Arrays.fill(buffer, offset, offset + count, 32.toByte())
                    remaining -= count
                    return count
                }
            }
            return java.io.SequenceInputStream(java.util.Collections.enumeration(listOf(
                "<tv>".byteInputStream(), padding,
                "<channel id=\"a\"><display-name>Safe</display-name></channel></tv>".byteInputStream()
            )))
        }
        fun request(source: String, expected: Boolean) {
            val call = PluginCall(source)
            getChannels(call)
            check(call.resolved == expected && call.rejected != expected) { "$source: ${call.rejection}" }
            check(call.resolveCount + call.rejectCount == 1)
            clean()
        }
        try {
            okhttp3.Fixture.reset()
            okhttp3.Fixture.stream = { padded(24 * 1024 * 1024) }
            request("https://stream.invalid/plain", true)
            check(okhttp3.Fixture.closed == 1)
            parsedCache.clear()
            okhttp3.Fixture.stream = null
            request("https://stream.invalid/plain", true) // parse the real disk cache
            check(okhttp3.Fixture.requests == 1)

            val gzip = File(dir, "fixture.gz")
            java.util.zip.GZIPOutputStream(gzip.outputStream()).use { output ->
                padded(24 * 1024 * 1024).use { it.copyTo(output) }
            }
            okhttp3.Fixture.stream = { gzip.inputStream() }
            okhttp3.Fixture.length = gzip.length()
            request("https://stream.invalid/gzip", true)
            parsedCache.clear()
            okhttp3.Fixture.stream = null
            request("https://stream.invalid/gzip", true)
            println("PASS Kotlin XMLTV: 24 MiB plain/gzip network and disk inputs under a 64 MiB heap")

            inputByteLimit = 1024
            okhttp3.Fixture.stream = { error("Declared overflow must not open the stream") }
            okhttp3.Fixture.length = 1025
            request("https://stream.invalid/declared", false)
            okhttp3.Fixture.stream = { padded(2048) }
            okhttp3.Fixture.length = -1
            request("https://stream.invalid/chunked", false)

            inputByteLimit = 64 * 1024 * 1024
            expandedByteLimit = 1024
            okhttp3.Fixture.stream = { gzip.inputStream() }
            request("https://stream.invalid/expanded", false)
            expandedByteLimit = 512 * 1024 * 1024
            okhttp3.Fixture.stream = null
            okhttp3.Fixture.data = gzip.readBytes().dropLast(4).toByteArray()
            request("https://stream.invalid/truncated-gzip", false)

            okhttp3.Fixture.data = "<tv><channel id=\"b\"><display-name>After failure</display-name></channel></tv>".toByteArray()
            inputByteLimit = okhttp3.Fixture.data!!.size
            request("https://stream.invalid/recovery", true)
            check(okhttp3.Fixture.closed == okhttp3.Fixture.requests)
            parsedCache.clear()
            metaFile.writeText("x".repeat(metadataByteLimit + 1))
            check(readCache("https://stream.invalid/recovery") == null)
            println("PASS Kotlin XMLTV: declared/chunked/expanded limits, gzip errors, stream closure, temporary cleanup, recovery")

            // Real records, not padding: the former all-channel object graph
            // exhausted the physical Fire's 128 MiB Java heap after discovery.
            inputByteLimit = 64 * 1024 * 1024
            val dense = File(dir, "dense.xml")
            val description = "d".repeat(4096)
            val now = (System.currentTimeMillis() / 1000).toInt()
            val format = java.text.SimpleDateFormat("yyyyMMddHHmmss Z").apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
            val start = format.format(java.util.Date(now.toLong() * 1000))
            val stop = format.format(java.util.Date((now.toLong() + 3600) * 1000))
            dense.bufferedWriter().use { out ->
                out.write("<tv><channel id=\"wanted\"><display-name>Wanted</display-name></channel><channel id=\"other\"><display-name>Other</display-name></channel>")
                repeat(12000) { index ->
                    out.write("<programme channel=\"other\" start=\"$start\" stop=\"$stop\"><title>Other $index</title><desc>$description</desc></programme>")
                }
                out.write("<programme channel=\"wanted\" start=\"$start\" stop=\"$stop\"><title>Kept <![CDATA[ ]]>&amp; complete</title><desc>Full description</desc></programme></tv>")
            }
            val denseSource = "https://stream.invalid/dense"
            okhttp3.Fixture.stream = { dense.inputStream() }
            okhttp3.Fixture.length = dense.length()
            request(denseSource, true)
            check(parsedCache[denseSource]!!.second.programs.isEmpty())
            val fetched = okhttp3.Fixture.requests
            fun guide(id: String): PluginCall = PluginCall(denseSource).apply { values["hash"] = id; getEpg(this) }
            val wanted = guide("wanted")
            check(wanted.resolved && !wanted.rejected)
            val rows = (wanted.result.values["epg_data"] as JSArray).values
            check(rows.size == 1)
            check((rows[0] as JSObject).values["name"] == "Kept  & complete")
            check((rows[0] as JSObject).values["descr"] == "Full description")
            check(okhttp3.Fixture.requests == fetched) // source bytes are reused from disk
            check(guide("other").rejected) // oversized individual schedules fail before exhausting the heap
            check(guide("wanted").resolved)
            clean()
            println("PASS Kotlin XMLTV: 12000 dense records, metadata-only discovery, scoped full guide, bounded failure and recovery at 64 MiB")

            // Refresh must invalidate a cached channel schedule.
            okhttp3.Fixture.stream = null
            okhttp3.Fixture.length = -1
            okhttp3.Fixture.data = "<tv><channel id=\"wanted\"><display-name>Wanted</display-name></channel><programme channel=\"wanted\" start=\"$start\" stop=\"$stop\"><title>Refreshed</title></programme></tv>".toByteArray()
            val refresh = PluginCall(denseSource)
            prefetch(refresh)
            check(refresh.resolved)
            val updated = guide("wanted")
            check(((updated.result.values["epg_data"] as JSArray).values[0] as JSObject).values["name"] == "Refreshed")

            okhttp3.Fixture.data = "<tv><channel id=\"a\"><display-name>${"x".repeat(262145)}</display-name></channel></tv>".toByteArray()
            request("https://stream.invalid/oversized-field", false)
            okhttp3.Fixture.data = "<tv><channel id=\"a\"><display-name>Safe</display-name></channel></tv>".toByteArray()
            repeat(40) { request("https://stream.invalid/cache-$it", true) }
            check(parsedCache.size <= 16)
            check(parsedCache.values.sumOf { it.second.retainedBytes.toLong() } <= parsedCacheByteLimit)
            println("PASS Kotlin XMLTV: refresh invalidation, record limits and bounded multi-source cache")

            val tooMany = PluginCall("").apply {
                values["xmltv_urls"] = JSArray().apply { repeat(9) { put("https://stream.invalid/source-$it") } }
            }
            val beforeLimit = okhttp3.Fixture.requests
            getChannels(tooMany)
            check(tooMany.rejected && okhttp3.Fixture.requests == beforeLimit)
            parsedCacheByteLimit = 128
            request("https://stream.invalid/metadata-set-limit", false)
            parsedCacheByteLimit = 16 * 1024 * 1024
            request("https://stream.invalid/after-set-limit", true)

            okhttp3.Fixture.deferred = true
            val pending = (0 until 17).map { index ->
                PluginCall("https://stream.invalid/pending-$index").also { getChannels(it) }
            }
            check(pending.last().rejected && pending.dropLast(1).none { it.rejected || it.resolved })
            while (okhttp3.Fixture.queue.isNotEmpty()) okhttp3.Fixture.releaseOne()
            check(pending.dropLast(1).all { it.resolved && it.resolveCount == 1 })
            val joined = (0 until 65).map { PluginCall("https://stream.invalid/joined").also { getChannels(it) } }
            check(joined.last().rejected)
            okhttp3.Fixture.releaseOne()
            check(joined.dropLast(1).all { it.resolved && it.resolveCount == 1 })
            check(pendingSources.isEmpty())
            clean()
            println("PASS Kotlin XMLTV: source-set, pending-load and joined-callback limits recover cleanly")
        } finally { okhttp3.Fixture.reset(); dir.deleteRecursively() }
    }
'''
