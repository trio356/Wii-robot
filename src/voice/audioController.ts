import { PermissionsAndroid, Platform } from 'react-native';
import type { AudioState, Expression, RobotCommand } from '../types';
import { route } from '../intent/router';
import { isGarble } from './grammar';
import { PorcupineService } from './porcupine';
import {
  COMMAND_WINDOW_MS,
  MIC_HANDOFF_MS,
  POST_TTS_QUIET_MS,
  getPorcupineAccessKey,
} from './porcupineConfig';
import { getWakeSettings } from './settings';
import { getStt } from './stt';
import { stopSpeaking } from './tts';
import { getLlmService } from '../ai/llm';
import { log } from '../util/log';
import { playChime } from './chime';

export type AudioErrorCode = 'mic-denied' | 'no-model' | 'no-access-key' | 'wake-failed';

export class AudioError extends Error {
  code: AudioErrorCode;
  constructor(code: AudioErrorCode, message: string) {
    super(message);
    this.name = 'AudioError';
    this.code = code;
  }
}

export interface WakeDetection {
  label: string;
  index: number;
  at: number;
}

export interface AudioSnapshot {
  phase: AudioState;
  running: boolean;
  error: AudioError | null;
  lastHeard: string;
  detections: WakeDetection[];
}

/** Wiring to the rest of the app. Injected so voice/ never imports robot/. */
export interface AudioAnswerEvents {
  onSpeakingStart: () => void;
  isInterrupted: () => boolean;
}

export interface AudioAnswer {
  text: string;
  interrupted: boolean;
}

export interface AudioHandlers {
  setEyes: (e: Expression) => void;
  sendCommand: (cmd: RobotCommand) => Promise<void>;
  stopRobot: () => void;
  /** Stage 6: on-device LLM + spoken answer. Must always resolve. */
  answerQuestion: (question: string, ev: AudioAnswerEvents) => Promise<AudioAnswer>;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function ensureMicPermission(): Promise<boolean> {
  // iOS prompts natively on first voice-processor start (usage string set).
  if (Platform.OS !== 'android') return true;
  const res = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    {
      title: 'Wii-Robot microphone',
      message: ' needed for the "Hey Wii" wake word and voice commands.',
      buttonPositive: 'Allow',
      buttonNegative: 'Deny',
    },
  );
  return res === PermissionsAndroid.RESULTS.GRANTED;
}

/**
 * The single owner of the microphone.
 * WAKE_LISTENING -> COMMAND_LISTENING -> THINKING -> SPEAKING -> WAKE_LISTENING
 *
 * Handoff discipline: Porcupine is fully stopped before Vosk starts (and
 * vice versa) with a short delay — two engines must never hold the mic at
 * once. All multi-step flows run through one promise chain so start/stop
 * calls can never overlap. A generation counter invalidates in-flight turns
 * on suspend / test-mode / settings re-init.
 */
export class AudioController {
  private phase: AudioState = 'WAKE_LISTENING';
  private error: AudioError | null = null;
  private running = false;
  private autoRun = false;
  private suspended = false;
  private testMode = false;
  private gen = 0;
  private chain: Promise<void> = Promise.resolve();
  private interruptFlag = false;
  private startTask: Promise<void> | null = null;
  private pendingSettings = false;
  private lastHeard = '';
  private detections: WakeDetection[] = [];
  private durationTimer: ReturnType<typeof setTimeout> | null = null;

  private porcupine = new PorcupineService();
  private handlers: AudioHandlers = {
    setEyes: () => undefined,
    sendCommand: async () => undefined,
    stopRobot: () => undefined,
    answerQuestion: async (q) => {
      console.log('[audio] question (no LLM wired):', q);
      return { text: "I'll answer that soon.", interrupted: false };
    },
  };
  private listeners = new Set<(s: AudioSnapshot) => void>();

  constructor() {
    this.porcupine.onDetection((d) => this.handleDetection(d));
  }

  // ---------- external API ----------

  attachHandlers(patch: Partial<AudioHandlers>) {
    this.handlers = { ...this.handlers, ...patch };
  }

