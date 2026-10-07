import {
  loadModel,
  onError,
  onFinalResult,
  onResult,
  start,
  stop,
} from 'react-native-vosk';
import {
  COMMAND_GRAMMAR,
  COMMAND_TIMEOUT_MS,
  FREE_TIMEOUT_MS,
} from './grammar';
import { ensureVoskModel, type ModelProgress } from './modelManager';

export type SttMode = 'command' | 'free';

export class SttError extends Error {
  code: 'not-ready' | 'busy' | 'native';
  constructor(code: SttError['code'], message: string) {
    super(message);
    this.name = 'SttError';
    this.code = code;
  }
}

/**
 * Single owner of the Vosk recognizer (besides the Stage 5 wake-word +
 * audio machine, which will absorb this class). Model loads once; each
 * listen() is one grammar-constrained pass resolving to plain text.
 * Empty string = silence/timeout/garble — the caller (not Vosk) decides
 * whether a FREE-mode second pass is worth it.
 */
class VoskSTT {
  private ready = false;
  private busy = false;
  private loading: Promise<void> | null = null;

  get isReady(): boolean {
    return this.ready;
  }

  /** Download (once) + loadModel (once). Concurrent callers share the work. */
  ensureReady(onProgress?: ModelProgress): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (!this.loading) {
      this.loading = (async () => {
        const dir = await ensureVoskModel(onProgress);
        await loadModel(dir);
        this.ready = true;
      })().finally(() => {
        // Allow retry after failure; success short-circuits above.
        if (!this.ready) this.loading = null;
      });
    }
    return this.loading;
  }

  /**
   * One recognition pass. Resolves '' on silence/timeout (not a rejection:
   * "heard nothing" is a normal outcome the router maps to `none`).
   * Rejects only on misuse (not-ready/busy) or native failure.
   */
  listen(mode: SttMode, timeoutMs = mode === 'command' ? COMMAND_TIMEOUT_MS : FREE_TIMEOUT_MS): Promise<string> {
    if (!this.ready) {
      return Promise.reject(new SttError('not-ready', 'STT model not loaded yet.'));
    }
    if (this.busy) {
      return Promise.reject(new SttError('busy', 'Already listening.'));
    }
    this.busy = true;

    return new Promise((resolve) => {
      let done = false;
      const subs = [
        onResult((text) => finish(text)),
        onFinalResult((text) => finish(text)),
        onError(() => finish('')),
      ];
      // start()'s own timeout ends the mic; this is belt and braces in case
      // a native event is ever dropped (promise must always settle).
      const guard = setTimeout(() => finish(''), timeoutMs + 2000);

      const finish = (text: string) => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        subs.forEach((s) => s.remove());
        try {
          stop();
        } catch {
          // Already stopped natively — harmless.
        }
        this.busy = false;
        resolve(text.trim());
      };

      start(
        mode === 'command' ? { grammar: COMMAND_GRAMMAR, timeout: timeoutMs } : { timeout: timeoutMs },
      ).catch(() => finish(''));
    });
  }

  /** Cancel an in-flight listen (resolves '' via stop's final result). */
  cancel() {
    if (!this.busy) return;
    try {
      stop();
    } catch {
      // Listener guard settles the promise regardless.
    }
  }
}

let shared: VoskSTT | null = null;

/** Process-wide recognizer: one mic, one owner. */
export function getStt(): VoskSTT {
  if (!shared) shared = new VoskSTT();
  return shared;
}

export { FREE_TIMEOUT_MS, COMMAND_TIMEOUT_MS };
