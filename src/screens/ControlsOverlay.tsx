import { useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import type { UseRobot } from '../robot/useRobot';

export interface ControlsOverlayProps {
  robot: UseRobot;
  onOpenSettings?: () => void;
}

/**
 * Manual-drive chrome floating over the face. The root is pointer-transparent
 * (`box-none`) so touches pass through to the eyes everywhere except on the
 * controls themselves. All of this is plain React state — the UI-thread rule
 * only constrains eye animation, not buttons.
 */
export default function ControlsOverlay({ robot, onOpenSettings }: ControlsOverlayProps) {
  const [panelOpen, setPanelOpen] = useState(true);
  const connected = robot.connState === 'connected';
  const busy =
    robot.connState === 'scanning' ||
    robot.connState === 'connecting' ||
    robot.connState === 'reconnecting';

  return (
    <View style={styles.root} pointerEvents="box-none">
      {/* status pill, top-left */}
      <View style={styles.statusPill} pointerEvents="box-none">
        <View style={[styles.dot, dotStyle(robot.connState)]} />
        <Text style={styles.statusText}>
          {robot.connState}
          {robot.link ? ` • batt ${robot.link.batt}%` : ''}
        </Text>
        {robot.connState === 'idle' || robot.connState === 'error' ? (
          <Pressable style={styles.connectBtn} onPress={robot.connect}>
            <Text style={styles.connectText}>Connect</Text>
          </Pressable>
        ) : connected ? (
          <Pressable style={styles.connectBtn} onPress={robot.disconnect}>
            <Text style={styles.connectText}>Disconnect</Text>
          </Pressable>
        ) : (
          <Text style={styles.statusText}>{busy ? '…' : ''}</Text>
        )}
        {onOpenSettings && (
          <Pressable style={styles.gearBtn} onPress={onOpenSettings}>
            <Text style={styles.gearText}>⚙</Text>
          </Pressable>
        )}
      </View>

      {/* error banner with recovery actions */}
      {robot.error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText} numberOfLines={3}>
            {robot.error.message}
          </Text>
          <View style={styles.errorRow}>
            <Pressable style={styles.retryBtn} onPress={robot.retry}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
            {robot.error.code === 'permission-blocked' && (
              <Pressable
                style={styles.retryBtn}
                onPress={() => Linking.openSettings()}
              >
                <Text style={styles.retryText}>Open Settings</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}

      {/* collapsible drive panel, right side */}
      {panelOpen ? (
        <View style={styles.panel}>
          <Pressable
            style={styles.collapseBtn}
            onPress={() => setPanelOpen(false)}
          >
            <Text style={styles.collapseText}>hide ›</Text>
          </Pressable>
          <DPad
            enabled={connected}
            onMove={robot.move}
            onStop={robot.stop}
          />
          <SpeedSlider
            value={robot.speed}
            enabled={connected}
            onChange={robot.setSpeed}
          />
          <Pressable
            style={[styles.wiggleBtn, !connected && styles.disabled]}
            disabled={!connected}
            onPress={robot.wiggle}
          >
            <Text style={styles.wiggleText}>wiggle</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable style={styles.fab} onPress={() => setPanelOpen(true)}>
          <Text style={styles.fabText}>🎮</Text>
        </Pressable>
      )}

      {/* STOP: always visible, even with the panel hidden */}
      <Pressable
        style={[styles.stopBtn, !connected && styles.disabled]}
        disabled={!connected}
        onPress={robot.stop}
      >
        <Text style={styles.stopText}>STOP</Text>
      </Pressable>
    </View>
  );
}

function dotStyle(s: UseRobot['connState']) {
  switch (s) {
    case 'connected':
      return styles.dotGreen;
    case 'scanning':
    case 'connecting':
    case 'reconnecting':
      return styles.dotAmber;
    case 'error':
      return styles.dotRed;
    default:
      return styles.dotGray;
  }
}

// ---------- D-pad: hold to move, release to stop ----------

function DPad({
  enabled,
  onMove,
  onStop,
}: {
  enabled: boolean;
  onMove: UseRobot['move'];
  onStop: () => void;
}) {
  const btn = (label: string, kind: Parameters<UseRobot['move']>[0]) => (
    <Pressable
      disabled={!enabled}
      style={[styles.padBtn, !enabled && styles.disabled]}
      onPressIn={() => onMove(kind)}
      onPressOut={onStop}
    >
      <Text style={styles.padText}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={[styles.pad, !enabled && styles.disabled]} pointerEvents={enabled ? 'auto' : 'none'}>
      <View style={styles.padRow}>{btn('▲', 'fwd')}</View>
      <View style={styles.padRow}>
        {btn('◀', 'left')}
        {btn('▶', 'right')}
      </View>
      <View style={styles.padRow}>{btn('▼', 'back')}</View>
    </View>
  );
}

// ---------- speed slider: drag the track, no extra native deps ----------

function SpeedSlider({
  value,
  enabled,
  onChange,
}: {
  value: number;
  enabled: boolean;
  onChange: (n: number) => void;
}) {
  const widthRef = useRef(0);
  const setFromX = (x: number) => {
    if (widthRef.current <= 0) return;
    onChange(Math.max(0, Math.min(100, (x / widthRef.current) * 100)));
  };
  return (
    <View style={[styles.sliderWrap, !enabled && styles.disabled]}>
      <Text style={styles.sliderLabel}>speed {Math.round(value)}</Text>
      <View
        style={styles.sliderTrack}
        onLayout={(e) => {
          widthRef.current = e.nativeEvent.layout.width;
        }}
        onStartShouldSetResponder={() => enabled}
        onResponderGrant={(e) => setFromX(e.nativeEvent.locationX)}
        onResponderMove={(e) => setFromX(e.nativeEvent.locationX)}
      >
        <View style={[styles.sliderFill, { width: `${value}%` as never }]} />
        <View style={[styles.sliderThumb, { left: `${value}%` as never }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  statusPill: {
    position: 'absolute',
    top: 10,
    left: 10,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(10,16,28,0.85)',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 8,
    borderWidth: 1,
    borderColor: '#22314d',
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotGreen: { backgroundColor: '#34d399' },
  dotAmber: { backgroundColor: '#fbbf24' },
  dotRed: { backgroundColor: '#ef4444' },
  dotGray: { backgroundColor: '#6b7280' },
  statusText: { color: '#cbd5e1', fontSize: 12 },
  connectBtn: {
    backgroundColor: '#2f5cb8',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  connectText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  gearBtn: {
    backgroundColor: '#1a2740',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  gearText: { color: '#cbd5e1', fontSize: 12 },
  errorBanner: {
    position: 'absolute',
    top: 52,
    left: 10,
    maxWidth: 340,
    backgroundColor: 'rgba(69,10,10,0.94)',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: '#7f1d1d',
  },
  errorText: { color: '#fecaca', fontSize: 12 },
  errorRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  retryBtn: {
    backgroundColor: '#b91c1c',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  retryText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  panel: {
    position: 'absolute',
    right: 10,
    top: 10,
    bottom: 96,
    width: 190,
    backgroundColor: 'rgba(10,16,28,0.88)',
    borderRadius: 14,
    padding: 10,
    alignItems: 'center',
    justifyContent: 'space-evenly',
    borderWidth: 1,
    borderColor: '#22314d',
  },
  collapseBtn: { alignSelf: 'flex-end', padding: 4 },
  collapseText: { color: '#5b7192', fontSize: 12 },
  pad: { alignItems: 'center', gap: 4 },
  padRow: { flexDirection: 'row', gap: 4, justifyContent: 'center' },
  padBtn: {
    width: 52,
    height: 52,
    borderRadius: 12,
    backgroundColor: '#1a2740',
    alignItems: 'center',
    justifyContent: 'center',
  },
  padText: { color: '#e9f2ff', fontSize: 20 },
  sliderWrap: { width: '100%', gap: 6 },
  sliderLabel: { color: '#9fb6d8', fontSize: 12, textAlign: 'center' },
  sliderTrack: {
    height: 28,
    borderRadius: 8,
    backgroundColor: '#1a2740',
    overflow: 'hidden',
    justifyContent: 'center',
  },
  sliderFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: '#2f5cb8' },
  sliderThumb: {
    position: 'absolute',
    width: 4,
    top: 2,
    bottom: 2,
    marginLeft: -2,
    backgroundColor: '#e9f2ff',
    borderRadius: 2,
  },
  wiggleBtn: {
    backgroundColor: '#1a2740',
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  wiggleText: { color: '#e9f2ff', fontSize: 14, fontWeight: '600' },
  fab: {
    position: 'absolute',
    right: 10,
    top: 10,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(10,16,28,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#22314d',
  },
  fabText: { fontSize: 20 },
  stopBtn: {
    position: 'absolute',
    right: 10,
    bottom: 14,
    width: 190,
    paddingVertical: 16,
    borderRadius: 14,
    backgroundColor: '#b91c1c',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#ef4444',
  },
  stopText: { color: '#fff', fontSize: 20, fontWeight: '800' },
  disabled: { opacity: 0.35 },
});
