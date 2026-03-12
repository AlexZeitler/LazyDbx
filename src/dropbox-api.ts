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