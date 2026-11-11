# SleepLogger manual

The detailed reference for every feature and experiment. Start with the [README](../README.md) for the
quick setup. Commands use the TypeScript tools in `analysis-ts/` (run them from that folder). A few tools
only exist in the older Python version under `legacy/python/`; those sections say so.

## Pixel Watch 4 first recording

1. Install the branch's debug APK on the watch using Android Studio or wireless ADB. With Windows PowerShell and this repository checked out, `.\gradlew.bat :app:installDebug` builds and installs it on a connected watch.
2. Open SleepLogger, grant the requested permissions and tap **2-min sensor test**. Keep the watch on your wrist and rest your arm. It stops after two minutes. Check **PPG** separately from **Controller** and **Extended HR**. A rising optical count establishes delivery. Look for a repeatable pulse in the exported trace before assigning channels or interpreting results.
3. From `analysis-ts` on your PC, run `npm ci`, then `npm run sync`. Tap **Sync to PC**. Alternatively, use a paired ADB connection and `npm run pull`. Inspect `sensor_report.json`, `session.json`, `sensors.txt` and `raw_ppg.csv` in the new session folder. If the optical stream is missing or registers but delivers no events, the inventory and report are still useful.
4. Run `npm run ppg -- ../sessions/<folder>` to generate the segment and beat reports for a recording with optical data. Try a 30-minute **Overnight PPG** session with **Live view overnight** off and the screen asleep. Compare optical cadence, largest gap, clean minutes and start/end battery with the short test. Then decide whether to record a full night.

New sessions carry the watch's IANA time zone. Explicit offsets in imported Fitbit timestamps take precedence. For older sessions recorded outside Berlin, use `npm run analyze -- ../sessions/<folder> --time-zone Australia/Sydney` (substitute your recording zone). Ambiguous or nonexistent local timestamps at a daylight-saving transition require an explicit offset to be included.

If Android recreates an overnight recording service, it resumes the recording mode in a new folder. `session.json` links the folders using `sessionId`, `segment` and `previousSegment`. Analyse each folder separately and keep the gap between them when comparing results.

## 1. Prepare the watch
1. Settings › System › About › Versions › tap **Build number** 7×.
2. Settings › Developer options › turn on **ADB debugging** and **Wireless debugging**.
3. Put the watch and the computer on the same Wi-Fi. Under "Wireless debugging" › **Pair new device**:
   ```
   adb pair <IP>:<pairing-port> <code>
   adb connect <IP>:<debug-port>      # the port is shown at the top under "Wireless debugging"
   adb devices
   ```

## 2. Build and install the app
- Open the folder in Android Studio and wait for the Gradle sync (downloads SDK 35 if missing).
- Pick the watch as the target device at the top, **Run**. Or from a terminal: `./gradlew installDebug`.
- Open the app on the watch, **Start**, allow the permissions. It runs as long as the notification is shown.
- In the morning open the app, **Stop**.

Tip: turn wireless debugging off at night, and do a 30-minute test before the first night.

## 3. Export the data
**Over Wi-Fi, without ADB (recommended).** The watch app talks to the PC directly; wireless debugging is only
needed to install new app versions.
```
cd analysis-ts
npm run sync        # or npm run ui – both receive sessions in the background
```
Tap **Sync to PC** to copy the recording. After a manual **Stop**, the app starts sync once the recording files close. The two-minute probe saves locally and can be synced when convenient. Use this branch's PC receiver. The watch discovers the PC over UDP 9001 and sends its files over HTTP 9002 on the same private Wi-Fi. The watch checks the receiver's file sizes and SHA-256 digests. Ordinary sync keeps watch copies. **Sync and remove copies…** enables optional removal of verified, finalized recordings. Older and interrupted recordings can be copied and stay on the watch.

Run `npm run ui` for live viewing or replay. **Overnight PPG** uses local capture by default. Select **Live view overnight** before starting if you need a live connection. **Start + PPG** keeps its interactive live view.

