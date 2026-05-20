import { readFile, writeFile, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// fileURLToPath (not URL.pathname) so a repo path containing spaces or other
// URL-escaped characters still resolves to a real filesystem path.
const CONFIG_PATH = fileURLToPath(new URL("../config.json", import.meta.url));

export interface Config {
  lurkerUrl: string;
  lurkerToken: string;
  lastNetworkId: number | null;
  lastTarget: string;
  lastDepth: number;
}

const EMPTY: Config = {
  lurkerUrl: "",
  lurkerToken: "",
  lastNetworkId: null,
  lastTarget: "",
  lastDepth: 200,
};

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    return { ...EMPTY, ...(JSON.parse(raw) as Partial<Config>) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY };
    throw err;
  }
}

export async function saveConfig(patch: Partial<Config>): Promise<Config> {
  const current = await loadConfig();
  const next = { ...current, ...patch };
  // config.json holds the Lurker API token — keep it owner-only. The mode on
  // writeFile only applies when the file is created, so chmod afterwards to
  // also tighten a file that already existed.
  await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(CONFIG_PATH, 0o600);
  return next;
}

export function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 8) return "•".repeat(token.length);
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
