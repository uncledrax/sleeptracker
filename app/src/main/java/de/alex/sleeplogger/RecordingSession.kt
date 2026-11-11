package de.alex.sleeplogger

import android.content.Context
import android.os.Build
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

enum class RecordingMode { NORMAL, RAW, OVERNIGHT, PROBE, ECG, SPO2 }

internal data class RecordingPlan(
    val mode: RecordingMode, val liveEnabled: Boolean, val endMs: Long, val previous: JSONObject?
) {
    companion object {
        /** A null request is Android restarting a sticky service. Keep the original timed-test deadline. */
        fun resolve(request: RecordingMode?, live: Boolean?, saved: JSONObject?, now: Long): RecordingPlan? {
            val previous = saved.takeIf { request == null }
            if (request == null && (previous == null || previous.optBoolean("stopRequested"))) return null
            val mode = request ?: RecordingMode.valueOf(previous!!.getString("mode"))
            val started = previous?.getLong("sessionStartMs") ?: now
            val deadline = when (mode) {
                RecordingMode.PROBE -> started + SensorLoggerService.PROBE_MS
                RecordingMode.ECG -> started + SensorLoggerService.ECG_TEST_MS
                else -> 0L
            }
            if (deadline > 0 && deadline <= now) return null
            val enabled = live ?: previous?.getBoolean("liveEnabled") ?: (mode != RecordingMode.OVERNIGHT)
            return RecordingPlan(mode, enabled, deadline, previous)
        }
    }
}

internal fun writeJson(file: File, data: JSONObject) {
    val atomic = AtomicFile(file)
    val out = atomic.startWrite()
    try {
        out.write((data.toString(2) + "\n").toByteArray(Charsets.UTF_8))
        atomic.finishWrite(out)
    } catch (e: Exception) {
        atomic.failWrite(out)
        throw e
    }
}

internal class RecordingSessions(private val context: Context) {
    private val prefs = context.getSharedPreferences("recording", Context.MODE_PRIVATE)
    private val root = File(context.filesDir, "sessions")
    private val format = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US)

    // The journal is committed before starting any sensor. Each reopened session has its own files.
    fun active(): JSONObject? = prefs.getString("active", null)?.let { JSONObject(it) }

    fun recoverStopped(): Boolean {
        val saved = active() ?: return false
        if (!saved.optBoolean("stopRequested")) return false
        interrupt(saved)
        endIntent()
        return true
    }

    fun begin(mode: RecordingMode, live: Boolean, previous: JSONObject?, now: Long, epochOffsetNs: Long): JSONObject {
        check(root.isDirectory || root.mkdirs()) { "Cannot create sessions folder" }
        var candidate = now
        var dir = File(root, format.format(Date(candidate)))
        while (!dir.mkdir()) {
            check(dir.exists()) { "Cannot create session folder" }
            candidate += 1000
            dir = File(root, format.format(Date(candidate)))
        }
        val metadata = JSONObject()
            .put("schemaVersion", 2)
            .put("sessionId", previous?.getString("sessionId") ?: UUID.randomUUID().toString())
            .put("segment", (previous?.getInt("segment") ?: -1) + 1)
            .put("previousSegment", previous?.getString("folder") ?: JSONObject.NULL)
            .put("folder", dir.name).put("state", "recording").put("mode", mode.name)
            .put("liveEnabled", live).put("sessionStartMs", previous?.getLong("sessionStartMs") ?: now)
            .put("segmentStartMs", now).put("epochOffsetNs", epochOffsetNs.toString())
            .put("timeZone", TimeZone.getDefault().id)
            .put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL)
            .put("osBuild", Build.FINGERPRINT).put("androidVersion", Build.VERSION.RELEASE)
            .put("sdkInt", Build.VERSION.SDK_INT).put("appVersion", BuildConfig.VERSION_NAME)
            .put("appVersionCode", BuildConfig.VERSION_CODE).put("appRevision", BuildConfig.SOURCE_REVISION)
        if (previous != null) {
            val end = interrupt(previous)
            if (end != null) metadata.put("previousLastSavedSampleMs", end).put("gapBeforeMs", now - end)
        }
        check(prefs.edit().putString("active", metadata.toString()).commit()) { "Cannot save recording state" }
        save(metadata)
        return metadata
    }

    fun dir(metadata: JSONObject): File = File(root, metadata.getString("folder"))

    fun save(metadata: JSONObject) = writeJson(File(dir(metadata), "session.json"), metadata)

    // Keep the segment reference until its writers have closed, so a process death during Stop is recoverable.
    fun requestStop(metadata: JSONObject) {
        check(prefs.edit().putString("active", JSONObject(metadata.toString()).put("stopRequested", true).toString()).commit()) {
            "Cannot save stop request"
        }
    }

    fun endIntent() {
        check(prefs.edit().remove("active").commit()) { "Cannot save stop request" }
    }

    fun interrupt(previous: JSONObject): Long? {
        val dir = dir(previous)
        val persisted = runCatching {
            JSONObject(AtomicFile(File(dir, "session.json")).openRead().bufferedReader().use { it.readText() })
        }.getOrDefault(previous)
        val last = listOf("raw_ppg.csv", "accel.csv", "hr.csv").firstNotNullOfOrNull {
            lastCompleteSample(File(dir, it))
        }
        if (dir.isDirectory && persisted.optString("state") == "recording") {
            persisted.put("state", "interrupted")
            if (last != null) persisted.put("lastSavedSampleMs", last)
            save(persisted)
        }
        return last
    }

}

// Read only the tail. A partially written event after the final newline is excluded.
internal fun lastCompleteSample(file: File): Long? {
    if (!file.isFile) return null
    return RandomAccessFile(file, "r").use { input ->
        val size = minOf(input.length(), 16_384L).toInt()
        if (size == 0) return@use null
        input.seek(input.length() - size)
        val bytes = ByteArray(size)
        input.readFully(bytes)
        val lines = String(bytes, Charsets.UTF_8).split('\n')
        lines.dropLast(1).lastOrNull()?.substringBefore(',')?.toLongOrNull()
    }
}
