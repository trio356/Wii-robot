import type { RobotCommand } from '../types';
import { toSpeed } from '../types';
import {
  FASTER_WORDS,
  FILLERS,
  FULL_SPEED,
  FULL_WORDS,
  FAST_SPEED,
  MOTION_WORDS,
  NEGATIONS,
  SHORT_DURATION_MS,
  SHORT_WORDS,
  SLOWER_WORDS,
  SLOW_SPEED,
  SPEED_NOUNS,
  STOP_FUZZY_DENYLIST,
  STOP_WORDS,
  UNK_TOKEN,
} from './vocabulary';

export type Intent =
  | { type: 'command'; command: RobotCommand }
  | { type: 'question'; text: string }
  | { type: 'none' };

/** Tiny Levenshtein (words are short; no lib needed). Exported for tests. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let cur0 = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(prev[j] + 1, cur0 + 1, prev[j - 1] + cost);
      prev[j - 1] = cur0;
      cur0 = next;
    }
    prev[n] = cur0;
  }
  return prev[n];
}

type PseudoKind = 'stop' | 'speed-up' | 'speed-down' | 'speed-noun' | 'motion-fwd' | 'motion-back' | 'motion-left' | 'motion-right' | 'wiggle';

/**
 * Classify one token. Exact hit wins; otherwise Levenshtein <= 1 against
 * vocabulary words of length >= 4 (short words match exactly only).
 */
function matchWord(word: string): PseudoKind | null {
  const all: Array<[string, PseudoKind]> = [];
  for (const w of MOTION_WORDS.fwd) all.push([w, 'motion-fwd']);
  for (const w of MOTION_WORDS.back) all.push([w, 'motion-back']);
  for (const w of MOTION_WORDS.left) all.push([w, 'motion-left']);
  for (const w of MOTION_WORDS.right) all.push([w, 'motion-right']);
  for (const w of MOTION_WORDS.wiggle) all.push([w, 'wiggle']);
  for (const w of STOP_WORDS) all.push([w, 'stop']);
  for (const w of FASTER_WORDS) all.push([w, 'speed-up']);
  for (const w of SLOWER_WORDS) all.push([w, 'speed-down']);
  for (const w of SPEED_NOUNS) all.push([w, 'speed-noun']);

  for (const [vocab, kind] of all) {
    if (word === vocab) return kind;
  }
  if (word.length < 4) return null;
  for (const [vocab, kind] of all) {
    if (vocab.length < 4) continue;
    if (levenshtein(word, vocab) <= 1) {
      // "want" is one typo from "wait" — never stop on it.
      if (kind === 'stop' && STOP_FUZZY_DENYLIST.has(word)) continue;
      return kind;
    }
  }
  return null;
}

function normalize(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/['’]/g, '') // don't -> dont (one token, matches NEGATIONS)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && t !== UNK_TOKEN);
}

/**
 * Deterministic text -> intent. Pure: no I/O, no randomness, no LLM.
 *
 * Order matters (safety first):
 *  1. empty -> none
 *  2. negation anywhere -> never a command (falls to question/none)
 *  3. stop word anywhere -> stop (priority over motion words)
 *  4. direction words -> LAST left/right/back wins ("go to the left",
 *     self-corrections); else first other motion
 *  5. no match + >2 words -> question, else none
 */
export function route(raw: string): Intent {
  const text = raw.trim();
  if (!text) return { type: 'none' };

  const tokens = normalize(text);
  if (tokens.length === 0) return { type: 'none' };

  // 2. Negation vetoes every command. "don't go forward" must not move.
  if (tokens.some((t) => NEGATIONS.has(t))) {
    return tokens.length > 2 ? { type: 'question', text } : { type: 'none' };
  }

  const content = tokens.filter((t) => !FILLERS.has(t));
  const kinds = content
    .map(matchWord)
    .filter((k): k is PseudoKind => k !== null);

  // 3. Stop priority: "stop moving forward" stops, full stop.
  if (kinds.includes('stop')) {
    return { type: 'command', command: { kind: 'stop' } };
  }

  // Modifiers + explicit numbers.
  const has = (k: PseudoKind) => kinds.includes(k);
  const numToken = content.find((t) => /^\d{1,3}$/.test(t));
  const numSpeed = numToken !== undefined ? Math.min(100, parseInt(numToken, 10)) : null;
  const short = content.some((t) => SHORT_WORDS.includes(t));
  const resolveSpeed = (): number | undefined => {
    if (numSpeed !== null && (has('speed-noun') || kinds.some((k) => k.startsWith('motion')))) {
      return numSpeed;
    }
    if (FULL_WORDS.some((w) => content.includes(w))) return FULL_SPEED;
    if (has('speed-up')) return FAST_SPEED;
    if (has('speed-down')) return SLOW_SPEED;
    return undefined;
  };

  // 4. Direction resolution.
  const dirs = kinds.filter(
    (k) => k === 'motion-left' || k === 'motion-right' || k === 'motion-back',
  );
  const firstMotion = kinds.find((k) => k.startsWith('motion') || k === 'wiggle');
  const picked = dirs.length > 0 ? dirs[dirs.length - 1] : firstMotion;

  if (picked === 'wiggle') {
    return { type: 'command', command: { kind: 'wiggle' } };
  }
  if (picked && picked.startsWith('motion')) {
    const kind = picked.slice('motion-'.length) as RobotCommand['kind'];
    const speed = resolveSpeed();
    const command: RobotCommand = speed !== undefined ? { kind, speed: toSpeed(speed) } : { kind };
    if (short) command.durationMs = SHORT_DURATION_MS;
    return { type: 'command', command };
  }

  // Bare speed directives: "faster", "slow down", "speed 70".
  if (has('speed-up') || has('speed-down') || (has('speed-noun') && numSpeed !== null)) {
    const speed = resolveSpeed();
    if (speed !== undefined) {
      return { type: 'command', command: { kind: 'speed', speed: toSpeed(speed) } };
    }
  }

  // 5. Not a command: long enough to be a question, else noise.
  return tokens.length > 2 ? { type: 'question', text } : { type: 'none' };
}
