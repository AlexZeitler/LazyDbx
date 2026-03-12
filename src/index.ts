#!/usr/bin/env bun

import {
  createCliRenderer,
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type KeyEvent,
  t,
  bold,
  dim,
  fg,
} from "@opentui/core"
import {
  dbxRunning,
  dbxStatus,
  dbxLs,
  dbxExcludeAdd,
  dbxExcludeRemove,
  dbxExcludeList,
  dbxFileStatus,
  dbxShareLink,
  dbxServerLs,
  type FileEntry,
  type ServerEntry,
} from "./dropbox-cli.ts"
import { loadConfig, saveConfig, configFilePath, type Config } from "./config.ts"
import { ensureAuth, authorize, tryRefresh } from "./auth.ts"
import { $ } from "bun"
import { homedir } from "node:os"
import { join } from "node:path"

// --- Colors (Tokyo Night) ---
const C = {
  bg: "#1a1b26",
  panel: "#16161e",
  sel: "#2a2d3e",
  border: "#3b4261",
  accent: "#7aa2f7",
  green: "#9ece6a",
  yellow: "#e0af68",
  red: "#f7768e",
  muted: "#565f89",
  white: "#c0caf5",
  cyan: "#7dcfff",
  purple: "#bb9af7",
}

// --- State ---
interface State {
  running: boolean
  status: string
  activeTab: "local" | "server"
  currentPath: string
  serverPath: string
  entries: FileEntry[]
  serverEntries: ServerEntry[]
  localIndex: number
  serverIndex: number
  lastLink: string
}

const DROPBOX_HOME = join(homedir(), "Dropbox")

let appConfig: Config = {}
let accessToken: string | null = null

const state: State = {
  running: false,
  status: "Loading...",
  activeTab: "local",
  currentPath: "",
  serverPath: "",
  entries: [],
  serverEntries: [],
  localIndex: 0,
  serverIndex: 0,
  lastLink: "",
}

// --- Renderer ---
let renderer: CliRenderer
let root: BoxRenderable
let header: BoxRenderable
let tabBar: BoxRenderable
let contentArea: BoxRenderable
let listPanel: BoxRenderable
let detailPanel: BoxRenderable
let statusbar: BoxRenderable

let localSelect: SelectRenderable | null = null
let serverSelect: SelectRenderable | null = null

// --- Helpers ---
async function copyToClipboard(text: string): Promise<void> {
  try {
    // Wayland
    await $`echo -n ${text} | wl-copy`.quiet()
    return
  } catch {}
  try {
    // X11
    await $`echo -n ${text} | xclip -selection clipboard`.quiet()
    return
  } catch {}
  try {
    // macOS
    await $`echo -n ${text} | pbcopy`.quiet()
  } catch {}
}

function fullPath(relativePath: string): string {
  return relativePath ? join(DROPBOX_HOME, relativePath) : DROPBOX_HOME
}

function displayPath(): string {
  const p = state.activeTab === "local" ? state.currentPath : state.serverPath
  return p ? `~/Dropbox/${p}` : "~/Dropbox/"
}

