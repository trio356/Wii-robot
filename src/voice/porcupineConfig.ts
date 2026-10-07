import Constants from 'expo-constants';

/** Picovoice access key comes from app.config.js (env), never source code. */
export function getPorcupineAccessKey(): string | null {
  const key = Constants.expoConfig?.extra?.porcupineAccessKey;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/** Short pause letting one engine release the mic before the next starts. */
export const MIC_HANDOFF_MS = 350;
/** Wake stays off this long after TTS so the robot never hears itself. */
export const POST_TTS_QUIET_MS = 500;
/** Command capture window (matches the STT grammar timeout). */
export const COMMAND_WINDOW_MS = 6000;

export const DEFAULT_SENSITIVITY_WII = 0.5;
export const DEFAULT_SENSITIVITY_WILLIAM = 0.5;
