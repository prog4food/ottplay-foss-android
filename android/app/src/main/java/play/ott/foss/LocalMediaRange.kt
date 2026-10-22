package play.ott.foss

/** Single HTTP byte ranges used by HTML video and native media players. */
internal object LocalMediaRange {
    fun parse(header: String?, size: Long): LongRange {
        require(size >= 0)
        if (header == null) return 0L..(size - 1)
        require(size > 0 && header.matches(Regex("bytes=[0-9]*-[0-9]*")))
        val parts = header.removePrefix("bytes=").split('-')
        val start: Long
        val end: Long
        if (parts[0].isEmpty()) {
            val suffix = parts[1].toLongOrNull() ?: throw IllegalArgumentException()
            require(suffix > 0)
            start = (size - suffix).coerceAtLeast(0)
            end = size - 1
        } else {
            start = parts[0].toLongOrNull() ?: throw IllegalArgumentException()
            end = if (parts[1].isEmpty()) size - 1 else
                (parts[1].toLongOrNull() ?: throw IllegalArgumentException()).coerceAtMost(size - 1)
            require(start < size && end >= start)
        }
        return start..end
    }
    fun mime(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "mp4", "m4v" -> "video/mp4"
        "webm" -> "video/webm"
        "mkv" -> "video/x-matroska"
        "mov" -> "video/quicktime"
        "mp3" -> "audio/mpeg"
        "m4a" -> "audio/mp4"
        "aac" -> "audio/aac"
        "ogg", "oga" -> "audio/ogg"
        "wav" -> "audio/wav"
        else -> "application/octet-stream"
    }
}