// --- Build UI ---
function buildLayout() {
  const W = renderer.width
  const H = renderer.height
  const detailW = 38
  const listW = W - detailW

  // Root
  root = new BoxRenderable(renderer, {
    id: "root",
    flexDirection: "column",
    width: "100%" as any,
    height: "100%" as any,
    backgroundColor: C.bg,
  })
  renderer.root.add(root)

  // Header
  header = new BoxRenderable(renderer, {
    id: "header",
    height: 3,
    width: "100%" as any,
    backgroundColor: C.panel,
    border: true,
    borderStyle: "rounded",
    borderColor: C.border,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 2,
    paddingRight: 2,
    gap: 2,
  })
  const hdrTitle = new TextRenderable(renderer, {
    id: "hdr-title",
    content: t`${bold(fg(C.accent)("LazyDbx"))}`,
  })
  const hdrSep1 = new TextRenderable(renderer, {
    id: "hdr-sep1",
    content: t`${fg(C.border)("│")}`,
  })
  const hdrStatus = new TextRenderable(renderer, {
    id: "hdr-status",
    content: t`${fg(C.yellow)("loading...")}`,
  })
  const hdrSep2 = new TextRenderable(renderer, {
    id: "hdr-sep2",
    content: t`${fg(C.border)("│")}`,
  })
  const hdrPath = new TextRenderable(renderer, {
    id: "hdr-path",
    content: t`${fg(C.white)(displayPath())}`,
  })
  header.add(hdrTitle)
  header.add(hdrSep1)
  header.add(hdrStatus)
  header.add(hdrSep2)
  header.add(hdrPath)
  root.add(header)

  // TabBar
  tabBar = new BoxRenderable(renderer, {
    id: "tab-bar",
    height: 3,
    width: "100%" as any,
    backgroundColor: C.panel,
    border: true,
    borderStyle: "rounded",
    borderColor: C.border,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 2,
    gap: 2,
  })
  const tabLocal = new TextRenderable(renderer, {
    id: "tab-local",
    content: t`${fg(C.accent)("[> Local ]")}`,
  })
  const tabServer = new TextRenderable(renderer, {
    id: "tab-server",
    content: t`${fg(C.muted)("[ Server ]")}`,
  })
  tabBar.add(tabLocal)
  tabBar.add(tabServer)
  root.add(tabBar)

  // Content area (row: list + detail)
  contentArea = new BoxRenderable(renderer, {
    id: "content-area",
    flexDirection: "row",
    flexGrow: 1,
    width: "100%" as any,
  })

  // List panel
  listPanel = new BoxRenderable(renderer, {
    id: "list-panel",
    width: listW,
    border: true,
    borderStyle: "rounded",
    borderColor: C.border,
    backgroundColor: C.bg,
    flexDirection: "column",
  })

  // Detail panel
  detailPanel = new BoxRenderable(renderer, {
    id: "detail-panel",
    width: detailW,
    border: true,
    borderStyle: "rounded",
    borderColor: C.border,
    backgroundColor: C.bg,
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 1,
  })
  const detailTitle = new TextRenderable(renderer, {
    id: "detail-title",
    content: t`${bold(fg(C.white)("Details"))}`,
  })
  const detailName = new TextRenderable(renderer, {
    id: "detail-name",
    content: t`${fg(C.muted)("")}`,
  })
  const detailStatus = new TextRenderable(renderer, {
    id: "detail-status",
    content: t`${fg(C.muted)("")}`,
  })
  const detailHint = new TextRenderable(renderer, {
    id: "detail-hint",
    content: t`${fg(C.muted)("")}`,
  })
  detailPanel.add(detailTitle)
  detailPanel.add(detailName)
  detailPanel.add(detailStatus)
  detailPanel.add(detailHint)

  contentArea.add(listPanel)
  contentArea.add(detailPanel)
  root.add(contentArea)

  // Statusbar
  statusbar = new BoxRenderable(renderer, {
    id: "statusbar",
    height: 3,
    width: "100%" as any,
    backgroundColor: C.panel,
    border: true,
    borderStyle: "rounded",
    borderColor: C.border,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 2,
    paddingRight: 2,
    justifyContent: "space-between",
  })
  const statusHints = new TextRenderable(renderer, {
    id: "status-hints",
    content: getStatusHints(),
  })
  const statusVersion = new TextRenderable(renderer, {
    id: "status-version",
    content: t`${dim("lazydbx v0.1.0")}`,
  })
  statusbar.add(statusHints)
  statusbar.add(statusVersion)
  root.add(statusbar)
}

// --- Update functions ---
function updateHeader() {
  const statusNode = renderer.root.findDescendantById("hdr-status") as TextRenderable | null
  const pathNode = renderer.root.findDescendantById("hdr-path") as TextRenderable | null

  if (statusNode) {
    if (!state.running) {
      statusNode.content = t`${fg(C.red)("not running")}`
    } else {
      const color = state.status.toLowerCase().includes("up to date") ? C.green : C.yellow
      statusNode.content = t`${fg(color)(state.status)}`
    }
  }
  if (pathNode) {
    pathNode.content = t`${fg(C.white)(displayPath())}`
  }
}

