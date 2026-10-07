import { PermissionsAndroid, Platform } from 'react-native';
import {
  BleManager,
  State as BleState,
  type Device,
  type Subscription,
} from 'react-native-ble-plx';
import type { RobotCommand } from '../types';
import { log } from '../util/log';
import { fromBase64Ascii, toBase64Ascii } from './encoding';
import {
  BLE_COMMAND_CHAR_UUID,
  BLE_DEVICE_NAME,
  BLE_SERVICE_UUID,
  BLE_STATUS_CHAR_UUID,
  HEARTBEAT_INTERVAL_MS,
  buildCommandJson,
  parseStatusPayload,
} from './protocol';

/** UI-facing link lifecycle. `reconnecting` = backoff between attempts. */
export type ConnState =
  | 'idle'
  | 'scanning'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

export type RobotErrorCode =
  | 'permission-denied'
  | 'permission-blocked'
  | 'bluetooth-off'
  | 'device-not-found'
  | 'not-connected'
  | 'connection-failed'
  | 'unsupported';

export class RobotError extends Error {
  code: RobotErrorCode;
  constructor(code: RobotErrorCode, message: string) {
    super(message);
    this.name = 'RobotError';
    this.code = code;
  }
}

/** Latest firmware status notification. */
export interface StatusEvent {
  state: 'idle' | 'moving';
  batt: number;
  at: number;
}

export type ConnListener = (s: ConnState, err: RobotError | null) => void;
export type StatusListener = (s: StatusEvent) => void;
export type PermissionResult = 'granted' | 'denied' | 'blocked';

const SCAN_TIMEOUT_MS = 12_000;
const MIN_WRITE_INTERVAL_MS = 50; // 20 msgs/sec ceiling
const RECONNECT_DELAYS = [1000, 2000, 5000, 10_000]; // then 10s forever

/**
 * Thin owner of the BleManager: scan → connect → monitor → heartbeat.
 * - Writes go through one rate limiter (write-without-response).
 * - Heartbeat skips a beat rather than jumping the queue, so a held D-pad
 *   can never be starved by hb and vice versa; watchdog margin stays huge.
 * - Reconnect loop runs while `wantConnection` is true; any manual
 *   disconnect() bumps the generation and stops it.
 */
export class RobotClient {
  private manager = new BleManager();
  private device: Device | null = null;
  private connState: ConnState = 'idle';
  private lastError: RobotError | null = null;
  private wantConnection = false;
  private generation = 0; // invalidates stale async flows + reconnect loops
  private reconnectAttempt = 0;
  private loopActive = false; // exactly one reconnect loop owns retries

  private connListeners = new Set<ConnListener>();
  private statusListeners = new Set<StatusListener>();
  private disconnectSub: Subscription | null = null;
  private statusSub: Subscription | null = null;
  private btStateSub: Subscription | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private lastWriteAt = 0;
  private pendingJson: string | null = null;

  // ---------- subscriptions ----------

  onConnState(cb: ConnListener): () => void {
    this.connListeners.add(cb);
    return () => {
      this.connListeners.delete(cb);
    };
  }

  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  get state(): ConnState {
    return this.connState;
  }

  get error(): RobotError | null {
    return this.lastError;
  }

  get isConnected(): boolean {
    return this.connState === 'connected' && this.device !== null;
  }

  /** Epoch ms of the last BLE write (command or heartbeat). Null if never. */
  get lastWriteAtMs(): number | null {
    return this.lastWriteAt === 0 ? null : this.lastWriteAt;
  }

  /** Live RSSI when connected; null otherwise (throws nothing). */
  async readRSSI(): Promise<number | null> {
    if (!this.device) return null;
    try {
      const rssi = await this.device.readRSSI();
      return rssi?.rssi ?? null;
    } catch {
      return null;
    }
  }

  /**
   * SAFETY: call on app background/foreground. Backgrounding stops the
   * heartbeat so a missed stop-write can't keep the watchdog fed while the
   * phone sits in a pocket (the link stays up in background, so the firmware
   * watchdog alone would NOT save us). Foreground restarts it if connected.
   */
  setBackgrounded(bg: boolean) {
    if (bg) {
      this.stopHeartbeat();
    } else if (this.isConnected && !this.hbTimer) {
      this.startHeartbeat();
    }
  }

