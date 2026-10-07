# Wii-Robot 🤖👀

An Android-first React Native (TypeScript, Expo development build) app that turns
a phone into the **face and brain** of a mini ESP32 robot.

- Full-screen animated **eyes** (Skia + Reanimated, UI thread) that follow your
  touch and react with expressions.
- **Voice control**: "Hey Wii" / "Hey William" wake words (foreground only) →
  deterministic command router → BLE. Commands never touch the LLM.
- **Questions** go to a small on-device LLM (4-bit GGUF, 0.5B–1B) and are spoken
  with TTS.
- **Safety first**: the ESP32 stops the motors if the link drops (heartbeat
  watchdog), and the app stops the heartbeat when backgrounded.

> Not Expo Go — the app needs custom native code (BLE, Skia, Vosk, Porcupine,
> llama.rn), so it runs as an **Expo development build**.

---

## 1. What you need

### Hardware
| Item | Notes |
|---|---|
| Android phone (Android 8+) | The robot's face + brain. More RAM = bigger brain (2 GB min for 0.5B, 3 GB for 1B). |
| ESP32 board | e.g. ESP32 DevKit V1. See `firmware/WiiBot/WiiBot.ino` CONFIG section for pins. |
| Motor driver + motors | L298N / TB6612FNG style dual H-bridge, 2WD chassis. |
| Battery | e.g. 2S LiPo 7.4 V into driver VM; 5 V regulator → ESP32 VIN. Common GND everywhere. |
| USB cable + computer | For flashing the ESP32 and building the app. |

### Accounts & files
- **Picovoice Console** (free): custom "Hey Wii" + "Hey William" Android `.ppn`
  files, plus an **Access Key**.
- **WiFi** on the phone (one-time ~40 MB Vosk model + ~400 MB LLM downloads).

### Software on your computer
- Node 22+, npm, Git, JDK 17 (for Android builds), Android platform tools (`adb`).
- Arduino IDE (for the ESP32) **or** `arduino-cli`.
- `eas-cli` (only needed later for the signed release APK).

---

## 2. Repository map

```
Wii-Robot/
  App / entry        src/App.tsx, index.js, app.config.js (env secrets), app.json
  src/eyes/          Skia face: EyesView, parametric controller, expressions, touch
  src/robot/         BLE client, protocol contracts, heartbeat, useRobot()
  src/voice/         Porcupine wake, Vosk STT, audio state machine, TTS, chime
  src/intent/        deterministic command router + 47 unit tests
  src/ai/            GGUF model manager, llama.rn service, streaming answers
  src/screens/       FaceScreen, ControlsOverlay, MicButton, AudioPill,
                     SettingsScreen, DiagnosticsScreen
  src/util/log.ts    ring-buffer log (300 entries) + export
  firmware/WiiBot/   ESP32 sketch (NimBLE-Arduino, ArduinoJson)
  assets/            chime.wav + porcupine/*.ppn (you add these)
```

Key contracts (single source of truth, both sides copy verbatim):
`src/robot/protocol.ts` — device name `WiiBot`, service/characteristic UUIDs,
`{"c":"fwd","s":60}` wire format, 1000 ms watchdog.

---

## 3. Flash the ESP32 first

1. Install in Arduino IDE: **ESP32 core** (2.0.x or 3.x — the sketch handles
   both `ledc` APIs), libraries **NimBLE-Arduino 1.4.x** + **ArduinoJson 6.x**.
2. Open `firmware/WiiBot/WiiBot.ino`, edit the **CONFIG** block:
   - motor pins (`MOTOR_L_A/B/PWM`, `MOTOR_R_A/B/PWM`),
   - battery pin or `-1` for the stub value,
   - `DEBUG 1` while setting up, `0` later.
