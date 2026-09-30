import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import type { Quote, Sample } from "./types.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Bumped when the file layout changes incompatibly (an old file is ignored with a warning). */
const VERSION = 2;

/**
 * What the history file holds: the hourly rank history behind /v1/climbers
 * and the rank-climb signal, plus the last snapshot. Without it every restart
 * wipes 24h of history and /v1/climbers stays unavailable until it rebuilds.
 */
export interface HistoryState {
  version: number;
  savedAt: number;
  publishedAt: number;
  quotes: Quote[];
  history: Record<string, Sample[]>;
}

/** On disk each sample is a compact [at, rank, price, marketCap, volume24h] tuple, about 3x smaller than objects. */
type Tuple = [number, number, number, number, number];

const pack = (s: Sample): Tuple => [s.at, s.rank, s.price, Math.round(s.marketCap), Math.round(s.volume24h)];
const unpack = ([at, rank, price, marketCap, volume24h]: Tuple): Sample => ({ at, rank, price, marketCap, volume24h });

/** Writes state atomically (temp file + rename) as gzip-compressed JSON; compression runs off the main thread. */
export async function saveHistory(path: string, state: Omit<HistoryState, "version">): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const history: Record<string, Tuple[]> = {};
  for (const [id, ring] of Object.entries(state.history)) history[id] = ring.map(pack);
  const json = JSON.stringify({ version: VERSION, savedAt: state.savedAt, publishedAt: state.publishedAt, quotes: state.quotes, history });
  const tmp = join(dirname(path), `.history-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(tmp, await gzipAsync(json));
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }); // a failed save must not leave a temp file behind (it would repeat every save)
    throw err;
  }
}

/** Removes leftover temp files from saves that were cut off (for example by a kill mid-write). */
export async function cleanStaleTemps(path: string): Promise<number> {
  let removed = 0;
  try {
    for (const name of await readdir(dirname(path))) {
      if (/^\.history-.*\.tmp$/.test(name)) {
        await rm(join(dirname(path), name), { force: true });
        removed++;
      }
    }
  } catch {
    // the directory may not exist yet
  }
  return removed;
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
  const file = JSON.parse((await gunzipAsync(raw)).toString("utf8")) as Omit<HistoryState, "history"> & { history: Record<string, Tuple[]> };
  if (file.version !== VERSION) throw new Error(`history file: unsupported version ${file.version}`);
  const history: Record<string, Sample[]> = {};
  for (const [id, ring] of Object.entries(file.history)) history[id] = ring.map(unpack);
  return { ...file, history };
}
