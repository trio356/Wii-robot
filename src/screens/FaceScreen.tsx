import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { EyesView, onTouchReaction, type EyesHandle } from '../eyes';
import { useRobot } from '../robot/useRobot';
import { useAudio } from '../voice/useAudio';
import { getAudioController } from '../voice/audioController';
import AudioPill from './AudioPill';
import ControlsOverlay from './ControlsOverlay';
import SettingsScreen from './SettingsScreen';

/**
 * Face route: eyes underneath, manual controls + voice pill on top.
 * Owns all glue so modules never import each other:
 * - link state drives the face (scanning -> thinking, connected ->
 *   happy flash, lost -> sad),
 * - tap on the eyes -> robot wiggle,
 * - voice pipeline (useAudio) drives listening/thinking/speaking eyes.
 */
export default function FaceScreen() {
  const robot = useRobot();
  const audio = useAudio();
  const eyesRef = useRef<EyesHandle>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Voice owns the mic: attach the face once, auto-start the pipeline.
  useEffect(() => {
    getAudioController().attachHandlers({
      setEyes: (e) => eyesRef.current?.setExpression(e),
    });
    audio.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Link state -> face. Only transition edges set expressions.
  useEffect(() => {
    const eyes = () => eyesRef.current;
    if (flashTimer.current) {
      clearTimeout(flashTimer.current);
      flashTimer.current = null;
    }
    switch (robot.connState) {
      case 'scanning':
      case 'connecting':
      case 'reconnecting':
        eyes()?.setExpression('thinking');
        break;
      case 'connected':
        eyes()?.setExpression('happy');
        flashTimer.current = setTimeout(() => {
          if (robot.connState === 'connected') eyes()?.setExpression('idle');
        }, 1200);
        break;
      case 'error':
        eyes()?.setExpression('sad');
        break;
      case 'idle':
        eyes()?.setExpression('idle');
        break;
    }
    return () => {
      if (flashTimer.current) {
        clearTimeout(flashTimer.current);
        flashTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [robot.connState]);

  // Tap the face: while the robot is thinking/talking it interrupts the
  // answer; otherwise (connected, idle ears) it's a friendly wiggle.
  useEffect(() => {
    return onTouchReaction((r) => {
      if (r.kind !== 'tap') return;
      if (
        audio.running &&
        (audio.phase === 'SPEAKING' || audio.phase === 'THINKING')
      ) {
        getAudioController().interrupt();
      } else if (robot.connState === 'connected') {
        robot.wiggle();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [robot.connState, audio.running, audio.phase]);

  if (showSettings) {
    return (
      <View style={styles.root}>
        <SettingsScreen audio={audio} robot={robot} onBack={() => setShowSettings(false)} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <EyesView ref={eyesRef} />
      <ControlsOverlay robot={robot} onOpenSettings={() => setShowSettings(true)} />
      <AudioPill audio={audio} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#04060c' },
});
