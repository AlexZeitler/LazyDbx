export interface ApiEntry {
  name: string
  pathLower: string
  pathDisplay: string
  isDir: boolean
}

interface ListFolderResponse {
  entries: Array<{
    ".tag": "file" | "folder" | "deleted"
    name: string
    path_lower: string
    path_display: string
  }>
  cursor: string
  has_more: boolean
}

/**
 * List folder contents via Dropbox HTTP API.
 * Handles pagination automatically.
 * @param accessToken Valid OAuth access token
 * @param path Dropbox path (e.g. "" for root, "/Documents")
 */
export async function apiListFolder(accessToken: string, path: string): Promise<ApiEntry[]> {
  const entries: ApiEntry[] = []

  const res = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path: path || "", recursive: false }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`list_folder failed: ${err}`)
  }

  let data = await res.json() as ListFolderResponse

  for (const e of data.entries) {
    if (e[".tag"] === "deleted") continue
    entries.push({
      name: e.name,
      pathLower: e.path_lower,
      pathDisplay: e.path_display,
      isDir: e[".tag"] === "folder",
    })
  }

  // Pagination
  while (data.has_more) {
    const contRes = await fetch("https://api.dropboxapi.com/2/files/list_folder/continue", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cursor: data.cursor }),
    })

    if (!contRes.ok) break

    data = await contRes.json() as ListFolderResponse
    for (const e of data.entries) {
      if (e[".tag"] === "deleted") continue
      entries.push({
        name: e.name,
        pathLower: e.path_lower,
        pathDisplay: e.path_display,
        isDir: e[".tag"] === "folder",
      })
    }
  }

  // Folders first, then alphabetical
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return entries
}

/**
 * Create or retrieve a shared link for a file/folder via Dropbox API.
 * Requires sharing.write scope.
 */
export async function apiShareLink(accessToken: string, path: string): Promise<string> {
  // Try to create a new shared link
  const res = await fetch("https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path }),
  })

  if (res.ok) {
    const data = await res.json() as { url: string }
    return data.url
  }

  // If link already exists, fetch it
  const err = await res.json() as { error?: { ".tag"?: string } }
  if (err.error?.[".tag"] === "shared_link_already_exists") {
    const listRes = await fetch("https://api.dropboxapi.com/2/sharing/list_shared_links", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path, direct_only: true }),
    })
    if (listRes.ok) {
      const listData = await listRes.json() as { links: Array<{ url: string }> }
      if (listData.links.length > 0) {
        return listData.links[0]!.url
      }
    }
  }

  throw new Error("Failed to create share link")
}