import { createAudioPlayer, type AudioPlayer } from 'expo-audio';

let player: AudioPlayer | null = null;

/**
 * Short wake/command chime (bundled assets/chime.wav, generated two-tone).
 * The player is created once; play() restarts it from zero each time.
 */
export function playChime(): void {
  try {
    if (!player) {
      player = createAudioPlayer(require('../../assets/chime.wav'));
    }
    void player.seekTo(0).catch(() => undefined).then(() => player?.play());
  } catch (e) {
    console.warn('[chime] play failed', e);
  }
}
