import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import type { Quote, Sample } from "./types.js";

const VERSION = 1;

/**
 * What the history file holds: the hourly rank history behind /v1/climbers
 * and the rank-climb signal, plus the last snapshot. Without it every restart
 * wipes 24h of history (the Telegram bot's digest kept saying "not enough
 * history yet" for exactly this reason).
 */
export interface HistoryState {
  version: number;
  savedAt: number;
  publishedAt: number;
  quotes: Quote[];
  history: Record<string, Sample[]>;
}

/** Writes state atomically (temp file + rename), gzip-compressed JSON. */
export async function saveHistory(path: string, state: Omit<HistoryState, "version">): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.history-${process.pid}-${Date.now()}.tmp`);
  await writeFile(tmp, gzipSync(JSON.stringify({ version: VERSION, ...state })));
  await rename(tmp, path);
}

/** Reads the saved state; undefined when the file does not exist. */
export async function loadHistory(path: string): Promise<HistoryState | undefined> {
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const state = JSON.parse(gunzipSync(raw).toString("utf8")) as HistoryState;
  if (state.version !== VERSION) throw new Error(`history file: unsupported version ${state.version}`);
  return state;
}
