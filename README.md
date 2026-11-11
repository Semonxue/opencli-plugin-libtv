# opencli-plugin-libtv

An [opencli](https://github.com/jackwener/OpenCLI) adapter for **LibTV** (`liblib.tv`) —
the AI video / storyboard canvas product from LiblibAI.

The LibTV web UI is a React Flow canvas backed by JSON APIs. This plugin talks to those same
endpoints from inside the logged-in page, so anything the UI can show, a script can read.
Everything here is **read-only**: the plugin never mutates a canvas.

## Install

```bash
opencli plugin install https://github.com/Semonxue/opencli-plugin-libtv.git
# local checkout:
opencli plugin install file:///path/to/libtv-opencli-plugin
```

Requirements: opencli >= 2.0, the Chrome extension connected (`opencli doctor`), and a
signed-in session at <https://www.liblib.tv> (the `usertoken` cookie is the credential).

## Commands, by workflow

opencli prints a site's commands alphabetically; each command description is tagged
**`Core:`** or **`Utility:`** so the important ones are easy to spot. The table below is
ordered the way you actually use the plugin.

### 1. Find a canvas

| Command | What it does |
|---|---|
| `libtv projects` | All canvas projects (`--search`, `--limit`, `--space`) with uuid + URL |

`projects` is the entry point: it hands you the uuid (or URL) that every other command takes.

### 2. Inspect a canvas

| Command | What it does |
|---|---|
| `libtv detail <project>` | One-line overview: node & asset counts, groups, size, model mix |
| `libtv nodes <project>` | Every node incl. group nodes (`--type`, `--group`, `--limit`) |
| `libtv assets <project>` | Every media asset with its **original** CDN URL (`--type`, `--group`, `--limit`) |
| `libtv groups <project>` | Grouping tree with per-type counts and total size |
| `libtv prompts <project>` | Generation prompt behind each media node (`--type`, `--group`, `--limit`) |

### 3. Export media

| Command | What it does |
|---|---|
| `libtv export <project>` | Download everything into `<out>/<project>/<group>/<type>/` + `manifest.csv` |

Options: `--type`, `--group`, `--concurrency`, `--overwrite`, `--manifest false`, `--summary`.
Export is resumable (existing files are skipped) and exits non-zero if any download failed.

### Utility

| Command | What it does |
|---|---|
| `libtv me` | Account name, plan, total / usable power, concurrency |
| `libtv version` | Plugin version |

## Project references

`<project>` accepts any of:

| Form | Example |
|---|---|
| **Canvas URL (copy from the address bar)** | `https://www.liblib.tv/canvas?spaceId=10001&projectId=0123456789abcdef0123456789abcdef` |
| URL without `spaceId` | `https://www.liblib.tv/canvas?projectId=0123456789abcdef0123456789abcdef` |
| Bare uuid | `0123456789abcdef0123456789abcdef` |
| Numeric project id | `1000001` |
| Name substring | `demo` |

URLs and bare uuids resolve **without any list lookup** — the canvas endpoint only needs the
uuid, and the real name/space/id come back in `projectMeta`. Numeric ids and name substrings
page `/api/canvas/project/list`. Recognised URL params: `projectId`, `projectUuid`, `uuid`,
`canvasId` (or a 32-char uuid anywhere in the path); `spaceId` is read as a hint only.
If a name matches several projects the command fails and lists the candidates — pass the uuid
or the canvas URL instead.

## Examples

```bash
# paste a canvas URL straight from the browser
opencli libtv detail "https://www.liblib.tv/canvas?spaceId=10001&projectId=0123456789abcdef0123456789abcdef"
opencli libtv export "https://www.liblib.tv/canvas?projectId=0123456789abcdef0123456789abcdef" --out ./exports

opencli libtv projects --limit 20 -f json
opencli libtv projects --space 10001
opencli libtv detail 0123456789abcdef0123456789abcdef
opencli libtv assets demo --type video -f csv > videos.csv
opencli libtv export demo --out ./exports                     # full, grouped download
opencli libtv export demo --group characters --type image     # partial export
opencli libtv prompts demo --limit 5 -f md
```

`export` writes:

```
exports/demo/
  characters/images/001_characters · portrait_i-1.png
  storyboard/videos/...
  _ungrouped/audio/...
  manifest.csv          # group,type,name,model,width,height,duration_sec,bytes,status,rel_path,node_key,url
```

Projects without groups export flat (`exports/demo/images/...`) — no `_ungrouped` wrapper.
Two groups with the same display name get a short key suffix in their folder names.
`manifest.csv` is UTF-8 with BOM and records one `status` (`ok` / `skipped` / `failed`) per file.

## How it works

| Concern | Implementation |
|---|---|
| Auth | `usertoken` cookie → `token` header (+ `webid`, `x-client-type`, `x-language`); read once per API call |
| Transport | `page.fetchJson` from the logged-in page (no API keys, no separate HTTP client) |
| Canvas data | `GET /api/canvas/project/detail?uuid=` → `data.nodeList` (no spaceId needed; `detail-by-space` kept as fallback) |
| Grouping | node `.parentKey` → group node name, cross-checked against group `.childNodeIds` |
| Project ref | `parseProjectRef()` — URL / uuid / numeric id / name → uuid (+ optional spaceId hint) |
| Asset URL | node `data.url` (string or array), stripped of `?x-oss-process=` so you get the original file |
| Metadata | `data._resourceMeta.items[i]` → width/height/duration/byteSize/mime (per URL) |
| Account | `api2.liblib.art/api/www/member/account?isApp=false` |

### Notes / gotchas

- **Node types**: `2=image`, `3=video`, `4=audio`, `5=group`. Group nodes carry `childNodeIds`
  and, for character sets, `characterAsset.roleId`.
- **Sizes are "declared"**: many nodes lack `_resourceMeta.byteSize`. `detail`/`groups` report the
  sum of *known* sizes plus a `size_unknown` count rather than pretending the total is complete.
  `export` reports real bytes on disk.
- **CDN truncation**: LibTV's CDN occasionally closes a response early. `export` verifies each
  file against `Content-Length` when the CDN sends it (otherwise the declared byteSize), retries
  from scratch on mismatch, downloads to a per-file `.part` temp name, and only then renames it.
- **DOM is not a source of truth**: the canvas virtualises — only a fraction of the nodes exist
  in the DOM at any zoom level — which is why everything here goes through the API.
- **Empty is valid**: a canvas with no assets (or `projects` on an account with none) returns an
  empty result, not an error.
- **All commands are `access: read`**; nothing mutates the canvas.

## Development

```bash
npm install            # links @jackwener/opencli peer
npm run build          # esbuild → lib/utils.js + root *.js  (requires esbuild on PATH)
npm test               # node --test tests/*.test.js
```

opencli resolves commands from the compiled `.js` files, so **rebuild and keep the `.js` in sync**
after editing any `.ts`. Only root-level `.ts` files are transpiled by opencli during plugin
install/update; `lib/utils.ts` must be compiled by `npm run build` and shipped as `lib/utils.js`.
