package de.alex.sleeplogger

import android.app.AlertDialog
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.CheckBox
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

class MainActivity : ComponentActivity() {

    private lateinit var status: TextView
    private lateinit var toggle: Button
    private lateinit var probeButton: Button
    private lateinit var overnightButton: Button
    private lateinit var overnightLive: CheckBox
    private lateinit var cleanupButton: Button
    private lateinit var rawButton: Button
    private lateinit var markButton: Button
    private lateinit var poseHeader: TextView
    private val poseButtons = LinkedHashMap<String, Button>()
    private lateinit var ecgButton: Button
    private lateinit var spo2Button: Button
    private lateinit var syncButton: Button
    private val clockFmt = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)
    private var pendingMode = RecordingMode.NORMAL
    private var shownEcgResult: String? = null

    private val ui = Handler(Looper.getMainLooper())

    private val requiredPermissions: Array<String>
        get() = buildList {
            // With targetSdk 34, Wear OS 6 maps BODY_SENSORS to READ_HEART_RATE automatically.
            add(Manifest.permission.BODY_SENSORS)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.toTypedArray()

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            if (result.values.all { it }) startLogger(pendingMode)
            else status.text = "Permission missing.\nAllow it in Settings › Apps."
        }

    private val refresh = object : Runnable {
        override fun run() {
            render()
            // faster during the ECG test so the event counter and countdown move smoothly
            // SpO2 test: 10 Hz so the clock's tenths are readable in a video
            ui.postDelayed(this, when {
                SensorLoggerService.isRunning && SensorLoggerService.spo2Mode -> 100
                SensorLoggerService.isRunning && SensorLoggerService.ecgMode -> 250
                else -> 1000
            })
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!SensorLoggerService.isRunning) {
            val sessions = RecordingSessions(this)
            // A process death between Stop and finalization must leave the old recording available to sync.
            runCatching { sessions.recoverStopped() }.onFailure {
                android.util.Log.w("SleepLogger", "Could not recover interrupted stop", it)
            }
        }
        val dm = resources.displayMetrics
        status = TextView(this).apply { gravity = Gravity.CENTER; textSize = 12f; setPadding(0, 8, 0, 8) }
        toggle = Button(this).apply { setOnClickListener { onToggle(RecordingMode.NORMAL) } }
        probeButton = Button(this).apply { text = "2-min sensor test"; setOnClickListener { onToggle(RecordingMode.PROBE) } }
        overnightButton = Button(this).apply { text = "Overnight PPG"; setOnClickListener { onToggle(RecordingMode.OVERNIGHT) } }
        overnightLive = CheckBox(this).apply { text = "Live view overnight"; isChecked = false }
        rawButton = Button(this).apply { text = "Start + PPG"; setOnClickListener { onToggle(RecordingMode.RAW) } }
        // experimental: 150 s (2 min usable for HRV) with the undocumented ECG sensors, finger of the other hand on the crown
        ecgButton = Button(this).apply { text = "ECG test"; setOnClickListener { onToggle(RecordingMode.ECG) } }
        // SpO2 calibration: PPG recording, large clock, screen stays on (film watch + oximeter together)
        spo2Button = Button(this).apply { text = "SpO2 test"; setOnClickListener { onToggle(RecordingMode.SPO2) } }
        // Ordinary Wi-Fi sync retains the watch files.
        syncButton = Button(this).apply { text = "Sync to PC"; setOnClickListener { SessionSync.start(this@MainActivity) } }
        cleanupButton = Button(this).apply {
            text = "Sync and remove copies…"
            setOnClickListener {
                AlertDialog.Builder(this@MainActivity)
                    .setMessage("Remove completed recordings from this watch after verifying them on the PC? Check your intended receiver is running on your trusted Wi-Fi.")
                    .setNegativeButton("Cancel", null)
                    .setPositiveButton("Sync and remove") { _, _ -> SessionSync.start(this@MainActivity, deleteAfter = true) }
                    .show()
            }
        }
        // ectopic beat felt -> time marker in events.csv ("felt"), as a reference for ppg.py
        markButton = Button(this).apply {
            text = "Felt"
            textSize = 18f
            minimumHeight = (dm.heightPixels * 0.28).toInt()   // large, so it can be hit blindly
            setOnClickListener {
                startService(Intent(this@MainActivity, SensorLoggerService::class.java)
                    .setAction(SensorLoggerService.ACTION_MARK)
                    .putExtra(SensorLoggerService.EXTRA_TIME, System.currentTimeMillis()))
            }
        }
        // Position calibration: lie in the position, tap it, keep still until the watch buzzes (25 s).
        // Each position 2–4 times with different arm placements. position.py learns from these.
        poseHeader = TextView(this).apply {
            gravity = Gravity.CENTER; textSize = 12f; setPadding(0, 16, 0, 4)
            text = "Calibrate position"
        }
        for ((label, title) in listOf("back" to "Back", "left" to "Left", "right" to "Right", "stomach" to "Stomach")) {
            poseButtons[label] = Button(this).apply {
                text = title
                setOnClickListener {
                    startService(Intent(this@MainActivity, SensorLoggerService::class.java)
                        .setAction(SensorLoggerService.ACTION_POSE)
                        .putExtra(SensorLoggerService.EXTRA_POSE, label)
                        .putExtra(SensorLoggerService.EXTRA_TIME, System.currentTimeMillis()))
                }
            }
        }
        // Round display: leave margins at the sides and top/bottom, everything in a ScrollView
        // (swipe or crown). Order: Felt at the top, status, Stop/Start at the bottom.
        val padX = (dm.widthPixels * 0.12).toInt()
        val padY = (dm.heightPixels * 0.14).toInt()
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(padX, padY, padX, padY)
            addView(markButton, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT))
            addView(status)
            addView(toggle, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT))
            for (view in listOf(probeButton, overnightButton, overnightLive)) {
                addView(view, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            }
            addView(rawButton, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT))
            addView(ecgButton, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT))
            addView(spo2Button, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT))
            addView(syncButton, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT))
            addView(cleanupButton)
            addView(poseHeader)
            poseButtons.values.forEach {
                addView(it, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT))
            }
        }
        val scroll = ScrollView(this).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = true
            isFocusableInTouchMode = true      // needed so the crown (rotary) scrolls
            addView(column)
        }
        setContentView(scroll)
        scroll.requestFocus()
    }

    override fun onResume() { super.onResume(); ui.post(refresh) }
    override fun onPause() { super.onPause(); ui.removeCallbacks(refresh) }

    private fun onToggle(mode: RecordingMode) {
        pendingMode = mode
        if (SensorLoggerService.isRunning) {
            startService(Intent(this, SensorLoggerService::class.java)
                .setAction(SensorLoggerService.ACTION_STOP))
        } else if (requiredPermissions.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }) {
            startLogger(mode)
        } else {
            permissionLauncher.launch(requiredPermissions)
        }
    }

    private fun startLogger(mode: RecordingMode) {
        startForegroundService(Intent(this, SensorLoggerService::class.java)
            .putExtra(SensorLoggerService.EXTRA_MODE, mode.name)
            .putExtra(SensorLoggerService.EXTRA_LIVE, mode != RecordingMode.OVERNIGHT || overnightLive.isChecked))
    }

    private fun render() {
        status.textSize = 12f
        val idle = !SensorLoggerService.isRunning
        for (view in listOf(probeButton, overnightButton, overnightLive, cleanupButton)) {
            view.visibility = if (idle) View.VISIBLE else View.GONE
        }
        cleanupButton.isEnabled = !SessionSync.running
        toggle.isEnabled = !SensorLoggerService.finishing
        if (SensorLoggerService.finishing) {
            status.text = "Saving recording…"
            return
        }
        if (SensorLoggerService.isRunning && SensorLoggerService.spo2Mode) {
            val now = System.currentTimeMillis()
            status.textSize = 30f
            status.text = clockFmt.format(java.util.Date(now)) + "." + (now % 1000) / 100
            toggle.text = "Stop"
            markButton.visibility = View.GONE
            poseHeader.text = "SpO2 test · ${SensorLoggerService.rawStatus}" +
                (if (SensorLoggerService.liveConnected) " · Live ✓ ${SensorLoggerService.liveVia}" else "")
            poseHeader.visibility = View.VISIBLE
            poseButtons.values.forEach { it.visibility = View.GONE }
            rawButton.visibility = View.GONE
            ecgButton.visibility = View.GONE
            spo2Button.visibility = View.GONE
            syncButton.visibility = View.GONE
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else if (SensorLoggerService.isRunning && SensorLoggerService.ecgMode) {
            val left = ((SensorLoggerService.ecgEndsAtMs - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
            status.text = "Finger on the crown\n$left s · ECG ${SensorLoggerService.ecgCount}\n" +
                "lead ${SensorLoggerService.ecgLeadLast}" +
                (if (SensorLoggerService.liveConnected) " · Live ✓ ${SensorLoggerService.liveVia}" else "")
            toggle.text = "Stop"
            shownEcgResult = null   // so the result of this test is shown/toasted
            rawButton.visibility = View.GONE
            ecgButton.visibility = View.GONE
            spo2Button.visibility = View.GONE
            syncButton.visibility = View.GONE
            markButton.visibility = View.GONE
            poseHeader.visibility = View.GONE
            poseButtons.values.forEach { it.visibility = View.GONE }
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else if (SensorLoggerService.isRunning) {
            // keep it short so "Felt" and "Stop" fit on the screen without scrolling
            status.text = "${SensorLoggerService.lastBpm.toInt()} bpm · felt ${SensorLoggerService.markCount}\n" +
                (if (SensorLoggerService.mode == RecordingMode.PROBE)
                    "Sensor test · ${((SensorLoggerService.testEndsAtMs - System.currentTimeMillis()) / 1000).coerceAtLeast(0)}s\n" else "") +
                (if (SensorLoggerService.rawMode) SensorLoggerService.rawStatus else "no PPG") +
                (if (SensorLoggerService.liveConnected) " · Live ✓ ${SensorLoggerService.liveVia}" else "")
            toggle.text = "Stop"
            rawButton.visibility = View.GONE
            ecgButton.visibility = View.GONE
            spo2Button.visibility = View.GONE
            syncButton.visibility = View.GONE
            markButton.visibility = View.VISIBLE
            val now = System.currentTimeMillis()
            val holdLeft = (SensorLoggerService.poseHoldUntilMs - now) / 1000
            poseHeader.text = if (holdLeft > 0) "Keep still: ${SensorLoggerService.poseHoldLabel} ${holdLeft} s"
                else "Calibrate position"
            for ((label, b) in poseButtons) {
                val n = SensorLoggerService.poseCounts[label] ?: 0
                b.text = label.replaceFirstChar { it.uppercase() } + if (n > 0) " ($n)" else ""
                b.visibility = View.VISIBLE
            }
            poseHeader.visibility = View.VISIBLE
            // In the PPG test keep the screen on for the first 20 min so "Felt" takes a single tap.
            // After that (e.g. PPG overnight) let it turn off normally again.
            // During position calibration keep it on until 2 min after the last hold, for the next tap.
            val keepOn = SensorLoggerService.mode == RecordingMode.PROBE ||
                (SensorLoggerService.mode == RecordingMode.RAW &&
                now - SensorLoggerService.startedAtMs < 20 * 60_000L) ||
                now < SensorLoggerService.poseHoldUntilMs + 2 * 60_000L
            if (keepOn) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            val ecgResult = SensorLoggerService.ecgResult
            status.text = listOf("Ready", SensorLoggerService.recorderResult, ecgResult.orEmpty())
                .filter { it.isNotEmpty() }.joinToString("\n") +
                (if (SessionSync.status.isNotEmpty()) "\n${SessionSync.status}" else "")
            syncButton.visibility = View.VISIBLE
            syncButton.isEnabled = !SessionSync.running
            if (ecgResult != null && ecgResult != shownEcgResult) {
                shownEcgResult = ecgResult
                if (SensorLoggerService.ecgBlocked) Toast.makeText(this, ecgResult, Toast.LENGTH_LONG).show()
            }
            toggle.text = "Start"
            rawButton.visibility = View.VISIBLE
            ecgButton.visibility = View.VISIBLE
            spo2Button.visibility = View.VISIBLE
            markButton.visibility = View.GONE
            poseHeader.visibility = View.GONE
            poseButtons.values.forEach { it.visibility = View.GONE }
            if (SessionSync.running) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }
}
