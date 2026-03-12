import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

export interface Config {
  appKey?: string
  appSecret?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number // Unix timestamp ms
}

const CONFIG_DIR = join(homedir(), ".config", "lazydbx")
const CONFIG_FILE = join(CONFIG_DIR, "config.json")

export async function loadConfig(): Promise<Config> {
  try {
    const data = await readFile(CONFIG_FILE, "utf-8")
    return JSON.parse(data) as Config
  } catch {
    // File doesn't exist or is invalid — return empty config
    return {}
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8")
}

export function configFilePath(): string {
  return CONFIG_FILE
}
