/*
 * WiiBot firmware — ESP32 + motor driver, Arduino framework, NimBLE-Arduino.
 *
 * App contract (mirrors src/robot/protocol.ts — keep in sync):
 *   Device name : "WiiBot"
 *   Service     : a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5
 *   Command chr : a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d6  (WRITE, WRITE_NR)
 *   Status chr  : a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d7  (READ, NOTIFY, 1 Hz)
 *
 * Commands (short JSON, 128-byte static buffer):
 *   {"c":"fwd","s":60}  {"c":"back"} {"c":"left"} {"c":"right"}
 *   {"c":"stop"} {"c":"speed","s":60} {"c":"wiggle"} {"c":"hb"}
 *   - "s" is 0-100, optional (uses defaultSpeed when omitted).
 *   - "hb" is heartbeat only: resets the watchdog, touches nothing else.
 *
 * Safety: watchdog stops motors after 1000 ms with no message while running;
 * disconnect stops motors immediately; malformed JSON is ignored, never crashes.
 */

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <ArduinoJson.h>  // v6.x (StaticJsonDocument API)

// ============================ CONFIG (edit me) =============================
// [ESP32 board model]  e.g. "ESP32 DevKit V1 (30-pin, CP2102)"
// [motor driver]       e.g. "L298N" | "TB6612FNG" | "L9110S"
// [number of motors]   e.g. 2 (differential drive)
// Powered by [battery/supply] e.g. "2S LiPo 7.4V -> driver VM, 5V reg -> ESP32 VIN"

// L298N-style wiring: per side IN1/IN2 = direction, ENx = speed PWM.
// TB6612FNG:        per side AIN1/AIN2 = direction, PWMA = speed PWM. (same shape)
// L9110S (2-pin):   set MOTOR_[L|R]_PWM to -1 and PWM is applied on A/B instead
//                   (handled in applyMotorPins — search "L9110S").
#define MOTOR_L_A      26   // [pin] left direction A  (L298N IN1)
#define MOTOR_L_B      27   // [pin] left direction B  (L298N IN2)
#define MOTOR_L_PWM    14   // [pin] left speed PWM    (L298N ENA, -1 = 2-pin mode)
#define MOTOR_R_A      32   // [pin] right direction A (L298N IN3)
#define MOTOR_R_B      33   // [pin] right direction B (L298N IN4)
#define MOTOR_R_PWM    25   // [pin] right speed PWM   (L298N ENB, -1 = 2-pin mode)

// Battery: -1 = no divider wired -> stub value used. Otherwise ADC pin with
// a divider, e.g. 100k/27k for 2S. [battery/supply + divider?]
#define BATT_PIN       -1   // [pin or -1]
#define BATT_STUB_PCT  87   // reported when BATT_PIN < 0
// ADC raw value that means 100% (measure once with full battery, fill in).
#define BATT_ADC_FULL  3000 // [calibrate]

// Behaviour
#define DEFAULT_SPEED  60      // used when a motion cmd omits "s"
#define RAMP_TICK_MS   20      // ramp step period
#define RAMP_STEP      14      // duty steps (0-255) per tick (~0.35 s 0->full)
#define WATCHDOG_MS    1000    // stop motors if silent this long (MUST match app)
#define STATUS_MS      1000    // status notify period
#define WIGGLE_MS      1200    // total wiggle duration
#define WIGGLE_PHASE_MS 200    // direction flip period inside wiggle

#define DEBUG 1  // 1 = Serial logs on, 0 = silent (except boot line)
// ========================== END CONFIG =======================================

#if DEBUG
  #define LOG(...)   Serial.printf(__VA_ARGS__)
  #define LOGLN(...) do { Serial.printf(__VA_ARGS__); Serial.println(); } while (0)
#else
  #define LOG(...)
  #define LOGLN(...)
#endif

static const char* DEVICE_NAME   = "WiiBot";
static const char* SERVICE_UUID  = "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5";
static const char* CMD_CHAR_UUID = "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d6";
static const char* STS_CHAR_UUID = "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d7";