  private setConn(s: ConnState, err: RobotError | null = null) {
    this.connState = s;
    this.lastError = err;
    this.connListeners.forEach((cb) => {
      try {
        cb(s, err);
      } catch (e) {
        console.warn('[robot] conn listener failed', e);
      }
    });
  }

  private emitStatus(s: StatusEvent) {
    this.statusListeners.forEach((cb) => {
      try {
        cb(s);
      } catch (e) {
        console.warn('[robot] status listener failed', e);
      }
    });
  }

  // ---------- permissions ----------

  /**
   * Android 12+ (API 31): BLUETOOTH_SCAN + BLUETOOTH_CONNECT, plus location
   * (our manifest sets neverForLocation=false, and most OEMs need it anyway).
   * Older: location only. iOS prompts automatically on first BLE use.
   */
  async requestPermissions(): Promise<PermissionResult> {
    if (Platform.OS !== 'android') return 'granted';
    const api = typeof Platform.Version === 'number' ? Platform.Version : 0;
    const perms =
      api >= 31
        ? [
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          ]
        : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

    let blocked = false;
    let denied = false;
    for (const p of perms) {
      const res = await PermissionsAndroid.request(p, {
        title: 'Wii-Robot Bluetooth',
        message:
          'Wii-Robot needs Bluetooth + location permission to find and drive the ESP32 robot.',
        buttonPositive: 'Allow',
        buttonNegative: 'Deny',
      });
      if (res === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) blocked = true;
      else if (res !== PermissionsAndroid.RESULTS.GRANTED) denied = true;
    }
    if (blocked) return 'blocked';
    if (denied) return 'denied';
    return 'granted';
  }

  // ---------- connect / scan ----------

  /** User-initiated connect. Enables auto-reconnect until disconnect(). */
  async connect(): Promise<void> {
    this.wantConnection = true;
    this.generation++;
    this.reconnectAttempt = 0;
    await this.connectOnce(this.generation);
  }

  private async connectOnce(gen: number): Promise<void> {
    if (gen !== this.generation) return;
    if (this.device) return; // already attached

    this.setConn('scanning');

    const perm = await this.requestPermissions();
    if (gen !== this.generation) return;
    if (perm !== 'granted') {
      const err =
        perm === 'blocked'
          ? new RobotError(
              'permission-blocked',
              'Bluetooth permission blocked. Open Settings → Apps → Wii-Robot → Permissions and allow Nearby devices + Location.',
            )
          : new RobotError(
              'permission-denied',
              'Bluetooth permission denied. Grant Nearby devices + Location to find WiiBot.',
            );
      this.setConn('error', err);
      throw err;
    }

    const bt = await this.manager.state();
    if (bt !== BleState.PoweredOn) {
      const err = new RobotError(
        'bluetooth-off',
        'Bluetooth is off. Turn it on and tap Retry.',
      );
      // Stay in `reconnecting`: the BT-state watcher + loop retry on power-on.
      this.setConn('reconnecting', err);
      this.watchBtState();
      this.enterLoop(gen);
      throw err;
    }

    try {
      await this.scanAndAttach(gen);
    } catch (e) {
      // Single retry owner: the loop (done() below only rejects now).
      if (gen === this.generation && this.wantConnection && !this.device) {
        if (this.connState !== 'error') {
          this.setConn(
            'reconnecting',
            e instanceof RobotError ? e : new RobotError('connection-failed', String(e)),
          );
        }
        this.enterLoop(gen);
      }
      throw e;
    }
  }

