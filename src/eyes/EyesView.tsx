import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  Canvas,
  Circle,
  Group,
  Path,
  Rect,
  RoundedRect,
  Skia,
} from '@shopify/react-native-skia';
import {
  runOnJS,
  useDerivedValue,
  withTiming,
} from 'react-native-reanimated';
import type { Expression } from '../types';
import { useEyesController, type EyesController } from './controller';
import { emitTouchReaction } from './events';
import type { TouchReaction } from './events';
import { TUNE } from './expressions';

/** Imperative API for audio/robot modules. */
export interface EyesHandle {
  setExpression: (e: Expression) => void;
  getExpression: () => Expression;
}

export interface EyesViewProps {
  /** External controller (audio machine). Defaults to an internal one. */
  controller?: EyesController;
  /** Extra subscriber alongside the global onTouchReaction bus. */
  onTouchReaction?: (r: TouchReaction) => void;
}

const ALL_EXPRESSIONS: Expression[] = [
  'idle',
  'happy',
  'sad',
  'sleepy',
  'surprised',
  'annoyed',
  'listening',
  'thinking',
  'speaking',
];

/**
 * Full-screen Skia face. Motion = Reanimated shared values read by Skia on
 * the UI thread. React state is only for the debug overlay (chrome, not
 * animation). Timers below are JS triggers; every visible move is a
 * withTiming/withSpring/withRepeat assignment.
 */