  get snapshot(): AudioSnapshot {
    return {
      phase: this.phase,
      running: this.running,
      error: this.error,
      lastHeard: this.lastHeard,
      detections: [...this.detections],
    };
  }

  onSnapshot(cb: (s: AudioSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Foreground start (also manual retry after an error). */
  async start(): Promise<void> {
    // Reentrancy guard: mount auto-start + pill tap share one init. A second
    // init would dispose() the first manager mid-start and wedge the mic.
    if (this.startTask) return this.startTask;
    this.startTask = this.doStart().finally(() => {
      this.startTask = null;
    });
    return this.startTask;
  }

  private async doStart(): Promise<void> {
    this.autoRun = true;
    this.suspended = false;
    this.error = null;
    this.emit();

    if (!(await ensureMicPermission())) {
      return this.fail(
        new AudioError(
          'mic-denied',
          'Microphone denied. Allow it in Settings → Apps → Wii-Robot → Permissions, then tap to retry.',
        ),
      );
    }
    try {
      await getStt().ensureReady();
    } catch (e) {
      return this.fail(
        new AudioError('no-model', `Speech model unavailable: ${String(e)}`),
      );
    }
    const key = getPorcupineAccessKey();
    if (!key) {
      return this.fail(
        new AudioError(
          'no-access-key',
          'No Picovoice key. Start with PICOVOICE_ACCESS_KEY=… and add both .ppn files (assets/porcupine/README.md).',
        ),
      );
    }
    try {
      const s = getWakeSettings();
      await this.porcupine.init(key, [s.sensitivityWii, s.sensitivityWilliam]);
      await this.porcupine.start();
    } catch (e) {
      return this.fail(
        new AudioError('wake-failed', `Wake engine failed: ${String(e)}`),
      );
    }
    this.pendingSettings = false;
    this.running = true;
    this.setPhase('WAKE_LISTENING');
    this.eyes('idle');
  }

  /** User turns voice off. Cancels everything, stays off until start(). */
  stopAll(): void {
    this.autoRun = false;
    this.gen++;
    this.interruptFlag = true;
    this.testMode = false;
    getStt().cancel();
    void stopSpeaking();
    getLlmService().cancel();
    void this.porcupine.stop();
    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }
    this.running = false;
    this.setPhase('WAKE_LISTENING');
    this.eyes('idle');
  }

  /** Background: mic off now (foreground-only listening, no service). */
  suspend(): void {
    if (!this.running && !this.autoRun) return;
    this.gen++;
    this.interruptFlag = true;
    this.suspended = true;
    this.testMode = false;
    getStt().cancel();
    void stopSpeaking();
    getLlmService().cancel();
    void this.porcupine.stop();
    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }
    this.handlers.stopRobot();
    this.running = false;
    this.setPhase('WAKE_LISTENING');
    this.eyes('idle');
  }

  /** Foreground again: resume only if the user had voice on. */
  resume(): void {
    if (!this.autoRun || this.running) {
      this.suspended = false;
      return;
    }
    this.suspended = false;
    const gen = this.gen;
    // Manager persists across suspend; just re-open the mic. The .then
    // re-checks generation: stopAll() in between must NOT flip running on.
    this.porcupine
      .start()
      .then(() => {
        if (gen !== this.gen || !this.autoRun) return;
        this.running = true;
        this.setPhase('WAKE_LISTENING');
      })
      .catch(() => {
        if (gen !== this.gen || !this.autoRun) return;
        void this.start();
      });
  }

