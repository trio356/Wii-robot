import type { Expression } from '../types';

/**
 * Parametric eye targets. All values are unitless and interpolated on the
 * UI thread via withTiming / withSpring — never in React state.
 */
export interface EyeTargets {
  /** 0 = fully shut, 1 = fully open. Surprised may exceed 1 (pop). */
  openness: number;
  /** Upper-lid tilt in radians. + = angry V, - = sad. Mirrored per eye. */
  lidTilt: number;
  /** Upper-lid droop 0..1 (sleepy / sad eyelid heaviness). */
  droop: number;
  /** Lower-lid raise 0..1 (annoyed squint). */
  lowerRaise: number;
  /** Overall eye scale multiplier. */
  scale: number;
  /** 0 = round eyes, 1 = closed happy arcs (^ ^). Crossfades shapes. */
  happyArc: number;
  /** Base gaze when no touch is active. */
  gazeX: number;
  gazeY: number;
}

/** One place to tune the look. EyesView reads TUNE for layout + colour. */
export const TUNE = {
  // Layout (fractions of screen, clamped in EyesView)
  eyeGapFraction: 0.17, // distance from centre to each eye, / screen width
  eyeWidthFraction: 0.15, // eye white width, / screen width
  eyeHeightFraction: 0.44, // eye white height, / screen height
  eyeYFraction: 0.52, // vertical centre, / screen height
  pupilTravelX: 0.3, // pupil offset as fraction of eye half-width
  pupilTravelY: 0.32, // pupil offset as fraction of eye half-height
  pupilSize: 0.27, // pupil radius as fraction of min(eyeW, eyeH)

  // Palette — dark friendly face
  background: '#04060c',
  white: '#e9f2ff',
  pupil: '#0c1426',
  lidCover: '#04060c', // must match background (lids are occluders)
  happyStroke: '#e9f2ff',

  // Timings (ms) — all UI-thread withTiming / withSpring
  transitionMs: 380,
  blinkCloseMs: 85,
  blinkOpenMs: 150,
  tapSurprisedMs: 800,
  happyHoldMs: 1400,
  annoyedHoldMs: 1700,

  // Idle life
  blinkMinMs: 2200,
  blinkMaxMs: 6000,
  driftMinMs: 1800,
  driftMaxMs: 3600,
  // Low-power idle: after this long untouched in idle/sleepy, blink slower
  // and stop pupil drift. Skia only renders on value change, so fewer
  // updates = fewer frames = less GPU/battery. Any touch wakes instantly.
  quietAfterMs: 30_000,
  quietBlinkMinMs: 8000,
  quietBlinkMaxMs: 14000,
  sleepAfterMs: 60_000,
  sleepCloseMs: 1200,

  // Touch
  tapWindowMs: 2000,
  tapsForAnnoyed: 4,
  petMinDurationMs: 700,
  petMinDistancePx: 120,
  petMaxAvgVelPxS: 950,
} as const;

export const EXPRESSION_TARGETS: Record<Expression, EyeTargets> = {
  idle: {
    openness: 1, lidTilt: 0, droop: 0, lowerRaise: 0,
    scale: 1, happyArc: 0, gazeX: 0, gazeY: 0,
  },
  happy: {
    openness: 0.82, lidTilt: 0, droop: 0.08, lowerRaise: 0.25,
    scale: 1.06, happyArc: 1, gazeX: 0, gazeY: 0.05,
  },
  sad: {
    openness: 0.68, lidTilt: -0.34, droop: 0.5, lowerRaise: 0.05,
    scale: 0.97, happyArc: 0, gazeX: 0, gazeY: 0.35,
  },
  sleepy: {
    openness: 0.26, lidTilt: 0, droop: 0.72, lowerRaise: 0.1,
    scale: 0.96, happyArc: 0, gazeX: 0, gazeY: 0.25,
  },
  surprised: {
    openness: 1.12, lidTilt: 0, droop: 0, lowerRaise: 0,
    scale: 1.24, happyArc: 0, gazeX: 0, gazeY: 0,
  },
  annoyed: {
    openness: 0.62, lidTilt: 0.5, droop: 0.12, lowerRaise: 0.42,
    scale: 1.0, happyArc: 0, gazeX: 0, gazeY: 0.1,
  },
  listening: {
    openness: 1.02, lidTilt: 0, droop: 0, lowerRaise: 0,
    scale: 1.14, happyArc: 0, gazeX: 0, gazeY: 0,
  },
  thinking: {
    // Gaze hard up-right; EyesView adds a slow drift on top.
    openness: 0.9, lidTilt: 0, droop: 0.1, lowerRaise: 0,
    scale: 0.99, happyArc: 0, gazeX: 0.65, gazeY: -0.7,
  },
  speaking: {
    openness: 0.95, lidTilt: 0, droop: 0.05, lowerRaise: 0.08,
    scale: 1.03, happyArc: 0, gazeX: 0, gazeY: 0,
  },
};