3. Wire it (defaults assume an L298N-style driver):

   | ESP32 GPIO | Driver | Notes |
   |---|---|---|
   | 26 / 27 / 14 | IN1 / IN2 / ENA | left side + speed PWM |
   | 32 / 33 / 25 | IN3 / IN4 / ENB | right side + speed PWM |
   | GND → GND | common ground | motors misbehave without this |
   | motor supply → driver VM only | ESP32 on its own 5 V regulator | never power motors from USB |

   **Wheels off the ground for the first test.**
4. Flash at 115200 baud, open Serial Monitor. You should see
   `[ble] advertising as 'WiiBot'`.
5. Sanity-check with **nRF Connect** on your phone: find `WiiBot`, connect,
   enable Notify on the status characteristic (1 Hz
   `{"state":"idle","batt":87}`), write `{"c":"fwd","s":40}` to the command
   characteristic → wheels ramp up. Stop sending for >1 s → wheels stop by
   themselves (watchdog). Disconnect → wheels stop, `WiiBot` re-advertises.

---

## 4. Build the app

```bash
cd Wii-Robot
npm install --legacy-peer-deps   # first time only

# 1. wake-word files (trained by you, Android builds, EXACT names):
#      assets/porcupine/hey-wii.ppn
#      assets/porcupine/hey-william.ppn
#    The app will not bundle until both exist.

# 2. phone in Developer Options → USB Debugging → plug in, allow the RSA key
adb devices                      # must show your phone as: device

# 3. build + install the dev-client (5–15 min, needs the key below)
PICOVOICE_ACCESS_KEY=xxxx npx expo run:android
```

Day-to-day afterwards (JS-only changes, no rebuild):
```bash
PICOVOICE_ACCESS_KEY=xxxx npx expo start --dev-client
```

Useful scripts: `npm run android` (rebuild), `npm test` (53 unit tests),
`npm run tsc` (typecheck), `npx expo doctor` (health).

---

## 5. First run — in this order

1. **Eyes.** The app opens on the black face. Drag → pupils follow. Tap →
   surprised. Long-press / slow stroke → happy `^ ^`. Four quick taps → annoyed.
   Triple-tap the top-right corner for the expression debug panel. Leave it
   alone 60 s → it falls asleep; touch wakes it.
2. **Drive.** Tap **Connect** (allow Nearby devices + Location when asked) →
   green dot + battery %. Hold the D-pad arrows to drive, release to stop;
   speed slider, **wiggle**, and the always-visible red **STOP**. Tap the eyes
   (not a button) → wiggle. Hide the panel with `hide ›` for a clean face.
3. **Voice.** Tap the voice pill to enable (first tap may download the ~40 MB
   Vosk model on WiFi). Say **"Hey Wii… go forward"** → chime, listening eyes,
   it drives. Say **"Hey Wii… don't go forward"** → logged as a question, the
   robot does *not* move (negation veto, by design).
4. **Brain.** It will first tell you no brain is installed. Open ⚙ → download
   **Qwen 2.5 0.5B** (~397 MB, WiFi, pausable/resumable) → ask
   **"Hey Wii… what is an ESP32?"** → it thinks (thinking eyes), then answers
   out loud, sentence by sentence. Tap the face mid-answer to interrupt it, or
   shout "stop".
5. **Tune.** ⚙ → wake sensitivity (start 0.5; down to ~0.3 against TV chatter,
   up to ~0.7 across rooms; short "Hey Wii" usually wants +0.1 over
   "Hey William") and the live **start test** bench. ⚙ → **open diagnostics**
   for link/audio/brain/RAM + log export.

---

## 6. How it works (30-second architecture)

- **Eyes** (`src/eyes/`): parametric model
  (`eyeOpenness, pupilX/Y, eyelidTop/Bottom, eyeScale, happyArc`) held in
  Reanimated shared values, read directly by Skia on the UI thread — React
  state never drives motion. Untouched 30 s in idle → blink cadence drops to
  8–14 s and drift pauses, so the canvas goes nearly static (battery).
