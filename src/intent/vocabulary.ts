import type { RobotCommandKind } from '../types';

/**
 * Command vocabulary. Exact matches always win; fuzzy matches (Levenshtein
 * <= 1) only apply to words of length >= 4 — short words like "go"/"to"
 * are one typo away from each other, so they must match exactly.
 */

/** Canonical motion -> accepted words (Vosk output + human synonyms). */
export const MOTION_WORDS: Record<
  Extract<RobotCommandKind, 'fwd' | 'back' | 'left' | 'right' | 'wiggle'>,
  string[]
> = {
  fwd: [
    'forward',
    'forwards',
    'ahead',
    'go',
    'move',
    'advance',
    'straight',
    'come',
    'onward',
    'onwards',
  ],
  back: ['back', 'backward', 'backwards', 'reverse', 'retreat'],
  left: ['left'],
  right: ['right'],
  wiggle: ['wiggle', 'dance', 'spin', 'shake', 'boogie', 'twirl'],
};

/** Stop words. Checked before everything except negation. */
export const STOP_WORDS = ['stop', 'halt', 'freeze', 'wait', 'hold', 'cease'];

/**
 * Fuzzy confusables that must NEVER match a stop word: "i want candy"
 * is one substitution from "wait" but must not halt the robot.
 */
export const STOP_FUZZY_DENYLIST = new Set(['want', 'went', 'what']);

/** Speed-up / slow-down directives (also act as speed modifiers). */
export const FASTER_WORDS = ['faster', 'fast', 'quicker', 'quickly'];
export const SLOWER_WORDS = ['slower', 'slow', 'slowly'];
export const FULL_WORDS = ['full', 'maximum', 'max'];
/** Nouns that license a nearby number as a speed value ("speed 70"). */
export const SPEED_NOUNS = ['speed', 'percent', 'power'];

/** Short-burst modifiers ("go forward a little"). */
export const SHORT_WORDS = ['little', 'bit', 'tiny'];
export const SHORT_DURATION_MS = 1200;

/** If a sentence contains these, it is NOT a command (never move). */
export const NEGATIONS = new Set([
  'no',
  'not',
  'never',
  'dont',
  "don't",
  'cant',
  'cannot',
  'wont',
  'wouldnt',
  'shouldnt',
  'neither',
  'nor',
]);

/** Wake leftovers + politeness + glue words: invisible to matching. */
export const FILLERS = new Set([
  'hey',
  'wii',
  'william',
  'please',
  'could',
  'would',
  'can',
  'will',
  'you',
  'your',
  'youre',
  'the',
  'a',
  'an',
  'to',
  'me',
  'my',
  'i',
  'im',
  'ive',
  'robot',
  'bot',
  'um',
  'uh',
  'eh',
  'oh',
  'ok',
  'okay',
  'now',
  'just',
  'really',
  'very',
  'up',
  'on',
  'and',
  'then',
  'it',
  'that',
  'this',
  'here',
  'there',
  'is',
  'are',
  'was',
  'were',
  'do',
  'does',
  'did',
  'of',
  'for',
  'at',
  'in',
  'so',
  'a',
]);

/** Vosk grammar-collapse token: out-of-grammar noise, not a word. */
export const UNK_TOKEN = 'unk';

export const FAST_SPEED = 85;
export const SLOW_SPEED = 30;
export const FULL_SPEED = 100;
