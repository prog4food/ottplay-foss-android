package play.ott.foss

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.FileInputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ConcurrentHashMap

/** SAF grants reference original documents. Existing private imports remain readable. */
@CapacitorPlugin(name = "LocalMedia")
class LocalMediaPlugin : Plugin() {
    private val listWork = ConcurrentHashMap<String, NativeWork.Ticket>()
    private val ownedWork = ConcurrentHashMap.newKeySet<NativeWork.Ticket>()
    @Synchronized private fun beginWork(): NativeWork.Ticket? =
        if (destroyed) null else NativeWork.begin()?.also { ownedWork.add(it) }
    private fun finishWork(ticket: NativeWork.Ticket) { ownedWork.remove(ticket); ticket.finish() }
    // shutdownNow returns queued Runnables without invoking them. Their tickets
    // still need deterministic completion, while running work owns its finally.
    private class QueuedWork(private val action: () -> Unit, private val discard: () -> Unit) : Runnable {
        private val claimed = java.util.concurrent.atomic.AtomicBoolean()
        override fun run() { if (claimed.compareAndSet(false, true)) action() }
        fun discardBeforeStart() { if (claimed.compareAndSet(false, true)) discard() }
    }
    private val currentWork = ThreadLocal<NativeWork.Ticket>()
    private var stopSubscription: (() -> Unit)? = null
    private fun checkWork() { currentWork.get()?.check() }
    private fun submit(call: PluginCall, requestId: String? = null, action: () -> Unit) {
        val ticket = beginWork() ?: run { call.reject("Local media unavailable or in standby", "standby"); return }
        if (requestId != null) listWork.put(requestId, ticket)?.cancel()
        try {
            worker.execute(QueuedWork({
                currentWork.set(ticket)
                try { ticket.check(); action() }
                catch (_: Exception) { call.reject("Local media request cancelled") }
                finally { currentWork.remove(); if (requestId != null) listWork.remove(requestId, ticket); finishWork(ticket) }
            }, { if (requestId != null) listWork.remove(requestId, ticket); finishWork(ticket); call.reject("Local media owner destroyed") }))
        } catch (_: Exception) { if (requestId != null) listWork.remove(requestId, ticket); finishWork(ticket); call.reject("Local media unavailable") }
    }
    private fun query(uri: Uri, projection: Array<String>): android.database.Cursor? {
        checkWork()
        val signal = android.os.CancellationSignal()
        currentWork.get()?.cancelWith { signal.cancel() }
        return context.contentResolver.query(uri, projection, null, null, null, signal)
    }
    private val worker = Executors.newSingleThreadExecutor()
    private val clients = Executors.newFixedThreadPool(4)
    private val connections = java.util.Collections.newSetFromMap(ConcurrentHashMap<Socket, Boolean>())
    private var listener: ServerSocket? = null
    private val token = UUID.randomUUID().toString().replace("-", "")
    @Volatile private var picking = false
    @Volatile private var destroyed = false
    private val sourceDirectory: File get() = File(directory, "sources").apply { mkdirs() }
    private val directory: File get() = File(context.filesDir, "offline-media").apply { mkdirs() }

    @Synchronized private fun startServer(): Int {
        check(!destroyed) { "Media owner destroyed" }
        listener?.let { return it.localPort }
        val socket = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        listener = socket
        Thread({
            try {
                while (!socket.isClosed) {
                    val client = socket.accept()
                    if (connections.size >= 4) { client.close(); continue }
                    val ticket = beginWork()
                    if (ticket == null) { client.close(); continue }
                    connections.add(client)
                    ticket.cancelWith { client.close() }
                    try { clients.execute(QueuedWork({
                        currentWork.set(ticket)
                        try { ticket.check(); serve(client) }
                        finally { currentWork.remove(); connections.remove(client); runCatching { client.close() }; finishWork(ticket) }
                    }, { connections.remove(client); runCatching { client.close() }; finishWork(ticket) })) }
                    catch (_: Exception) { connections.remove(client); runCatching { client.close() }; finishWork(ticket) }
                }
            } catch (_: IOException) { /* destroyed */ }
        }, "ott-offline-media").start()
        return socket.localPort
    }

    private fun privateFile(file: File): Boolean = file.isFile &&
        file.canonicalFile == File(directory.canonicalFile, file.name)