  /**
   * Live-detection mode for the test screen: Porcupine keeps running and
   * every detection is logged, but no command turns fire. Enabling mid-turn
   * aborts the turn (generation bump) and re-opens wake listening.
   */
  setTestMode(on: boolean): Promise<void> {
    return this.enqueue(async () => {
      this.gen++;
      this.testMode = on;
      if (on) {
        // Test bench must hear even if voice never started: init on demand.
        if (!this.porcupine.isInitialised) {
          const key = getPorcupineAccessKey();
          if (!key) {
            this.fail(
              new AudioError(
                'no-access-key',
                'No Picovoice key. Start with PICOVOICE_ACCESS_KEY=… (app.config.js).',
              ),
            );
            this.testMode = false;
            return;
          }
          const s = getWakeSettings();
          await this.porcupine.init(key, [s.sensitivityWii, s.sensitivityWilliam]).catch(() => undefined);
        }
        if (!this.porcupine.isRunning) {
          await this.porcupine.start().catch(() => undefined);
        }
        this.setPhase('WAKE_LISTENING');
      } else if (this.autoRun && !this.suspended) {
        if (!this.porcupine.isRunning) {
          await this.porcupine.start().catch(() => undefined);
        }
        this.running = true;
        this.setPhase('WAKE_LISTENING');
      } else {
        await this.porcupine.stop().catch(() => undefined);
      }
    });
  }

  get inTestMode(): boolean {
    return this.testMode;
  }

  /**
   * Tap / "stop" barge-in while the robot is thinking or talking. Stops TTS
   * immediately and aborts generation; the answer loop sees the flag and
   * returns to wake. No-op in other phases (a tap there means wiggle).
   */
  interrupt(): void {
    if (this.phase !== 'SPEAKING' && this.phase !== 'THINKING') return;
    this.interruptFlag = true;
    void stopSpeaking();
    getLlmService().cancel();
  }

  /** Re-init wake with fresh sensitivities when safely idle, else defer. */
  applySettings(): Promise<void> {
    this.pendingSettings = true;
    if (this.phase === 'WAKE_LISTENING' && this.running && !this.testMode) {
      return this.enqueue(() => this.reinitWake());
    }
    return Promise.resolve();
  }

  // ---------- internals ----------

  private enqueue(task: () => Promise<void>): Promise<void> {
    const tail = this.chain.then(() => task());
    this.chain = tail.catch(() => undefined);
    tail.catch((e) => console.warn('[audio] task failed', e));
    return tail;
  }

  private alive(gen: number): boolean {
    return gen === this.gen && this.running && !this.suspended && !this.testMode;
  }

  private emit() {
    const s = this.snapshot;
    this.listeners.forEach((cb) => {
      try {
        cb(s);
      } catch (e) {
        console.warn('[audio] snapshot listener failed', e);
      }
    });
  }

  private setPhase(p: AudioState) {
    this.phase = p;
    this.emit();
  }

  private eyes(e: Expression) {
    try {
      this.handlers.setEyes(e);
    } catch (err) {
      console.warn('[audio] eyes failed', err);
    }
  }

  private fail(err: AudioError) {
    log('error', 'audio', `fail: ${err.code} — ${err.message}`);
    this.gen++;
    this.running = false;
    this.error = err;
    this.setPhase('WAKE_LISTENING');
    this.eyes('sad');
  }

  private handleDetection(d: { index: number; label: string }) {
    this.detections = [{ ...d, at: Date.now() }, ...this.detections].slice(0, 20);
    this.emit();
    if (this.testMode || !this.running || this.phase !== 'WAKE_LISTENING') return;
    void this.enqueue(() => this.commandTurn(d.label));
  }

  private async backToWake(gen: number): Promise<void> {
    if (!this.alive(gen)) return;
    if (this.pendingSettings) {
      this.pendingSettings = false;
      await this.reinitWake();
      if (!this.alive(gen)) return;
    } else {
      // Small delay: Vosk's stop() needs a beat before Porcupine re-opens.
      await delay(200);
      if (!this.alive(gen)) return;
      await this.porcupine.start().catch(() => undefined);
    }
    if (!this.alive(gen)) return;
    // A swallowed start() failure must never leave us "running but deaf":
    // retry once, then surface wake-failed so the pill offers a retry.
    if (!this.porcupine.isRunning) {
      await delay(800);
      if (!this.alive(gen)) return;
      await this.porcupine.start().catch(() => undefined);
    }
    if (!this.alive(gen)) return;
    if (!this.porcupine.isRunning) {
      this.fail(new AudioError('wake-failed', 'Wake engine stopped responding. Tap to retry.'));
      return;
    }
    this.setPhase('WAKE_LISTENING');
    this.eyes('idle');
  }

