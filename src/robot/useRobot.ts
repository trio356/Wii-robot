import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { RobotCommandKind, RobotStatus } from '../types';
import { toSpeed } from '../types';
import {
  RobotClient,
  RobotError,
  type ConnState,
  type StatusEvent,
} from './RobotClient';

let shared: RobotClient | null = null;

/** Process-wide client. Screens share one BleManager (BLE allows one link). */
export function getRobotClient(): RobotClient {
  if (!shared) shared = new RobotClient();
  return shared;
}

export interface UseRobot {
  connState: ConnState;
  error: RobotError | null;
  /** Latest firmware status notification (null until first NOTIFY). */
  link: StatusEvent | null;
  /** UI-ready summary for the status dot. */
  robotStatus: RobotStatus;
  speed: number;
  setSpeed: (n: number) => void;
  connect: () => void;
  disconnect: () => void;
  retry: () => void;
  move: (kind: 'fwd' | 'back' | 'left' | 'right') => void;
  stop: () => void;
  wiggle: () => void;
}

/**
 * Binds the singleton client to React + owns app-lifecycle safety:
 * - backgrounding the app sends stop (motors must not run unseen),
 * - unmount sends stop (face is the only screen, so this is app exit).
 * Reconnect/backoff/Bluetooth-toggle handling lives in RobotClient.
 */
export function useRobot(): UseRobot {
  const clientRef = useRef<RobotClient | null>(null);
  if (!clientRef.current) clientRef.current = getRobotClient();
  const client = clientRef.current;

  const [connState, setConnState] = useState<ConnState>(client.state);
  const [error, setError] = useState<RobotError | null>(client.error);
  const [link, setLink] = useState<StatusEvent | null>(null);
  const [speed, setSpeedState] = useState(60);

  useEffect(() => {
    const offConn = client.onConnState((s, e) => {
      setConnState(s);
      setError(e);
    });
    const offStatus = client.onStatus((s) => setLink(s));

    const sub = AppState.addEventListener('change', (next) => {
      // Motors running while the face is hidden is the one state we forbid.
      // sendStop() is best-effort; pausing the heartbeat is what guarantees
      // the firmware watchdog fires even if the stop write never lands.
      if (next === 'background') {
        void client.sendStop();
        client.setBackgrounded(true);
      } else if (next === 'active') {
        client.setBackgrounded(false);
      }
    });

    return () => {
      offConn();
      offStatus();
      sub.remove();
      void client.sendStop();
    };
  }, [client]);

  const connect = useCallback(() => {
    client.connect().catch(() => undefined); // state surfaces via onConnState
  }, [client]);

  const disconnect = useCallback(() => {
    client.disconnect().catch(() => undefined);
  }, [client]);

  const setSpeed = useCallback(
    (n: number) => {
      const s = Math.max(0, Math.min(100, Math.round(n)));
      setSpeedState(s);
      // Firmware stores this as its default; later bare fwd/back reuse it.
      client.send({ kind: 'speed', speed: toSpeed(s) }).catch(() => undefined);
    },
    [client],
  );

  const move = useCallback(
    (kind: RobotCommandKind) => {
      client
        .send({ kind, speed: toSpeed(speed) })
        .catch(() => undefined);
    },
    [client, speed],
  );

  const stop = useCallback(() => {
    void client.sendStop();
  }, [client]);

  const wiggle = useCallback(() => {
    client.send({ kind: 'wiggle' }).catch(() => undefined);
  }, [client]);

  const robotStatus: RobotStatus = {
    isConnected: connState === 'connected',
    lastHeartbeatAckAt: link?.at ?? null,
    rssi: null, // read on demand later (device.readRSSI); not polled in v1
    lastError: error?.message ?? null,
  };

  return {
    connState,
    error,
    link,
    robotStatus,
    speed,
    setSpeed,
    connect,
    disconnect,
    retry: connect,
    move,
    stop,
    wiggle,
  };
}
