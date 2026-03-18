import { join } from "path"
import { homedir } from "os"
import { existsSync, readFileSync } from "fs"
import { parse } from "smol-toml"

export interface Theme {
  bg: string
  panel: string
  sel: string
  border: string
  accent: string
  green: string
  yellow: string
  red: string
  muted: string
  white: string
  cyan: string
  purple: string
}

const DEFAULT_THEME: Theme = {
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

function loadOmarchyColors(): Partial<Theme> | null {
  const colorsPath = join(
    homedir(),
    ".config",
    "omarchy",
    "current",
    "theme",
    "colors.toml",
  )
  if (!existsSync(colorsPath)) return null

  try {
    const raw = readFileSync(colorsPath, "utf-8")
    const colors = parse(raw) as Record<string, string>

    return {
      bg: colors.background,
      panel: colors.background,
      sel: colors.selection_background,
      border: colors.color7,
      accent: colors.accent,
      green: colors.color2,
      yellow: colors.color3,
      red: colors.color1,
      muted: colors.color7,
      white: colors.foreground,
      cyan: colors.color6,
      purple: colors.color5,
    }
  } catch {
    return null
  }
}

function loadConfigTheme(
  configTheme: Record<string, string> | undefined,
): Partial<Theme> | null {
  if (!configTheme || Object.keys(configTheme).length === 0) return null
  return configTheme as unknown as Partial<Theme>
}

export function loadTheme(configTheme?: Record<string, string>): Theme {
  const omarchy = loadOmarchyColors()
  const config = loadConfigTheme(configTheme)

  return {
    ...DEFAULT_THEME,
    ...(omarchy ?? {}),
    ...(config ?? {}),
  }
}
