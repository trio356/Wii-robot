import 'react-native-gesture-handler';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useKeepAwake } from 'expo-keep-awake';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import FaceScreen from './screens/FaceScreen';

/**
 * Stage 1 shell: full-screen Skia eyes.
 * - KeepAwake keeps the phone-face alive; landscape matches the head mount.
 * - All eye motion lives in Reanimated shared values (UI thread) consumed
 *   directly by Skia — this component never re-renders for animation.
 */
export default function App() {
  useKeepAwake();

  useEffect(() => {
    ScreenOrientation.lockAsync(
      ScreenOrientation.OrientationLock.LANDSCAPE,
    ).catch((e) => console.warn('[App] orientation lock failed', e));
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar hidden />
      <FaceScreen />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#04060c' },
});