  private async reinitWake(): Promise<void> {
    const key = getPorcupineAccessKey();
    if (!key) return;
    const s = getWakeSettings();
    await this.porcupine.dispose().catch(() => undefined);
    await this.porcupine.init(key, [s.sensitivityWii, s.sensitivityWilliam]).catch(() => undefined);
    await this.porcupine.start().catch(() => undefined);
  }

  private async flashEyes(e: Expression, ms: number, gen: number): Promise<void> {
    this.eyes(e);
    await delay(ms);
    if (!this.alive(gen)) return;
  }

  private async commandTurn(wakeLabel: string): Promise<void> {
    const gen = this.gen;
    if (this.phase !== 'WAKE_LISTENING' || !this.running || this.testMode) return;
    this.interruptFlag = false;
    try {
      this.setPhase('COMMAND_LISTENING');
      this.eyes('listening');
      playChime();
      await this.porcupine.stop();
      if (!this.alive(gen)) return;
      await delay(MIC_HANDOFF_MS);
      if (!this.alive(gen)) return;

      const heard = await getStt().listen('command', COMMAND_WINDOW_MS);
      if (!this.alive(gen)) return;
      this.lastHeard = heard;
      this.emit();

      if (!heard || isGarble(heard)) {
        // Silence or out-of-grammar noise: stay quiet (no nagging TTS).
        await this.flashEyes('sad', 800, gen);
        await this.backToWake(gen);
        return;
      }

      const intent = route(heard);
      if (intent.type === 'command') {
        log('info', 'audio', `wake → command ${intent.command.kind}${intent.command.speed !== undefined ? ` @${intent.command.speed}` : ''} (“${heard}”)`);
        try {
          await this.handlers.sendCommand(intent.command);
        } catch (e) {
          // Link down etc: sad flash, still recover to wake.
          console.warn('[audio] send failed', e);
          await this.flashEyes('sad', 900, gen);
          await this.backToWake(gen);
          return;
        }
        this.eyes('happy');
        playChime();
        if (intent.command.durationMs) {
          const ms = intent.command.durationMs;
          if (this.durationTimer) clearTimeout(this.durationTimer);
          this.durationTimer = setTimeout(() => this.handlers.stopRobot(), ms);
        }
        await delay(900);
        if (!this.alive(gen)) return;
        await this.backToWake(gen);
      } else if (intent.type === 'question') {
        log('info', 'audio', `wake → question (“${heard}”)`);
        this.setPhase('THINKING');
        this.eyes('thinking');
        // answerQuestion streams + speaks (first sentence fires onSpeakingStart
        // -> SPEAKING eyes). interruptFlag (tap / barge "stop" / suspend)
        // aborts it; wake stays paused until the quiet period below.
        const done = await this.handlers.answerQuestion(intent.text, {
          onSpeakingStart: () => {
            if (gen !== this.gen) return;
            this.setPhase('SPEAKING');
            this.eyes('speaking');
          },
          isInterrupted: () => this.interruptFlag || !this.alive(gen),
        });
        if (!this.alive(gen) || this.interruptFlag || done.interrupted) {
          await this.backToWake(gen);
          return;
        }
        await delay(POST_TTS_QUIET_MS);
        await this.backToWake(gen);
      } else {
        await this.flashEyes('sad', 700, gen);
        await this.backToWake(gen);
      }
    } catch (e) {
      log('error', 'audio', `turn failed: ${String(e)} (wake=${wakeLabel})`);
      await this.flashEyes('sad', 800, gen).catch(() => undefined);
      await this.backToWake(gen).catch(() => undefined);
    }
  }
}

let shared: AudioController | null = null;

/** Process-wide mic owner. There must never be a second instance. */
export function getAudioController(): AudioController {
  if (!shared) shared = new AudioController();
  return shared;
}