function updateTabBar() {
  const localNode = renderer.root.findDescendantById("tab-local") as TextRenderable | null
  const serverNode = renderer.root.findDescendantById("tab-server") as TextRenderable | null

  if (localNode) {
    localNode.content = state.activeTab === "local"
      ? t`${fg(C.accent)("[> Local ]")}`
      : t`${fg(C.muted)("[ Local ]")}`
  }
  if (serverNode) {
    serverNode.content = state.activeTab === "server"
      ? t`${fg(C.accent)("[> Server ]")}`
      : t`${fg(C.muted)("[ Server ]")}`
  }
}

function getStatusHints() {
  if (state.activeTab === "local") {
    return t`${fg(C.muted)("Tab · j/k · Enter open · u up · e excl · s share · y copy · f status · r refresh · q quit")}`
  }
  return t`${fg(C.muted)("Tab switch · j/k nav · Enter open · u up · Space toggle · s share · y copy · a auth · r refresh · q quit")}`
}

function updateStatusbar() {
  const hintsNode = renderer.root.findDescendantById("status-hints") as TextRenderable | null
  if (hintsNode) {
    hintsNode.content = getStatusHints()
  }
}

function updateDetail() {
  const nameNode = renderer.root.findDescendantById("detail-name") as TextRenderable | null
  const statusNode = renderer.root.findDescendantById("detail-status") as TextRenderable | null
  const hintNode = renderer.root.findDescendantById("detail-hint") as TextRenderable | null

  if (!nameNode || !statusNode || !hintNode) return

  if (state.activeTab === "local") {
    const entry = state.entries[state.localIndex]
    if (entry) {
      nameNode.content = t`${bold(fg(C.white)(entry.name))}`
      const statusColor = entry.status.toLowerCase().includes("up to date") ? C.green : C.yellow
      statusNode.content = t`${fg(statusColor)(`sync: ${entry.status}`)}`
      hintNode.content = entry.isDir
        ? t`${fg(C.muted)("Enter → open · e → exclude")}`
        : t`${fg(C.muted)("s → share · f → status")}`
    } else {
      nameNode.content = t`${fg(C.muted)("")}`
      statusNode.content = t`${fg(C.muted)("")}`
      hintNode.content = t`${fg(C.muted)("")}`
    }
  } else {
    const entry = state.serverEntries[state.serverIndex]
    if (entry) {
      nameNode.content = t`${bold(fg(C.white)(entry.name))}`
      if (entry.isDir) {
        const syncLabels = { synced: "synced locally", partial: "partially synced", excluded: "excluded from sync" }
        const syncColors = { synced: C.green, partial: C.yellow, excluded: C.red }
        statusNode.content = t`${fg(syncColors[entry.syncState])(syncLabels[entry.syncState])}`
        hintNode.content = t`${fg(C.muted)("Enter → open · Space → toggle")}`
      } else {
        const syncLabels = { synced: "synced locally", partial: "synced locally", excluded: "excluded from sync" }
        const syncColors = { synced: C.green, partial: C.green, excluded: C.red }
        statusNode.content = t`${fg(syncColors[entry.syncState])(syncLabels[entry.syncState])}`
        hintNode.content = t`${fg(C.muted)("Space → toggle sync")}`
      }
    } else {
      nameNode.content = t`${fg(C.muted)("")}`
      statusNode.content = accessToken
        ? t`${fg(C.muted)("")}`
        : t`${fg(C.yellow)("CLI fallback — a → auth for full API")}`
      hintNode.content = t`${fg(C.muted)("")}`
    }
  }
}

// --- SelectRenderable management ---
function buildLocalSelect() {
  if (localSelect) {
    localSelect.destroy()
    localSelect = null
  }
  if (serverSelect) {
    serverSelect.destroy()
    serverSelect = null
  }

  const H = renderer.height
  const W = renderer.width
  const detailW = 38
  const listW = W - detailW - 4

  localSelect = new SelectRenderable(renderer, {
    id: "local-select",
    width: listW,
    height: H - 12,
    options: state.entries.map((e) => ({
      name: `${e.isDir ? "▶" : "·"} ${e.name}`,
      description: `  ${e.status}`,
    })),
    backgroundColor: C.bg,
    selectedBackgroundColor: C.sel,
    selectedTextColor: C.cyan,
    showDescription: true,
    showScrollIndicator: true,
    wrapSelection: true,
  })

  localSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (i: number) => {
    state.localIndex = i
    updateDetail()
  })

  listPanel.add(localSelect)
  if (state.activeTab === "local") {
    localSelect.focus()
  }
}

