import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { UseAudio } from '../voice/useAudio';

/**
 * Tiny voice status pill (top-center). Tap toggles voice on/off — doubles
 * as the retry button when init fails (missing key, .ppn, model, mic).
 */
export default function AudioPill({ audio }: { audio: UseAudio }) {
  const label = !audio.running
    ? audio.error
      ? `voice off: ${shortError(audio.error.code)} — tap to retry`
      : 'voice off — tap to enable'
    : audio.phase === 'WAKE_LISTENING'
      ? 'say “Hey Wii”…'
      : audio.phase === 'COMMAND_LISTENING'
        ? 'listening…'
        : audio.phase === 'THINKING'
          ? 'thinking…'
          : 'speaking…';

  return (
    <Pressable
      style={[styles.pill, !audio.running && styles.pillOff]}
      onPress={() => (audio.running ? audio.stop() : audio.start())}
    >
      <View style={[styles.dot, audio.running ? styles.dotOn : styles.dotOff]} />
      <Text style={styles.text} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

function shortError(code: string): string {
  switch (code) {
    case 'no-access-key':
      return 'no Picovoice key';
    case 'mic-denied':
      return 'mic denied';
    case 'no-model':
      return 'no speech model';
    default:
      return 'wake failed';
  }
}

const styles = StyleSheet.create({
  pill: {
    position: 'absolute',
    top: 10,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(10,16,28,0.85)',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#22314d',
    maxWidth: 300,
  },
  pillOff: { borderColor: '#7f1d1d' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotOn: { backgroundColor: '#34d399' },
  dotOff: { backgroundColor: '#6b7280' },
  text: { color: '#cbd5e1', fontSize: 12 },
});
