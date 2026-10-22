package play.ott.foss
import org.junit.Assert.assertEquals
import org.junit.Test

class LocalMediaRangeTest {
    @Test fun fullFile() { assertEquals(0L..99L, LocalMediaRange.parse(null, 100)) }
    @Test fun seek() { assertEquals(30L..99L, LocalMediaRange.parse("bytes=30-", 100)) }
    @Test fun bounded() { assertEquals(10L..19L, LocalMediaRange.parse("bytes=10-19", 100)) }
    @Test fun suffix() { assertEquals(90L..99L, LocalMediaRange.parse("bytes=-10", 100)) }
    @Test fun clamp() { assertEquals(50L..99L, LocalMediaRange.parse("bytes=50-999", 100)) }
    @Test fun longFiles() { assertEquals(4294967296L..8589934591L, LocalMediaRange.parse("bytes=4294967296-", 8589934592)) }
    @Test(expected = IllegalArgumentException::class) fun emptyRange() { LocalMediaRange.parse("bytes=-", 100) }
    @Test(expected = IllegalArgumentException::class) fun invalidRange() { LocalMediaRange.parse("bytes=100-", 100) }
    @Test(expected = IllegalArgumentException::class) fun multipleRanges() { LocalMediaRange.parse("bytes=0-1,3-4", 100) }
    @Test(expected = IllegalArgumentException::class) fun overflow() { LocalMediaRange.parse("bytes=999999999999999999999-", 100) }
    @Test fun oversizedSuffix() { assertEquals(0L..99L, LocalMediaRange.parse("bytes=-1000", 100)) }
    @Test fun emptyFile() { assertEquals(0L..-1L, LocalMediaRange.parse(null, 0)) }
    @Test(expected = IllegalArgumentException::class) fun rangeOnEmptyFile() { LocalMediaRange.parse("bytes=0-", 0) }
    @Test(expected = IllegalArgumentException::class) fun reversed() { LocalMediaRange.parse("bytes=10-9", 100) }
    @Test(expected = IllegalArgumentException::class) fun zeroSuffix() { LocalMediaRange.parse("bytes=-0", 100) }
    @Test(expected = IllegalArgumentException::class) fun invalidUnit() { LocalMediaRange.parse("items=0-9", 100) }
    @Test fun mediaTypes() { assertEquals("video/mp4", LocalMediaRange.mime("Film.MP4")) }
}
