import {
  createDownloadResumable,
  deleteAsync,
  documentDirectory,
  getInfoAsync,
} from 'expo-file-system/legacy';
import { unzip } from 'react-native-zip-archive';
import { MODEL_DIR_NAME, MODEL_ZIP_NAME, MODEL_ZIP_URL } from './grammar';

export type ModelStage = 'checking' | 'downloading' | 'unzipping' | 'ready';
export type ModelProgress = (stage: ModelStage, fraction: number) => void;

export class ModelError extends Error {
  code: 'no-storage' | 'download-failed' | 'unzip-failed' | 'verify-failed';
  constructor(
    code: ModelError['code'],
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
  }
}

/**
 * Downloads the ~40 MB Vosk model once into app-private storage and returns
 * the extracted directory path for loadModel(). Bundling is deliberately
 * avoided: 40 MB inside the APK slows every dev-client rebuild and OTA.
 * A sentinel file (am/final.mdl) proves a previous download completed, so
 * this is a no-op on later launches (offline-friendly).
 */
export async function ensureVoskModel(
  onProgress?: ModelProgress,
): Promise<string> {
  if (!documentDirectory) {
    throw new ModelError('no-storage', 'No app document directory (emulator?).');
  }
  const dir = `${documentDirectory}${MODEL_DIR_NAME}`;
  onProgress?.('checking', 0);

  const sentinel = await getInfoAsync(`${dir}/am/final.mdl`).catch(() => null);
  if (sentinel?.exists) {
    onProgress?.('ready', 1);
    return dir;
  }

  const zipPath = `${documentDirectory}${MODEL_ZIP_NAME}`;
  try {
    onProgress?.('downloading', 0);
    const task = createDownloadResumable(
      MODEL_ZIP_URL,
      zipPath,
      {},
      (p) => onProgress?.('downloading', p.totalBytesWritten / p.totalBytesExpectedToWrite),
    );
    const res = await task.downloadAsync();
    if (!res || res.status !== 200) {
      throw new Error(`HTTP ${res?.status ?? 'no response'}`);
    }
  } catch (e) {
    throw new ModelError(
      'download-failed',
      'Model download failed. Connect to WiFi once; the model caches forever after.',
      e,
    );
  }

  try {
    onProgress?.('unzipping', 0);
    await unzip(zipPath, documentDirectory);
  } catch (e) {
    throw new ModelError('unzip-failed', 'Could not unzip the model archive.', e);
  } finally {
    await deleteAsync(zipPath, { idempotent: true }).catch(() => undefined);
  }

  const check = await getInfoAsync(`${dir}/am/final.mdl`).catch(() => null);
  if (!check?.exists) {
    throw new ModelError(
      'verify-failed',
      'Model extracted but looks incomplete. Delete app storage and retry on WiFi.',
    );
  }
  onProgress?.('ready', 1);
  return dir;
}

/** Test hook: is there a usable model without downloading? */
export async function hasVoskModel(): Promise<boolean> {
  if (!documentDirectory) return false;
  const info = await getInfoAsync(
    `${documentDirectory}${MODEL_DIR_NAME}/am/final.mdl`,
  ).catch(() => null);
  return info?.exists === true;
}