function buildServerSelect() {
  if (serverSelect) {
    serverSelect.destroy()
    serverSelect = null
  }
  if (localSelect) {
    localSelect.destroy()
    localSelect = null
  }

  const H = renderer.height
  const W = renderer.width
  const detailW = 38
  const listW = W - detailW - 4

  serverSelect = new SelectRenderable(renderer, {
    id: "server-select",
    width: listW,
    height: H - 12,
    options: state.serverEntries.map((e) => {
      const check = e.syncState === "synced" ? "[x]" : e.syncState === "partial" ? "[~]" : "[ ]"
      const icon = e.isDir ? "▶" : "·"
      const statusLabel = e.syncState === "synced" ? "synced" : e.syncState === "partial" ? "partial" : "excluded"
      return { name: `${check} ${icon} ${e.name}`, description: `  ${statusLabel}` }
    }),
    backgroundColor: C.bg,
    selectedBackgroundColor: C.sel,
    selectedTextColor: C.cyan,
    showDescription: true,
    showScrollIndicator: true,
    wrapSelection: true,
  })

  serverSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (i: number) => {
    state.serverIndex = i
    updateDetail()
  })

  listPanel.add(serverSelect)
  if (state.activeTab === "server") {
    serverSelect.focus()
  }
}

// --- Data loading ---
async function loadLocalEntries() {
  const path = fullPath(state.currentPath)
  state.entries = await dbxLs(path)
  state.localIndex = 0
}

async function loadServerEntries() {
  // Refresh token if needed before API call (never starts interactive OAuth)
  if (appConfig.appKey && appConfig.appSecret) {
    accessToken = await tryRefresh(appConfig)
  }
  const dirPath = fullPath(state.serverPath)
  state.serverEntries = await dbxServerLs(dirPath, accessToken ?? undefined)
  state.serverIndex = 0
}

async function refresh() {
  state.running = await dbxRunning()
  state.status = state.running ? await dbxStatus() : "not running"
  updateHeader()

  if (state.activeTab === "local") {
    await loadLocalEntries()
    buildLocalSelect()
  } else {
    await loadServerEntries()
    buildServerSelect()
  }
  updateDetail()
}

// --- Tab switching ---
async function switchTab() {
  state.activeTab = state.activeTab === "local" ? "server" : "local"
  updateTabBar()
  updateStatusbar()
  updateHeader()

  if (state.activeTab === "local") {
    await loadLocalEntries()
    buildLocalSelect()
  } else {
    await loadServerEntries()
    buildServerSelect()
  }
  updateDetail()
}

