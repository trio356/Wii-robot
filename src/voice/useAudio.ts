import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import type { RobotCommand } from '../types';
import { answerAloud } from '../ai/answerAloud';
import { getRobotClient } from '../robot/useRobot';
import {
  getAudioController,
  type AudioSnapshot,
} from './audioController';

export interface UseAudio extends AudioSnapshot {
  start: () => void;
  stop: () => void;
  setTestMode: (on: boolean) => void;
  inTestMode: boolean;
  applySettings: () => void;
}

/**
 * Binds the singleton mic owner to React + owns lifecycle wiring:
 * - robot send/stop, on-device LLM answers spoken sentence-by-sentence,
 * - background suspend / foreground resume (foreground-only listening),
 * - eyes are attached separately by FaceScreen (it owns the ref).
 */
export function useAudio(): UseAudio {
  const [ctrl] = useState(getAudioController);
  const [snap, setSnap] = useState<AudioSnapshot>(ctrl.snapshot);

  useEffect(() => {
    ctrl.attachHandlers({
      sendCommand: (cmd: RobotCommand) => getRobotClient().send(cmd),
      stopRobot: () => {
        void getRobotClient().sendStop();
      },
      answerQuestion: (q, ev) => answerAloud(q, ev),
    });
    const off = ctrl.onSnapshot(setSnap);
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') ctrl.suspend();
      else if (next === 'active') ctrl.resume();
    });
    return () => {
      off();
      sub.remove();
    };
  }, [ctrl]);

  const [testMode, setTestModeState] = useState(ctrl.inTestMode);

  return {
    ...snap,
    start: () => {
      void ctrl.start();
    },
    stop: () => ctrl.stopAll(),
    setTestMode: (on: boolean) => {
      void ctrl.setTestMode(on).then(() => setTestModeState(ctrl.inTestMode));
    },
    inTestMode: testMode,
    applySettings: () => {
      void ctrl.applySettings();
    },
  };
}
