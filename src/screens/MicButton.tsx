import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { route, type Intent } from '../intent/router';
import type { UseRobot } from '../robot/useRobot';
import { getStt } from '../voice/stt';
import { COMMAND_TIMEOUT_MS, FREE_TIMEOUT_MS, isGarble } from '../voice/grammar';

export interface MicButtonProps {
  robot: UseRobot;
  /** Stage 5 LLM plugs in here. Temporary: FaceScreen logs it. */
  onQuestion?: (text: string) => void;
}

type Phase = 'loading' | 'ready' | 'listening-command' | 'listening-free' | 'routing';

/**
 * DEPRECATED since Stage 5: the AudioController owns the mic (wake-word
 * pipeline). Kept for manual STT debugging only — do NOT mount alongside
 * the wake pipeline (two owners fight over one mic). Kept out of FaceScreen.
 */
export default function MicButton({ robot, onQuestion }: MicButtonProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [progress, setProgress] = useState(0);
  const [last, setLast] = useState<string>('tap 🎤 to talk');
  const [loadError, setLoadError] = useState<string | null>(null);
  const mounted = useRef(true);
  const durationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mounted.current = true;
    getStt()
      .ensureReady((_stage, f) => {
        if (mounted.current) setProgress(f);
      })
      .then(() => mounted.current && setPhase('ready'))
      .catch((e) => mounted.current && setLoadError(String(e?.message ?? e)));
    return () => {
      mounted.current = false;
      if (durationTimer.current) clearTimeout(durationTimer.current);
      getStt().cancel();
    };
  }, []);

  const dispatch = useCallback(
    (intent: Intent, heard: string) => {
      if (intent.type === 'command') {
        const c = intent.command;
        const label = `“${heard}” → ${c.kind}${c.speed !== undefined ? ` @${c.speed}` : ''}`;
        if (c.kind === 'stop') robot.stop();
        else if (c.kind === 'wiggle') robot.wiggle();
        else if (c.kind === 'speed') robot.setSpeed(c.speed ?? 60);
        else {
          if (c.speed !== undefined) robot.setSpeed(c.speed);
          robot.move(c.kind);
          // Short-burst modifier: drive, then halt (firmware has no clock).
          if (c.durationMs) {
            if (durationTimer.current) clearTimeout(durationTimer.current);
            durationTimer.current = setTimeout(() => robot.stop(), c.durationMs);
          }
        }
        setLast(label);
      } else if (intent.type === 'question') {
        setLast(`“${heard}” → question (logged, LLM in Stage 5)`);
        onQuestion?.(intent.text);
      } else {
        setLast(heard ? `“${heard}” → heard nothing` : 'heard nothing — try again');
      }
    },
    [robot, onQuestion],
  );

  const onPress = useCallback(async () => {
    if (phase !== 'ready') return;
    const stt = getStt();
    try {
      setPhase('listening-command');
      setLast('listening (commands)…');
      const first = await stt.listen('command', COMMAND_TIMEOUT_MS);
      if (!mounted.current) return;
      // COMMAND-first, FREE-fallback: the grammar pass is accurate but
      // garbles questions; a garbled result earns one open-vocabulary pass
      // instead of being misrouted. (Two passes can't run in parallel —
      // there is only one mic — so this costs latency, not accuracy.)
      let heard = first;
      if (isGarble(first)) {
        setPhase('listening-free');
        setLast('…didn’t catch it, listening openly…');
        heard = await stt.listen('free', FREE_TIMEOUT_MS);
        if (!mounted.current) return;
      }
      setPhase('routing');
      dispatch(route(heard), heard);
    } catch (e) {
      setLast(`mic error: ${String(e)}`);
    } finally {
      if (mounted.current) setPhase('ready');
    }
  }, [phase, dispatch]);

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <Pressable
        style={[styles.mic, phase !== 'ready' && styles.micBusy]}
        disabled={phase !== 'ready'}
        onPress={onPress}
      >
        <Text style={styles.micText}>
          {phase === 'loading' ? `…${Math.round(progress * 100)}%` : '🎤'}
        </Text>
      </Pressable>
      <Text style={styles.caption} numberOfLines={2}>
        {loadError ?? last}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 10, bottom: 14, alignItems: 'center', gap: 6, maxWidth: 220 },
  mic: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: '#1a2740', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: '#2f5cb8',
  },
  micBusy: { opacity: 0.6 },
  micText: { fontSize: 22, color: '#e9f2ff' },
  caption: { color: '#9fb6d8', fontSize: 11, textAlign: 'center' },
});
