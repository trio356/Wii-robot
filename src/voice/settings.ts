import {
  DEFAULT_SENSITIVITY_WII,
  DEFAULT_SENSITIVITY_WILLIAM,
} from './porcupineConfig';

export interface WakeSettings {
  /** "Hey Wii" sensitivity 0..1. */
  sensitivityWii: number;
  /** "Hey William" sensitivity 0..1. */
  sensitivityWilliam: number;
}

export function defaultWakeSettings(): WakeSettings {
  return {
    sensitivityWii: DEFAULT_SENSITIVITY_WII,
    sensitivityWilliam: DEFAULT_SENSITIVITY_WILLIAM,
  };
}

type SettingsHandler = (s: WakeSettings) => void;

// In-memory store (resets on reload — persistence is a later-stage nicety).
// AudioController re-inits Porcupine from these values when idle.
let current: WakeSettings = defaultWakeSettings();
const handlers = new Set<SettingsHandler>();

export function getWakeSettings(): WakeSettings {
  return { ...current };
}

export function setWakeSettings(patch: Partial<WakeSettings>): WakeSettings {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  current = {
    sensitivityWii: patch.sensitivityWii !== undefined ? clamp(patch.sensitivityWii) : current.sensitivityWii,
    sensitivityWilliam:
      patch.sensitivityWilliam !== undefined ? clamp(patch.sensitivityWilliam) : current.sensitivityWilliam,
  };
  handlers.forEach((cb) => {
    try {
      cb({ ...current });
    } catch (e) {
      console.warn('[wake] settings handler failed', e);
    }
  });
  return getWakeSettings();
}

export function onWakeSettings(cb: SettingsHandler): () => void {
  handlers.add(cb);
  return () => {
    handlers.delete(cb);
  };
}