- **One mic owner** (`src/voice/audioController.ts`):
  `WAKE_LISTENING → COMMAND_LISTENING → THINKING → SPEAKING → WAKE_LISTENING`.
  Porcupine is fully stopped before Vosk starts (350 ms handoff) and only
  restarts after TTS + 500 ms quiet, so the robot never hears itself.
- **Deterministic intent** (`src/intent/router.ts`): lowercase → strip wake
  words/fillers → negation veto → stop priority → direction resolution →
  speed/duration modifiers → fuzzy (Levenshtein ≤1, words ≥4 chars only, with a
  `want≠wait` denylist). No match + >2 words → question; else noise. Pure
  function, 47 tests including "don't go forward".
- **BLE link** (`src/robot/`): single-owner reconnect loop with backoff,
  20 msg/s rate limit, 400 ms heartbeat against the firmware's 1000 ms
  watchdog. Backgrounding the app sends stop **and** pauses the heartbeat, so
  a lost stop-write can't keep the robot driving in your pocket.
- **Brain** (`src/ai/`): resumable GGUF download with size verification and
  RAM/storage gates; lazy llama.rn context (n_ctx 1024, ≤80 tokens, last 3
  turns, 3-min idle unload); answers stream into sentence-by-sentence TTS.
  Interrupts: face tap, shouted bare "stop" (barge-in), backgrounding.

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Bundler: "Unable to resolve …hey-wii.ppn" | Add both Android `.ppn` files with exact names (Section 4). |
| Voice pill: "no Picovoice key" | Restart Metro/ rebuild with `PICOVOICE_ACCESS_KEY=…` set. |
| "WiiBot not found" | ESP32 powered + flashed? Still connected in nRF Connect (BLE allows one link — disconnect there)? Phone Location services on? Tap Retry (backoff keeps trying). |
| Permission blocked | Banner → Open Settings → allow Nearby devices + Location (+ Microphone for voice). |
| Wake misses / false alarms | ⚙ sliders (Section 5.5); verify with the live test log first. |
| Answer never comes | ⚙ → model status `ready`? Device `unsupported_device` (needs 2–3 GB RAM)? |
| Motors keep running?! | Firmware watchdog stops them ≤1 s after the last message; app backgrounding pauses the heartbeat. If it persists, the ESP32 isn't running this firmware — reflash. |
| `npm install` peer conflicts | Use `--legacy-peer-deps`, then `npx expo install --fix`. |
| Anything else | ⚙ → diagnostics → export log → file lands in app storage; pull with the `adb pull` line shown on screen. |

---

## 8. Release build (signed APK)

```bash
npm i -g eas-cli && eas login
eas build:configure                       # creates eas.json
# eas.json → "production": { "android": { "buildType": "apk" } }
eas secret:create --name PICOVOICE_ACCESS_KEY --value xxxx --scope project
eas build -p android --profile production
```
EAS manages the keystore (back it up with `eas credentials`). Bump `version`
+ `android.versionCode` in `app.json` per release. After installing the APK,
repeat the safety check: drive → background the app → motors must stop
within ~1 s.

---

## 9. Project history (stages)

0. Expo TS + dev-client scaffold, permissions, typed contracts, black face.
1. Parametric Skia eyes, UI-thread animation, touch gestures, debug overlay.
2. ESP32 firmware: NimBLE service, JSON commands, ramped PWM, watchdog.
3. App BLE client, heartbeat, reconnect, D-pad overlay, eyes↔robot glue.
4. Vosk STT (grammar + free modes), intent router + tests, push-to-talk.
5. Porcupine wake words, audio state machine, TTS, settings + test bench.
6. On-device LLM (streaming sentence TTS, barge-in, idle unload), model manager.
7. Hardening audit (reconnect fan-out, background heartbeat, audio races),
   idle throttle, diagnostics, ring-buffer logging.

Voice roadmap, if you want more: per-topic history clearing, TTS voice pick,
persistent wake sensitivity, and a release AAB for the Play Store.
