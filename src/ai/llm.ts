import { initLlama, type LlamaContext } from 'llama.rn';

export const SYSTEM_PROMPT =
  'You are Wii, a small, curious robot. Answer in one to three short sentences. If you do not know, say so.';
const MAX_TOKENS = 80;
const KEEP_TURNS = 3;
const IDLE_UNLOAD_MS = 3 * 60_000;
const TEMPERATURE = 0.7;

export interface BenchResult {
  tokens: number;
  ttftMs: number;
  tokensPerSec: number;
}

/**
 * Lazy llama.rn wrapper. Context loads on first question (n_ctx 1024 keeps
 * a 0.5B model resident-friendly); idle 3 min unloads it to give RAM back.
 * History is re-fed every turn (max 3 exchanges) — no session files, so a
 * model swap can't poison the cache.
 */
class LlmService {
  private ctx: LlamaContext | null = null;
  private loading: Promise<void> | null = null;
  private modelPath: string | null = null;
  private stops: string[] = [];
  private history: Array<{ q: string; a: string }> = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelGen = 0; // bumped by cancel(); answers check their generation
  private benchResult: (BenchResult & { at: number }) | null = null;

  /** Last benchmark (with wall time) for the diagnostics screen. */
  get lastBench(): (BenchResult & { at: number }) | null {
    return this.benchResult;
  }

  get isLoaded(): boolean {
    return this.ctx !== null;
  }

  async ensureLoaded(modelPath: string, stop: string[] = []): Promise<void> {
    if (this.ctx && this.modelPath === modelPath) {
      this.stops = stop;
      this.touchIdle();
      return;
    }
    if (this.loading) {
      await this.loading;
      return;
    }
    this.loading = (async () => {
      await this.unload();
      this.ctx = await initLlama(
        {
          model: modelPath,
          n_ctx: 1024,
          n_batch: 128,
          n_threads: 4,
          use_mmap: true,
          use_mlock: false,
        },
        () => undefined,
      );
      this.modelPath = modelPath;
      this.stops = stop;
      this.touchIdle();
    })().finally(() => {
      if (!this.ctx) this.loading = null;
      else this.loading = null;
    });
    await this.loading;
  }

  /**
   * Stream an answer token-by-token. Resolves the full trimmed text.
   * Throws on native failure; resolves partial text when cancelled.
   */
  async answer(question: string, onToken: (t: string) => void): Promise<string> {
    if (!this.ctx) throw new Error('[llm] not loaded');
    const gen = this.cancelGen;
    this.touchIdle();
    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      ...this.history.flatMap((h) => [
        { role: 'user' as const, content: h.q },
        { role: 'assistant' as const, content: h.a },
      ]),
      { role: 'user' as const, content: question },
    ];
    let full = '';
    try {
      await this.ctx.completion(
        {
          messages,
          n_predict: MAX_TOKENS,
          temperature: TEMPERATURE,
          ...(this.stops.length > 0 ? { stop: this.stops } : {}),
        },
        (data) => {
          if (gen !== this.cancelGen) return;
          const t = data.token ?? '';
          if (!t) return;
          full += t;
          onToken(t);
        },
      );
    } catch (e) {
      // stopCompletion() surfaces as an error: partial text is the answer.
      if (gen !== this.cancelGen) return full.trim();
      throw e;
    }
    const text = full.trim();
    if (text && gen === this.cancelGen) {
      this.history = [...this.history, { q: question, a: text }].slice(-KEEP_TURNS);
    }
    return text;
  }

  /** Abort the in-flight answer (tap / "stop" / suspend). Partial text kept. */
  cancel() {
    this.cancelGen++;
    this.ctx?.stopCompletion().catch(() => undefined);
  }

  /**
   * Decode-speed benchmark (prefill excluded: the clock starts at the first
   * token). Run on-device from Settings; compare across models/quant levels.
   */
  async benchmark(modelPath: string, stop: string[] = []): Promise<BenchResult> {
    await this.ensureLoaded(modelPath, stop);
    if (!this.ctx) throw new Error('[llm] not loaded');
    let tokens = 0;
    let tFirst = 0;
    const t0 = Date.now();
    await this.ctx.completion(
      {
        messages: [{ role: 'user', content: 'Reply with exactly: one two three four five.' }],
        n_predict: 16,
        temperature: 0,
      },
      () => {
        if (tokens === 0) tFirst = Date.now();
        tokens++;
      },
    );
    const dt = Math.max(1, Date.now() - tFirst);
    const result = { tokens, ttftMs: tFirst - t0, tokensPerSec: (tokens / dt) * 1000 };
    this.benchResult = { ...result, at: Date.now() };
    console.log(
      `[llm] bench: ${tokens} tok, ttft ${result.ttftMs} ms, ${result.tokensPerSec.toFixed(1)} tok/s`,
    );
    return result;
  }

  async unload(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.ctx) {
      await this.ctx.release().catch(() => undefined);
      this.ctx = null;
      this.modelPath = null;
    }
  }

  clearHistory() {
    this.history = [];
  }

  private touchIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.unload();
    }, IDLE_UNLOAD_MS);
  }
}

let shared: LlmService | null = null;

/** Process-wide inference owner (one context in RAM at a time). */
export function getLlmService(): LlmService {
  if (!shared) shared = new LlmService();
  return shared;
}