// --- Key handling ---
function setupKeyboard() {
  renderer.keyInput.on("keypress", async (key: KeyEvent) => {
    // Global keys
    if (key.name === "q") {
      renderer.destroy()
      process.exit(0)
    }
    if (key.name === "r") {
      await refresh()
      return
    }
    if (key.name === "tab") {
      switchTab()
      return
    }

    // Local-Tab keys
    if (state.activeTab === "local") {
      if (key.name === "return") {
        const entry = state.entries[state.localIndex]
        if (entry?.isDir) {
          state.currentPath = state.currentPath
            ? join(state.currentPath, entry.name)
            : entry.name
          await loadLocalEntries()
          buildLocalSelect()
          updateHeader()
          updateDetail()
        } else if (entry) {
          const path = fullPath(
            state.currentPath ? join(state.currentPath, entry.name) : entry.name,
          )
          await $`xdg-open ${path}`.quiet()
        }
        return
      }
      if (key.name === "u") {
        if (state.currentPath) {
          const parts = state.currentPath.split("/")
          parts.pop()
          state.currentPath = parts.join("/")
          await loadLocalEntries()
          buildLocalSelect()
          updateHeader()
          updateDetail()
        }
        return
      }
      if (key.name === "e") {
        const entry = state.entries[state.localIndex]
        if (entry?.isDir) {
          const path = fullPath(
            state.currentPath ? join(state.currentPath, entry.name) : entry.name,
          )
          await dbxExcludeAdd(path)
          await refresh()
        }
        return
      }
      if (key.name === "s") {
        const entry = state.entries[state.localIndex]
        if (entry) {
          const path = fullPath(
            state.currentPath ? join(state.currentPath, entry.name) : entry.name,
          )
          const link = await dbxShareLink(path)
          state.lastLink = link
          const hintNode = renderer.root.findDescendantById("detail-hint") as TextRenderable | null
          if (hintNode) {
            hintNode.content = t`${fg(C.cyan)(`${link}  (y → copy)`)}`
          }
        }
        return
      }
      if (key.name === "y") {
        if (state.lastLink) {
          await copyToClipboard(state.lastLink)
          const hintNode = renderer.root.findDescendantById("detail-hint") as TextRenderable | null
          if (hintNode) {
            hintNode.content = t`${fg(C.green)("Copied!")}`
          }
        }
        return
      }
      if (key.name === "f") {
        const entry = state.entries[state.localIndex]
        if (entry) {
          const path = fullPath(
            state.currentPath ? join(state.currentPath, entry.name) : entry.name,
          )
          const status = await dbxFileStatus(path)
          const statusNode = renderer.root.findDescendantById("detail-status") as TextRenderable | null
          if (statusNode) {
            statusNode.content = t`${fg(C.cyan)(status)}`
          }
        }
        return
      }
    }

    // Server-Tab keys
    if (state.activeTab === "server") {
      if (key.name === "return") {
        const entry = state.serverEntries[state.serverIndex]
        if (entry?.isDir) {
          state.serverPath = state.serverPath
            ? join(state.serverPath, entry.name)
            : entry.name
          await loadServerEntries()
          buildServerSelect()
          updateHeader()
          updateDetail()
        } else if (entry) {
          if (entry.syncState === "excluded") {
            const hintNode = renderer.root.findDescendantById("detail-hint") as TextRenderable | null
            if (hintNode) {
              hintNode.content = t`${fg(C.yellow)("Not synced — Space to toggle sync")}`
            }
          } else {
            await $`xdg-open ${entry.path}`.quiet()
          }
        }
        return
      }
      if (key.name === "u") {
        if (state.serverPath) {
          const parts = state.serverPath.split("/")
          parts.pop()
          state.serverPath = parts.join("/")
          await loadServerEntries()
          buildServerSelect()
          updateHeader()
          updateDetail()
        }
        return
      }
      if (key.name === "space") {
        const entry = state.serverEntries[state.serverIndex]
        if (entry) {
          if (entry.isDir) {
            if (entry.syncState === "excluded") {
              await dbxExcludeRemove(entry.path)
            } else {
              await dbxExcludeAdd(entry.path)
            }
          } else {
            const excludedPaths = await dbxExcludeList()
            if (entry.syncState === "excluded") {
              const excludedParent = excludedPaths.find(
                (p) => entry.path.startsWith(p + "/"),
              )
              if (excludedParent) {
                await dbxExcludeRemove(excludedParent)
              }
            } else {
              const { dirname } = await import("node:path")
              const parentDir = dirname(entry.path)
              await dbxExcludeAdd(parentDir)
            }
          }
          await loadServerEntries()
          buildServerSelect()
          updateDetail()
        }
        return
      }
      if (key.name === "a") {
        const hintNode = renderer.root.findDescendantById("detail-hint") as TextRenderable | null
        const statusNode = renderer.root.findDescendantById("detail-status") as TextRenderable | null
        if (!appConfig.appKey || !appConfig.appSecret) {
          if (hintNode) {
            hintNode.content = t`${fg(C.red)("Set appKey & appSecret in ~/.config/lazydbx/config.json")}`
          }
        } else if (accessToken) {
          if (hintNode) {
            hintNode.content = t`${fg(C.green)("Already authorized. Run 'lazydbx auth' to re-authorize.")}`
          }
        } else {
          if (statusNode) {
            statusNode.content = t`${fg(C.yellow)("Run: lazydbx auth")}`
          }
          if (hintNode) {
            hintNode.content = t`${fg(C.muted)("Then restart the app to use the API.")}`
          }
        }
        return
      }
      if (key.name === "s") {
        const entry = state.serverEntries[state.serverIndex]
        if (entry && accessToken) {
          const hintNode = renderer.root.findDescendantById("detail-hint") as TextRenderable | null
          try {
            const { apiShareLink } = await import("./dropbox-api.ts")
            const dropboxPath = entry.path.replace(DROPBOX_HOME, "")
            const link = await apiShareLink(accessToken, dropboxPath)
            state.lastLink = link
            if (hintNode) {
              hintNode.content = t`${fg(C.cyan)(`${link}  (y → copy)`)}`
            }
          } catch (e) {
            if (hintNode) {
              hintNode.content = t`${fg(C.red)(`Share failed: ${e}`)}`
            }
          }
        }
        return
      }
      if (key.name === "y") {
        if (state.lastLink) {
          await copyToClipboard(state.lastLink)
          const hintNode = renderer.root.findDescendantById("detail-hint") as TextRenderable | null
          if (hintNode) {
            hintNode.content = t`${fg(C.green)("Copied!")}`
          }
        }
        return
      }
    }
  })
}

