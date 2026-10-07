import {
  createDownloadResumable,
  deleteAsync,
  documentDirectory,
  getInfoAsync,
  readAsStringAsync,
  writeAsStringAsync,
  type DownloadResumable,
} from 'expo-file-system/legacy';
import { getFreeDiskStorage, getTotalMemory } from 'react-native-device-info';
import { DEFAULT_BRAIN_ID, getBrain, type BrainModel } from './catalog';

export type ModelStatus =
  | 'not_installed'
  | 'downloading'
  | 'ready'
  | 'unsupported_device';

export interface ModelProgress {
  received: number;
  total: number;
}

export interface DeviceGates {
  totalRam: number | null;
  freeStorage: number | null;
  supported: boolean;
  reason: string | null;
}

export class ModelError extends Error {
  code: 'no-storage' | 'download-failed' | 'verify-failed';
  constructor(code: ModelError['code'], message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
  }
}

const HEADROOM_BYTES = 300_000_000; // model + KV cache + unzip slack
const VERIFY_TOLERANCE = 1_000_000; // hosts report slightly different sizes

const dirFor = (id: string) => `${documentDirectory}llm/${id}`;
const fileFor = (m: BrainModel) => `${dirFor(m.id)}/${m.fileName}`;
const sidecarFor = (id: string) => `${dirFor(id)}/resume.json`;

/**
 * Owns GGUF files in app-private storage. Download is resumable across
 * launches: pause() persists the native resume token to a sidecar file and
 * the next download() continues where it stopped (same URL required).
 */
class ModelManager {
  private selectedId = DEFAULT_BRAIN_ID;
  private task: DownloadResumable | null = null;

  getSelected(): BrainModel {
    return getBrain(this.selectedId);
  }

  select(id: string) {
    this.selectedId = getBrain(id).id; // unknown ids fall back to default
  }

  /** RAM + storage gates for the selected model. Never throws. */
  async checkDevice(): Promise<DeviceGates> {
    const need = this.getSelected().minRamBytes;
    let totalRam: number | null = null;
    let freeStorage: number | null = null;
    try {
      totalRam = await getTotalMemory();
    } catch {
      totalRam = null;
    }
    try {
      freeStorage = await getFreeDiskStorage();
    } catch {
      freeStorage = null;
    }
    if (totalRam !== null && totalRam < need) {
      return {
        totalRam,
        freeStorage,
        supported: false,
        reason: `Needs ${Math.round(need / 1e9)} GB RAM, device has ${(
          totalRam / 1e9
        ).toFixed(1)} GB.`,
      };
    }
    const want = this.getSelected().sizeBytes + HEADROOM_BYTES;
    if (freeStorage !== null && freeStorage < want) {
      return {
        totalRam,
        freeStorage,
        supported: false,
        reason: `Needs ${Math.round(want / 1e9)} GB free, device has ${(
          freeStorage / 1e9
        ).toFixed(1)} GB.`,
      };
    }
    return { totalRam, freeStorage, supported: true, reason: null };
  }

  async status(): Promise<ModelStatus> {
    if (this.task) return 'downloading';
    const gates = await this.checkDevice();
    if (!gates.supported) return 'unsupported_device';
    return (await this.verify(this.getSelected())) ? 'ready' : 'not_installed';
  }

  /** Installed path, or null. Call status() first if you need the reason. */
  async modelPath(): Promise<string | null> {
    const m = this.getSelected();
    return (await this.verify(m)) ? fileFor(m) : null;
  }

  private async verify(m: BrainModel): Promise<boolean> {
    const info = await getInfoAsync(fileFor(m)).catch(() => null);
    if (!info?.exists || typeof info.size !== 'number') return false;
    if (m.md5 && 'md5' in info && typeof (info as { md5?: string }).md5 === 'string') {
      return (info as { md5?: string }).md5 === m.md5;
    }
    // No checksum published: size match within host variance.
    return Math.abs(info.size - m.sizeBytes) < VERIFY_TOLERANCE;
  }

  /**
   * Download to completion with progress. Resumes a paused download when
   * the sidecar + partial file exist. Rejects on HTTP errors; callers
   * surface status() afterwards.
   */
  async download(onProgress?: (p: ModelProgress) => void): Promise<string> {
    if (!documentDirectory) throw new ModelError('no-storage', 'No app storage.');
    if (this.task) throw new ModelError('download-failed', 'Already downloading.');
    const m = this.getSelected();
    const target = fileFor(m);

    if (await this.verify(m)) return target;

    let resumeData: string | undefined;
    const sidecar = await readAsStringAsync(sidecarFor(m.id)).catch(() => null);
    if (sidecar) {
      try {
        const parsed = JSON.parse(sidecar) as { resumeData?: string };
        resumeData = parsed.resumeData;
      } catch {
        resumeData = undefined;
      }
    }

    const total = m.sizeBytes;
    this.task = createDownloadResumable(
      m.url,
      target,
      {},
      (p) =>
        onProgress?.({
          received: p.totalBytesWritten,
          total: p.totalBytesExpectedToWrite > 0 ? p.totalBytesExpectedToWrite : total,
        }),
      resumeData,
    );
    try {
      const res = await this.task.downloadAsync();
      if (!res || res.status !== 200) {
        throw new Error(`HTTP ${res?.status ?? 'no response'}`);
      }
    } catch (e) {
      this.task = null;
      throw new ModelError('download-failed', `Download failed: ${String(e)}`, e);
    }
    this.task = null;
    await deleteAsync(sidecarFor(m.id), { idempotent: true }).catch(() => undefined);

    if (!(await this.verify(m))) {
      await deleteAsync(target, { idempotent: true }).catch(() => undefined);
      throw new ModelError(
        'verify-failed',
        'File failed verification (size/checksum). Deleted; retry on stable WiFi.',
      );
    }
    return target;
  }

  /** Pause mid-download, persisting the resume token for next launch. */
  async pause(): Promise<void> {
    if (!this.task) return;
    try {
      const savable = (await this.task.pauseAsync()) as unknown as {
        resumeData?: string;
      };
      if (savable?.resumeData) {
        await writeAsStringAsync(
          sidecarFor(this.selectedId),
          JSON.stringify({ resumeData: savable.resumeData }),
        ).catch(() => undefined);
      }
    } finally {
      this.task = null;
    }
  }

  /** Delete model + resume state (frees ~0.4–1 GB). */
  async remove(): Promise<void> {
    await this.pause().catch(() => undefined);
    const m = this.getSelected();
    await deleteAsync(fileFor(m), { idempotent: true }).catch(() => undefined);
    await deleteAsync(sidecarFor(m.id), { idempotent: true }).catch(() => undefined);
  }
}

let shared: ModelManager | null = null;

/** Process-wide download owner (one 400 MB+ write at a time). */
export function getModelManager(): ModelManager {
  if (!shared) shared = new ModelManager();
  return shared;
}
