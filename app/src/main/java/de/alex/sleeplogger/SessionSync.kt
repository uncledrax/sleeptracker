package de.alex.sleeplogger

import android.content.Context
import android.os.PowerManager
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** Copies watch recordings to the PC. Cleanup requires a finalized manifest and matching hashes. */
object SessionSync {
    private const val TAG = "SessionSync"
    @Volatile var running = false
        private set
    @Volatile var status = ""
        private set

    fun start(ctx: Context, deleteAfter: Boolean = false) {
        synchronized(this) {
            if (running) return
            running = true
        }
        val app = ctx.applicationContext
        Thread({ run(app, deleteAfter) }, "session-sync").start()
    }

    private fun run(ctx: Context, deleteAfter: Boolean) {
        val wl = ctx.getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sleeplogger:sync").apply { acquire(30 * 60_000L) }
        WifiLink.acquire(ctx)
        try {
            status = "Sync: Wi-Fi …"
            val net = WifiLink.await(20_000) ?: return fail("no Wi-Fi")
            status = "Sync: looking for PC …"
            val pc = WifiLink.findPc(ctx, net, 4000) ?: return fail("PC not found (npm run sync running?)")
            val base = "http://${pc.host.hostAddress}:${pc.syncPort}/sessions"
            val dirs = (File(ctx.filesDir, "sessions").listFiles() ?: emptyArray())
                .filter { it.isDirectory && it.name.matches(Regex("\\d{8}_\\d{6}")) }
                .sortedBy { it.name }
            var sentBytes = 0L
            var copied = 0
            var deleted = 0
            for (d in dirs) {
                if (d.name == SensorLoggerService.currentSession) continue
                val metadata = File(d, "session.json")
                if (metadata.isFile && JSONObject(metadata.readText()).optString("state") == "recording") continue
                val sealed = SessionManifest.sealedFiles(d)
                val expected = sealed ?: SessionManifest.files(d).associate { it.name to SessionManifest.digest(it) }
                if (expected.isEmpty()) continue
                val url = "$base/${d.name}"
                var remote = remoteDigests(net, url)
                // Publish the completion manifest only after its recording files.
                for ((name, digest) in expected.entries.sortedBy { it.key == SessionManifest.NAME }) {
                    if (remote[name] == digest) continue
                    status = "Sync ${d.name}: $name ${digest.bytes / 1_000_000} MB"
                    put(net, "$url/${URLEncoder.encode(name, "UTF-8")}", File(d, name), digest)
                    sentBytes += digest.bytes
                }
                remote = remoteDigests(net, url)
                check(expected.all { remote[it.key] == it.value }) { "${d.name}: PC verification failed" }
                copied++
                if (deleteAfter && sealed != null && d.name != SensorLoggerService.currentSession) {
                    check(SessionManifest.sealedFiles(d) == sealed &&
                          expected.all { SessionManifest.digest(File(d, it.key)) == it.value }) {
                        "${d.name}: originals changed, retained on watch"
                    }
                    check(d.deleteRecursively()) { "${d.name}: watch cleanup failed" }
                    deleted++
                }
            }
            status = if (copied == 0) "Sync: nothing ready to send" else
                "Sync ✓ $copied session(s), ${sentBytes / 1_000_000} MB → ${pc.name.ifEmpty { pc.host.hostAddress }}" +
                    if (deleteAfter) ", removed $deleted verified session(s)" else ", kept on watch"
        } catch (e: Exception) {
            Log.w(TAG, "sync failed", e)
            fail(e.message ?: e.javaClass.simpleName)
        } finally {
            WifiLink.release(ctx)
            if (wl.isHeld) wl.release()
            running = false
        }
    }

    private fun fail(msg: String) { status = "Sync failed: $msg" }

    private fun remoteDigests(net: android.net.Network, url: String): Map<String, SessionManifest.Digest> {
        val c = net.openConnection(URL("$url?hashes=1")) as HttpURLConnection
        c.connectTimeout = 5000; c.readTimeout = 180_000
        try {
            check(c.responseCode == 200) { "PC answered ${c.responseCode}" }
            val receipt = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
            val hashes = receipt.optJSONObject("sha256") ?: error("Update the PC receiver for verified sync")
            val sizes = receipt.getJSONObject("files")
            return hashes.keys().asSequence().associateWith { SessionManifest.Digest(sizes.getLong(it), hashes.getString(it)) }
        } finally { c.disconnect() }
    }

    private fun put(net: android.net.Network, url: String, f: File, expected: SessionManifest.Digest) {
        val c = net.openConnection(URL(url)) as HttpURLConnection
        c.connectTimeout = 5000; c.readTimeout = 60_000
        c.requestMethod = "PUT"
        c.doOutput = true
        c.setFixedLengthStreamingMode(expected.bytes)
        c.setRequestProperty("Content-Type", "application/octet-stream")
        c.setRequestProperty("X-Content-SHA256", expected.sha256)
        try {
            c.outputStream.use { out -> f.inputStream().use { it.copyTo(out, 64 * 1024) } }
            check(c.responseCode == 200) { "upload ${f.name}: PC answered ${c.responseCode}" }
            val response = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
            check(response.getString("sha256") == expected.sha256 && response.getLong("size") == expected.bytes) {
                "upload ${f.name}: PC digest mismatch"
            }
        } finally { c.disconnect() }
    }
}