// --- Main ---
async function main() {
  renderer = await createCliRenderer({
    exitOnCtrlC: true,
  })

  try {
    // Load config — only refresh existing tokens, never start full OAuth here
    appConfig = await loadConfig()
    if (appConfig.appKey && appConfig.appSecret) {
      accessToken = await tryRefresh(appConfig)
    }

    buildLayout()
    setupKeyboard()

    // Initial data load
    state.running = await dbxRunning()
    state.status = state.running ? await dbxStatus() : "not running"
    updateHeader()

    await loadLocalEntries()
    buildLocalSelect()
    updateDetail()
  } catch (err) {
    renderer.destroy()
    console.error("Failed to start lazydbx:", err)
    process.exit(1)
  }
}

// --- CLI subcommands ---
async function authCommand(force: boolean) {
  const config = await loadConfig()
  if (!config.appKey || !config.appSecret) {
    console.error("Set appKey and appSecret in ~/.config/lazydbx/config.json first.")
    process.exit(1)
  }

  if (force) {
    // Clear existing tokens to force re-authorization
    config.accessToken = undefined
    config.refreshToken = undefined
    config.expiresAt = undefined
    await saveConfig(config)
  }

  try {
    const token = await ensureAuth(config)
    if (token) {
      console.log("Authorization successful! You can now start lazydbx.")
    }
  } catch (e) {
    console.error("Authorization failed:", e)
    process.exit(1)
  }
}

async function initCommand() {
  const readline = await import("node:readline/promises")
  const existing = await loadConfig()

  if (existing.appKey && existing.appSecret) {
    console.log(`Config already exists at ${configFilePath()}`)
    console.log(`  appKey:    ${existing.appKey}`)
    console.log(`  appSecret: ${existing.appSecret.slice(0, 4)}...`)
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question("Overwrite? (y/N) ")
    rl.close()
    if (answer.trim().toLowerCase() !== "y") {
      process.exit(0)
    }
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log("\n┌─────────────────────────────────────────────┐")
  console.log("│  LazyDbx — Setup                            │")
  console.log("├─────────────────────────────────────────────┤")
  console.log("│  Create a Dropbox App at:                   │")
  console.log("│  https://www.dropbox.com/developers/apps    │")
  console.log("│  (Scoped access, Full Dropbox)              │")
  console.log("│                                             │")
  console.log("│  Required scopes (Permissions tab):         │")
  console.log("│    account_info.read                        │")
  console.log("│    files.metadata.read                      │")
  console.log("│    sharing.write                            │")
  console.log("└─────────────────────────────────────────────┘\n")

  const appKey = await rl.question("App Key: ")
  const appSecret = await rl.question("App Secret: ")
  rl.close()

  if (!appKey.trim() || !appSecret.trim()) {
    console.error("App Key and App Secret are required.")
    process.exit(1)
  }

  const config: Config = { appKey: appKey.trim(), appSecret: appSecret.trim() }
  await saveConfig(config)
  console.log(`\nConfig saved to ${configFilePath()}`)
  console.log("Next: run 'lazydbx auth' to authorize with Dropbox.")
}

if (process.argv.includes("init")) {
  initCommand()
} else if (process.argv.includes("auth")) {
  const force = process.argv.includes("--force")
  authCommand(force)
} else {
  main()
}
