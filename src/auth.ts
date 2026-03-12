import { loadConfig, saveConfig, type Config } from "./config.ts"
import * as readline from "node:readline/promises"

interface TokenResponse {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface RefreshResponse {
  accessToken: string
  expiresAt: number
}

/**
 * Exchange an authorization code for tokens (no-redirect flow).
 */
async function exchangeCode(
  code: string,
  appKey: string,
  appSecret: string,
): Promise<TokenResponse> {
  const tokenRes = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: appKey,
      client_secret: appSecret,
    }),
  })

  if (!tokenRes.ok) {
    const err = await tokenRes.text()
    throw new Error(`Token exchange failed: ${err}`)
  }

  const data = await tokenRes.json() as {
    access_token: string
    refresh_token: string
    expires_in: number
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
}

/**
 * OAuth Authorization Code Flow (manual, no redirect).
 * Prints URL, user authorizes in browser, Dropbox shows code, user pastes it back.
 * Works everywhere — SSH, headless, desktop.
 */
export async function authorize(appKey: string, appSecret: string): Promise<TokenResponse> {
  const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${appKey}&response_type=code&token_access_type=offline`

  console.log("\n┌─────────────────────────────────────────────┐")
  console.log("│  LazyDbx — Dropbox Authorization            │")
  console.log("├─────────────────────────────────────────────┤")
  console.log("│  Open this URL in your browser:             │")
  console.log("└─────────────────────────────────────────────┘")
  console.log(`\n${authUrl}\n`)

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const code = await rl.question("Paste the authorization code here: ")
  rl.close()

  if (!code.trim()) {
    throw new Error("No authorization code provided")
  }

  return exchangeCode(code.trim(), appKey, appSecret)
}

/**
 * Refresh an expired access token using the refresh token.
 */
export async function refreshAccessToken(
  appKey: string,
  appSecret: string,
  refreshToken: string,
): Promise<RefreshResponse> {
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: appKey,
      client_secret: appSecret,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Token refresh failed: ${err}`)
  }

  const data = await res.json() as {
    access_token: string
    expires_in: number
  }

  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
}

/**
 * Only refresh an existing token — never starts an interactive OAuth flow.
 * Safe to call at startup without blocking.
 */
export async function tryRefresh(config: Config): Promise<string | null> {
  if (!config.appKey || !config.appSecret) {
    return null
  }

  // Have a valid token?
  if (config.accessToken && config.expiresAt && config.expiresAt > Date.now() + 60_000) {
    return config.accessToken
  }

  // Try refresh
  if (config.refreshToken) {
    try {
      const refreshed = await refreshAccessToken(config.appKey, config.appSecret, config.refreshToken)
      config.accessToken = refreshed.accessToken
      config.expiresAt = refreshed.expiresAt
      await saveConfig(config)
      return config.accessToken
    } catch {
      return null
    }
  }

  return null
}

/**
 * Ensures we have a valid access token.
 * Refreshes if expired, starts full OAuth if no tokens exist.
 * Returns the access token or null if auth is not configured.
 */
export async function ensureAuth(config: Config): Promise<string | null> {
  if (!config.appKey || !config.appSecret) {
    return null
  }

  // Have a valid token?
  if (config.accessToken && config.expiresAt && config.expiresAt > Date.now() + 60_000) {
    return config.accessToken
  }

  // Try refresh
  if (config.refreshToken) {
    try {
      const refreshed = await refreshAccessToken(config.appKey, config.appSecret, config.refreshToken)
      config.accessToken = refreshed.accessToken
      config.expiresAt = refreshed.expiresAt
      await saveConfig(config)
      return config.accessToken
    } catch {
      // Refresh failed — fall through to full auth
    }
  }

  // Full OAuth flow
  const tokens = await authorize(config.appKey, config.appSecret)
  config.accessToken = tokens.accessToken
  config.refreshToken = tokens.refreshToken
  config.expiresAt = tokens.expiresAt
  await saveConfig(config)
  return config.accessToken
}
