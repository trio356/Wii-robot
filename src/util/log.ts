import { documentDirectory, writeAsStringAsync } from 'expo-file-system/legacy';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  t: number; // epoch ms
  level: LogLevel;
  tag: string; // 'audio' | 'robot' | 'ai' | 'eyes' | ...
  msg: string;
}

const CAPACITY = 300;

/**
 * In-memory ring buffer for field diagnostics. log() also mirrors to
 * console (same call sites, no double instrumentation). exportLog() writes
 * timestamped JSON to app storage — pull it with
 * `adb pull /data/data/com.wii.robot/files/wii-log-<ts>.json`.
 */
const buf: LogEntry[] = [];

export function log(level: LogLevel, tag: string, msg: string): void {
  buf.push({ t: Date.now(), level, tag, msg });
  if (buf.length > CAPACITY) buf.splice(0, buf.length - CAPACITY);
  const line = `[${tag}] ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function getLogs(): LogEntry[] {
  return [...buf];
}

export function clearLogs(): void {
  buf.length = 0;
}

export async function exportLog(): Promise<string> {
  if (!documentDirectory) throw new Error('No app storage.');
  const name = `wii-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const path = `${documentDirectory}${name}`;
  await writeAsStringAsync(path, JSON.stringify(getLogs(), null, 1));
  return path;
}