    override fun load() {
        stopSubscription = NativeWork.onStandby {
            connections.forEach { runCatching { it.close() } }
        }
        val ticket = beginWork() ?: return
        try { worker.execute(QueuedWork({
            try {
                ticket.check()
                // Interrupted imports never become library entries; discard their private staging files.
                directory.listFiles().orEmpty().forEach {
                    ticket.check()
                    if (it.name.endsWith(".part") || (it.name.endsWith(".media") &&
                        !File(directory, it.name.removeSuffix(".media") + ".json").isFile)) it.delete()
                }
            } catch (_: Exception) { /* cancelled or unavailable local storage */ }
            finally { finishWork(ticket) }
        }, { finishWork(ticket) })) }
        catch (_: Exception) { finishWork(ticket) }
    }

    private fun openSource(item: JSONObject): LocalMediaSource {
        checkWork()
        if (!item.has("uri")) {
            val file = File(directory, "${item.getString("id")}.media")
            check(privateFile(file)) { "Original media unavailable" }
            return LocalMediaSource(FileInputStream(file), file.length(), 0)
        }
        val uri = Uri.parse(item.getString("uri"))
        require(uri.scheme == "content")
        val signal = android.os.CancellationSignal()
        currentWork.get()?.cancelWith { signal.cancel() }
        val descriptor = context.contentResolver.openAssetFileDescriptor(uri, "r", signal)
            ?: throw IOException("Original media unavailable")
        try {
            val input = FileInputStream(descriptor.fileDescriptor)
            val offset = descriptor.startOffset
            // Seekability is mandatory for reliable HTTP byte ranges. Pipes/cloud streams are not copied.
            input.channel.position(offset)
            val size = if (descriptor.length >= 0) descriptor.length else input.channel.size() - offset
            require(size >= 0) { "Unknown media size" }
            return LocalMediaSource(input, size, offset, descriptor)
        } catch (error: Exception) { descriptor.close(); throw error }
    }

    private fun readMetadata(file: File): JSONObject? {
        checkWork()
        val text = try { file.readText() } catch (_: Exception) { null }
        // A synchronous read keeps its ticket until it returns; do not start
        // another read, or hide cancellation as corrupt JSON, afterward.
        checkWork()
        return try { text?.let { JSONObject(it) } } catch (_: Exception) { null }
    }

    private fun metadata(onRecord: ((JSONObject) -> Unit)? = null): List<JSONObject> {
        checkWork()
        val files = directory.listFiles().orEmpty()
        checkWork()
        val records = files.sortedBy { it.name }.mapNotNull {
            checkWork()
            if (!it.name.endsWith(".json") || !privateFile(it)) null
            else readMetadata(it)?.takeIf { item -> validId(item.optString("id")) }?.also { item -> onRecord?.invoke(item) }
        }
        checkWork()
        return records
    }

    private fun sourceMetadata(): List<JSONObject> {
        checkWork()
        val files = sourceDirectory.listFiles().orEmpty()
        checkWork()
        val records = files.filter { it.name.endsWith(".json") }.mapNotNull { readMetadata(it) }
        checkWork()
        return records
    }

    private fun sourceId(item: JSONObject): String = item.optString("sourceId").ifEmpty {
        item.optString("grantUri").takeIf { it.isNotEmpty() }?.let { sourceId(Uri.parse(it)) } ?: item.getString("id")
    }
    private fun sourceId(uri: Uri): String = UUID.nameUUIDFromBytes(uri.toString().toByteArray(Charsets.UTF_8)).toString()

    private fun saveSource(uri: Uri, name: String, kind: String) {
        val id = sourceId(uri)
        checkWork()
        val partial = File(sourceDirectory, "$id.part")
        try {
            partial.writeText(JSONObject().put("id", id).put("name", name).put("kind", kind)
                .put("grantUri", uri.toString()).toString())
            val publish = { check(partial.renameTo(File(sourceDirectory, "$id.json"))) }
            currentWork.get()?.commit(publish) ?: publish()
        } finally { partial.delete() }
    }