const EyesView = forwardRef<EyesHandle, EyesViewProps>(function EyesView(
  props,
  ref,
) {
  const internal = useEyesController();
  // Always mounted to keep hook order stable; ignored when external given.
  const ctl = props.controller ?? internal;
  const { sv, expression } = ctl;
  const { width: W, height: H } = useWindowDimensions();
  const [debug, setDebug] = useState(false);

  // ---- layout (JS, static per window size) ----
  const layout = useMemo(() => {
    const cx = W / 2;
    const cy = H * TUNE.eyeYFraction;
    const gap = Math.min(W * TUNE.eyeGapFraction, 230);
    const eyeW = Math.max(90, Math.min(W * TUNE.eyeWidthFraction, 190));
    const eyeH = Math.max(120, Math.min(H * TUNE.eyeHeightFraction, 250));
    return {
      cx,
      cy,
      eyeW,
      eyeH,
      left: { x: cx - gap, y: cy },
      right: { x: cx + gap, y: cy },
    };
  }, [W, H]);
  const { cx: CX, cy: CY, eyeW: EW, eyeH: EH } = layout;

  // ---- derived geometry (UI-thread worklets -> Skia props) ----
  // Hooks are hoisted here (never inside JSX) so order stays stable.
  const openH = useDerivedValue(
    () =>
      Math.max(0.03, Math.min(1.15, sv.eyeOpenness.value)) *
      EH *
      sv.eyeScale.value,
    [EH],
  );
  const openW = useDerivedValue(() => EW * sv.eyeScale.value, [EW]);
  const pupilR = useDerivedValue(
    () => Math.max(8, Math.min(openW.value, openH.value) * TUNE.pupilSize + 4),
    [],
  );
  const pupilDX = useDerivedValue(
    () => sv.pupilX.value * openW.value * TUNE.pupilTravelX,
    [],
  );
  const pupilDY = useDerivedValue(
    () => sv.pupilY.value * openH.value * TUNE.pupilTravelY,
    [],
  );
  const droopDY = useDerivedValue(() => sv.droop.value * openH.value * 0.22, []);
  const whiteOpacity = useDerivedValue(
    () => Math.max(0, Math.min(1, 1 - sv.happyArc.value)),
    [],
  );
  const happyOpacity = useDerivedValue(
    () => Math.max(0, Math.min(1, sv.happyArc.value)),
    [],
  );
  const topCoverH = useDerivedValue(
    () => sv.droop.value * EH * 0.5 * sv.eyeScale.value,
    [EH],
  );
  const botCoverH = useDerivedValue(
    () => sv.eyelidBottom.value * EH * 0.34 * sv.eyeScale.value,
    [EH],
  );
  // Angry V / sad Λ: mirror tilt per eye. Cast at usage (`as any`) because
  // Skia's transform type lags Reanimated interop (runtime reads `.value`).
  const leftTilt = useDerivedValue(
    () => [{ rotate: sv.eyelidTop.value }],
    [],
  );
  const rightTilt = useDerivedValue(
    () => [{ rotate: -sv.eyelidTop.value }],
    [],
  );
  const eyeTop = useDerivedValue(
    () => CY - openH.value / 2 + droopDY.value,
    [CY],
  );
  const botCoverY = useDerivedValue(() => CY + EH / 2 + 10 - botCoverH.value, [CY, EH]);
  const pupilCY = useDerivedValue(
    () => CY + pupilDY.value + droopDY.value,
    [CY],
  );
  const leftPupilCX = useDerivedValue(() => layout.left.x + pupilDX.value, [layout]);
  const rightPupilCX = useDerivedValue(() => layout.right.x + pupilDX.value, [layout]);
  const hiR = useDerivedValue(() => pupilR.value * 0.28, []);
  const leftHiCX = useDerivedValue(
    () => layout.left.x + pupilDX.value + pupilR.value * 0.35,
    [layout],
  );
  const rightHiCX = useDerivedValue(
    () => layout.right.x + pupilDX.value + pupilR.value * 0.35,
    [layout],
  );
  const hiCY = useDerivedValue(
    () => CY + pupilDY.value + droopDY.value - pupilR.value * 0.35,
    [CY],
  );

  // Happy closed-eye arcs (^ ^). Static paths — only opacity animates.
  const happyPaths = useMemo(() => {
    const w = EW;
    const h = EH * 0.5;
    const mk = (ex: number, ey: number) =>
      Skia.Path.MakeFromSVGString(
        `M ${ex - w / 2} ${ey + 12} Q ${ex} ${ey - h * 0.62} ${ex + w / 2} ${ey + 12}`,
      )!;
    return { left: mk(layout.left.x, CY), right: mk(layout.right.x, CY) };
  }, [EW, EH, layout, CY]);

  // ---- touch bookkeeping (JS refs — control logic, not animation) ----
  const tapTimes = useRef<number[]>([]);
  const revertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTouchAt = useRef<number>(Date.now());
  const panActiveUntil = useRef<number>(0);
  const panStartAt = useRef<number>(0);
  const closedForSleep = useRef(false);
  const onTouchProp = useRef(props.onTouchReaction);
  onTouchProp.current = props.onTouchReaction;

  const notify = useCallback(
    (kind: TouchReaction['kind'], expressionAfter: Expression) => {
      const r: TouchReaction = { kind, at: Date.now(), expressionAfter };
      emitTouchReaction(r);
      onTouchProp.current?.(r);
    },
    [],
  );

  const revertIf = useCallback(
    (expected: Expression, ms: number) => {
      if (revertTimer.current) clearTimeout(revertTimer.current);
      revertTimer.current = setTimeout(() => {
        // Don't stomp a newer expression (e.g. audio machine took over).
        if (ctl.getExpression() === expected) ctl.setExpression('idle');
      }, ms);
    },
    [ctl],
  );

  /** Record contact; wake from sleep. Called via runOnJS from gestures. */
  const poke = useCallback(() => {
    lastTouchAt.current = Date.now();
    if (closedForSleep.current || ctl.getExpression() === 'sleepy') {
      closedForSleep.current = false;
      ctl.setExpression('idle');
      notify('wake', 'idle');
    }
  }, [ctl, notify]);

  const handlePanStart = useCallback(() => {
    panStartAt.current = Date.now();
    lastTouchAt.current = Date.now();
    if (closedForSleep.current || ctl.getExpression() === 'sleepy') {
      closedForSleep.current = false;
      ctl.setExpression('idle');
      notify('wake', 'idle');
    }
    notify('follow-start', ctl.getExpression());
  }, [ctl, notify]);

  const handleTap = useCallback(
    (x: number, y: number) => {
      // Debug corner has its own triple-tap detector.
      if (x > W - 96 && y < 96) return;
      // A tap ending a drag is the drag's release, not a new tap.
      if (Date.now() - panActiveUntil.current < 300) {
        lastTouchAt.current = Date.now();
        return;
      }
      poke();
      const now = Date.now();
      tapTimes.current = [...tapTimes.current, now].filter(
        (t) => now - t < TUNE.tapWindowMs,
      );
      if (tapTimes.current.length >= TUNE.tapsForAnnoyed) {
        tapTimes.current = [];
        ctl.setExpression('annoyed');
        notify('annoyed', 'annoyed');
        revertIf('annoyed', TUNE.annoyedHoldMs);
        return;
      }
      ctl.setExpression('surprised');
      notify('tap', 'surprised');
      revertIf('surprised', TUNE.tapSurprisedMs);
    },
    [W, ctl, notify, poke, revertIf],
  );

  const handleLongPress = useCallback(() => {
    poke();
    ctl.setExpression('happy');
    notify('long-press', 'happy');
    revertIf('happy', TUNE.happyHoldMs);
  }, [ctl, notify, poke, revertIf]);

  const handlePanEndJS = useCallback(
    (transX: number, transY: number) => {
      panActiveUntil.current = Date.now();
      lastTouchAt.current = Date.now();
      const dur = Date.now() - panStartAt.current;
      const dist = Math.hypot(transX, transY);
      const avgVel = dur > 0 ? (dist / dur) * 1000 : 0;
      // Slow stroking ("petting") — long, far, gentle.
      if (
        dur > TUNE.petMinDurationMs &&
        dist > TUNE.petMinDistancePx &&
        avgVel < TUNE.petMaxAvgVelPxS
      ) {
        ctl.setExpression('happy');
        notify('pet', 'happy');
        revertIf('happy', TUNE.happyHoldMs);
      } else {
        notify('follow-end', ctl.getExpression());
        // Glide back to the expression's gaze (re-arms thinking/speaking).
        ctl.resumeGaze();
      }
    },
    [ctl, notify, revertIf],
  );

  // ---- idle life: JS triggers, UI-thread motion ----
  // Quiet rule: untouched 30 s + face sitting in idle/sleepy -> blink every
  // 8-14 s and skip drift. Skia renders only on value change, so this is the
  // frame-rate reduction: the canvas goes nearly static instead of animating
  // at 60 fps for an empty room. Any touch/gesture resets lastTouchAt.
  useEffect(() => {
    let alive = true;
    let blinkT: ReturnType<typeof setTimeout>;
    let driftT: ReturnType<typeof setTimeout>;
    const isQuiet = () => {
      if (Date.now() - lastTouchAt.current < TUNE.quietAfterMs) return false;
      const e = ctl.getExpression();
      return e === 'idle' || e === 'sleepy';
    };
    const loopBlink = () => {
      if (!alive) return;
      ctl.blink();
      const quiet = isQuiet();
      const lo = quiet ? TUNE.quietBlinkMinMs : TUNE.blinkMinMs;
      const hi = quiet ? TUNE.quietBlinkMaxMs : TUNE.blinkMaxMs;
      blinkT = setTimeout(loopBlink, lo + Math.random() * (hi - lo));
    };
    const loopDrift = () => {
      if (!alive) return;
      if (!isQuiet()) ctl.drift();
      driftT = setTimeout(
        loopDrift,
        TUNE.driftMinMs + Math.random() * (TUNE.driftMaxMs - TUNE.driftMinMs),
      );
    };
    blinkT = setTimeout(loopBlink, 2500);
    driftT = setTimeout(loopDrift, 2000);
    const sleepCheck = setInterval(() => {
      if (!alive) return;
      if (
        Date.now() - lastTouchAt.current > TUNE.sleepAfterMs &&
        ctl.getExpression() !== 'sleepy'
      ) {
        ctl.setExpression('sleepy');
        notify('sleep', 'sleepy');
        setTimeout(() => {
          // Second stage: fully shut if nobody touched meanwhile.
          if (
            ctl.getExpression() === 'sleepy' &&
            Date.now() - lastTouchAt.current > TUNE.sleepAfterMs
          ) {
            closedForSleep.current = true;
            sv.eyeOpenness.value = withTiming(0.04, {
              duration: TUNE.sleepCloseMs,
            });
          }
        }, 1500);
      }
    }, 2000);
    return () => {
      alive = false;
      clearTimeout(blinkT);
      clearTimeout(driftT);
      clearInterval(sleepCheck);
      if (revertTimer.current) clearTimeout(revertTimer.current);
    };
  }, [ctl, sv.eyeOpenness, notify]);

  useImperativeHandle(
    ref,
    () => ({
      setExpression: (e: Expression) => {
        lastTouchAt.current = Date.now();
        ctl.setExpression(e);
      },
      getExpression: () => ctl.getExpression(),
    }),
    [ctl],
  );

  // ---- gestures: follow runs on UI thread, classification via runOnJS ----
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .onBegin(() => {
          'worklet';
          runOnJS(handlePanStart)();
        })
        .onUpdate((e) => {
          'worklet';
          // Normalised gaze -1..1. Direct assignment = tightest follow;
          // the finger provides the easing. Kills gaze loops (re-armed
          // on release via resumeGaze) — intended, touch wins.
          sv.pupilX.value = Math.max(-1, Math.min(1, (e.absoluteX - CX) / (W * 0.3)));
          sv.pupilY.value = Math.max(-1, Math.min(1, (e.absoluteY - CY) / (H * 0.3)));
        })
        .onEnd((e) => {
          'worklet';
          runOnJS(handlePanEndJS)(e.translationX, e.translationY);
        }),
    [W, H, CX, CY, sv.pupilX, sv.pupilY, handlePanStart, handlePanEndJS],
  );

  const tap = useMemo(
    () =>
      Gesture.Tap()
        .maxDuration(260)
        .onEnd((e) => {
          'worklet';
          runOnJS(handleTap)(e.absoluteX, e.absoluteY);
        }),
    [handleTap],
  );

  const longPress = useMemo(
    () =>
      Gesture.LongPress()
        .minDuration(550)
        .onStart(() => {
          'worklet';
          runOnJS(handleLongPress)();
        }),
    [handleLongPress],
  );

  const faceGestures = useMemo(
    () => Gesture.Simultaneous(pan, tap, longPress),
    [pan, tap, longPress],
  );

  const cornerTripleTap = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(3)
        .maxDuration(600)
        .onEnd(() => {
          'worklet';
          runOnJS(() => setDebug((d) => !d))();
        }),
    [],
  );

  // ---- render (animated numbers flow into Skia as `as any`: Reanimated
  // SharedValues, read on the UI thread — the `as any` is only TS interop) ----
  const cornerR = EW * 0.28;
  const anyOpenW = openW as any;
  const anyOpenH = openH as any;
  const anyWhite = whiteOpacity as any;
  const anyHappy = happyOpacity as any;
  const anyEyeTop = eyeTop as any;
  const anyPupilCY = pupilCY as any;
  const anyPupilR = pupilR as any;
  const anyLeftCX = leftPupilCX as any;
  const anyRightCX = rightPupilCX as any;
  const anyHiR = hiR as any;
  const anyLeftHiCX = leftHiCX as any;
  const anyRightHiCX = rightHiCX as any;
  const anyHiCY = hiCY as any;
  const anyTopH = topCoverH as any;
  const anyBotH = botCoverH as any;
  const anyBotY = botCoverY as any;

  return (
    <View style={styles.root}>
      <GestureDetector gesture={faceGestures}>
        <View style={styles.face}>
          <Canvas style={styles.canvas}>
            <Rect x={0} y={0} width={W} height={H} color={TUNE.background} />

            <Group origin={layout.left} transform={leftTilt as any}>
              <RoundedRect
                x={layout.left.x - EW / 2}
                y={anyEyeTop}
                width={anyOpenW}
                height={anyOpenH}
                r={cornerR}
                color={TUNE.white}
                opacity={anyWhite}
              />
            </Group>
            <Group origin={layout.right} transform={rightTilt as any}>
              <RoundedRect
                x={layout.right.x - EW / 2}
                y={anyEyeTop}
                width={anyOpenW}
                height={anyOpenH}
                r={cornerR}
                color={TUNE.white}
                opacity={anyWhite}
              />
            </Group>

            <Circle cx={anyLeftCX} cy={anyPupilCY} r={anyPupilR} color={TUNE.pupil} opacity={anyWhite} />
            <Circle cx={anyRightCX} cy={anyPupilCY} r={anyPupilR} color={TUNE.pupil} opacity={anyWhite} />
            <Circle cx={anyLeftHiCX} cy={anyHiCY} r={anyHiR} color="#ffffff" opacity={anyWhite} />
            <Circle cx={anyRightHiCX} cy={anyHiCY} r={anyHiR} color="#ffffff" opacity={anyWhite} />

            {/* Upper droop + lower squint occluders (bg-coloured lids) */}
            <Rect x={layout.left.x - EW / 2 - 8} y={CY - EH / 2 - 10} width={EW + 16} height={anyTopH} color={TUNE.lidCover} opacity={anyWhite} />
            <Rect x={layout.right.x - EW / 2 - 8} y={CY - EH / 2 - 10} width={EW + 16} height={anyTopH} color={TUNE.lidCover} opacity={anyWhite} />
            <Rect x={layout.left.x - EW / 2 - 8} y={anyBotY} width={EW + 16} height={anyBotH} color={TUNE.lidCover} opacity={anyWhite} />
            <Rect x={layout.right.x - EW / 2 - 8} y={anyBotY} width={EW + 16} height={anyBotH} color={TUNE.lidCover} opacity={anyWhite} />

            {/* Happy arcs ^ ^, crossfaded in */}
            <Path path={happyPaths.left} color={TUNE.happyStroke} style="stroke" strokeWidth={11} strokeCap="round" opacity={anyHappy} />
            <Path path={happyPaths.right} color={TUNE.happyStroke} style="stroke" strokeWidth={11} strokeCap="round" opacity={anyHappy} />
          </Canvas>

          <GestureDetector gesture={cornerTripleTap}>
            <View style={styles.debugCorner} />
          </GestureDetector>

          {debug && (
            <View style={styles.debugPanel}>
              <Text style={styles.debugTitle}>eyes: {expression}</Text>
              <View style={styles.debugRow}>
                {ALL_EXPRESSIONS.map((e) => (
                  <Pressable
                    key={e}
                    style={[styles.debugBtn, expression === e && styles.debugBtnActive]}
                    onPress={() => {
                      if (e === 'sleepy') {
                        // Pin the sleep timer in the past so it sticks.
                        lastTouchAt.current = Date.now() - TUNE.sleepAfterMs - 1000;
                      } else {
                        lastTouchAt.current = Date.now();
                        closedForSleep.current = false;
                      }
                      ctl.setExpression(e);
                    }}
                  >
                    <Text style={styles.debugBtnText}>{e}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.debugHint}>
                triple-tap top-right to hide • drag = follow/pet • tap =
                surprised • 4 taps = annoyed
              </Text>
            </View>
          )}
        </View>
      </GestureDetector>
    </View>
  );
});

export default EyesView;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: TUNE.background },
  face: { flex: 1 },
  canvas: { flex: 1 },
  debugCorner: { position: 'absolute', top: 0, right: 0, width: 96, height: 96 },
  debugPanel: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    backgroundColor: 'rgba(10,16,28,0.92)',
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: '#22314d',
  },
  debugTitle: { color: '#9fb6d8', fontSize: 12, marginBottom: 8 },
  debugRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  debugBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#1a2740',
  },
  debugBtnActive: { backgroundColor: '#2f5cb8' },
  debugBtnText: { color: '#e9f2ff', fontSize: 12 },
  debugHint: { color: '#5b7192', fontSize: 10, marginTop: 8 },
});
