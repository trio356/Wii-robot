/**
 * Static requires for the two custom .ppn files.
 * Metro resolves these at bundle time: BOTH files must exist at
 * assets/porcupine/hey-wii.ppn and hey-william.ppn (Android builds),
 * otherwise bundling fails with "Unable to resolve module". Isolated here
 * so the error points at one obvious file, not deep voice logic.
 */
const HeyWii = require('../../assets/porcupine/hey-wii.ppn');
const HeyWilliam = require('../../assets/porcupine/hey-william.ppn');

export interface WakeAsset {
  label: string;
  module: number;
}

export const WAKE_ASSETS: WakeAsset[] = [
  { label: 'Hey Wii', module: HeyWii },
  { label: 'Hey William', module: HeyWilliam },
];
