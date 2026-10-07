import { route } from '../intent/router';
import { speakText } from '../voice/tts';
import { getStt } from '../voice/stt';
import { getLlmService } from './llm';
import { getModelManager } from './modelManager';
import { pullSentences } from './sentences';

export interface AnswerEvents {
  /** Fired once, right before the first sentence speaks (eyes -> speaking). */
  onSpeakingStart: () => void;
  /** Polled between sentences and tokens; true = abort now. */
  isInterrupted: () => boolean;
}

export interface AnswerResult {
  text: string;
  interrupted: boolean;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Question -> LLM tokens -> spoken sentences. Sentences speak as soon as
 * they complete, so TTFB is one sentence, not the whole answer.
 *
 * Barge-in: while speaking, a COMMAND-mode Vosk pass runs in parallel and
 * only honors a bare "stop" (<=3 words). Echo caveat: the mic hears our own
 * speaker, so anything longer is ignored — a shouted STOP still cuts through
 * because Vosk emits it as its own short result.
 */
export async function answerAloud(
  question: string,
  ev: AnswerEvents,
): Promise<AnswerResult> {
  const mm = getModelManager();
  const status = await mm.status();
  if (status !== 'ready') {
    const line =
      status === 'unsupported_device'
        ? 'I need a stronger phone for a brain. Sorry!'
        : "I don't have a brain installed yet. Open settings to download it.";
    if (!ev.isInterrupted()) {
      ev.onSpeakingStart();
      await speakText(line);
    }
    return { text: line, interrupted: ev.isInterrupted() };
  }

  const path = await mm.modelPath();
  if (!path) {
    return { text: '', interrupted: ev.isInterrupted() };
  }
  const llm = getLlmService();
  const stops = mm.getSelected().stop;
  try {
    await llm.ensureLoaded(path, stops);
  } catch (e) {
    console.warn('[ai] load failed', e);
    const line = 'My brain would not wake up. Sorry!';
    if (!ev.isInterrupted()) {
      ev.onSpeakingStart();
      await speakText(line);
    }
    return { text: line, interrupted: ev.isInterrupted() };
  }

  const pending: string[] = [];
  let buffer = '';
  let streamDone = false;
  let speakDone = false;
  let speaking = false;
  let barged = false;
  let full = '';

  const markSpeaking = () => {
    if (!speaking) {
      speaking = true;
      ev.onSpeakingStart();
    }
  };

  // Speaker: drains complete sentences sequentially.
  const speakLoop = (async () => {
    try {
      for (;;) {
        const next = pending.shift();
        if (next === undefined) {
          if (streamDone) return;
          await delay(120);
          continue;
        }
        if (ev.isInterrupted()) return;
        markSpeaking();
        await speakText(next);
      }
    } finally {
      speakDone = true;
    }
  })();

  // Barge-in: only a bare "stop" counts (see docstring for why).
  const bargeLoop = (async () => {
    const stt = getStt();
    for (;;) {
      if (speakDone || ev.isInterrupted()) return;
      if (!speaking) {
        await delay(300);
        continue;
      }
      const heard = await stt.listen('command', 4000).catch(() => '');
      if (speakDone || ev.isInterrupted()) return;
      if (!heard) continue;
      const intent = route(heard);
      if (
        intent.type === 'command' &&
        intent.command.kind === 'stop' &&
        heard.trim().split(/\s+/).length <= 3
      ) {
        barged = true;
        return;
      }
    }
  })();

  try {
    await llm.answer(question, (tok) => {
      if (ev.isInterrupted()) return;
      full += tok;
      buffer += tok;
      const { sentences, rest } = pullSentences(buffer);
      buffer = rest;
      pending.push(...sentences);
    });
  } catch (e) {
    console.warn('[ai] generation failed', e);
  } finally {
    const tail = buffer.trim();
    if (tail && !ev.isInterrupted()) pending.push(tail);
    streamDone = true;
  }

  await speakLoop;
  getStt().cancel(); // release the barge pass promptly so it can exit
  await bargeLoop;

  const interrupted = ev.isInterrupted() || barged;
  return { text: full.trim(), interrupted };
}
