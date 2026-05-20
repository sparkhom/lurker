import { readFile, writeFile, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(here, "..", "config.json");

const EMPTY = {
  lurkerUrl: "",
  lurkerToken: "",
  lastNetworkId: null,
  lastTarget: "",
  lastDepth: 200,
};

export async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    return { ...EMPTY, ...JSON.parse(raw) };
  } catch (err) {
    if (err.code === "ENOENT") return { ...EMPTY };
    throw err;
  }
}

export async function saveConfig(patch) {
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

export function maskToken(token) {
  if (!token) return "";
  if (token.length <= 8) return "•".repeat(token.length);
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