    private fun releaseUnusedGrant(grant: String, referenced: Boolean) {
        // Use the caller's serial-worker snapshot. Cleanup must also work after
        // cancellation, without starting another metadata enumeration.
        if (!referenced) {
            try { context.contentResolver.releasePersistableUriPermission(Uri.parse(grant), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            catch (_: SecurityException) { /* permission was already revoked */ }
        }
    }

    private fun snapshot(): JSObject {
        checkWork()
        val port = startServer()
        val records = metadata()
        val items = records.map { item ->
            checkWork()
            var size = item.optLong("size", 0)
            val available = try { openSource(item).use { size = it.size }; true } catch (_: Exception) { false }
            JSObject().apply {
                put("id", item.getString("id")); put("name", item.getString("name")); put("mime", item.getString("mime"))
                put("directory", item.optString("directory"))
                put("size", size); put("sourceId", sourceId(item)); put("source", if (item.has("uri")) "linked" else "imported")
                put("available", available)
                if (!available) put("sourceUnavailable", "Original file missing, inaccessible or not seekable; reconnect the folder or file")
                put("url", if (available) "http://127.0.0.1:$port/$token/${item.getString("id")}" else "")
            }
        }
        val sources = linkedMapOf<String, JSONObject>()
        sourceMetadata().forEach { source ->
            checkWork()
            if (validId(source.optString("id"))) sources[source.getString("id")] = source
        }
        records.forEach { item ->
            checkWork()
            val id = sourceId(item)
            if (!sources.containsKey(id)) sources[id] = JSONObject().put("id", id).put("name", item.getString("name"))
                .put("kind", "file").put("grantUri", item.optString("grantUri"))
        }
        val sourceItems = sources.values.map { source ->
            checkWork()
            val children = items.filter { it.optString("sourceId") == source.getString("id") }
            val grant = source.optString("grantUri")
            val available = if (children.isNotEmpty()) children.any { it.optBoolean("available") }
                else context.contentResolver.persistedUriPermissions.any { it.uri.toString() == grant && it.isReadPermission }
            JSObject().put("id", source.getString("id")).put("name", source.getString("name"))
                .put("kind", source.optString("kind", "file")).put("available", available).put("access", if (available) "granted" else "unavailable")
        }
        checkWork()
        return JSObject().put("available", true).put("persistent", true).put("storage", "device")
            .put("directAccess", true).put("directSources", true).put("sources", JSArray(sourceItems)).put("items", JSArray(items))
    }

    private fun resolveSnapshot(call: PluginCall) {
        val result = snapshot()
        val ticket = currentWork.get() ?: throw IOException("Local media owner unavailable")
        ticket.commit { call.resolve(result) }
    }

    private fun progressList(call: PluginCall, requestId: String) {
        val ticket = currentWork.get() ?: throw IOException("Local media owner unavailable")
        val sources = sourceMetadata().filter { validId(it.optString("id")) }
        val items = linkedMapOf<String, JSObject>()
        val preferredId = call.getString("preferredId").orEmpty()
        var preferredState = "pending"
        var scanned = 0
        var lastPublish = 0L
        val port = startServer()
        fun row(item: JSONObject): JSObject {
            var size = item.optLong("size", 0)
            val available = try { openSource(item).use { size = it.size }; true }
                catch (_: Exception) { checkWork(); false }
            return JSObject().put("id", item.getString("id")).put("name", item.getString("name"))
                .put("mime", item.getString("mime")).put("directory", item.optString("directory"))
                .put("size", size).put("sourceId", sourceId(item))
                .put("source", if (item.has("uri")) "linked" else "imported")
                .put("available", available)
                .put("url", if (available) "http://127.0.0.1:$port/$token/${item.getString("id")}" else "")
        }
        fun catalog(scanning: Boolean): JSObject {
            val knownSources = linkedMapOf<String, JSONObject>()
            sources.forEach { knownSources[it.getString("id")] = it }
            items.values.forEach { item ->
                val id = item.getString("sourceId").orEmpty()
                if (!knownSources.containsKey(id)) knownSources[id] = JSONObject().put("id", id)
                    .put("name", item.getString("name")).put("kind", "file")
            }
            val sourceRows = knownSources.values.map { source ->
                val id = source.getString("id")
                val available = items.values.any { it.getString("sourceId") == id && it.getBoolean("available") == true } ||
                    context.contentResolver.persistedUriPermissions.any { it.uri.toString() == source.optString("grantUri") && it.isReadPermission }
                JSObject().put("id", id).put("name", source.getString("name")).put("kind", source.optString("kind", "file"))
                    .put("available", available).put("access", if (available) "granted" else "unavailable")
            }
            val value = JSObject().put("available", true).put("persistent", true).put("storage", "device")
                .put("directAccess", true).put("directSources", true).put("sources", JSArray(sourceRows))
                .put("items", JSArray(items.values.toList())).put("scanning", scanning).put("scanned", scanned)
            if (!scanning) value.put("total", scanned)
            if (preferredId.isNotEmpty()) value.put("preferred", JSObject().put("id", preferredId).put("state", preferredState))
            return value
        }
        fun publish(force: Boolean = false) {
            checkWork()
            val now = android.os.SystemClock.elapsedRealtime()
            if (!force && now - lastPublish < 250) return
            lastPublish = now
            val value = catalog(true)
            ticket.commit { notifyListeners("localMediaProgress", JSObject().put("requestId", requestId).put("catalog", value)) }
        }
        fun accept(item: JSONObject) {
            checkWork()
            val value = row(item)
            val first = items.values.none { it.getBoolean("available") == true }
            items[item.getString("id")] = value
            scanned++
            if (item.optString("id") == preferredId && value.getBoolean("available") == true) preferredState = "found"
            publish(first && value.getBoolean("available") == true)
        }
        if (validId(preferredId)) {
            val file = File(directory, "$preferredId.json")
            if (!file.exists()) preferredState = "missing"
            else readMetadata(file)?.takeIf { it.optString("id") == preferredId }?.let { item ->
                accept(item)
                if (preferredState != "found") {
                    if (!item.has("uri")) {
                        if (!File(directory, "$preferredId.media").exists()) preferredState = "missing"
                    } else {
                        runCatching { query(Uri.parse(item.getString("uri")), arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID))?.use {
                            if (!it.moveToFirst()) preferredState = "missing"
                        } }
                        checkWork()
                    }
                }
            }
        }
        publish(true)
        metadata { accept(it) }
        sources.forEach { source ->
            checkWork()
            try { if (source.optString("kind") == "folder") scanTree(Uri.parse(source.getString("grantUri"))) { accept(it) } }
            catch (_: Exception) { checkWork() }
        }
        val value = catalog(false)
        ticket.commit { call.resolve(value) }
    }

    @PluginMethod fun cancelList(call: PluginCall) {
        val requestId = call.getString("requestId").orEmpty()
        listWork[requestId]?.cancel()
        call.resolve()
    }

    @PluginMethod fun list(call: PluginCall) {
        val requestId = call.getString("requestId").orEmpty()
        submit(call, requestId.takeIf { it.isNotEmpty() }) {
            try {
                if (requestId.isNotEmpty()) { progressList(call, requestId); return@submit }
                // Older clients retain the complete-snapshot contract.
                sourceMetadata().forEach { source ->
                    checkWork()
                    try {
                        if (source.optString("kind") == "folder") scanTree(Uri.parse(source.getString("grantUri")))
                    } catch (_: Exception) { checkWork() }
                }
                resolveSnapshot(call)
            } catch (_: Exception) { call.reject("Local media unavailable") }
        }
    }

    @PluginMethod fun remove(call: PluginCall) {
        val id = call.getString("id").orEmpty()
        if (!validId(id)) { call.reject("Invalid local media ID"); return }
        submit(call) {
            try {
                val records = metadata()
                val item = records.find { it.getString("id") == id }
                val remaining = records.filter { it.getString("id") != id }
                // Only legacy private copies may be deleted. Never delete a referenced source document.
                val media = File(directory, "$id.media")
                if (media.exists() && !media.delete()) throw IOException("Delete failed")
                val meta = File(directory, "$id.json")
                if (meta.exists() && !meta.delete()) throw IOException("Delete failed")
                item?.optString("grantUri")?.takeIf { it.isNotEmpty() }?.let { grant ->
                    if (remaining.none { it.optString("grantUri") == grant }) {
                        File(sourceDirectory, "${sourceId(Uri.parse(grant))}.json").delete()
                        releaseUnusedGrant(grant, false)
                    }
                }
                resolveSnapshot(call)
            } catch (_: Exception) { call.reject("Unable to remove local media reference") }
        }
    }

    @PluginMethod fun removeSource(call: PluginCall) {
        val id = call.getString("id").orEmpty()
        if (!validId(id)) { call.reject("Invalid source ID"); return }
        submit(call) {
            try {
                val records = metadata()
                val affected = records.filter { sourceId(it) == id }
                val remainingGrants = records.filter { sourceId(it) != id }.mapTo(HashSet<String>()) { it.optString("grantUri") }
                val sourceFile = File(sourceDirectory, "$id.json")
                val sourceGrant = if (sourceFile.isFile) JSONObject(sourceFile.readText()).optString("grantUri") else ""
                for (item in affected) {
                    val itemId = item.getString("id")
                    // This is always app-owned legacy storage, never the original SAF document.
                    val media = File(directory, "$itemId.media")
                    if (media.exists() && !media.delete()) throw IOException("Delete failed")
                    val meta = File(directory, "$itemId.json")
                    if (meta.exists() && !meta.delete()) throw IOException("Delete failed")
                }
                if (sourceFile.exists() && !sourceFile.delete()) throw IOException("Delete failed")
                (affected.map { it.optString("grantUri") } + sourceGrant).filter { it.isNotEmpty() }.distinct()
                    .forEach { releaseUnusedGrant(it, it in remainingGrants) }
                resolveSnapshot(call)
            } catch (_: Exception) { call.reject("Unable to disconnect local source") }
        }
    }

    private fun pick(call: PluginCall, folder: Boolean) {
        if (NativeWork.isStandby) { call.reject("Player is in standby", "standby"); return }
        synchronized(this) {
            if (picking) { call.reject("A media picker is already open"); return }
            picking = true
        }
        val intent = Intent(if (folder) Intent.ACTION_OPEN_DOCUMENT_TREE else Intent.ACTION_OPEN_DOCUMENT).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            if (!folder) {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("video/*", "audio/*"))
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
        }
        try { startActivityForResult(call, intent, if (folder) "selectedFolder" else "selected") }
        catch (_: Exception) { picking = false; call.reject("This device has no document picker") }
    }

