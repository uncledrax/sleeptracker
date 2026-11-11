package de.alex.sleeplogger

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener2
import android.hardware.SensorManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.os.SystemClock
import android.util.Log
import java.io.BufferedWriter
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * Logs acceleration and gyroscope (~25 Hz, batched in the sensor FIFO) and heart rate (~1 Hz) to CSV files.
 * Files go to files/sessions/<start>/ and are exported via adb (see README).
 */
class SensorLoggerService : Service(), SensorEventListener2 {

    companion object {
        const val TAG = "SleepLogger"
        const val ACTION_STOP = "de.alex.sleeplogger.STOP"
        const val EXTRA_MODE = "mode"
        const val EXTRA_LIVE = "live"
        const val PROBE_MS = 120_000L
        const val EXTRA_RAW = "raw"
        const val ACTION_MARK = "de.alex.sleeplogger.MARK"
        const val EXTRA_TIME = "time"
        // position calibration: "pose <label>" in events.csv, then lie still until the watch vibrates
        const val ACTION_POSE = "de.alex.sleeplogger.POSE"
        const val EXTRA_POSE = "pose"
        const val POSE_HOLD_MS = 25_000L            // position.py uses 5–25 s after the tap
        // Undocumented Google sensors of the Pixel Watch (see `adb shell dumpsys sensorservice`).
        // Format unknown, hence raw: epoch_ms,accuracy,n,v0 v1 ... v(n-1)
        val RAW_SENSORS = linkedMapOf(
            "com.google.wear.sensor.ppg" to "raw_ppg.csv",
            "com.google.sensor.heart_rate_extended" to "raw_hr_ext.csv",
            "com.google.sensor.ppg_controller" to "raw_ppg_ctrl.csv",
        )
        // ECG test (experimental): undocumented ECG sensors of the Pixel Watch, 150 s (≈8 s settling + 2 min for HRV), finger on the crown
        const val EXTRA_ECG_TEST = "ecg_test"
        // SpO2 calibration test: PPG recording with a large clock on the screen (film it next to an oximeter)
        const val EXTRA_SPO2_TEST = "spo2_test"
        const val ECG_TEST_MS = 150_000L
        const val ECG_TYPE = "com.google.sensor.ecg"
        const val ECG_LEAD_TYPE = "com.google.sensor.ecg_lead_detector"
        const val PPG_TYPE = "com.google.wear.sensor.ppg"
        val ECG_SENSORS = linkedMapOf(
            ECG_TYPE to "raw_ecg.csv",
            ECG_LEAD_TYPE to "raw_ecg_lead.csv",
        )
        const val ACCEL_PERIOD_US = 40_000          // 25 Hz
        const val ACCEL_MAX_LATENCY_US = 10_000_000 // buffer up to 10 s in the FIFO
        const val FLUSH_INTERVAL_MS = 30_000L
        const val BATTERY_INTERVAL_MS = 10 * 60_000L
        private const val CHANNEL_ID = "logging"
        private const val NOTIFICATION_ID = 1

        @Volatile var isRunning = false
            private set
        @Volatile var mode = RecordingMode.NORMAL
            private set
        @Volatile var finishing = false
            private set
        @Volatile var rawStatus = ""
            private set
        @Volatile var recorderResult = ""
            private set
        @Volatile var testEndsAtMs = 0L
            private set
        @Volatile var lastBpm = 0f
            private set
        @Volatile var accelCount = 0L
            private set
        @Volatile var rawMode = false
            private set
        @Volatile var markCount = 0
            private set
        @Volatile var startedAtMs = 0L
            private set
        /** folder name of the session being recorded (skipped by the Wi-Fi sync) */
        @Volatile var currentSession: String? = null
            private set
        /** live view over Wi-Fi: how long after the start of a recording the watch looks for the PC */
        const val LIVE_WIFI_WINDOW_MS = 15 * 60_000L
        @Volatile var liveConnected = false
            private set
        /** "adb" or "Wi-Fi" */
        @Volatile var liveVia = ""
            private set
        /** calibration taps per position in this recording */
        val poseCounts = java.util.concurrent.ConcurrentHashMap<String, Int>()
        /** end of the current calibration hold (epoch ms), 0 = none */
        @Volatile var poseHoldUntilMs = 0L
            private set
        @Volatile var poseHoldLabel = ""
            private set
        @Volatile var spo2Mode = false
        @Volatile var ecgMode = false
            private set
        @Volatile var ecgCount = 0L
            private set
        @Volatile var ecgLeadLast = "–"
            private set
        @Volatile var ecgEndsAtMs = 0L
            private set
        /** Result line of the last ECG test (shown on the watch after it ends), null before the first test. */
        @Volatile var ecgResult: String? = null
            private set
        @Volatile var ecgBlocked = false
            private set
    }