static const uint32_t PWM_FREQ = 5000;
static const uint8_t  PWM_RES  = 8;  // duty 0-255

struct Motor {
  int8_t pinA, pinB, pinPwm;
#if ESP_ARDUINO_VERSION_MAJOR < 3
  uint8_t ch;  // LEDC channel (core 2.x only; core 3.x addresses pins directly)
#endif
  int8_t dir;        // -1, 0, +1 (target direction)
  uint8_t target;    // target duty 0-255
  uint8_t current;   // ramped duty 0-255 (what is actually applied)
};

static Motor motors[2] = {
#if ESP_ARDUINO_VERSION_MAJOR < 3
  { MOTOR_L_A, MOTOR_L_B, MOTOR_L_PWM, 0, 0, 0, 0 },
  { MOTOR_R_A, MOTOR_R_B, MOTOR_R_PWM, 1, 0, 0, 0 },
#else
  { MOTOR_L_A, MOTOR_L_B, MOTOR_L_PWM, 0, 0, 0 },
  { MOTOR_R_A, MOTOR_R_B, MOTOR_R_PWM, 0, 0, 0 },
#endif
};

static NimBLEServer*         gServer   = nullptr;
static NimBLECharacteristic* gCmdChar  = nullptr;
static NimBLECharacteristic* gStsChar  = nullptr;
static volatile bool         gConnected = false;
static unsigned long         gLastMsgAt = 0;   // any BLE write resets watchdog
static uint8_t               gDefaultSpeed = DEFAULT_SPEED;  // 0-100
static unsigned long         gLastRampAt = 0;
static unsigned long         gLastStatusAt = 0;
// Wiggle state (non-blocking so watchdog + notify keep running)
static bool          gWiggleActive = false;
static unsigned long gWiggleUntil = 0;
static unsigned long gWigglePhaseAt = 0;
static bool          gWiggleFlip = false;

// ---------------- motor helpers ----------------

static uint8_t speedToDuty(uint8_t s) {
  if (s > 100) s = 100;
  return (uint8_t)((uint16_t)s * 255 / 100);
}

static void pwmWritePin(const Motor& m, uint8_t duty) {
#if ESP_ARDUINO_VERSION_MAJOR < 3
  ledcWrite(m.ch, duty);
#else
  if (m.pinPwm >= 0) ledcWrite(m.pinPwm, duty);
#endif
}

// Apply one motor's pins from its dir/current. Direction pins switch
// immediately; speed ramps in loop() so the robot never jerks.
static void applyMotorPins(const Motor& m) {
  if (m.dir > 0) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    // L9110S 2-pin mode: PWM the direction pins themselves.
    if (m.pinPwm < 0) { ledcWrite(m.pinA, m.current); digitalWrite(m.pinB, LOW); return; }
#endif
    digitalWrite(m.pinA, HIGH); digitalWrite(m.pinB, LOW);
  } else if (m.dir < 0) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    if (m.pinPwm < 0) { digitalWrite(m.pinA, LOW); ledcWrite(m.pinB, m.current); return; }
#endif
    digitalWrite(m.pinA, LOW); digitalWrite(m.pinB, HIGH);
  } else {
    digitalWrite(m.pinA, LOW); digitalWrite(m.pinB, LOW);
  }
  if (m.pinPwm >= 0) pwmWritePin(m, m.current);
}

static void stopTargets() {
  for (auto& m : motors) { m.dir = 0; m.target = 0; }
  gWiggleActive = false;
}

static void stopNow() {
  // Immediate halt (watchdog / disconnect): zero PWM first, then release.
  for (auto& m : motors) {
    m.dir = 0; m.target = 0; m.current = 0;
    applyMotorPins(m);
  }
  gWiggleActive = false;
  LOGLN("[mot] STOP now");
}

static bool motorsActive() {
  return motors[0].target > 0 || motors[1].target > 0 || gWiggleActive;
}

