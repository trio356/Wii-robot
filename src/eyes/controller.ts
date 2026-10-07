import { useCallback, useRef, useState } from 'react';
import {
  cancelAnimation,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import type { Expression } from '../types';
import { EXPRESSION_TARGETS, TUNE } from './expressions';

/**
 * All eye animation state. Every field is a UI-thread shared value —
 * Skia reads `.value` directly each frame, React never re-renders for motion.
 *
 * Naming follows the brief: eyeOpenness, pupilX/Y, eyelidTop/Bottom (tilt),
 * eyeScale, happyArc. Droop/lowerRaise fold into the lid params.
 */
export interface EyesSharedValues {
  eyeOpenness: SharedValue<number>;
  pupilX: SharedValue<number>;
  pupilY: SharedValue<number>;
  eyelidTop: SharedValue<number>;
  eyelidBottom: SharedValue<number>;
  droop: SharedValue<number>;
  eyeScale: SharedValue<number>;
  happyArc: SharedValue<number>;
}

export interface EyesController {
  sv: EyesSharedValues;
  /** Imperative API for audio/robot modules. Animation runs on UI thread. */
  setExpression: (e: Expression) => void;
  getExpression: () => Expression;
  /** Current expression as React state (debug overlay label only). */
  expression: Expression;
  /** One blink cycle. No-op when eyes are arcs (happy) or shut (sleepy). */
  blink: () => void;
  /** Small idle gaze wander. Skipped while touching or in looped states. */
  drift: () => void;
  /**
   * Ease pupils back to the current expression's gaze, restarting its loop
   * if it has one. Called on pan release — touch-follow assigns pupilX/Y
   * directly (killing loops), so the loop must be re-armed from JS.
   */
  resumeGaze: () => void;
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

export function useEyesController(): EyesController {
  const eyeOpenness = useSharedValue(1);
  const pupilX = useSharedValue(0);
  const pupilY = useSharedValue(0);
  const eyelidTop = useSharedValue(0);
  const eyelidBottom = useSharedValue(0);
  const droop = useSharedValue(0);
  const eyeScale = useSharedValue(1);
  const happyArc = useSharedValue(0);

  const currentRef = useRef<Expression>('idle');
  const [expression, setExpressionState] = useState<Expression>('idle');

  const setExpression = useCallback((e: Expression) => {
    currentRef.current = e;
    setExpressionState(e);
    const t = EXPRESSION_TARGETS[e];
    const ms = TUNE.transitionMs;

    // Assigning a new animation cancels any withRepeat loop from the
    // previous expression — this is how listening/thinking/speaking stop.
    eyeOpenness.value = withTiming(t.openness, { duration: ms });
    eyelidTop.value = withTiming(t.lidTilt, { duration: ms });
    eyelidBottom.value = withTiming(t.lowerRaise, { duration: ms });
    droop.value = withTiming(t.droop, { duration: ms });
    happyArc.value = withTiming(t.happyArc, { duration: ms });
    eyeScale.value = withSpring(t.scale, { damping: 14, stiffness: 160 });

    if (e === 'listening') {
      // Wide-open subtle pulse. withRepeat lives on the UI thread.
      pupilX.value = withTiming(t.gazeX, { duration: ms });
      pupilY.value = withTiming(t.gazeY, { duration: ms });
      eyeScale.value = withRepeat(
        withTiming(t.scale * 1.06, { duration: 750 }),
        -1,
        true,
      );
    } else if (e === 'thinking') {
      // Slow look-away drift, up-right. Different periods so it wanders.
      // Starts from wherever the gaze is — no snap, no seed needed.
      pupilX.value = withRepeat(
        withTiming(0.85, { duration: 2400 }),
        -1,
        true,
      );
      pupilY.value = withRepeat(
        withTiming(-0.85, { duration: 3100 }),
        -1,
        true,
      );
    } else if (e === 'speaking') {
      // Small rhythmic nod of the gaze.
      pupilX.value = withTiming(t.gazeX, { duration: ms });
      pupilY.value = withRepeat(
        withTiming(0.22, { duration: 320 }),
        -1,
        true,
      );
    } else {
      pupilX.value = withTiming(t.gazeX, { duration: ms });
      pupilY.value = withTiming(t.gazeY, { duration: ms });
    }
  }, []); // shared values are stable handles — safe to omit from deps

  const blink = useCallback(() => {
    const cur = currentRef.current;
    // Arcs have no lids to blink; shut eyes need no blink.
    if (cur === 'happy' || cur === 'sleepy') return;
    eyeOpenness.value = withTiming(
      0.05,
      { duration: TUNE.blinkCloseMs },
      (finished) => {
        if (finished) {
          eyeOpenness.value = withTiming(EXPRESSION_TARGETS[cur].openness, {
            duration: TUNE.blinkOpenMs,
          });
        }
      },
    );
  }, []); // see above — handles are stable

  const drift = useCallback(() => {
    const cur = currentRef.current;
    // Looped states own the gaze; touch-follow owns it while pressed.
    if (cur === 'thinking' || cur === 'listening' || cur === 'speaking') return;
    if (cur === 'sleepy') return;
    pupilX.value = withTiming(rand(-0.22, 0.22), { duration: 700 });
    pupilY.value = withTiming(rand(-0.18, 0.18), { duration: 700 });
  }, []); // see above — handles are stable

  const resumeGaze = useCallback(() => {
    const cur = currentRef.current;
    const t = EXPRESSION_TARGETS[cur];
    if (cur === 'thinking') {
      pupilX.value = withRepeat(withTiming(0.85, { duration: 2400 }), -1, true);
      pupilY.value = withRepeat(withTiming(-0.85, { duration: 3100 }), -1, true);
    } else if (cur === 'speaking') {
      pupilX.value = withTiming(t.gazeX, { duration: 300 });
      pupilY.value = withRepeat(withTiming(0.22, { duration: 320 }), -1, true);
    } else if (cur === 'listening') {
      // Scale pulse untouched (follow only kills pupil anims) — recenter.
      pupilX.value = withTiming(0, { duration: 450 });
      pupilY.value = withTiming(0, { duration: 450 });
    } else {
      pupilX.value = withTiming(t.gazeX, { duration: 450 });
      pupilY.value = withTiming(t.gazeY, { duration: 450 });
    }
  }, []); // see above — handles are stable

  return {
    sv: {
      eyeOpenness,
      pupilX,
      pupilY,
      eyelidTop,
      eyelidBottom,
      droop,
      eyeScale,
      happyArc,
    },
    setExpression,
    getExpression: () => currentRef.current,
    expression,
    blink,
    drift,
    resumeGaze,
  };
}

// Re-exported so EyesView can cancel loops on unmount if needed.
export { cancelAnimation };
