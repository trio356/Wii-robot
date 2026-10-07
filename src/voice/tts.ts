import * as Speech from 'expo-speech';

/**
 * Promise wrapper around expo-speech. Always resolves (even on error):
 * a failed utterance must not wedge the audio state machine — the
 * controller logs and returns to WAKE_LISTENING either way.
 */
export function speakText(text: string): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      Speech.speak(text, {
        language: 'en-US',
        rate: 1.0,
        onDone: finish,
        onStopped: finish,
        onError: (e) => {
          console.warn('[tts] speak error', e);
          finish();
        },
      });
    } catch (e) {
      console.warn('[tts] speak threw', e);
      finish();
    }
  });
}

export function stopSpeaking(): Promise<void> {
  return Speech.stop().catch(() => undefined);
}
