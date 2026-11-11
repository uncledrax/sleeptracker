package de.alex.sleeplogger

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class RecordingTest {
    private fun journal(mode: RecordingMode, live: Boolean = false) = JSONObject()
        .put("mode", mode.name).put("liveEnabled", live).put("sessionStartMs", 1000)
        .put("sessionId", "one-night").put("folder", "20261111_234512").put("segment", 1)

    @Test fun stickyRestartRestoresOvernightModeAndLocalTransport() {
        val saved = journal(RecordingMode.OVERNIGHT)
        val plan = RecordingPlan.resolve(null, null, saved, 360_000)!!
        assertEquals(RecordingMode.OVERNIGHT, plan.mode)
        assertFalse(plan.liveEnabled)
        assertSame(saved, plan.previous)
        assertEquals(0L, plan.endMs)
        assertNull(RecordingPlan.resolve(null, null, null, 360_000))
        assertNull(RecordingPlan.resolve(null, null, saved.put("stopRequested", true), 360_000))
    }

    @Test fun explicitStartOpensANewRecordingAndProbeKeepsItsDeadline() {
        val saved = journal(RecordingMode.PROBE, true)
        val resumed = RecordingPlan.resolve(null, null, saved, 65_000)!!
        assertEquals(121_000L, resumed.endMs)
        assertTrue(resumed.liveEnabled)
        assertNull(RecordingPlan.resolve(null, null, saved, 121_000))
        val new = RecordingPlan.resolve(RecordingMode.OVERNIGHT, null, saved, 121_000)!!
        assertNull(new.previous)
        assertFalse(new.liveEnabled)
        assertTrue(RecordingPlan.resolve(RecordingMode.OVERNIGHT, true, null, 1000)!!.liveEnabled)
    }

    @Test fun waveformCountersAndOriginalWidthsAreIndependentOfControllerEvents() {
        val optical = RawStreamStats("ppg")
        val controller = RawStreamStats("controller")
        controller.add(1_000_000_000L, floatArrayOf(1f), 1)
        assertEquals(0, optical.report(1_000_000_000L).getInt("events"))
        optical.registration = "registered"
        assertTrue(optical.summary(1_000_000_000L).contains("waiting"))
        optical.add(1_000_000_000L, floatArrayOf(0f, 0f, 0f, 0f), 1)
        optical.add(1_010_000_000L, floatArrayOf(17f, 4f, 0f, 0f), 2)
        val report = optical.report(1_030_000_000L)
        assertEquals(2, report.getInt("events"))
        assertEquals(100.0, report.getDouble("rateHz"), 0.0001)
        assertEquals(10.0, report.getDouble("maxGapMs"), 0.0001)
        assertEquals(20.0, report.getDouble("lastSampleAgeMs"), 0.0001)
        assertEquals("[4]", report.getJSONArray("eventWidths").toString())
        assertEquals("[1,2]", report.getJSONArray("storedWidths").toString())
        assertFalse(report.getBoolean("allZero"))
        assertFalse(report.getBoolean("constant"))
        assertEquals(1, report.getInt("changes"))
    }

    @Test fun recoveredGapUsesLastCompleteRecord() {
        val file = File.createTempFile("optical", ".csv")
        try {
            file.writeText("epoch_ms,accuracy,n,values\n1000,3,1,17\n1010,3,1,")
            assertEquals(1000L, lastCompleteSample(file))
            file.writeText("epoch_ms,accuracy,n,values\n")
            assertNull(lastCompleteSample(file))
        } finally { file.delete() }
    }
}
