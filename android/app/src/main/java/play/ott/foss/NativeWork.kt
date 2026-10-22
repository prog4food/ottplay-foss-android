package play.ott.foss

import java.io.IOException

/** Per-app background ownership. Cancelled work stays retired after wake. */
object NativeWork {
    private val lock = Any()
    private var standby = false
    private val pending = mutableSetOf<Ticket>()
    private val stops = mutableSetOf<((() -> Unit) -> Unit)>()
    private val draining = mutableSetOf<Any>()
    val isStandby: Boolean get() = synchronized(lock) { standby }
    val pendingCount: Int get() = synchronized(lock) { pending.size + draining.size }
    data class Snapshot(val standby: Boolean, val pending: Int) {
        val quiescent: Boolean get() = standby && pending == 0
    }
    fun snapshot(): Snapshot = synchronized(lock) { Snapshot(standby, pending.size + draining.size) }

    class Ticket internal constructor() {
        private var cancelled = false
        private var finished = false
        private var cancel: (() -> Unit)? = null
        fun check() = synchronized(lock) {
            if (cancelled || finished) throw IOException("Player is in standby")
        }
        fun <T> commit(action: () -> T): T = synchronized(lock) { check(); action() }
        fun cancelWith(action: () -> Unit) {
            val now = synchronized(lock) {
                if (finished) false else if (cancelled) true else { cancel = action; false }
            }
            if (now) runCatching(action)
        }
        internal fun retire(): (() -> Unit)? {
            if (cancelled || finished) return null
            cancelled = true
            return cancel.also { cancel = null }
        }
        fun cancel() {
            val action = synchronized(lock) { retire() }
            action?.let { runCatching(it) }
        }
        fun finish() = synchronized(lock) {
            finished = true
            cancel = null
            pending.remove(this)
            Unit
        }
    }

    fun begin(): Ticket? = synchronized(lock) {
        if (standby) null else Ticket().also { pending.add(it) }
    }

    fun onStandby(action: () -> Unit): () -> Unit = onStandbyAsync { done ->
        try { action() } finally { done() }
    }

    // Reserve cleanup before publishing standby, including asynchronously queued teardown.
    private fun cleanup(action: (() -> Unit) -> Unit): () -> Unit {
        val id = Any()
        draining.add(id)
        return {
            val done: () -> Unit = { synchronized(lock) { draining.remove(id) } }
            try { action(done) } catch (error: Throwable) { done(); throw error }
        }
    }
    fun onStandbyAsync(action: (() -> Unit) -> Unit): () -> Unit {
        val now = synchronized(lock) { stops.add(action); if (standby) cleanup(action) else null }
        if (now != null) runCatching(now)
        return { synchronized(lock) { stops.remove(action) } }
    }

    fun setStandby(value: Boolean) {
        val actions = synchronized(lock) {
            if (standby == value) return
            standby = value
            if (value) pending.mapNotNull { it.retire() } + stops.map { cleanup(it) } else emptyList()
        }
        // Never run platform cancellation under the ownership lock.
        actions.forEach { runCatching(it) }
    }
}
