package de.alex.sleeplogger

import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/** All counters refer to one raw sensor. Values changing also includes status fields and counters. */
internal class RawStreamStats(val stringType: String) {
    var registration = "missing"
    var sensorName: String? = null
    var wakeUp = false
    var count = 0L
        private set
    private var firstNs = 0L
    private var lastNs = 0L
    private var previous: FloatArray? = null
    private val widths = sortedSetOf<Int>()
    private val storedWidths = sortedSetOf<Int>()
    private var changes = 0L
    private var lastChangeNs = 0L
    private var maxGapNs = 0L
    private var outOfOrder = 0L
    var allZero = true
        private set
    val constant: Boolean get() = changes == 0L
    val rateHz: Double get() = if (count > 1 && lastNs > firstNs)
        (count - 1) * 1e9 / (lastNs - firstNs) else 0.0

    fun add(ns: Long, values: FloatArray, storedWidth: Int) {
        val old = previous
        if (old == null) {
            firstNs = ns
            previous = values.copyOf()
        } else {
            val gap = ns - lastNs
            maxGapNs = maxOf(maxGapNs, gap)
            if (gap <= 0) outOfOrder++
            if (!old.contentEquals(values)) {
                changes++
                lastChangeNs = ns
                if (old.size == values.size) values.copyInto(old) else previous = values.copyOf()
            }
        }
        if (allZero && values.any { it != 0f }) allZero = false
        widths.add(values.size)
        storedWidths.add(storedWidth)
        lastNs = ns
        count++
    }

    fun summary(nowNs: Long): String {
        if (registration != "registered") return registration
        if (count == 0L) return "registered, waiting"
        val age = (nowNs - lastNs).coerceAtLeast(0L) / 1e9
        val shape = when {
            allZero -> "all zero"
            constant -> "constant"
            nowNs - lastChangeNs > 3_000_000_000L -> "steady"
            else -> "changing"
        }
        return String.format(Locale.US, "%d · %.1f Hz · %.1fs ago · %s", count, rateHz, age, shape)
    }

    fun report(nowNs: Long): JSONObject = JSONObject().apply {
        put("stringType", stringType); put("sensor", sensorName ?: JSONObject.NULL)
        put("registration", registration); put("wakeUp", wakeUp); put("events", count)
        put("eventWidths", JSONArray(widths.toList())); put("storedWidths", JSONArray(storedWidths.toList()))
        put("rateHz", rateHz); put("maxGapMs", maxGapNs / 1e6); put("nonIncreasingTimestamps", outOfOrder)
        put("firstSensorNs", if (count > 0) firstNs.toString() else JSONObject.NULL)
        put("lastSensorNs", if (count > 0) lastNs.toString() else JSONObject.NULL)
        put("lastSampleAgeMs", if (count > 0) (nowNs - lastNs).coerceAtLeast(0L) / 1e6 else JSONObject.NULL)
        put("allZero", if (count > 0) allZero else JSONObject.NULL)
        put("constant", if (count > 0) constant else JSONObject.NULL)
        put("changes", changes)
    }
}
