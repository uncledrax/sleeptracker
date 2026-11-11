# SleepLogger for Pixel Watch

A Wear OS app that records what your watch's sensors see while you sleep, plus TypeScript tools to analyse it.
It logs the accelerometer and gyroscope (25 Hz), the heart-rate sensor (~1 Hz) and, on the Pixel Watch, the
undocumented raw PPG sensor (100 Hz observed on the original Pixel Watch) and the ECG electrode in the crown.

I built it to check myself for sleep apnea. The whole story, with results from seven nights, is in the blog post:
[I reverse-engineered my Pixel Watch's raw PPG sensor to check myself for sleep apnea](https://www.swetlow.com/blog/pixel-watch-raw-ppg-sleep-apnea/).

![Live analyzer replaying a real night: pulse wave from the raw PPG sensor with detected beats, heart rate, HRV, breathing rate](docs/live-analyzer.png)

*The live analyzer (`npm run ui`) replaying 15 minutes of one of my nights.*

> **Not a medical device.** This is a developer's experiment. It does not diagnose anything, and its numbers
> are only checked against Fitbit, which is itself an estimate. If you have symptoms of sleep apnea, talk to a
> doctor and get a real sleep study.

## What you get

| From | What | Works on |
|---|---|---|
| Motion | movement events, posture changes, breathing rate in still phases | any Wear OS 3+ watch |
| Heart-rate sensor | heart rate per second, periodic heart-rate spikes (CVHR) | any Wear OS 3+ watch |
| Raw PPG (`com.google.wear.sensor.ppg`) | every single heartbeat, HRV (RMSSD/SDNN), ectopic beat candidates, breathing from the pulse wave | Pixel Watch 1 (tested) |
| ECG (`com.google.sensor.ecg`) | a 150-s ECG with R peaks and HRV, live in the browser | Pixel Watch 1 (tested) |
| Fitbit export (optional) | sleep stages, SpO2, Fitbit HRV next to your own numbers | anything that syncs to Fitbit |

Plus a live analyzer in the browser (pulse wave, beat intervals, breathing, ECG) and Wi-Fi sync from the watch
to your PC without `adb`.

The upstream author tested the original Pixel Watch. On a Pixel Watch 4, run the two-minute sensor test below to establish what your watch and firmware expose. Motion, standard heart rate, optical samples, and controller events are recorded independently.

## Quick start

You need: a Wear OS watch, a PC on the same Wi-Fi, Android Studio (or the Android SDK with `adb`), and Node.js ≥ 20.

**1. Developer mode on the watch.** Settings › System › About › Versions › tap *Build number* 7 times.
Then Settings › Developer options › turn on *ADB debugging* and *Wireless debugging*, and pair:
```
adb pair <watch-ip>:<pairing-port> <code>
adb connect <watch-ip>:<debug-port>
```

**2. Install the app.** Open this folder in Android Studio, pick the watch, *Run*. Or: `./gradlew installDebug`.
Open *SleepLogger* on the watch and allow the permissions.

**3. Test the optical sensor.** Tap **2-min sensor test**, wear the watch snugly and rest your arm. The PPG line shows the optical sample count, measured rate, age of the latest sample and whether values are changing. Controller and extended-HR counts have their own lines. The test stops and saves automatically. Tap **Sync to PC** when the receiver is running. See [the Pixel Watch 4 test procedure](docs/manual.md#pixel-watch-4-first-recording).

**4. Record overnight.** Tap **Overnight PPG** and leave **Live view overnight** unchecked for local recording with normal screen timeout. First try a 30-minute screen-off recording to measure sample continuity and battery drain on your watch. Tap **Stop** to finish. **Start** still records motion and standard HR, and **Start + PPG** retains the interactive live workflow.

**5. Get the data onto your PC.**
```
cd analysis-ts
npm ci
npm run sync
```
Use the desktop receiver from this branch. **Sync to PC** copies sessions and keeps the originals on the watch. Manual **Stop** also starts a copy after the files close. Sessions land in `sessions/<start time>/`.
Allow Node.js on *private networks* when Windows asks. Fallback over adb: `npm run pull`.

**6. Analyse.**
```
npm run analyze -- ../sessions/<session>    # summary.txt, breathing.csv, movement_events.csv, per_minute.csv, CVHR
npm run ppg     -- ../sessions/<session>    # PPG nights: ppg_summary.txt, ppg_beats.csv (beats, HRV, ectopic candidates)
npm run ui                                  # live analyzer on http://localhost:8765 (also lists ECG tests)
```
Put a `fitbit.json` night export into the session folder and `analyze` adds sleep stages, SpO2 episodes and a
comparison with Fitbit (format: see [docs/manual.md](docs/manual.md#fitbit-export-optional)).

## Experiments

Each one is described step by step in the [manual](docs/manual.md):

- [Raw PPG test](docs/manual.md#6-testing-raw-ppg-data-experimental): what the hidden PPG sensor delivers.
- [Breath-hold test](docs/manual.md#7-breath-hold-test-voluntary-breath-holding-python-only): does the watch see a breathing pause?
- [ECG test](docs/manual.md#10-ecg-test-experimental): ECG from the crown into your own app, plus morning HRV.
- [SpO2 calibration](docs/manual.md#10b-spo2-calibration-test-experimental): channel ratios against a finger oximeter (in 7-channel mode the red/infrared ratio follows a breath-hold drop).
- [Sleep position](docs/manual.md#11-sleep-position-calibrated): calibrate wrist poses and classify nights.
- [Audio reference](docs/manual.md#5-audio-reference-from-the-phone-optional-python-only): a phone recording as ground truth for breathing and snoring.

## Repository layout

```
app/              Wear OS app (Kotlin): SensorLoggerService records, WifiLink/SessionSync talk to the PC
analysis-ts/      analysis, live analyzer (React + Express), sync/pull tools, tests
  src/lib/        signal processing (Butterworth, filtfilt, find_peaks, Welch …), no runtime dependencies
docs/manual.md    full reference for every feature and experiment
legacy/python/    the original Python scripts; still the only home of plots, audio, breath-hold, multi-night table
sessions/         your recordings (git-ignored, stays on your machine)
```

## Data format

Every recording is a folder `sessions/<YYYYMMDD_HHMMSS>/` with plain CSV:

- `accel.csv`, `gyro.csv`: `epoch_ms,x,y,z` (m/s² including gravity, rad/s)
- `hr.csv`: `epoch_ms,bpm,accuracy`
- `events.csv`: start/stop, sensors used, battery every 10 min, markers you tapped
- with PPG: `raw_ppg.csv`, `raw_ppg_ctrl.csv`, `raw_hr_ext.csv` as `epoch_ms,accuracy,n,values`
  (space-separated values; trailing zeros are trimmed). Each raw stream has a matching `*_timing.csv`
  with the original monotonic sensor timestamp in nanoseconds and original event width, in row order.
- `session.json` records model, OS build, app revision, time zone, recording mode, session ID and segment linkage.
- `sensor_report.json` records per-stream registration, sample counts, rates, event widths and maximum observed gaps.
- `session_manifest.json` stores file sizes and SHA-256 hashes after a segment closes successfully.
- The desktop PPG analysis writes `ppg_segments.csv` with per-segment channel, sample rate, exclusions and clean duration.

## Limits

Read the [honest limits](docs/manual.md#limits-honestly) before trusting any number. In short: breathing is only
estimated while you lie still, heart-rate spikes are a hint and not an apnea index, SpO2 from the raw channels
follows a deep drop during a breath hold but is uncalibrated and thrown off by deep breathing, so it is not a
night value, and nothing here replaces a sleep study.

## How this was made

Written together with Claude (Opus 5.5). Claude wrote most of the code; I decided what to build and test,
and every recording comes from my own nights.

## License

MIT, see [LICENSE](LICENSE).