    private val sessions by lazy { RecordingSessions(this) }
    private lateinit var metadata: JSONObject
    private lateinit var directory: File
    private val main = Handler(Looper.getMainLooper())
    private val registered = mutableSetOf<Sensor>()
    private val awaitingFlush = mutableSetOf<Sensor>()
    private val liveFlush = mutableSetOf<Sensor>()
    private var completeOnStop = false
    private var syncAfterStop = false
    private var closed = false
    private var destroyed = false
    private var writeError: String? = null

    private lateinit var sensorManager: SensorManager
    private lateinit var thread: HandlerThread
    private lateinit var handler: Handler
    private var wakeLock: PowerManager.WakeLock? = null

    private var accelOut: BufferedWriter? = null
    private var gyroOut: BufferedWriter? = null
    private var hrOut: BufferedWriter? = null
    private var eventsOut: BufferedWriter? = null
    private data class RawOutput(val values: BufferedWriter, val timing: BufferedWriter)
    private val rawOut = mutableMapOf<Int, RawOutput>()
    private val rawStats = linkedMapOf<String, RawStreamStats>()
    @Volatile private var live: LiveStream? = null

    // Sensor timestamps are elapsedRealtimeNanos; anchored to the wall clock once
    // so the time series does not jump when the clock is corrected via NTP at night.
    private var epochOffsetNs = 0L

    private val flushRunnable = object : Runnable {
        override fun run() {
            try { writers().forEach { it.flush() } }
            catch (e: java.io.IOException) { failRecording(e); return }
            handler.postDelayed(this, FLUSH_INTERVAL_MS)
        }
    }

    // while the laptop is watching: flush the sensor FIFOs every second, otherwise accel/gyro would arrive in 10-s blocks
    /** Wi-Fi for the live view only at the start of a recording and in the short tests (battery). */
    private fun liveWifiAllowed(): Boolean =
        ecgMode || spo2Mode || System.currentTimeMillis() - startedAtMs < LIVE_WIFI_WINDOW_MS

    private val liveRunnable = object : Runnable {
        override fun run() {
            publishRawStatus()
            liveConnected = live?.connected == true
            liveVia = live?.via ?: ""
            if (liveConnected && liveFlush.isEmpty() && sensorManager.flush(this@SensorLoggerService)) {
                liveFlush.addAll(registered)
            }
            handler.postDelayed(this, 1000)
        }
    }

    private val batteryRunnable = object : Runnable {
        override fun run() {
            val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            logEvent("battery ${bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)}")
            handler.postDelayed(this, BATTERY_INTERVAL_MS)
        }
    }

