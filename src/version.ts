import { readFileSync } from "node:fs";

/** The package.json version, found from both src/ (tsx) and dist/src/ (built) locations. */
export function readVersion(): string {
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "100xaltcoin" && pkg.version) return pkg.version;
    } catch {
      // try the next location
    }
  }
  return "dev";
}
