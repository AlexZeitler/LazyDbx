# LazyDbx

A terminal UI for the Dropbox desktop client, built with [OpenTUI](https://opentui.com/) and Bun.

Browse your local and remote Dropbox files, manage sync exclusions, and share links — all from the terminal.

## Requirements

- [Bun](https://bun.sh) v1+
- Dropbox desktop client installed and running (`dropbox start`)
- A [Dropbox App](https://www.dropbox.com/developers/apps) for API access (optional, enables Server tab — see below)

## Install

Global install (no source checkout needed):

```bash
bun install -g github:alexzeitler/lazydbx
```

### From Source

```bash
git clone https://github.com/alexzeitler/lazydbx.git
cd lazydbx
bun install
```

## Setup

Each user creates their own Dropbox App. The app credentials and tokens stay on your machine (`~/.config/lazydbx/config.json`) and all API requests go directly from your computer to Dropbox — no third-party servers involved.

### 1. Create a Dropbox App

Go to https://www.dropbox.com/developers/apps and create a new app:

- **Access type**: Scoped access, Full Dropbox
- **Permissions tab**: Enable `account_info.read` and `files.metadata.read`

### 2. Initialize config

```bash
lazydbx init
```

Prompts for your App Key and App Secret, saves them to `~/.config/lazydbx/config.json`.

### 3. Authorize

```bash
lazydbx auth
```

Opens the Dropbox authorization URL. Copy the code from the Dropbox page and paste it back into the terminal. Tokens are saved automatically.

To re-authorize (e.g. after changing scopes):

```bash
lazydbx auth --force
```

### 4. Run

```bash
lazydbx
```
## Tabs

### Local

Browse files and folders synced locally in `~/Dropbox`.

### Server

Browse the full Dropbox folder structure via the API. The local `dropbox` CLI can only list files that are synced locally — excluded folders and their contents are invisible. The Server tab uses the Dropbox HTTP API to fetch the complete folder structure directly from the server, including folders and files that have never been synced to this machine. This requires a configured Dropbox App (see Setup). Without it, the Server tab falls back to the local filesystem + exclude list.

## Keybindings

### Global

| Key   | Action                          |
| ----- | ------------------------------- |
| `Tab` | Switch between Local and Server |
| `r`   | Refresh                         |
| `q`   | Quit                            |

### Local tab

| Key     | Action                   |
| ------- | ------------------------ |
| `j`/`k` | Navigate up/down         |
| `Enter` | Open folder or file      |
| `u`     | Go up one directory      |
| `e`     | Exclude folder from sync |
| `s`     | Get share link           |
| `y`     | Copy last share link     |
| `f`     | Show file sync status    |

### Server tab

| Key     | Action                          |
| ------- | ------------------------------- |
| `j`/`k` | Navigate up/down                |
| `Enter` | Open folder (or file if synced) |
| `u`     | Go up one directory             |
| `Space` | Toggle sync (exclude/include)   |
| `a`     | Show auth status                |

> **Note**: `dropbox exclude` only works at the folder level. Toggling sync on a file toggles the parent excluded folder.

## Config

Stored at `~/.config/lazydbx/config.json`:

```json
{
  "appKey": "your-app-key",
  "appSecret": "your-app-secret"
}
```

Token fields (`accessToken`, `refreshToken`, `expiresAt`) are managed automatically by the auth flow.
