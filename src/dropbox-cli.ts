import { $ } from "bun"
import { stat, readdir } from "node:fs/promises"
import { realpathSync, openSync, readSync, closeSync } from "node:fs"
import { join, basename, dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { apiListFolder } from "./dropbox-api.ts"

function isElfBinary(filePath: string): boolean {
  try {
    const realPath = realpathSync(filePath)
    const fd = openSync(realPath, "r")
    const buf = Buffer.alloc(4)
    readSync(fd, buf, 0, 4, 0)
    closeSync(fd)
    return buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46
  } catch {
    return false
  }
}

function resolveDropboxCmd(): string {
  // On Arch Linux / Omarchy / CachyOS, the CLI package installs `dropbox-cli` (Python script),
  // while `dropbox` is the desktop GUI client ELF executable.
  // On Ubuntu/Debian, `dropbox` is the Python script CLI.
  // We prefer non-ELF CLI scripts (`dropbox-cli`, `dropbox.py`, or `dropbox`).
  const candidates = ["dropbox-cli", "dropbox.py", "dropbox"]
  for (const cmd of candidates) {
    const path = Bun.which(cmd)
    if (path && !isElfBinary(path)) {
      return cmd
    }
  }
  return Bun.which("dropbox-cli") || "dropbox"
}

export const DROPBOX_CMD = resolveDropboxCmd()

export interface FileEntry {
  name: string
  status: string
  isDir: boolean
}

export async function dbxRunning(): Promise<boolean> {
  // Fast process check first: pgrep is instant (<20ms) and avoids spawning Python/GUI
  try {
    const result = await $`pgrep -x dropbox || pgrep -x dropboxd`.quiet().text()
    if (result.trim().length > 0) return true
  } catch {
    // Process not found
  }

  // Fallback: check via the CLI tool
  try {
    const result = await $`${DROPBOX_CMD} running`.quiet().nothrow()
    if (result.exitCode === 1 || result.text().trim() === "1") return true
  } catch {
    // CLI check failed
  }

  return false
}

export async function dbxStatus(): Promise<string> {
  try {
    const result = await $`${DROPBOX_CMD} status`.text()
    return result.trim()
  } catch {
    return "Unknown"
  }
}

export async function dbxLs(dirPath: string): Promise<FileEntry[]> {
  const resolvedDir = resolve(dirPath)
  const entries: FileEntry[] = []

  try {
    const dirEntries = await readdir(resolvedDir, { withFileTypes: true })
    for (const d of dirEntries) {
      if (d.name === ".dropbox.cache") continue
      entries.push({ name: d.name, status: "", isDir: d.isDirectory() })
    }
  } catch {
    // Directory may not exist
  }

  // Directories first, then alphabetical
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return entries
}

export async function dbxExcludeList(): Promise<string[]> {
  try {
    const result = await $`${DROPBOX_CMD} exclude list`.text()
    const lines = result.trim().split("\n").filter((l) => l.length > 0)
    // First line is often a header like "Excluded:"
    if (lines[0]?.toLowerCase().includes("excluded")) {
      lines.shift()
    }
    // Paths are relative to CWD — resolve to absolute paths
    return lines
      .map((l) => resolve(l.trim()))
      .filter((l) => l.length > 0)
  } catch {
    return []
  }
}

export async function dbxExcludeAdd(path: string): Promise<string> {
  try {
    const result = await $`${DROPBOX_CMD} exclude add ${path}`.text()
    return result.trim()
  } catch (e) {
    return `Error: ${e}`
  }
}

export async function dbxExcludeRemove(path: string): Promise<string> {
  try {
    const result = await $`${DROPBOX_CMD} exclude remove ${path}`.text()
    return result.trim()
  } catch (e) {
    return `Error: ${e}`
  }
}

export async function dbxFileStatus(path: string): Promise<string> {
  try {
    const result = await $`${DROPBOX_CMD} filestatus ${path}`.text()
    return result.trim()
  } catch (e) {
    return `Error: ${e}`
  }
}

export type SyncState = "synced" | "partial" | "excluded"

export interface ServerEntry {
  name: string
  path: string
  syncState: SyncState
  isDir: boolean
}

const DROPBOX_HOME = join(homedir(), "Dropbox")

/**
 * List all entries at one level for the Server tab.
 * Uses Dropbox HTTP API when accessToken is available (shows fully excluded folders too).
 * Falls back to local readdir + exclude list otherwise.
 */
export async function dbxServerLs(dirPath: string, accessToken?: string): Promise<ServerEntry[]> {
  if (accessToken) {
    return dbxServerLsApi(dirPath, accessToken)
  }
  return dbxServerLsLocal(dirPath)
}

async function dbxServerLsApi(dirPath: string, accessToken: string): Promise<ServerEntry[]> {
  const excludedPaths = await dbxExcludeList()
  const excludedSet = new Set(excludedPaths)
  const resolvedDir = resolve(dirPath)

  // Convert local path to Dropbox API path
  // ~/Dropbox → "", ~/Dropbox/Documents → /Documents
  let apiPath = ""
  if (resolvedDir !== resolve(DROPBOX_HOME)) {
    apiPath = resolvedDir.replace(resolve(DROPBOX_HOME), "")
  }

  // Check if current directory itself (or a parent) is excluded
  const parentExcluded = excludedPaths.some(
    (p) => resolvedDir === p || resolvedDir.startsWith(p + "/"),
  )

  const apiEntries = await apiListFolder(accessToken, apiPath)

  const entries: ServerEntry[] = apiEntries.map((e) => {
    const fullP = join(DROPBOX_HOME, e.pathDisplay)
    let syncState: SyncState = parentExcluded ? "excluded" : "synced"
    if (!parentExcluded && e.isDir) {
      if (excludedSet.has(fullP)) {
        syncState = "excluded"
      } else {
        const hasExcludedChild = excludedPaths.some((p) => p.startsWith(fullP + "/"))
        syncState = hasExcludedChild ? "partial" : "synced"
      }
    }
    return { name: e.name, path: fullP, syncState, isDir: e.isDir }
  })

  // Directories first, then alphabetical
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return entries
}

async function dbxServerLsLocal(dirPath: string): Promise<ServerEntry[]> {
  const excludedPaths = await dbxExcludeList()
  const resolvedDir = resolve(dirPath)
  const excludedSet = new Set(excludedPaths)
  const entries: ServerEntry[] = []
  const seen = new Set<string>()

  // 1. Read local entries (directories + files)
  try {
    const dirEntries = await readdir(resolvedDir, { withFileTypes: true })
    for (const d of dirEntries) {
      if (d.name === ".dropbox.cache") continue
      const fullP = resolve(resolvedDir, d.name)
      const isDir = d.isDirectory()
      let syncState: SyncState = "synced"
      if (isDir) {
        if (excludedSet.has(fullP)) {
          syncState = "excluded"
        } else {
          // Check if children are excluded → partial
          const hasExcludedChild = excludedPaths.some((p) => p.startsWith(fullP + "/"))
          syncState = hasExcludedChild ? "partial" : "synced"
        }
      }
      entries.push({ name: d.name, path: fullP, syncState, isDir })
      seen.add(d.name)
    }
  } catch {
    // Directory may not exist (e.g. fully excluded)
  }

  // 2. Add excluded directories that exist at this level but not locally
  for (const exPath of excludedPaths) {
    const parent = dirname(exPath)
    if (parent === resolvedDir) {
      const name = basename(exPath)
      if (!seen.has(name)) {
        entries.push({ name, path: exPath, syncState: "excluded", isDir: true })
      }
    }
  }

  // Directories first, then alphabetical
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return entries
}

export async function dbxShareLink(path: string): Promise<string> {
  try {
    const result = await $`${DROPBOX_CMD} sharelink ${path}`.text()
    return result.trim()
  } catch (e) {
    return `Error: ${e}`
  }
}
