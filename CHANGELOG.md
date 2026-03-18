# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.2.0] - 2026-03-18

### Fixed

- Sync toggle now works for indirectly excluded subfolders (inherited from parent)

## [0.1.0] - 2026-03-12

### Added

- Terminal UI with Local and Server tab browsing
- Local tab: navigate directories, exclude folders, view file status, share links
- Server tab: browse Dropbox server contents via API or CLI fallback
- Sync toggle (Space) to include/exclude folders from sync
- OAuth2 setup (`lazydbx init` / `lazydbx auth`) for Dropbox API access
- Share links via Dropbox API in server tab
- Copy to clipboard support (Wayland, X11, macOS)
- Periodic daemon status polling
- Hidden `.dropbox.cache` from file listings
- Server tab disabled when Dropbox daemon not running
- Tokyo Night color scheme
