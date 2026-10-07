import { PorcupineManager } from '@picovoice/porcupine-react-native';
import { Asset } from 'expo-asset';
import { WAKE_ASSETS } from './porcupineAssets';

export type WakeHandler = (detection: { index: number; label: string }) => void;

export class WakeError extends Error {
  code: 'no-access-key' | 'asset-missing' | 'init-failed';
  constructor(code: WakeError['code'], message: string) {
    super(message);
    this.name = 'WakeError';
    this.code = code;
  }
}

/**
 * Thin wrapper around PorcupineManager for the two custom keywords.
 * Sensitivities are fixed at init (Porcupine constraint): changing them
 * means re-init, which AudioController does when idle in WAKE_LISTENING.
 */
export class PorcupineService {
  private manager: PorcupineManager | null = null;
  private running = false;
  private handlers = new Set<WakeHandler>();
  private labels: string[] = [];

  get isRunning(): boolean {
    return this.running;
  }

  get isInitialised(): boolean {
    return this.manager !== null;
  }

  onDetection(cb: WakeHandler): () => void {
    this.handlers.add(cb);
    return () => {
      this.handlers.delete(cb);
    };
  }

  private emit(index: number) {
    const label = this.labels[index] ?? `keyword ${index}`;
    this.handlers.forEach((cb) => {
      try {
        cb({ index, label });
      } catch (e) {
        console.warn('[wake] detection handler failed', e);
      }
    });
  }

  /** Resolve bundled .ppn modules to absolute on-device paths. */
  private async keywordPaths(): Promise<string[]> {
    const paths: string[] = [];
    for (const a of WAKE_ASSETS) {
      const asset = Asset.fromModule(a.module);
      await asset.downloadAsync();
      const uri = asset.localUri;
      if (!uri) {
        throw new WakeError(
          'asset-missing',
          `Missing .ppn for "${a.label}". See assets/porcupine/README.md.`,
        );
      }
      // Native side wants a filesystem path, not a file:// URI.
      paths.push(uri.startsWith('file://') ? uri.slice('file://'.length) : uri);
    }
    this.labels = WAKE_ASSETS.map((a) => a.label);
    return paths;
  }

  async init(accessKey: string, sensitivities: number[]): Promise<void> {
    await this.dispose();
    let paths: string[];
    try {
      paths = await this.keywordPaths();
    } catch (e) {
      if (e instanceof WakeError) throw e;
      throw new WakeError('init-failed', `Keyword assets failed: ${String(e)}`);
    }
    try {
      this.manager = await PorcupineManager.fromKeywordPaths(
        accessKey,
        paths,
        (index: number) => this.emit(index),
        (err) => console.warn('[wake] process error', err),
        undefined,
        undefined,
        sensitivities,
      );
    } catch (e) {
      this.manager = null;
      throw new WakeError('init-failed', `Porcupine init failed: ${String(e)}`);
    }
  }

  async start(): Promise<void> {
    if (!this.manager) throw new WakeError('init-failed', 'Wake engine not initialised.');
    await this.manager.start();
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.manager || !this.running) {
      this.running = false;
      return;
    }
    try {
      await this.manager.stop();
    } finally {
      this.running = false;
    }
  }

  /** delete() is synchronous in this binding; stop first, then release. */
  async dispose(): Promise<void> {
    await this.stop().catch(() => undefined);
    if (this.manager) {
      try {
        this.manager.delete();
      } catch {
        // Already released — harmless.
      }
      this.manager = null;
    }
  }
}
