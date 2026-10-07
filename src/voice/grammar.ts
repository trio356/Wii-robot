/**
 * Vosk recognition setup: one small English model, two grammars.
 *
 * COMMAND mode passes `grammar` to start(): the decoder only considers these
 * phrases, so "go forward" beats "go for word" acoustically. "[unk]" maps
 * everything else to out-of-grammar noise instead of hallucinating commands.
 * FREE mode passes no grammar: full vocabulary for questions (Stage 5 LLM).
 */

export const MODEL_DIR_NAME = 'vosk-model-small-en-us-0.15';
export const MODEL_ZIP_URL =
  'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip';
export const MODEL_ZIP_NAME = 'vosk-model-small-en-us-0.15.zip';

/** Must contain every word the router matches, else Vosk can never emit it. */
export const COMMAND_GRAMMAR: string[] = [
  // multi-word commands first (Vosk scores whole phrases)
  'go forward',
  'go back',
  'go left',
  'go right',
  'move forward',
  'move back',
  'turn left',
  'turn right',
  'a little',
  'a bit',
  'hey wii',
  // motion
  'forward',
  'forwards',
  'ahead',
  'go',
  'move',
  'advance',
  'straight',
  'come',
  'back',
  'backward',
  'backwards',
  'reverse',
  'retreat',
  'left',
  'right',
  // stop
  'stop',
  'halt',
  'freeze',
  'wait',
  'hold',
  // speed
  'faster',
  'slower',
  'fast',
  'slow',
  'quickly',
  'slowly',
  'speed',
  // fun
  'wiggle',
  'dance',
  'spin',
  'shake',
  // out-of-grammar collapse (keeps questions from becoming fake commands)
  '[unk]',
];

export const COMMAND_TIMEOUT_MS = 6000;
export const FREE_TIMEOUT_MS = 8000;

/** COMMAND result is unusable -> worth a second open-vocabulary pass. */
export function isGarble(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === '' || t.split(/\s+/).every((w) => w === 'unk' || w === '[unk]');
}
