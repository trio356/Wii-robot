/**
 * Shared domain types for Wii-Robot.
 *
 * These are the only cross-module contracts. Keep them serializable
 * (passable over BLE / to the LLM) and free of React imports.
 */

/** Visual face state. Driven by touch gestures + audio state machine. */
export type Expression =
  | 'idle'
  | 'happy'
  | 'sad'
  | 'sleepy'
  | 'surprised'
  | 'annoyed'
  | 'listening'
  | 'thinking'
  | 'speaking';

/** Discrete motion primitives understood by the ESP32 firmware. */
export type RobotCommandKind =
  | 'fwd'
  | 'back'
  | 'left'
  | 'right'
  | 'stop'
  | 'speed'
  | 'wiggle';

/** Speed is 0-100 inclusive. Branded so invalid values fail at compile time. */
export type Speed = number & { readonly __brand: 'Speed' };

export function toSpeed(n: number): Speed {
  const clamped = Math.max(0, Math.min(100, Math.round(n)));
  return clamped as Speed;
}

/** Single command sent to ESP32 over BLE. Never goes through the LLM. */
export interface RobotCommand {
  kind: RobotCommandKind;
  /** Optional speed 0-100. Defaults are resolved firmware-side. */
  speed?: Speed;
  /**
   * Optional auto-stop hint (ms) from voice modifiers ("a little").
   * The BLE sender ignores it; the voice layer schedules the stop.
   */
  durationMs?: number;
  /** Epoch ms, set by sender. Used for ordering / dedup. */
  issuedAt?: number;
}

/**
 * Single-owner microphone state machine:
 * WAKE_LISTENING -> COMMAND_LISTENING -> THINKING -> SPEAKING -> WAKE_LISTENING
 *
 * - Wake-word (Porcupine) only runs in WAKE_LISTENING.
 * - STT (Vosk) only runs in COMMAND_LISTENING.
 * - TTS mutes the mic in SPEAKING.
 */
export type AudioState =
  | 'WAKE_LISTENING'
  | 'COMMAND_LISTENING'
  | 'THINKING'
  | 'SPEAKING';

/** BLE + heartbeat health surfaced to the UI (dot / banner only). */
export interface RobotStatus {
  isConnected: boolean;
  /** Last successful heartbeat ack, epoch ms. Null if never connected. */
  lastHeartbeatAckAt: number | null;
  /** Last RSSI reading, if available. */
  rssi: number | null;
  /** Human-readable failure, e.g. 'timeout', 'disconnected'. Null when OK. */
  lastError: string | null;
}

/** Wake phrases that enter COMMAND_LISTENING. Foreground-only. */
export const WAKE_PHRASES = ['hey wii', 'hey william'] as const;
export type WakePhrase = (typeof WAKE_PHRASES)[number];
