package play.ott.foss

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.*
import java.io.*
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/** Internal queue is always available; an HTTP control surface requires explicit opt-in. */
@CapacitorPlugin(name = "MobileCommandQueue")
class MobileCommandQueuePlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lifecycleLock = Any()
    private val queueLock = Any()
    private var serverJob: Job? = null
    private var serverSocket: ServerSocket? = null
    private val activeClients = java.util.Collections.newSetFromMap(ConcurrentHashMap<Socket, Boolean>())
    @Volatile private var isRunningFlag = true
    @Volatile private var boundPort = 0
    @Volatile private var destroyed = false
    private var token: String? = null
    private val maxBodyBytes = 65536
    private val deviceCommands = HashMap<String, MutableList<CommandEntry>>()
    private val broadcastCommands = ArrayList<CommandEntry>()
    data class CommandEntry(val data: Map<String, Any>, val timestamp: Double, val bytes: Int)

    override fun load() { /* No listener on load, including in Play. */ }

    private fun status() = JSObject().apply {
        put("running", isRunningFlag)
        put("port", boundPort)
        put("httpEnabled", boundPort != 0)
    }

    @PluginMethod
    fun start(call: PluginCall) {
        synchronized(lifecycleLock) {
            if (destroyed) { call.reject("Queue owner was destroyed"); return }
            if (call.getBoolean("httpEnabled", false) != true) {
                isRunningFlag = true
                call.resolve(status())
                return
            }
            val requestedToken = call.getString("token").orEmpty()
            if (!requestedToken.matches(Regex("[A-Za-z0-9_-]{32,256}"))) {
                call.reject("HTTP control requires a random token of 32-256 URL-safe characters")
                return
            }
            if (serverSocket != null) {
                if (token != requestedToken) call.reject("Stop HTTP control before changing its token")
                else call.resolve(status())
                return
            }
            if (serverJob?.isCompleted == false) {
                call.reject("HTTP control is still stopping")
                return
            }
            val configured = System.getenv("OTTPLAY_QUEUE_PORT")?.trim().orEmpty()
            val ports = if (configured.isEmpty()) (18081..18090).toList() else {
                val port = configured.toIntOrNull()
                if (port == null || port !in 1..65535) { call.reject("Invalid command queue port"); return }
                listOf(port)
            }
            var bound: ServerSocket? = null
            for (port in ports) {
                try { bound = ServerSocket(port, 8, InetAddress.getByName("127.0.0.1")); break }
                catch (_: IOException) { }
            }
            val listener = bound ?: run { call.reject("No loopback command queue port available"); return }
            token = requestedToken
            serverSocket = listener
            boundPort = listener.localPort
            isRunningFlag = true
            serverJob = scope.launch {
                try {
                    while (isActive) {
                        val client = listener.accept()
                        if (activeClients.size >= 8) { client.close(); continue }
                        activeClients.add(client)
                        launch { handleClient(client, requestedToken, listener) }.invokeOnCompletion {
                            activeClients.remove(client)
                            try { client.close() } catch (_: IOException) { }
                        }
                    }
                } catch (_: IOException) { /* stop/destroy closes accept */ }
                finally {
                    try { listener.close() } catch (_: IOException) { }
                    synchronized(lifecycleLock) {
                        if (serverSocket === listener) { serverSocket = null; boundPort = 0; token = null }
                    }
                }
            }
            call.resolve(status())
        }
    }

    private fun closeQueue() = synchronized(lifecycleLock) {
        isRunningFlag = false
        try { serverSocket?.close() } catch (_: IOException) { }
        serverSocket = null
        serverJob?.cancel()
        activeClients.forEach { try { it.close() } catch (_: IOException) { } }
        activeClients.clear()
        token = null
        boundPort = 0
        synchronized(queueLock) { deviceCommands.clear(); broadcastCommands.clear() }
        // Keep the job until completion so repeated stops share its cleanup
        // boundary and start cannot bind while old native I/O is still closing.
        serverJob
    }

    override fun handleOnDestroy() {
        destroyed = true
        closeQueue()
        scope.cancel()
        super.handleOnDestroy()
    }

    @PluginMethod fun stop(call: PluginCall) {
        val stoppedJob = closeQueue()
        val complete = {
            notifyListeners("isRunning", status())
            call.resolve()
        }
        // Socket.close() can defer releasing its native descriptor until a
        // blocked accept/read returns. A completed listener job also guarantees
        // its client workers have finished. Register outside lifecycleLock so
        // listener cleanup can acquire it, including during owner destruction.
        if (stoppedJob == null) complete()
        else stoppedJob.invokeOnCompletion { complete() }
    }
    @PluginMethod fun isRunning(call: PluginCall) { call.resolve(status()) }

    private fun enqueue(raw: org.json.JSONObject, deviceId: String): Int = synchronized(queueLock) {
        require(deviceId.length <= 128) { "Device ID is too long" }
        val bodyBytes = raw.toString().toByteArray(Charsets.UTF_8).size
        require(bodyBytes <= maxBodyBytes) { "Command is too large" }
        val timestamp = System.currentTimeMillis() / 1000.0
        val data = mutableMapOf<String, Any>()
        val keys = raw.keys()
        while (keys.hasNext()) { val key = keys.next(); data[key] = raw.get(key) }
        data["ts"] = timestamp
        // Expire inactive device IDs as well as entries to bound queue storage.
        deviceCommands.entries.removeAll { (_, list) -> list.removeAll { it.timestamp <= timestamp - 60 }; list.isEmpty() }
        broadcastCommands.removeAll { it.timestamp <= timestamp - 60 }
        val storedBytes = broadcastCommands.sumOf { it.bytes } + deviceCommands.values.sumOf { entries -> entries.sumOf { it.bytes } }
        require(storedBytes + bodyBytes + 64 <= 1024 * 1024) { "Command queue is full" }
        val list = if (deviceId.isEmpty()) broadcastCommands else {
            require(deviceCommands.containsKey(deviceId) || deviceCommands.size < 128) { "Too many device queues" }
            deviceCommands.getOrPut(deviceId) { ArrayList() }
        }
        list.add(CommandEntry(data, timestamp, bodyBytes + 64))
        val cap = if (deviceId.isEmpty()) 100 else 50
        if (list.size > cap) list.subList(0, list.size - cap / 2).clear()
        list.size
    }

    private fun drain(deviceId: String): List<Map<String, Any>> = synchronized(queueLock) {
        require(deviceId.length <= 128) { "Device ID is too long" }
        val list = if (deviceId.isEmpty()) ArrayList(broadcastCommands).also { broadcastCommands.clear() }
            else deviceCommands.remove(deviceId).orEmpty()
        val cutoff = System.currentTimeMillis() / 1000.0 - 60
        list.filter { it.timestamp > cutoff }.map { it.data }
    }

    @PluginMethod fun post(call: PluginCall) {
        if (destroyed) { call.reject("Queue owner was destroyed"); return }
        try {
            val raw = call.data.optJSONObject("data") ?: call.data
            call.resolve(JSObject().put("queued", enqueue(raw, call.getString("deviceId").orEmpty())))
        } catch (_: Exception) { call.reject("Invalid or oversized command") }
    }

    @PluginMethod fun get(call: PluginCall) {
        try {
            val values = drain(call.getString("deviceId").orEmpty()).map { item ->
                JSObject().apply { item.forEach { (key, value) -> put(key, value) } }
            }
            call.resolve(JSObject().put("commands", JSArray(values)))
        } catch (_: Exception) { call.reject("Invalid device ID") }
    }

    private class RequestError(val status: Int) : IOException()

    private inline fun <T> withHttpAccess(expectedToken: String, expectedListener: ServerSocket, action: () -> T): T =
        synchronized(lifecycleLock) {
            // Authentication done before reading a body is insufficient: stop()
            // can revoke this listener while the request is being parsed. Keep
            // the same lifecycle -> queue lock order as closeQueue(), and also
            // reject old connections if a listener restarts with the same code.
            if (destroyed || serverSocket !== expectedListener || token != expectedToken) throw RequestError(401)
            action()
        }

    private fun handleClient(client: Socket, expectedToken: String, expectedListener: ServerSocket) {
        client.use { socket ->
            val input = BufferedInputStream(socket.getInputStream())
            val deadline = System.nanoTime() + 5_000_000_000L
            fun readByte(): Int {
                val remaining = (deadline - System.nanoTime()) / 1_000_000
                if (remaining <= 0) throw RequestError(408)
                socket.soTimeout = remaining.coerceAtMost(5000).toInt().coerceAtLeast(1)
                return input.read()
            }
            fun line(max: Int): String {
                val bytes = ByteArrayOutputStream()
                while (true) {
                    val byte = readByte()
                    if (byte < 0) throw RequestError(400)
                    if (byte == 10) break
                    if (bytes.size() >= max) throw RequestError(431)
                    bytes.write(byte)
                }
                return bytes.toString("US-ASCII").removeSuffix("\r")
            }
            try {
                val request = line(2048).split(" ")
                if (request.size != 3 || request[2] !in listOf("HTTP/1.0", "HTTP/1.1")) throw RequestError(400)
                val headers = HashMap<String, String>()
                var headerBytes = 0
                while (true) {
                    val value = line(8192)
                    headerBytes += value.length + 2
                    if (headerBytes > 8192 || headers.size > 32) throw RequestError(431)
                    if (value.isEmpty()) break
                    val colon = value.indexOf(':')
                    if (colon <= 0) throw RequestError(400)
                    val name = value.substring(0, colon).lowercase(java.util.Locale.ROOT)
                    if (headers.put(name, value.substring(colon + 1).trim()) != null) throw RequestError(400)
                }
                val authorization = headers["authorization"].orEmpty().toByteArray(Charsets.UTF_8)
                if (!MessageDigest.isEqual(authorization, "Bearer $expectedToken".toByteArray(Charsets.UTF_8))) {
                    throw RequestError(401)
                }
                if (headers.containsKey("transfer-encoding")) throw RequestError(400)
                val length = headers["content-length"]?.toIntOrNull() ?: if (headers.containsKey("content-length")) -1 else 0
                if (length < 0) throw RequestError(400)
                if (length > maxBodyBytes) throw RequestError(413)
                val path = request[1].substringBefore('?')
                val deviceId = request[1].substringAfter('?', "").split('&').firstOrNull { it.startsWith("device_id=") }
                    ?.substringAfter('=')?.let { URLDecoder.decode(it, "UTF-8") }.orEmpty()
                if (deviceId.length > 128) throw RequestError(400)
                val commandsPath = path == "/api/webhook/commands"
                when {
                    request[0] == "GET" && path in listOf("/api/webhook/health", "/webhook/health") -> {
                        val health = withHttpAccess(expectedToken, expectedListener) {
                            mapOf("status" to "ok", "backend" to "capacitor", "port" to boundPort)
                        }
                        writeJson(socket, 200, health)
                    }
                    request[0] == "GET" && (commandsPath || path == "/webhook/poll") -> {
                        val commands = withHttpAccess(expectedToken, expectedListener) { drain(deviceId) }
                        writeJson(socket, 200, commands)
                    }
                    request[0] == "POST" && (commandsPath || path == "/webhook/notify") -> {
                        val body = ByteArray(length)
                        for (index in body.indices) { val byte = readByte(); if (byte < 0) throw RequestError(400); body[index] = byte.toByte() }
                        val raw = org.json.JSONObject(String(body, Charsets.UTF_8))
                        val queued = withHttpAccess(expectedToken, expectedListener) { enqueue(raw, deviceId) }
                        writeJson(socket, 200, mapOf("queued" to queued, "status" to "ok"))
                    }
                    else -> throw RequestError(404)
                }
            } catch (error: Exception) {
                val status = when (error) { is RequestError -> error.status; is java.net.SocketTimeoutException -> 408; else -> 400 }
                try { writeJson(socket, status, mapOf("error" to "Request rejected")) } catch (_: IOException) { }
            }
        }
    }

    private fun writeJson(socket: Socket, status: Int, body: Any) {
        val json = if (body is Collection<*>) org.json.JSONArray(body.toTypedArray()).toString()
            else org.json.JSONObject.wrap(body)?.toString() ?: "null"
        val bytes = json.toByteArray(Charsets.UTF_8)
        // No browser CORS grant: a native control client must explicitly possess the token.
        val header = "HTTP/1.1 $status ${if (status == 200) "OK" else "Error"}\r\n" +
            "Content-Type: application/json; charset=utf-8\r\nConnection: close\r\n" +
            "Cache-Control: no-store\r\nContent-Length: ${bytes.size}\r\n\r\n"
        socket.getOutputStream().apply { write(header.toByteArray(Charsets.US_ASCII)); write(bytes); flush() }
    }
}