// dirL/dirR: -1 back, 0 stop, +1 fwd. speedPct 0-100.
static void drive(int8_t dirL, int8_t dirR, uint8_t speedPct) {
  gWiggleActive = false;
  uint8_t duty = speedToDuty(speedPct);
  motors[0].dir = dirL; motors[0].target = (dirL == 0) ? 0 : duty;
  motors[1].dir = dirR; motors[1].target = (dirR == 0) ? 0 : duty;
  for (auto& m : motors) applyMotorPins(m);  // dirs now, speed ramps up
  LOGLN("[mot] drive L=%d R=%d duty=%u", dirL, dirR, duty);
}

// ---------------- command parsing ----------------

static void handleCommand(const char* c, int s) {
  uint8_t speed = (s < 0) ? gDefaultSpeed : (uint8_t)constrain(s, 0, 100);
  if (s >= 0 && (strcmp(c, "fwd") == 0 || strcmp(c, "back") == 0 ||
                 strcmp(c, "left") == 0 || strcmp(c, "right") == 0 ||
                 strcmp(c, "speed") == 0)) {
    gDefaultSpeed = speed;  // explicit speed becomes the new default
  }
  if (strcmp(c, "fwd") == 0)         drive(1, 1, speed);
  else if (strcmp(c, "back") == 0)   drive(-1, -1, speed);
  else if (strcmp(c, "left") == 0)   drive(-1, 1, speed);   // spin in place
  else if (strcmp(c, "right") == 0)  drive(1, -1, speed);   // spin in place
  else if (strcmp(c, "stop") == 0)   { stopTargets(); LOGLN("[mot] stop"); }
  else if (strcmp(c, "speed") == 0)  { LOGLN("[mot] default speed=%u", gDefaultSpeed); }
  else if (strcmp(c, "wiggle") == 0) {
    gWiggleActive = true;
    gWiggleUntil = millis() + WIGGLE_MS;
    gWigglePhaseAt = 0;
    gWiggleFlip = false;
    LOGLN("[mot] wiggle %lums", (unsigned long)WIGGLE_MS);
  }
  else if (strcmp(c, "hb") == 0)     { /* heartbeat: watchdog already reset */ }
  else LOGLN("[ble] unknown cmd '%s' (ignored)", c);
}

class CmdCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* ch) override {
    gLastMsgAt = millis();  // ANY write proves the link is alive
    std::string v = ch->getValue();
    if (v.empty() || v.size() > 96) { LOGLN("[ble] write %u bytes (ignored)", (unsigned)v.size()); return; }
    char buf[96];
    memcpy(buf, v.data(), v.size());
    StaticJsonDocument<128> doc;  // small static buffer, no heap JSON
    DeserializationError err = deserializeJson(doc, buf, v.size());
    if (err) { LOGLN("[ble] malformed JSON (%s) — ignored", err.c_str()); return; }
    const char* c = doc["c"];
    if (!c) { LOGLN("[ble] missing 'c' — ignored"); return; }
    int s = doc["s"] | -1;
    LOGLN("[ble] cmd c=%s s=%d", c, s);
    handleCommand(c, s);
  }
};

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s) override {
    gConnected = true;
    gLastMsgAt = millis();
    LOGLN("[ble] client connected");
  }
  void onDisconnect(NimBLEServer* s) override {
    gConnected = false;
    stopNow();  // motors must never run without an owner
    LOGLN("[ble] client disconnected — re-advertising");
    NimBLEDevice::startAdvertising();  // re-advertise so the app can reconnect
  }
};

// ---------------- battery ----------------

static uint8_t readBatteryPct() {
#if BATT_PIN >= 0
  int raw = analogRead(BATT_PIN);
  int pct = map(raw, 0, BATT_ADC_FULL, 0, 100);
  return (uint8_t)constrain(pct, 0, 100);
#else
  (void)0;
  return BATT_STUB_PCT;
#endif
}

// ---------------- setup / loop ----------------

