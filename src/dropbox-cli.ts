import { $ } from "bun"
import { stat, readdir } from "node:fs/promises"
import { join, basename, dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { apiListFolder } from "./dropbox-api.ts"

export interface FileEntry {
  name: string
  status: string
  isDir: boolean
}

export async function dbxRunning(): Promise<boolean> {
  try {
    const result = await $`dropbox running`.quiet().text()
    if (result.trim() === "1") return true
  } catch {
    // dropbox running sometimes returns non-zero exit code even when running
  }
  // Fallback: check if dropbox process exists
  try {
    const result = await $`pgrep -x dropbox`.quiet().text()
    return result.trim().length > 0
  } catch {
    return false
  }
}

export async function dbxStatus(): Promise<string> {
  try {
    const result = await $`dropbox status`.text()
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
    const result = await $`dropbox exclude list`.text()
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
    const result = await $`dropbox exclude add ${path}`.text()
    return result.trim()
  } catch (e) {
    return `Error: ${e}`
  }
}

export async function dbxExcludeRemove(path: string): Promise<string> {
  try {
    const result = await $`dropbox exclude remove ${path}`.text()
    return result.trim()
  } catch (e) {
    return `Error: ${e}`
  }
}

export async function dbxFileStatus(path: string): Promise<string> {
  try {
    const result = await $`dropbox filestatus ${path}`.text()
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
    const result = await $`dropbox sharelink ${path}`.text()
    return result.trim()
  } catch (e) {
    return `Error: ${e}`
  }
}