  private scanAndAttach(gen: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (err: RobotError | null) => {
        if (this.scanTimer) {
          clearTimeout(this.scanTimer);
          this.scanTimer = null;
        }
        try {
          this.manager.stopDeviceScan();
        } catch {
          // Already stopped — harmless.
        }
        if (gen !== this.generation) {
          reject(new RobotError('connection-failed', 'Superseded.'));
          return;
        }
        if (err) {
          this.setConn('error', err);
          reject(err);
          // No recursion here: the single reconnect loop (enterLoop) owns
          // retries — spawning one here fanned out duplicate scans.
          return;
        }
        resolve();
      };

      this.scanTimer = setTimeout(() => {
        done(
          new RobotError(
            'device-not-found',
            'WiiBot not found. Check: ESP32 powered + flashed, not connected to nRF Connect (BLE allows one link), phone Location services on.',
          ),
        );
      }, SCAN_TIMEOUT_MS);

      this.manager.startDeviceScan(
        [BLE_SERVICE_UUID],
        { allowDuplicates: false },
        async (scanError, dev) => {
          if (gen !== this.generation) {
            done(new RobotError('connection-failed', 'Superseded.'));
            return;
          }
          if (scanError) {
            done(
              new RobotError(
                'connection-failed',
                `Scan failed: ${scanError.message}`,
              ),
            );
            return;
          }
          if (!dev) return;
          const uuids = (dev.serviceUUIDs ?? []).map((u) => u.toLowerCase());
          const isOurs =
            dev.name === BLE_DEVICE_NAME ||
            dev.localName === BLE_DEVICE_NAME ||
            uuids.includes(BLE_SERVICE_UUID.toLowerCase());
          if (!isOurs) return;
          // Match: stop scanning first so the timeout can't fire mid-attach.
          if (this.scanTimer) {
            clearTimeout(this.scanTimer);
            this.scanTimer = null;
          }
          try {
            this.manager.stopDeviceScan();
          } catch {
            // ignore
          }
          this.setConn('connecting');
          try {
            await this.attach(dev, gen);
            if (gen !== this.generation) return;
            resolve();
          } catch (e) {
            done(
              e instanceof RobotError
                ? e
                : new RobotError('connection-failed', `Attach failed: ${String(e)}`),
            );
          }
        },
      );
    });
  }

  private async attach(device: Device, gen: number): Promise<void> {
    const connected = await device.connect({ autoConnect: false });
    if (gen !== this.generation) {
      await connected.cancelConnection().catch(() => undefined);
      throw new RobotError('connection-failed', 'Superseded.');
    }
    await connected.discoverAllServicesAndCharacteristics();
    this.device = connected;

    this.statusSub?.remove();
    this.statusSub = connected.monitorCharacteristicForService(
      BLE_SERVICE_UUID,
      BLE_STATUS_CHAR_UUID,
      (err, char) => {
        if (err || !char?.value) return; // drop is reported via onDisconnected
        try {
          const parsed = parseStatusPayload(fromBase64Ascii(char.value));
          if (parsed) this.emitStatus({ ...parsed, at: Date.now() });
        } catch (e) {
          console.warn('[robot] bad status payload', e);
        }
      },
    );

    this.disconnectSub?.remove();
    this.disconnectSub = connected.onDisconnected(() => {
      this.handleDrop(gen, 'Link lost. Reconnecting…');
    });

    this.startHeartbeat();
    this.reconnectAttempt = 0;
    this.setConn('connected');
  }

  /** User-initiated disconnect. Stops auto-reconnect. */
  async disconnect(): Promise<void> {
    this.wantConnection = false;
    this.generation++;
    // Best effort: tell the firmware to stop before releasing the link.
    // It stops on disconnect anyway — this is belt and braces.
    await this.sendStop();
    this.teardownLink();
    this.setConn('idle');
  }

  private teardownLink() {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    try {
      this.manager.stopDeviceScan();
    } catch {
      // ignore
    }
    this.stopHeartbeat();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingJson = null;
    this.statusSub?.remove();
    this.statusSub = null;
    this.disconnectSub?.remove();
    this.disconnectSub = null;
    const dev = this.device;
    this.device = null;
    if (dev) dev.cancelConnection().catch(() => undefined);
  }

  private handleDrop(gen: number, message: string) {
    log('warn', 'robot', `link drop: ${message}`);
    this.teardownLink();
    if (gen !== this.generation || !this.wantConnection) {
      this.setConn('idle');
      return;
    }
    this.setConn(
      'reconnecting',
      new RobotError('connection-failed', message),
    );
    this.enterLoop(gen);
  }

  /** Starts the single retry loop; extra callers while one runs are ignored. */
  private enterLoop(gen: number) {
    if (this.loopActive) return;
    this.loopActive = true;
    void (async () => {
      try {
        while (gen === this.generation && this.wantConnection && !this.device) {
          const wait =
            RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
          this.reconnectAttempt++;
          await new Promise((r) => setTimeout(r, wait));
          if (gen !== this.generation || !this.wantConnection || this.device) return;
          // Bluetooth may have been toggled: only scan when powered.
          try {
            const bt = await this.manager.state();
            if (bt !== BleState.PoweredOn) {
              this.setConn(
                'reconnecting',
                new RobotError('bluetooth-off', 'Bluetooth is off. Turn it on to reconnect.'),
              );
              this.watchBtState();
              continue;
            }
          } catch {
            continue;
          }
          this.setConn('scanning');
          try {
            await this.scanAndAttach(gen);
            return;
          } catch {
            if (this.connState !== 'reconnecting' && this.connState !== 'error') {
              this.setConn('reconnecting');
            }
          }
        }
      } finally {
        this.loopActive = false;
      }
    })();
  }

  private watchBtState() {
    if (this.btStateSub) return;
    this.btStateSub = this.manager.onStateChange((state) => {
      if (
        state === BleState.PoweredOn &&
        this.wantConnection &&
        !this.device &&
        (this.connState === 'reconnecting' || this.connState === 'error')
      ) {
        // New generation retires any waiting loop; the fresh loop owns retries.
        this.generation++;
        this.reconnectAttempt = 0;
        this.setConn('scanning');
        this.enterLoop(this.generation);
      }
    }, true);
  }

  // ---------- send path ----------

  /** Rate-limited send. Throws RobotError('not-connected') when offline. */
  async send(cmd: RobotCommand): Promise<void> {
    if (!this.isConnected) {
      throw new RobotError('not-connected', 'Not connected to WiiBot.');
    }
    this.enqueue(buildCommandJson(cmd.kind, cmd.speed as number | undefined));
  }

  /** Immediate best-effort stop. Never rejects — safe from AppState hooks. */
  async sendStop(): Promise<void> {
    if (!this.isConnected) return;
    this.pendingJson = null;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      await this.writeNow(buildCommandJson('stop'));
    } catch (e) {
      console.warn('[robot] stop write failed', e);
    }
  }

  async sendWiggle(): Promise<void> {
    await this.send({ kind: 'wiggle' });
  }

  private enqueue(json: string) {
    if (!this.device) return;
    const now = Date.now();
    if (now - this.lastWriteAt >= MIN_WRITE_INTERVAL_MS) {
      void this.writeNow(json);
      return;
    }
    // Coalesce: only the latest queued command matters for driving.
    this.pendingJson = json;
    if (this.flushTimer) return;
    const wait = MIN_WRITE_INTERVAL_MS - (now - this.lastWriteAt);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const next = this.pendingJson;
      this.pendingJson = null;
      if (next && this.device) void this.writeNow(next);
    }, wait);
  }

  private async writeNow(json: string): Promise<void> {
    const dev = this.device;
    if (!dev) return;
    await dev.writeCharacteristicWithoutResponseForService(
      BLE_SERVICE_UUID,
      BLE_COMMAND_CHAR_UUID,
      toBase64Ascii(json),
    );
    this.lastWriteAt = Date.now();
  }

  // ---------- heartbeat ----------

  private startHeartbeat() {
    this.stopHeartbeat();
    // Firmware watchdog is 1000 ms: a 400 ms beat leaves 2+ beats of margin.
    // Beats skip rather than queue, so held D-pad moves are never starved.
    this.hbTimer = setInterval(() => {
      if (!this.isConnected) return;
      if (Date.now() - this.lastWriteAt < MIN_WRITE_INTERVAL_MS) return;
      this.writeNow('{"c":"hb"}').catch((e) =>
        console.warn('[robot] heartbeat failed', e),
      );
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.hbTimer) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
  }

  /** Full teardown: call on app unmount. The client must not be reused. */
  async shutdown(): Promise<void> {
    this.wantConnection = false;
    this.generation++;
    await this.sendStop().catch(() => undefined);
    this.teardownLink();
    this.btStateSub?.remove();
    this.btStateSub = null;
    await this.manager.destroy().catch(() => undefined);
    this.setConn('idle');
  }
}