void setup() {
  Serial.begin(115200);
  Serial.println("\n[boot] WiiBot starting");

  for (auto& m : motors) {
    pinMode(m.pinA, OUTPUT); pinMode(m.pinB, OUTPUT);
    digitalWrite(m.pinA, LOW); digitalWrite(m.pinB, LOW);
    if (m.pinPwm >= 0) {
#if ESP_ARDUINO_VERSION_MAJOR < 3
      ledcSetup(m.ch, PWM_FREQ, PWM_RES);
      ledcAttachPin(m.pinPwm, m.ch);
      ledcWrite(m.ch, 0);
#else
      ledcAttach(m.pinPwm, PWM_FREQ, PWM_RES);
      ledcWrite(m.pinPwm, 0);
#endif
    } else {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
      ledcAttach(m.pinA, PWM_FREQ, PWM_RES);
      ledcAttach(m.pinB, PWM_FREQ, PWM_RES);
#endif
    }
  }
#if BATT_PIN >= 0
  analogReadResolution(12);
#endif

  NimBLEDevice::init(DEVICE_NAME);
  gServer = NimBLEDevice::createServer();
  gServer->setCallbacks(new ServerCallbacks());

  NimBLEService* svc = gServer->createService(SERVICE_UUID);
  gCmdChar = svc->createCharacteristic(
      CMD_CHAR_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  gCmdChar->setCallbacks(new CmdCallbacks());
  gStsChar = svc->createCharacteristic(
      STS_CHAR_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  svc->start();

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->setName(DEVICE_NAME);
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  adv->start();
  gLastMsgAt = millis();
  LOGLN("[ble] advertising as '%s'", DEVICE_NAME);
}

void loop() {
  const unsigned long now = millis();

  // Wiggle sequencer: flip spin direction each phase until time is up.
  if (gWiggleActive) {
    if (now >= gWiggleUntil) {
      stopTargets();
    } else if (now - gWigglePhaseAt >= WIGGLE_PHASE_MS) {
      gWigglePhaseAt = now;
      gWiggleFlip = !gWiggleFlip;
      uint8_t duty = speedToDuty(gDefaultSpeed);
      motors[0].dir = gWiggleFlip ? 1 : -1;  motors[0].target = duty;
      motors[1].dir = gWiggleFlip ? -1 : 1;  motors[1].target = duty;
      for (auto& m : motors) applyMotorPins(m);
    }
  }

  // Ramp: ease current duty toward target — no jerky starts/stops.
  if (now - gLastRampAt >= RAMP_TICK_MS) {
    gLastRampAt = now;
    for (auto& m : motors) {
      if (m.current == m.target) continue;
      if (m.current < m.target) {
        // int math: current + STEP can overflow uint8_t, so widen first.
        uint16_t n = (uint16_t)m.current + RAMP_STEP;
        m.current = (n > m.target) ? m.target : (uint8_t)n;
      } else {
        m.current = (m.current <= RAMP_STEP) ? 0 : (uint8_t)(m.current - RAMP_STEP);
      }
      applyMotorPins(m);
    }
  }

  // Watchdog: link alive but silent while driving = stop (app crashed/muted).
  if (motorsActive() && now - gLastMsgAt > WATCHDOG_MS) {
    LOGLN("[safe] watchdog %lums silent — stopping", (unsigned long)(now - gLastMsgAt));
    stopNow();
    gLastMsgAt = now;  // re-arm so we log once per second, not every loop
  }

  // 1 Hz status notify.
  if (gConnected && now - gLastStatusAt >= STATUS_MS) {
    gLastStatusAt = now;
    char msg[48];
    snprintf(msg, sizeof(msg), "{\"state\":\"%s\",\"batt\":%u}",
             motorsActive() ? "moving" : "idle", readBatteryPct());
    gStsChar->setValue((uint8_t*)msg, strlen(msg));
    gStsChar->notify();
    LOGLN("[ble] status %s", msg);
  }

  delay(5);  // yield to NimBLE stack; keeps notify timing stable
}
