# opencli-plugin-libtv

[opencli](https://github.com/jackwener/opencli) adapter for **LibTV** (`liblib.tv`) — LiblibAI's
AI video / storyboard canvas product.

The LibTV web UI is a React Flow canvas backed by two JSON hosts. This plugin talks to those
same endpoints from inside the logged-in page, so anything the UI can show, a script can read.

## Install

```bash
opencli plugin install file:///path/to/libtv-plugin     # local checkout
# or, once pushed:
opencli plugin install https://github.com/<you>/opencli-plugin-libtv.git
```

Requirements: opencli >= 2.0, Chrome extension connected (`opencli doctor`), and a signed-in
session at <https://www.liblib.tv> (the `usertoken` cookie is the credential).

## Commands

| Command | What it does |
|---|---|
| `libtv me` | Account name, plan, total / usable power, concurrency |
| `libtv projects` | All canvas projects (`--search`, `--limit`) with uuid + URL |
| `libtv spaces` | Project spaces / folders; `--inside <id>` lists children |
| `libtv detail <p>` | One-line canvas overview: node & asset counts, groups, size, model mix |
| `libtv nodes <p>` | Every node incl. group nodes (`--type`, `--group`, `--limit`) |
| `libtv assets <p>` | Every asset with its **original** CDN URL (`--type`, `--group`, `--with-prompt`) |
| `libtv groups <p>` | Grouping tree with per-type counts and total size |
| `libtv prompts <p>` | Generation prompt behind each media node |
| `libtv export <p>` | Download everything into `<out>/<project>/<group>/<type>/` + `manifest.csv` |
| `libtv characters` | Reusable character library (uuid, name, cover) |
| `libtv artifacts` | Generation history across projects (`--media`, `--project`) |
| `libtv workflows` | Saved workflows |
| `libtv versions <p>` | Canvas snapshot history |
| `libtv version` | Plugin version |

`<p>` accepts any of:

| Form | Example |
|---|---|
| **Canvas URL (copy from the address bar)** | `https://www.liblib.tv/canvas?spaceId=11161198&projectId=5110c032...` |
| URL without `spaceId` | `https://www.liblib.tv/canvas?projectId=5110c032...` |
| Bare uuid | `5110c03295d34f64aff6e398cb91d764` |
| Numeric project id | `14839047` |
| Name substring (e.g. `科技篇`) | `科技篇` |

URLs and bare uuids resolve **without any list lookup** — the canvas endpoint only needs the
uuid, and the real name/space/id come back in `projectMeta`. Only numeric ids and name
substrings page `/api/canvas/project/list`. Recognised URL params: `projectId`, `projectUuid`,
`uuid`, `canvasId` (or a 32-char uuid anywhere in the path); `spaceId` is read as a hint only.

## Examples

```bash
# paste a canvas URL straight from the browser
opencli libtv detail "https://www.liblib.tv/canvas?spaceId=11161198&projectId=5110c03295d34f64aff6e398cb91d764"
opencli libtv export "https://www.liblib.tv/canvas?projectId=5110c03295d34f64aff6e398cb91d764" --out ./exports

opencli libtv projects --search 全景篇 -f json
opencli libtv detail 5110c03295d34f64aff6e398cb91d764
opencli libtv assets 全景篇 --type video -f csv > videos.csv
opencli libtv export 全景篇 --out ./exports            # full, grouped download
opencli libtv export 全景篇 --group 护士 --type image   # partial export
opencli libtv prompts 科技篇 --limit 5 -f md
```

`export` writes:

```
exports/全景篇/
  护士/images/001_护士 · 头像_i-RINdyMojEK.png
  故事板2/images/...
  _ungrouped/videos/...
  _ungrouped/audio/...
  manifest.csv          # group,type,name,width,height,duration,bytes,rel_path,node_key,url
```

Projects without groups export flat (`exports/<p>/images/...`) — no `_ungrouped` wrapper.

## How it works

| Concern | Implementation |
|---|---|
| Auth | `usertoken` cookie → `token` header (+ `webid`, `x-client-type`, `x-language`) |
| Transport | `page.fetchJson` from the logged-in page (no API keys, no separate HTTP client) |
| Canvas data | `GET /api/canvas/project/detail?uuid=` → `data.nodeList` (no spaceId needed; `detail-by-space` kept as fallback) |
| Grouping | node `.parentKey` → group node name (cross-checked against group `.childNodeIds`) |
| Project ref | `parseProjectRef()` — URL / uuid / numeric id / name → uuid (+ optional spaceId hint) |
| Asset URL | node `data.url` (string or array), stripped of `?x-oss-process=` so you get the original file |
| Metadata | `data._resourceMeta.items[0]` → width/height/duration/byteSize/mime |
| Account | `api2.liblib.art/api/www/member/account?isApp=false` |

### Notes / gotchas

- **Node types**: `2=image`, `3=video`, `4=audio`, `5=group`. Group nodes carry `childNodeIds`
  and, for character sets, `characterAsset.roleId` (matches `libtv characters` uuids).
- **Sizes are "declared"**: many nodes lack `_resourceMeta.byteSize`. `detail`/`groups` report the
  sum of *known* sizes plus a `size_unknown` count rather than pretending the total is complete.
  `export` reports real bytes on disk.
- **CDN truncation**: LibTV's CDN occasionally closes a response early. `export` verifies every
  file against `Content-Length`, retries from scratch on mismatch, and only then renames off `.part`.
- **DOM is not a source of truth**: the canvas virtualises — only ~60 of 291 nodes exist in the DOM
  at any zoom level — which is why everything here goes through the API.
- **Simplicity of the uuid endpoint**: `/api/canvas/project/detail?uuid=` returns the same
  292-node / 505-edge payload as `detail-by-space` in one call and works for canvases that were
  shared with you, which is why pasted URLs "just work".
- All commands are `access: read`; nothing mutates the canvas.

## Development

```bash
npm install            # links @jackwener/opencli peer
npm run build          # esbuild → lib/utils.js + root *.js
npm test               # node --test tests/*.test.js
```

opencli resolves commands from the compiled `.js` files, so **rebuild and keep the `.js` in sync**
after editing any `.ts`. Only root-level `.ts` files are auto-transpiled by opencli itself.