    @PluginMethod fun importFiles(call: PluginCall) = pick(call, false)
    @PluginMethod fun importFolder(call: PluginCall) = pick(call, true)

    @PluginMethod fun requestAccess(call: PluginCall) {
        submit(call) {
            val requestedId = call.getString("id")
            val sources = sourceMetadata()
            val records = if (requestedId == null && sources.isNotEmpty()) metadata() else emptyList()
            val denied = sources.firstOrNull { source ->
                checkWork()
                if (requestedId != null) source.optString("id") == requestedId
                else records.filter { sourceId(it) == source.optString("id") }.any { item ->
                    try { openSource(item).use { }; false } catch (_: Exception) { true }
                }
            }
            checkWork()
            val folder = denied?.optString("kind") != "file"
            activity.runOnUiThread { pick(call, folder) }
        }
    }

    private fun grant(uri: Uri) {
        require(uri.scheme == "content") { "Only document references are supported" }
        context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    private class UnavailableDocument(cause: Exception) : IOException(cause)

    private fun link(uri: Uri, grantUri: Uri, known: MutableSet<String>, knownName: String? = null, knownMime: String? = null, folderLabel: String = "", existing: JSONObject? = null, onRecord: ((JSONObject) -> Unit)? = null): Boolean {
        checkWork()
        var name = knownName ?: "Local media"
        if (knownName == null) query(uri, arrayOf(OpenableColumns.DISPLAY_NAME))?.use {
            if (it.moveToFirst()) name = it.getString(0).orEmpty().take(256)
        }
        val declaredMime = knownMime ?: context.contentResolver.getType(uri).orEmpty()
        val mime = if (declaredMime.isEmpty() || declaredMime == "application/octet-stream") LocalMediaRange.mime(name) else declaredMime
        if (!mime.startsWith("video/") && !mime.startsWith("audio/")) return false
        if (uri.toString() in known) {
            // Normal tree refresh already visits this parent. Upgrade legacy metadata
            // without copying media or starting a separate footer scan.
            if (existing != null && folderLabel.isNotEmpty() && existing.optString("directory") != folderLabel) {
                val updated = JSONObject(existing.toString()).put("directory", folderLabel)
                val id = updated.getString("id")
                val partial = File(this.directory, "$id.json.part")
                try {
                    partial.writeText(updated.toString())
                    val publish = { check(partial.renameTo(File(this.directory, "$id.json"))) }
                    currentWork.get()?.commit(publish) ?: publish()
                } finally { partial.delete() }
            }
            if (existing != null) onRecord?.invoke(existing)
            return false
        }
        val id = UUID.randomUUID().toString()
        val item = JSONObject().put("id", id).put("name", name).put("mime", mime).put("directory", folderLabel)
            .put("uri", uri.toString()).put("grantUri", grantUri.toString()).put("sourceId", sourceId(grantUri))
        try { openSource(item).use { item.put("size", it.size) } }
        catch (error: IOException) { throw UnavailableDocument(error) }
        catch (error: SecurityException) { throw UnavailableDocument(error) }
        catch (error: IllegalArgumentException) { throw UnavailableDocument(error) }
        val partial = File(directory, "$id.json.part")
        try {
            partial.writeText(item.toString())
            val publish = { check(partial.renameTo(File(directory, "$id.json"))) }
            currentWork.get()?.commit(publish) ?: publish()
        } finally { partial.delete() }
        known.add(uri.toString())
        onRecord?.invoke(item)
        return true
    }

    @ActivityCallback private fun selected(call: PluginCall?, result: ActivityResult) {
        picking = false
        if (call == null) return
        submit(call) {
            try {
                if (result.resultCode == Activity.RESULT_OK) {
                    val uris = mutableListOf<Uri>()
                    result.data?.clipData?.let { clip -> for (index in 0 until clip.itemCount) uris.add(clip.getItemAt(index).uri) }
                    if (uris.isEmpty()) result.data?.data?.let { uris.add(it) }
                    require(uris.size <= 128) { "Select at most 128 files at once" }
                    val records = metadata()
                    val known = records.mapTo(HashSet<String>()) { it.optString("uri") }
                    val knownGrants = records.mapTo(HashSet<String>()) { it.optString("grantUri") }
                    for (uri in uris.distinct()) {
                        checkWork()
                        grant(uri)
                        try {
                            link(uri, uri, known)
                            val item = metadata().find { it.optString("uri") == uri.toString() }
                            if (item != null) saveSource(uri, item.getString("name"), "file")
                            else releaseUnusedGrant(uri.toString(), uri.toString() in knownGrants || uri.toString() in known)
                        } catch (error: Exception) {
                            releaseUnusedGrant(uri.toString(), uri.toString() in knownGrants || uri.toString() in known)
                            throw error
                        }
                    }
                }
                resolveSnapshot(call)
            } catch (_: Exception) { call.reject("Cannot link source: select local seekable files with persistent read access. No files were copied.") }
        }
    }

    private fun scanTree(tree: Uri, onRecord: ((JSONObject) -> Unit)? = null) {
        val root = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        var folderName = "Local folder"
        query(root, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME))?.use {
            if (it.moveToFirst()) folderName = it.getString(0).orEmpty().take(256)
        }
        saveSource(tree, folderName, "folder")
        val existing = metadata().associateBy { it.optString("uri") }
        val known = existing.keys.toMutableSet()
        val pending = java.util.ArrayDeque<String>()
        val seen = mutableSetOf<String>()
        val directoryNames = mutableMapOf(DocumentsContract.getTreeDocumentId(tree) to folderName)
        pending.add(DocumentsContract.getTreeDocumentId(tree))
        var count = 0
        while (!pending.isEmpty()) {
            check(!destroyed)
            checkWork()
            val parent = pending.removeFirst()
            if (!seen.add(parent)) continue
            require(seen.size <= 4096) { "Too many folders" }
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent)
            query(children, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE))?.use { cursor ->
                while (cursor.moveToNext()) {
                    checkWork()
                    require(++count <= 20000) { "Too many documents" }
                    val document = cursor.getString(0)
                    val name = cursor.getString(1).orEmpty().take(256)
                    val mime = cursor.getString(2).orEmpty()
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                        pending.add(document)
                        directoryNames[document] = name
                    }
                    else try {
                        val uri = DocumentsContract.buildDocumentUriUsingTree(tree, document)
                        link(uri, tree, known, name, mime, directoryNames[parent].orEmpty(), existing[uri.toString()], onRecord)
                    } catch (_: UnavailableDocument) {
                        // A revoked/non-seekable document must not hide readable siblings.
                    }
                }
            } ?: throw IOException("Folder unavailable")
        }
    }

    @ActivityCallback private fun selectedFolder(call: PluginCall?, result: ActivityResult) {
        picking = false
        if (call == null) return
        submit(call) {
            try {
                if (result.resultCode == Activity.RESULT_OK) {
                    val tree = result.data?.data ?: throw IOException("No folder selected")
                    grant(tree)
                    scanTree(tree)
                }
                resolveSnapshot(call)
            } catch (_: Exception) { call.reject("Cannot finish linking folder: select a local folder with persistent read access. No files were copied.") }
        }
    }

    private fun serve(socket: Socket) {
        try {
            socket.soTimeout = 5000
            val input = socket.getInputStream().buffered()
            var budget = 8192
            val deadline = System.nanoTime() + 5_000_000_000L
            fun line(): String {
                val text = StringBuilder()
                while (true) {
                    if (--budget < 0) throw IOException("Headers too large")
                    val remaining = (deadline - System.nanoTime()) / 1_000_000L
                    if (remaining <= 0) throw IOException("Header timeout")
                    socket.soTimeout = remaining.coerceAtMost(5000L).toInt().coerceAtLeast(1)
                    val next = input.read()
                    if (next < 0) throw IOException("Incomplete headers")
                    if (next == 10) return text.toString().trimEnd('\r')
                    text.append(next.toChar())
                }
            }
            val first = line().split(" ")
            if (first.size != 3 || first[2] !in listOf("HTTP/1.0", "HTTP/1.1")) return
            val headers = mutableMapOf<String, String>()
            while (true) {
                val line = line()
                if (line.isEmpty()) break
                val colon = line.indexOf(':')
                if (colon <= 0) return
                val key = line.substring(0, colon).lowercase()
                if (headers.containsKey(key)) return
                headers[key] = line.substring(colon + 1).trim()
            }
            val output = socket.getOutputStream().buffered()
            fun reply(code: Int, extra: String = "", length: Long = 0) {
                output.write(("HTTP/1.1 $code ${if (code == 200) "OK" else if (code == 206) "Partial Content" else "Response"}\r\n" +
                    "Connection: close\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Accept-Ranges, Content-Range, Content-Length\r\n" +
                    "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Allow-Private-Network: true\r\nCache-Control: no-store\r\n" +
                    "Content-Length: $length\r\n$extra\r\n").toByteArray(Charsets.US_ASCII))
            }
            val path = first[1].split('/')
            if (path.size != 3 || path[1] != token || !validId(path[2])) { reply(404); output.flush(); return }
            if (first[0] == "OPTIONS") { reply(204); output.flush(); return }
            if (first[0] != "GET" && first[0] != "HEAD") { reply(405); output.flush(); return }
            val metadata = File(directory, "${path[2]}.json")
            if (!privateFile(metadata)) { reply(404); output.flush(); return }
            val item = JSONObject(metadata.readText())
            val source = try { openSource(item) } catch (_: Exception) { reply(410); output.flush(); return }
            source.use { media ->
                val size = media.size
                val range = try { LocalMediaRange.parse(headers["range"], size) } catch (_: IllegalArgumentException) {
                    reply(416, "Content-Range: bytes */$size\r\n"); output.flush(); return
                }
                val mime = item.getString("mime").filter { it > ' ' && it < '\u007f' }
                val length = if (size == 0L) 0 else range.last - range.first + 1
                reply(if (headers.containsKey("range")) 206 else 200,
                    "Content-Type: $mime\r\nAccept-Ranges: bytes\r\n" +
                        if (headers.containsKey("range")) "Content-Range: bytes ${range.first}-${range.last}/$size\r\n" else "", length)
                if (first[0] == "GET" && length > 0) {
                    media.copyRange(output, range.first, length)
                }
                output.flush()
            }
        } catch (_: Exception) { /* disconnected or malformed client */ }
    }

    override fun handleOnDestroy() {
        stopSubscription?.invoke(); stopSubscription = null
        synchronized(this) {
            destroyed = true
            listener?.close(); listener = null
        }
        connections.forEach { try { it.close() } catch (_: Exception) { } }
        ownedWork.forEach { it.cancel() }
        (clients.shutdownNow() + worker.shutdownNow()).forEach { (it as? QueuedWork)?.discardBeforeStart() }
        super.handleOnDestroy()
    }

    companion object { private fun validId(id: String) = id.matches(Regex("[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}")) }
}
