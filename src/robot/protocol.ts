/**
 * Shared BLE contracts between the app (src/robot/) and the ESP32 firmware
 * (firmware/WiiBot/WiiBot.ino). Single source of truth — both sides copy
 * these UUIDs verbatim. Changing a UUID requires reflashing the ESP32 AND
 * rebuilding the dev-client (BLE cache).
 */

export const BLE_DEVICE_NAME = 'WiiBot';

/** One custom service; two characteristics (command WRITE, status NOTIFY). */
export const BLE_SERVICE_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5';
export const BLE_COMMAND_CHAR_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d6';
export const BLE_STATUS_CHAR_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d7';

/** Motion primitives (user intent). Transport-only `hb` is NOT in this union. */
export type FirmwareMotionCommand =
  | 'fwd'
  | 'back'
  | 'left'
  | 'right'
  | 'stop'
  | 'speed'
  | 'wiggle';

/** Wire command. `hb` = heartbeat, resets the firmware watchdog only. */
export type FirmwareCommand = FirmwareMotionCommand | 'hb';

/**
 * Build the short JSON the firmware parses with a 128-byte static buffer:
 * {"c":"fwd","s":60}. `s` is 0-100; omitted = use firmware default speed.
 */
export function buildCommandJson(cmd: FirmwareCommand, speed?: number): string {
  if (speed === undefined) return JSON.stringify({ c: cmd });
  const s = Math.max(0, Math.min(100, Math.round(speed)));
  return JSON.stringify({ c: cmd, s });
}

/** Firmware → app status notification, sent every STATUS_INTERVAL_MS. */
export interface RobotStatusPayload {
  state: 'idle' | 'moving';
  /** Battery percent 0-100. Stubbed until a divider is wired (see firmware). */
  batt: number;
}

/** Parse a status notification. Returns null on malformed payload. */
export function parseStatusPayload(raw: string): RobotStatusPayload | null {
  try {
    const o = JSON.parse(raw) as { state?: unknown; batt?: unknown };
    if (o.state !== 'idle' && o.state !== 'moving') return null;
    if (typeof o.batt !== 'number' || o.batt < 0 || o.batt > 100) return null;
    return { state: o.state, batt: Math.round(o.batt) };
  } catch {
    return null;
  }
}

/**
 * Timing contracts — MUST mirror the firmware #defines.
 * App sends hb every HEARTBEAT_INTERVAL_MS; firmware stops motors if no
 * message of any kind arrives for HEARTBEAT_TIMEOUT_MS.
 */
export const HEARTBEAT_INTERVAL_MS = 400;
export const HEARTBEAT_TIMEOUT_MS = 1000;
export const STATUS_INTERVAL_MS = 1000;
