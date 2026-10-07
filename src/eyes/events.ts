import type { Expression } from '../types';

/** Touch reactions other modules (e.g. robot/) can subscribe to. */
export type TouchReactionKind =
  | 'tap'
  | 'long-press'
  | 'pet'
  | 'annoyed'
  | 'follow-start'
  | 'follow-end'
  | 'sleep'
  | 'wake';

export interface TouchReaction {
  kind: TouchReactionKind;
  at: number;
  expressionAfter: Expression;
}

export type TouchReactionCallback = (r: TouchReaction) => void;

// Tiny pub/sub — no dependency, safe to import from anywhere.
const listeners = new Set<TouchReactionCallback>();

export function emitTouchReaction(r: TouchReaction): void {
  listeners.forEach((cb) => {
    try {
      cb(r);
    } catch (e) {
      console.warn('[eyes] reaction listener failed', e);
    }
  });
}

/** So robot/audio modules can react to touches later. Returns unsubscribe. */
export function onTouchReaction(cb: TouchReactionCallback): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