**Over ADB** (fallback):
**One command** (watch with wireless debugging on, same Wi-Fi as the PC):
```
cd analysis-ts
npm run pull                 # fetches new and changed sessions into ..\sessions
npm run pull -- --delete     # also deletes on the watch what is complete and identical here
npm run pull -- --list       # only shows what is on the watch
```
The watch is found automatically (devices adb knows, otherwise via mDNS, which works once the watch has been
paired with this PC; otherwise `--serial <IP:port>`). A completed session has a SHA-256 manifest. ADB pull stages and verifies completed files before replacing PC copies. Interrupted or older sessions are copy-only. `--delete` removes only complete recordings verified on both devices.

By hand, if needed: the files are in the app's private folder; with a debug build you can reach them via `run-as`:
```
adb devices          # with Wi-Fi debugging the watch often shows up twice -> pick one with -s <name>
adb -s <IP:port> shell run-as de.alex.sleeplogger ls files/sessions
```
Export (on Windows via `cmd`, because PowerShell's `>` corrupts binary data as UTF-16):
```
cmd /c "adb -s <IP:port> exec-out run-as de.alex.sleeplogger tar c -C files sessions > sessions.tar"
tar xf sessions.tar
```
Fetch a single night instead of all:
```
cmd /c "adb -s <IP:port> exec-out run-as de.alex.sleeplogger tar c -C files sessions/20261103_225540 > session.tar"
tar xf session.tar
```

Clean up on the watch (permanent – first check that the night is in your local `sessions\`):
```
adb -s <IP:port> shell run-as de.alex.sleeplogger rm -r files/sessions/20261030_224900   # one night
adb -s <IP:port> shell run-as de.alex.sleeplogger rm -r files/sessions                   # all (not during a recording)
```
The `sessions` folder is recreated automatically on the next start.

Each night produces `sessions/<start time>/` with:
- `accel.csv` – `epoch_ms,x,y,z` (m/s², including gravity)
- `gyro.csv` – `epoch_ms,x,y,z` (rad/s)
- `hr.csv` – `epoch_ms,bpm,accuracy` (accuracy 0–3, <2 is discarded in the analysis)
- `events.csv` – start/stop, sensors used, whether a wake-up sensor/wakelock was active, battery level every 10 min

Size: ~25 MB per 8 h and sensor CSV.

## 4. Analysis
```
cd analysis-ts
npm install
npm run analyze -- ../sessions/20261030_230512
```
Plots (`night.png`) only exist in the Python version: `python legacy/python/analyze.py sessions/<session> --plot`
(`pip install -r legacy/python/requirements.txt`).
Results in the session folder:
- `summary.txt` – overview
- `movement_events.csv` – start, duration, posture change in degrees, heart rate before / peak after
- `breathing.csv` – breathing rate per 2-min window (every 30 s), quality 0–1, source (accel/gyro/both)
- `cvhr_episodes.csv` – episodes of periodic heart-rate spikes (see below)
- `per_minute.csv`, `night.png`

Tuning knobs at the top of `src/analyze.ts`: `THRESHOLD_K`, `MIN_THRESHOLD` (movement), `BREATH_MIN_QUALITY`,
`CVHR_MIN_RISE_BPM`, `CVHR_CYCLE_S`, `CVHR_MIN_CYCLES`.

### Fitbit export (optional)
If the session folder contains a `fitbit.json` (the night export with `"fitbit": {...}`), the analysis
reads it automatically (or `--fitbit path/to/file`). That adds:
- the watch's breathing rate per sleep stage next to the Fitbit values, heart-rate comparison, movement per stage
- SpO2 minutes below 90%, desaturations, and `spo2_episodes.csv` for groups of at least five low minutes. The report labels sustained runs and intermittent clusters, gives the longest consecutive low run, and marks insufficient HR data when a pulse-response assessment is unavailable.
- room climate (tado), plot with hypnogram, Fitbit heart rate and SpO2

### Breathing rate
Only in quiet windows. Per sensor a band-pass of 0.1–0.5 Hz, principal component across all three axes,
period via autocorrelation. Quality = height of the autocorrelation peak. Pure noise scores
≤0.25 in tests, hence the threshold of 0.4. Gyro and accelerometer are estimated separately and
averaged when they agree; outliers against the smoothed trend are down-weighted.

### Periodic heart-rate spikes (CVHR)
At the end of a breathing pause there is typically a brief arousal with a heart-rate jump of 10–20 bpm.
If this repeats every 25–100 s at least 4 times, the script flags an episode, including the share
of spikes with simultaneous movement. This is a hint, not proof of apnea and not an AHI.

### Compare several nights
Python only for now. First analyse each night, then:
```
python legacy/python/nights.py sessions/20261030_224900 sessions/20261031_235707 sessions/20261101_231037 --out nights.csv
```
One column per night: sleep and stages (Fitbit), HRV, resting heart rate, heart rate asleep and in deep sleep,
breathing rate per stage, movements/h, posture changes, SpO2, CVHR, battery, room climate, steps the day before.
For A/B comparisons (e.g. mouth tape) put a `notes.txt` into the session folder:
```
mouth_tape=yes
note=toilet 04:00
```

## 5. Audio reference from the phone (optional, Python only)
Without a reference the thresholds cannot be tuned seriously. The phone recording provides one.

**Recording:** any voice recorder app that records for hours with the screen off
(Pixel: "Recorder"). Phone on the bedside table, microphone towards your head, plugged in.
1. Start the watch app, then start the recording.
2. **Clap once firmly with the watch hand.** Bang in the audio + spike in the accelerometer
   = synchronisation to ~0.1 s.
3. In the morning stop both and put the audio file next to the session folder.

**Analysis** (m4a/mp3 need ffmpeg: `winget install Gyan.FFmpeg` or `scoop install ffmpeg`):
```
npm run analyze -- ../sessions/20261030_230512          # in analysis-ts
python legacy/python/audio.py sessions/20261030_230512 "Recording.m4a"
```
The start time comes from the file metadata or the file name; if needed `--start "2026-10-30 23:05:12"`.

Result: `audio_summary.txt` plus CSVs:
- `audio_events.csv` – snores, breathing pause candidates (10–120 s of silence right after audible
  breathing, with "ends loud" for gasps/snores), loud events
- `audio_breathing.csv` – breathing rate from the breathing sound
- `breathing_vs_audio.csv` – watch against audio. The summary shows the error per
  watch quality level: set `BREATH_MIN_QUALITY` where the error becomes small.
- the share of heart-rate spikes that come shortly after an audible pause, with the chance level for comparison.

If you don't sleep alone, the other person is recorded too. Agree on it beforehand.

### Testing without a watch
```
python legacy/python/simulate.py testnight --audio
python legacy/python/analyze.py testnight --plot
python legacy/python/audio.py testnight "testnight/Recording 2025-10-30 19.46.27.wav"
```
Generates 3 h with breathing 15→12/min, three movements, a clap, a snoring phase, 20 apnea-like
cycles and a matching phone recording (~170 MB WAV).

## 6. Testing raw PPG data (experimental)
`adb shell dumpsys sensorservice` shows undocumented Google sensors on the Pixel Watch 1:
`com.google.wear.sensor.ppg` (PPG sensor, TI), `com.google.sensor.heart_rate_extended` and
`com.google.sensor.ppg_controller`. The **Start + PPG** button additionally records them raw
(`raw_ppg.csv`, `raw_hr_ext.csv`, `raw_ppg_ctrl.csv`, format `epoch_ms,accuracy,n,values` with
space-separated values) and writes `sensors.txt` listing all sensors.

Test briefly first, not overnight (data volume and battery unknown): wear the watch snugly, **Start + PPG**,
sit still for 1–2 minutes, Stop, export as in section 3, then
```
python legacy/python/ppg_probe.py sessions/<session> --plot      # Python only
```
The script shows the sample rate, values per event, statistics per channel, whether a channel contains a
pulse wave (peak in the pulse band vs. heart-rate sensor) and whether values look like beat intervals in ms.

**Result of the first test (2026-11-03):** `raw_ppg.csv` delivers 100 Hz with 16 values per event, of which
7 are used. v6 shows the pulse wave most cleanly (v1, v3, v4 are also light channels, v0 is probably
ambient light, v2/v5 are status with sentinel values −59000/−23000). `raw_hr_ext.csv` only contains bpm and a
status value, no beat intervals. Trailing zeros are no longer written (~40 → ~20 MB/h).

Beat-to-beat analysis:
```
npm run ppg -- ../sessions/<session>       # in analysis-ts; --plot only in legacy/python/ppg.py
```
The TypeScript analyser divides the recording at optical-mode, cadence and clock-gap boundaries. It selects a channel within each stretch and writes the result, exclusions and usable minutes to `ppg_segments.csv`. It rejects motion and atypical beats, computes RMSSD from adjacent accepted intervals within one segment, and lists
ectopic beat candidates: "premature" (short interval + pause, together ≈ 2 intervals) and
"missed pulse" (one interval ≈ twice as long). Output: `ppg_summary.txt`, `ppg_beats.csv`,
`ppg_events.csv`, `ppg.png` with a snippet per candidate. Without a simultaneous ECG these are candidates,
not findings.

**Felt ectopic beats as a reference:** during a recording the **Felt** button appears. Every
time you feel a skipped beat, tap it immediately with the other hand (the arm with the watch stays
still). This writes `felt` with a timestamp to `events.csv`. In interactive **Start + PPG** mode the screen stays on for the
first 20 min. The PPG analysis then checks the 8 s before each marker for the pattern (premature / missed pulse),
reports the chance of a random hit and counts automatic candidates without a marker (`ppg_felt.csv`).

## 7. Breath-hold test (voluntary breath holding, Python only)
Checks whether the watch sees a breathing pause at all. Procedure (~9 min, preferably with **Start + PPG**):
1. Lie on your back, watch arm relaxed next to your body, start, breathe calmly for 2 min.
2. Shake the wrist firmly for 2 s and start a stopwatch at the same time (time marker).
3. From 0:30, five times: hold your breath for 20 s (after a normal exhale), breathe normally for 40 s.
4. At ~5:30 shake again, Stop.
```
python legacy/python/breath_hold.py sessions/<session> --plot   # Python only
```
Finds the time marker automatically (otherwise `--marker HH:MM:SS`), filters the breathing motion (0.1–0.7 Hz,
gyro and accelerometer separately), computes the amplitude over 5 s and marks pauses in which it
drops below 35 % of normal breathing (≥ 8 s). Output: detected pauses out of 5, false alarms, time offset,
heart rate before/during/after the pauses and, if raw PPG is present, the same for the breathing modulation
of the pulse wave. Other procedures: `--first-s`, `--hold-s`, `--cycle-s`, `--holds`.

Limit: holding your breath means the chest stands still (like a central pause). In an
obstructive apnea the chest keeps working against the closed airway. If the watch fails
the test, it won't detect real apneas either. If it passes, that is only a first step.

## 8. Live dashboard
The watch streams its measurements live to the laptop, over Wi-Fi directly or through the ADB tunnel
(latency < 1 s). Recording on the watch continues independently.
```
npm run ui                                          # finds the watch over Wi-Fi or adb by itself
npm run ui -- --demo                                # without a watch, synthetic data
npm run ui -- --replay ../sessions/<session> --speed 4
```
On the watch use **Start + PPG** (without PPG there is no pulse wave). Within 3 s the watch shows
"Live ✓" (and "PPG …k" if started with PPG). Shown: pulse wave with detected beats, beat intervals of the last
5 min (red = ectopic beat candidate, grey = movement, green = felt, purple = heart-rate sensor),
breathing motion, movement, heart rate, RMSSD (60 s), breaths/min. The live detection is simpler than
the PPG analysis and reports more false alarms. The analysis afterwards is what counts.

The PPG channel is chosen automatically (the one with the clearest pulse period; `--channel 6` fixes it).
Below the pulse wave is a diagnostics line: channel and quality per channel, buffer length, lag of
PPG and accel relative to the laptop clock, range of the filtered wave, errors and the last
received PPG line. The live server records everything it receives to `sessions/live/live_<time>.txt`.
This file helps with debugging.

Costs battery (Wi-Fi stays on), so not all night. When the watch screen turns off, Wi-Fi may
sleep. Then the live connection drops, but recording continues.

## 9. TypeScript tools and the Python legacy
`analysis-ts/` needs only Node ≥ 20 (`npm install` once). All commands from that folder:
```
npm run analyze  -- ../sessions/<session>         # one night: summary.txt, breathing, movements, CVHR, Fitbit
npm run ppg      -- ../sessions/<session>         # raw PPG: beats, HRV, ectopic beat candidates
npm run ecg      -- ../sessions/<session>         # ECG test report (section 10)
npm run position -- classify ../sessions/<session> --plot   # sleep position (section 11), plot as SVG
npm run ui                                        # live analyzer in the browser (React)
npm run sync                                      # receive sessions from the watch over Wi-Fi
npm run pull                                      # fetch sessions over adb instead
npm test                                          # DSP and parsers against reference values
```
Use TypeScript for segment-aware PPG analysis and current reports. The archived Python PPG plotting tool selects one channel across the recording and writes its own report files; run it on a copy if you need its plots. Python-only tools include plots (`--plot`), `audio.py`, `breath_hold.py`, `nights.py`, `ppg_probe.py`, `simulate.py`.

## 10. ECG test (experimental)
Checks whether a third-party app gets raw ECG data from the Pixel Watch. The watch lists two undocumented
sensors to the app (`sensors.txt`): "ECG Sensor" (`com.google.sensor.ecg`, type 65550, minDelay 4000 µs ≈ 250 Hz)
and "ECG Lead Detector" (`com.google.sensor.ecg_lead_detector`, type 65551). Whether they deliver data with
the normal `BODY_SENSORS` permission is exactly the open question – the Fitbit ECG app may use a
permission or an unlock that third-party apps cannot get.

Procedure (like the Fitbit ECG app):
1. Sit still, arm resting on the table, watch snug on the wrist.
2. On the watch: **ECG test** (below "Start + PPG", only visible while nothing is recording).
3. Immediately put a finger of the other hand on the crown (touch, don't press) and keep it there.
   The watch shows "Finger on the crown", a countdown, the number of ECG events and the last lead-detector value.
4. After 150 s the test stops by itself. "Ready" then shows the result, e.g. `ECG: 15000 events, 250 Hz`
   or `ECG blocked? 0 events` (plus a toast).

The test writes its own session folder with only `raw_ecg.csv`, `raw_ecg_lead.csv` (format as for PPG:
`epoch_ms,accuracy,n,values`), `raw_ppg.csv` and `hr.csv` as references, `events.csv` and `sensors.txt`.
`events.csv` contains for each sensor its name, type, minDelay/maxDelay, FIFO, reporting mode and the result of
`registerListener`, and at the end per sensor: events, first/last time, effective rate, whether all values were
constant or 0. Night and PPG recordings are unchanged.

Export a single session (same pattern as section 3; the folder name is shown by `ls files/sessions`):
```
adb -s <IP:port> shell run-as de.alex.sleeplogger ls files/sessions
cmd /c "adb -s <IP:port> exec-out run-as de.alex.sleeplogger tar c -C files sessions/20261105_201500 > session.tar"
tar xf session.tar
```
Analysis (TypeScript):
```
cd analysis-ts
npm run ecg -- ..\sessions\20261105_201500
npm run ui                                      # tab "ECG test" lists all sessions with raw_ecg.csv
```
`ecg_probe.ts` reports events, sample rate, values per event, statistics per channel and the lead-detector history.
If a channel looks like an ECG (≥ 8 regular R peaks): band-pass 0.5–40 Hz, R peaks, heart rate and RR intervals,
comparison with `hr.csv` and the PPG beats (same rules as `ppg.ts`), and the delay R peak → pulse wave.
Outputs `ecg_summary.txt`, `ecg_beats.csv` and `ecg_probe.svg` (10-s snippet raw + filtered with R peaks,
RR over 60 s, lead detector).

**Live view:** start the dashboard first (`npm run ui -- --serial <IP:port>`), then start the ECG test on the watch.
The Live tab then shows the ECG card at the top: last 10 s with R peaks, heart rate from the ECG, whether the finger
is on the crown, and the RR intervals of the whole test. A saved test can be played back the same way:
`npm run ui -- --replay ..\sessions\20261105_104704`.

What the data looks like (first test, 2026-11-05): the ECG is value **v0** (signed, ±2^21 = ADC rail),
v1 is a running sample counter and v2 a byte 0–255 without signal (sequence/checksum). After the finger touches the
crown, v0 sits at the rail for 1–2 s and needs ~8 s to settle; the analysis skips that part automatically.
A channel only counts as ECG if its beats repeat their shape (median correlation with the average beat ≥ 0.7);
peaks picked from noise reach ~0.4. Without that check the first version took v2 and reported 152 bpm.

If the sensor delivers nothing (`registered=false`, 0 events, or only constant values), that is the answer:
a third-party app gets no ECG. No workarounds beyond that. Not a medical device, no diagnosis.

**HRV from the ECG (morning measurement).** The ECG test now runs 150 s (≈8 s settling + 2 min). The live ECG card
shows RMSSD, SDNN and extrasystoles of the whole test with a progress bar to the standard 2 min; the tab
"ECG test" shows the history of all ECG tests (also written to `sessions/hrv_ecg.csv`, or
`npx tsx src/ecg_probe.ts --history ..\sessions`). R peaks are timed to a fraction of a sample. Only comparable
when done the same way every day: right after waking, lying, finger of the other hand on the crown, **normal
breathing** (slow deep breathing raises RMSSD through respiratory sinus arrhythmia and measures the technique,
not recovery).

## 10b. SpO2 calibration test (experimental)
The watch has no SpO2 sensor for apps, but the raw PPG has three LED channels besides green (v1 at 20 mA,
v3/v4 at 4.9 mA, see `raw_ppg_ctrl.csv`). Which of them is red and which infrared is not known. The live
analyzer (`npm run ui -- --serial …`, watch on "Start + PPG") shows a **SpO2 test** card: perfusion index ratios
v4/v1, v3/v1, v4/v3 every 2 s (8-s window, moving phases ignored), the uncalibrated night-5 hypothesis
110 − 25·(v4/v1), a large clock and an input for oximeter readings (saved as `oximeter <value>` in
`sessions/live/live_<time>.txt`).

> **Safety:** never hyperventilate (fast, deep breathing, e.g. Wim Hof style) before a hold. It lets you hold longer
> but can make you pass out without warning, even on land; in or near water it can be fatal. Do these tests sitting
> or lying down, with normal breathing before each hold, and never aim for a deep desaturation on purpose.

Calibration protocol (~10 min, sitting, watch snug, arm resting at heart height, oximeter on the other hand):
film oximeter and dashboard clock together the whole time; 2 min normal breathing; then 3× exhale fully,
hold 30–45 s, breathe normally for 90 s. Stop if you get dizzy. Afterwards the ratio that follows the
oximeter decides the channels and the curve; only then is a live SpO2 number meaningful, and only within the
range the test reached.

Result of the first test (2026-11-05): the oximeter went down to 79 %, but the watch stayed in its 6-channel
**day mode** the whole time, where the candidate v4 is off. The watch switches by itself between 6 values per
line (day: v1 20 mA, v3 2.35 mA, v5 green, v0/v2/v4 ambient) and 7 values (night: v1 20 mA, v3/v4 4.9 mA,
v6 green, v0/v2/v5 ambient). Repeat the test only when the card below shows **7 channels**.

Result of the second test (2026-11-06, session `20261106_151153`, 7 channels the whole time): two holds, oximeter
99 → 82 % and 99 → 81 %. The ratio R = PI v4 / PI v1 rose from 0.50 to 0.98 in both holds (r = 0.86 and 0.91
against the oximeter within the holds), and the uncalibrated 110 − 25·R put the lowest points at 81 and 85 %.
So **v4 is most likely red, v1 (and v3, its ratio to v1 stays at 1.0) infrared**. During the fast, deep breathing
rounds before each hold the estimate dropped to 52–80 % while the oximeter stayed at 99 %, together with jumps
in pulse amplitude on both channels; in calm minutes it stayed within about two points. Not validated for
nights: three nights gave only r = 0.21–0.64 against Fitbit, whose SpO2 barely moves (93–97 %).

**PPG channels card** (live analyzer, below the SpO2 card): mode badge (6/7 channels, time of the last switch),
per channel the LED current, DC, pulse strength PI and the last 8 s, plus 10 min of DC (relative) and PI.
LED currents need the current watch app (it streams the PPG controller as `q` lines) or a replay.
- *Colour test* (which LED is red, which infrared): watch off the wrist, sensor down on white, red and green
  paper in the dark, 30 s each. Red light: DC stays high on red paper, drops on green. Infrared: stays high on
  both (most dyes are transparent in infrared; avoid black, carbon ink absorbs infrared). The watch may switch
  the PPG off when it is not on a wrist; then the counters stop.
- *Finger test*: fingertip on the sensor with light, constant pressure. PI rises several-fold; with a breath
  hold and the oximeter on the other hand this shows whether a channel ratio follows SpO2 at all.

## 11. Sleep position (calibrated)
The watch sees how the **wrist** lies, not the torso. With the arm under the pillow or on the hip
the same body position looks completely different. So the model is personal and needs several arm
placements per position. Whether it is good enough for you is answered by the phone check below,
not by the calibration itself.

**Calibrate** (once, ~10 min, then now and then a few more taps): start a recording, scroll down to
"Calibrate position". Lie in the position, tap it (Back / Left / Right / Stomach), keep the watch arm
still until the watch buzzes (25 s). Then change the arm placement and tap the same position again.
2–4 placements per position, the ones you really sleep in. Watch on the left wrist: on your left
side the arm is usually under the body or under the pillow, calibrate exactly those.
```
npm run position -- calibrate ../sessions/<session>    # adds the taps to sessions/pose_model.json
```
Taps in a moving hold are discarded. A warning appears if two positions have templates that look
the same; the watch cannot tell those apart.

**Classify a night** (after `npm run analyze`, so the per-position statistics have data):
```
npm run position -- classify ../sessions/<session> --plot
```
Splits the night at movement events, assigns each still segment the closest template
(`unknown` if none is within 35°, `uncertain` if two positions are within 8° of each other).
Output: `positions.csv`, `position_summary.txt`, `positions.svg`. Per position: time, movements/h,
heart-rate spike episodes, breathing rate, heart rate and, with a Fitbit export, SpO2 and sleep stages.
This is where positional effects show up (e.g. spike episodes almost only on the back).

**Check it against the phone (do this before trusting the numbers):** one night with the phone on
the sternum (tight shirt pocket or tape), **screen facing out, top edge towards the head**, recording
the accelerometer, e.g. with the app "Sensor Logger" (enable Gravity and TotalAcceleration, export CSV).
Do the calibration taps in that night as well; the phone then learns its own templates from them.
```
npm run position -- validate ../sessions/<session> --phone "../sessions/<sensor-logger-export>" --plot
```
The clocks of phone and watch are aligned automatically via the roll-overs (±2 min, otherwise
`--offset-s`). Output: `position_validation.txt` with the share of time the watch gives a position,
accuracy, confusion matrix, back detection (hit rate / false alarms) and the chance level for comparison;
`position_validation.csv` and a plot. Only if accuracy is clearly above chance and back
detection is reliable is a vibration alarm for the back position worth building.

## Limits (honestly)
- **Breathing rate** is only estimated in quiet phases and comes with a quality value. At the wrist
  the signal is very small; expect many unusable windows. The parameters have only been checked on
  synthetic data. Real tuning needs a reference (audio recording of the
  breathing or a chest strap). A test night with the watch on the chest shows what the signal can deliver.
- **Audio pauses** are candidates: quiet breathing is often inaudible. That's why only silences right
  after audible breathing count, and silences over 120 s count as "too quiet", not as a pause.
- **CVHR** does not replace polysomnography. The watch smooths its BPM, beta blockers dampen the
  heart-rate response, and snoring without apnea or normal arousals also produce spikes.
- Officially Wear OS only delivers BPM. The Pixel Watch, however, also reports a raw "PPG Sensor"
  and "HeartRate-Extended" (only `BODY_SENSORS` needed). Whether the data reaches third-party apps and what it contains
  is answered by the PPG test (section 6): yes, raw PPG at 100 Hz, which gives beat-to-beat intervals and HRV.
- Battery: continuous heart rate + wakelock costs noticeably. `events.csv` shows whether a wake-up accelerometer
  was available.