    // end of a calibration hold: short double buzz = "done, next arm placement or position"
    // (poseHoldUntilMs stays set: the UI keeps the screen on for 2 min after it, for the next tap)
    private val poseDone = Runnable {
        val vib = if (Build.VERSION.SDK_INT >= 31)
            getSystemService(VibratorManager::class.java)?.defaultVibrator
        else getSystemService(Vibrator::class.java)
        vib?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 150, 120, 150), -1))
    }

    private val timeLimit = Runnable { main.post { stopRecording(complete = true, sync = false) } }
    private val flushTimeout = Runnable {
        if (awaitingFlush.isNotEmpty()) logEvent("flush_timeout sensors=" + awaitingFlush.joinToString { it.stringType })
        finishSegment()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            if (isRunning) stopRecording(complete = true, sync = true)
            else {
                sessions.active()?.let { sessions.interrupt(it); sessions.endIntent() }
                stopSelf()
            }
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_MARK) {
            // time of the tap, not of processing; written on the writer thread
            val at = intent.getLongExtra(EXTRA_TIME, System.currentTimeMillis())
            if (isRunning && !finishing) handler.post { logEvent("felt", at); markCount++; live?.send("e,$at,felt\n") }
            else if (!isRunning) stopSelf()
            return if (isRunning) START_STICKY else START_NOT_STICKY
        }
        if (intent?.action == ACTION_POSE) {
            val at = intent.getLongExtra(EXTRA_TIME, System.currentTimeMillis())
            val label = intent.getStringExtra(EXTRA_POSE) ?: "unknown"
            if (finishing) return START_NOT_STICKY
            if (!isRunning) { stopSelf(); return START_NOT_STICKY }
            handler.post {
                logEvent("pose $label", at)
                live?.send("e,$at,pose $label\n")
                poseCounts.merge(label, 1) { a, b -> a + b }
                poseHoldLabel = label
                poseHoldUntilMs = at + POSE_HOLD_MS
                handler.removeCallbacks(poseDone)
                handler.postDelayed(poseDone, at + POSE_HOLD_MS - System.currentTimeMillis())
            }
            return START_STICKY
        }
        if (isRunning) return START_STICKY

        val saved = sessions.active()
        val requested = intent?.let {
            it.getStringExtra(EXTRA_MODE)?.let(RecordingMode::valueOf) ?: when {
                it.getBooleanExtra(EXTRA_ECG_TEST, false) -> RecordingMode.ECG
                it.getBooleanExtra(EXTRA_SPO2_TEST, false) -> RecordingMode.SPO2
                it.getBooleanExtra(EXTRA_RAW, false) -> RecordingMode.RAW
                else -> RecordingMode.NORMAL
            }
        }
        val now = System.currentTimeMillis()
        val plan = RecordingPlan.resolve(requested, intent?.getBooleanExtra(EXTRA_LIVE, requested != RecordingMode.OVERNIGHT), saved, now)
        if (saved != null && plan?.previous == null) {
            sessions.interrupt(saved)
            sessions.endIntent()
        }
        if (plan == null) {
            if (saved != null) recorderResult = "Recording interrupted · files retained"
            stopSelf()
            return START_NOT_STICKY
        }
        mode = plan.mode
        val ecg = mode == RecordingMode.ECG
        val notification = buildNotification(ecg)
        if (Build.VERSION.SDK_INT >= 34)
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH)
        else startForeground(NOTIFICATION_ID, notification)
        testEndsAtMs = plan.endMs
        epochOffsetNs = now * 1_000_000L - SystemClock.elapsedRealtimeNanos()
        recorderResult = ""
        try {
            metadata = sessions.begin(mode, plan.liveEnabled, plan.previous, now, epochOffsetNs)
            directory = sessions.dir(metadata)
            currentSession = directory.name
            startedAtMs = metadata.getLong("sessionStartMs")
            thread = HandlerThread("sensor-writer").apply { start() }
            handler = Handler(thread.looper)
            sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
            isRunning = true
            rawMode = mode != RecordingMode.NORMAL
            ecgMode = ecg; spo2Mode = mode == RecordingMode.SPO2; finishing = false
            rawStatus = "Opening sensors"
            handler.post {
                try { startLogging(directory, rawMode, ecg, plan.liveEnabled) }
                catch (e: Exception) { failRecording(e) }
            }
        } catch (e: Exception) {
            runCatching { sessions.active()?.let(sessions::interrupt); sessions.endIntent() }
            currentSession = null
            recorderResult = "Cannot start: ${e.message}"
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    /** Initialization and every event write run on the same looper. */
    private fun startLogging(dir: File, raw: Boolean, ecg: Boolean, liveEnabled: Boolean) {
        if (!ecg) {
            accelOut = File(dir, "accel.csv").bufferedWriter().apply { write("epoch_ms,x,y,z\n") }
            gyroOut = File(dir, "gyro.csv").bufferedWriter().apply { write("epoch_ms,x,y,z\n") }
        }
        hrOut = File(dir, "hr.csv").bufferedWriter().apply { write("epoch_ms,bpm,accuracy\n") }
        eventsOut = File(dir, "events.csv").bufferedWriter().apply { write("epoch_ms,event\n") }
        accelCount = 0; markCount = 0; lastBpm = 0f
        ecgMode = ecg; ecgCount = 0; ecgLeadLast = "–"; ecgResult = null; ecgBlocked = false
        poseCounts.clear(); poseHoldUntilMs = 0L
        if (!metadata.isNull("previousSegment")) logEvent("recovered session=${metadata.getString("sessionId")} previous=${metadata.getString("previousSegment")} gap_ms=${metadata.opt("gapBeforeMs") ?: "unknown"}")

        // record all sensors with metadata; costs nothing and helps reverse engineering.
        val all = sensorManager.getSensorList(Sensor.TYPE_ALL)
        File(dir, "sensors.txt").writeText(all.joinToString("\n") {
            "${it.name} | ${it.vendor} | type=${it.type} ${it.stringType} | wakeup=${it.isWakeUpSensor} | " +
                "minDelay=${it.minDelay}us maxDelay=${it.maxDelay}us | range=${it.maximumRange} " +
                "res=${it.resolution} | fifo=${it.fifoMaxEventCount} | mode=${it.reportingMode}"
        } + "\n")

        val hr = sensorManager.getDefaultSensor(Sensor.TYPE_HEART_RATE)
        val wakeAccel = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER, true)
        if (raw || wakeAccel == null || hr != null) {
            wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SleepLogger::log").apply {
                acquire(if (ecg || mode == RecordingMode.PROBE) 5 * 60_000L else 12 * 60 * 60_000L)
            }
        }
        if (!ecg) {
            val accel = wakeAccel ?: sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
            val gyro = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
            logEvent("start accel=${accel?.name} wakeup=${wakeAccel != null} fifo=${accel?.fifoMaxEventCount} gyro=${gyro?.name} hr=${hr?.name} wakelock=${wakeLock != null}")
            accel?.let { register(it, ACCEL_PERIOD_US, ACCEL_MAX_LATENCY_US) }
            gyro?.let { register(it, ACCEL_PERIOD_US, ACCEL_MAX_LATENCY_US) } ?: logEvent("no_gyroscope")
        } else {
            logEvent("ecg_test start duration=${ECG_TEST_MS / 1000}s hr=${hr?.name}")
            ecgEndsAtMs = testEndsAtMs
        }
        hr?.let { register(it, SensorManager.SENSOR_DELAY_NORMAL, 0) } ?: logEvent("no_heart_rate_sensor")
        if (raw) {
            val sensors = if (ecg) linkedMapOf(PPG_TYPE to "raw_ppg.csv") + ECG_SENSORS else RAW_SENSORS
            sensors.forEach { (kind, filename) -> openRawSensor(all, kind, filename) }
            publishRawStatus()
        }
        if (spo2Mode) logEvent("spo2_test start (clock on screen, film it next to the oximeter)")
        if (mode == RecordingMode.PROBE) logEvent("optical_test start duration=${PROBE_MS / 1000}s")
        if (liveEnabled) live = LiveStream(this, wifiAllowed = ::liveWifiAllowed).also { it.start() }
        handler.postDelayed(flushRunnable, FLUSH_INTERVAL_MS)
        handler.post(batteryRunnable)
        handler.post(liveRunnable)
        if (testEndsAtMs > 0) handler.postDelayed(timeLimit, (testEndsAtMs - System.currentTimeMillis()).coerceAtLeast(0L))
        Log.i(TAG, "logging to ${dir.absolutePath}")
    }

    private fun register(sensor: Sensor, period: Int, latency: Int): Boolean {
        val ok = try { sensorManager.registerListener(this, sensor, period, latency, handler) }
            catch (e: SecurityException) { logEvent("permission_denied ${sensor.stringType}"); false }
        if (ok) registered.add(sensor)
        logEvent("registration ${sensor.stringType} name=${sensor.name} wakeup=${sensor.isWakeUpSensor} registered=$ok")
        return ok
    }

    private fun openRawSensor(all: List<Sensor>, kind: String, filename: String) {
        val stats = RawStreamStats(kind)
        rawStats[kind] = stats
        val matches = all.filter { it.stringType == kind }.sortedBy { it.isWakeUpSensor }
        val sensor = matches.firstOrNull { register(it, 0, 0) }
        val descriptor = sensor ?: matches.firstOrNull()
        descriptor?.let {
            logEvent("raw ${it.name} | ${it.vendor} | type=${it.type} $kind | wakeup=${it.isWakeUpSensor} | minDelay=${it.minDelay}us | registered=${sensor != null}")
        }
        if (sensor == null) {
            stats.registration = if (matches.isEmpty()) "missing" else "registration failed"
            if (matches.isEmpty()) logEvent("raw_missing $kind")
            return
        }
        stats.registration = "registered"; stats.sensorName = sensor.name; stats.wakeUp = sensor.isWakeUpSensor
        val values = File(directory, filename).bufferedWriter()
        try {
            val timing = File(directory, filename.removeSuffix(".csv") + "_timing.csv").bufferedWriter()
            rawOut[sensor.type] = RawOutput(values, timing)
            values.write("epoch_ms,accuracy,n,values\n")
            timing.write("sensor_timestamp_ns,event_width\n")
        } catch (e: Exception) { values.close(); throw e }
    }

    private fun publishRawStatus() {
        val optical = rawStats[PPG_TYPE] ?: return
        val now = SystemClock.elapsedRealtimeNanos()
        val info = mutableListOf("PPG ${optical.summary(now)}")
        for ((key, label) in listOf("com.google.sensor.ppg_controller" to "Controller", "com.google.sensor.heart_rate_extended" to "Extended HR")) {
            rawStats[key]?.let { info.add("$label: ${if (it.registration == "registered") it.count.toString() else it.registration}") }
        }
        rawStatus = info.joinToString("\n")
    }

    private fun writeSensorReport() {
        val now = SystemClock.elapsedRealtimeNanos()
        val streams = JSONArray()
        rawStats.values.forEach { streams.put(it.report(now)) }
        writeJson(File(directory, "sensor_report.json"), JSONObject()
            .put("sessionId", metadata.getString("sessionId")).put("segment", metadata.getInt("segment"))
            .put("elapsedMs", System.currentTimeMillis() - metadata.getLong("segmentStartMs"))
            .put("streams", streams))
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (closed || writeError != null) return
        try { recordEvent(event) } catch (e: java.io.IOException) { failRecording(e) }
    }

    private fun recordEvent(event: SensorEvent) {
        val epochMs = (event.timestamp + epochOffsetNs) / 1_000_000L
        when (event.sensor.type) {
            Sensor.TYPE_ACCELEROMETER -> {
                val v = event.values
                accelOut?.write("$epochMs,${v[0]},${v[1]},${v[2]}\n")
                live?.send("a,$epochMs,${v[0]},${v[1]},${v[2]}\n")
                accelCount++
            }
            Sensor.TYPE_GYROSCOPE -> {
                val v = event.values
                gyroOut?.write("$epochMs,${v[0]},${v[1]},${v[2]}\n")
                live?.send("g,$epochMs,${v[0]},${v[1]},${v[2]}\n")
            }
            Sensor.TYPE_HEART_RATE -> {
                lastBpm = event.values[0]
                hrOut?.write("$epochMs,${event.values[0]},${event.accuracy}\n")
                live?.send("h,$epochMs,${event.values[0]}\n")
            }
            else -> rawOut[event.sensor.type]?.let { w ->
                // the trailing values are mostly zeros (PPG: 9 of 16 values) – we skip them
                val v = event.values
                var n = v.size
                while (n > 1 && v[n - 1] == 0f) n--
                val joined = v.take(n).joinToString(" ")
                w.values.write("$epochMs,${event.accuracy},$n,$joined\n")
                w.timing.write("${event.timestamp},${v.size}\n")
                rawStats[event.sensor.stringType]?.add(event.timestamp, v, n)
                if (event.sensor.stringType == "com.google.wear.sensor.ppg") live?.send("p,$epochMs,$joined\n")
                if (event.sensor.stringType == "com.google.sensor.ppg_controller") live?.sendSticky("q" + v[0].toInt(), "q,$epochMs,$joined\n")
                if (ecgMode) {
                    when (event.sensor.stringType) {
                        ECG_TYPE -> { ecgCount++; live?.send("c,$epochMs,$joined\n") }
                        ECG_LEAD_TYPE -> { ecgLeadLast = joined; live?.send("l,$epochMs,$joined\n") }
                    }
                }
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {
        logEvent("accuracy ${sensor.type} $accuracy")
    }

    private fun logEvent(text: String, atMs: Long = System.currentTimeMillis()) {
        if (closed || writeError != null) return
        try { eventsOut?.write("$atMs,\"${text.replace("\"", "\"\"")}\"\n") }
        catch (e: java.io.IOException) { failRecording(e) }
    }

    private fun writers(): List<BufferedWriter> = listOfNotNull(accelOut, gyroOut, hrOut, eventsOut) +
        rawOut.values.flatMap { listOf(it.values, it.timing) }

    private fun failRecording(e: Exception) {
        if (writeError != null) return
        writeError = e.message ?: e.javaClass.simpleName
        Log.e(TAG, "Recording interrupted", e)
        main.post { stopRecording(complete = false, sync = false) }
    }

    /** Keep the foreground service and wakelock until FIFO callbacks, file closes and sealing finish. */
    private fun stopRecording(complete: Boolean, sync: Boolean) {
        if (!isRunning || finishing) return
        finishing = true
        completeOnStop = complete
        syncAfterStop = sync
        if (complete || writeError != null) {
            try { sessions.requestStop(metadata) } catch (e: Exception) {
                writeError = e.message ?: "Cannot save stop request"
            }
        }
        handler.post {
            handler.removeCallbacks(liveRunnable); handler.removeCallbacks(batteryRunnable)
            handler.removeCallbacks(flushRunnable); handler.removeCallbacks(poseDone); handler.removeCallbacks(timeLimit)
            live?.stop(); live = null; liveConnected = false
            awaitingFlush.addAll(registered)
            if (writeError == null && awaitingFlush.isNotEmpty() && sensorManager.flush(this)) {
                handler.postDelayed(flushTimeout, 2_000)
            } else finishSegment()
        }
    }

    override fun onFlushCompleted(sensor: Sensor) {
        // A live-view request may already be in flight when Stop asks for its own FIFO flush.
        if (liveFlush.remove(sensor)) return
        if (awaitingFlush.remove(sensor) && awaitingFlush.isEmpty()) finishSegment()
    }

    private fun finishSegment() {
        if (closed) return
        handler.removeCallbacks(flushTimeout)
        sensorManager.unregisterListener(this)
        var completed = completeOnStop && writeError == null
        try {
            val battery = getSystemService(BatteryManager::class.java)
            logEvent("battery ${battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)}")
            if (rawMode) {
                publishRawStatus()
                writeSensorReport()
            }
            if (ecgMode) {
                val ecg = rawStats[ECG_TYPE]
                ecgBlocked = ecg == null || ecg.count == 0L
                ecgResult = "ECG: " + (ecg?.summary(SystemClock.elapsedRealtimeNanos()) ?: "missing")
                for ((kind, st) in rawStats) logEvent("ecg_stats $kind registered=${st.registration} events=${st.count} rate=${"%.1f".format(Locale.US, st.rateHz)}Hz constant=${st.constant} all_zero=${st.allZero}")
                logEvent("ecg_test stopped result=$ecgResult")
            }
            logEvent(if (completed) "stop" else "interrupted")
        } catch (e: Exception) { completed = false; writeError = e.message ?: "report failed" }
        completed = completed && writeError == null
        closed = true
        for (writer in writers()) {
            try { writer.close() } catch (e: Exception) { completed = false; writeError = e.message ?: "close failed" }
        }
        try {
            metadata.put("state", if (completed) "complete" else "interrupted").put("closedAtMs", System.currentTimeMillis())
            if (writeError != null) metadata.put("error", writeError)
            sessions.save(metadata)
            if (completed) SessionManifest.seal(directory)
        } catch (e: Exception) {
            completed = false
            writeError = e.message ?: "finalization failed"
            runCatching { metadata.put("state", "interrupted").put("error", writeError); sessions.save(metadata) }
        }
        if (completeOnStop || writeError != null) runCatching { sessions.endIntent() }.onFailure {
            // requestStop prevents a stale journal from restarting a completed recording.
            Log.w(TAG, "Cannot clear recording journal", it)
        }
        val summary = when {
            !completed -> "Session retained · ${writeError ?: "interrupted"}"
            mode == RecordingMode.PROBE -> "Test saved · $rawStatus"
            else -> "Saved ${directory.name}"
        }
        val doSync = syncAfterStop && completed
        main.post {
            recorderResult = summary
            currentSession = null; isRunning = false; finishing = false
            poseHoldUntilMs = 0; spo2Mode = false; ecgMode = false
            wakeLock?.takeIf { it.isHeld }?.release()
            thread.quitSafely()
            if (!destroyed) stopSelf()
            if (doSync) SessionSync.start(applicationContext)
        }
    }

    override fun onDestroy() {
        destroyed = true
        if (isRunning && !finishing && ::handler.isInitialized) stopRecording(complete = false, sync = false)
        super.onDestroy()
    }

    private fun buildNotification(ecg: Boolean = false): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Sleep logging", NotificationManager.IMPORTANCE_LOW)
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("SleepLogger running")
            .setContentText(if (ecg) "ECG test (${ECG_TEST_MS / 1000} s)" else if (mode == RecordingMode.NORMAL) "Recording movement + heart rate" else "Recording optical sensor data")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }
}
