import { AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
const LIBTV_DOMAIN = "www.liblib.tv";
const LIBTV_HOME = "https://www.liblib.tv/";
const CANVAS_HOST = "https://api.liblib.tv";
const WWW_HOST = "https://api2.liblib.art";
const canvasUrl = (projectUuid) => `https://www.liblib.tv/canvas?projectId=${projectUuid}`;
const NODE_TYPES = { 2: "image", 3: "video", 4: "audio", 5: "group" };
const ASSET_TYPES = ["image", "video", "audio"];
const TYPE_DIRS = { image: "images", video: "videos", audio: "audio" };
const TYPE_EXTS = { image: "png", video: "mp4", audio: "wav" };
function cookieValue(cookie, name) {
  const m = String(cookie ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}
async function getAuth(page) {
  const raw = String(await page.evaluate("document.cookie") ?? "");
  const token = cookieValue(raw, "usertoken");
  if (!token) {
    throw new AuthRequiredError(
      LIBTV_DOMAIN,
      "LibTV session not found (usertoken cookie missing).",
      "Log in at https://www.liblib.tv first, then retry."
    );
  }
  return { token, webid: cookieValue(raw, "webid") };
}
async function callApi(page, host, apiPath, opts = {}) {
  const auth = await getAuth(page);
  const method = opts.method ?? "POST";
  let res;
  try {
    res = await page.fetchJson(`${host}${apiPath}`, {
      method,
      headers: {
        token: auth.token,
        webid: auth.webid,
        "x-client-type": "web",
        "x-language": "zh"
      },
      ...opts.body !== void 0 ? { body: opts.body } : {},
      timeoutMs: opts.timeoutMs ?? 6e4
    });
  } catch (err) {
    const message = String(err?.message ?? err);
    if (/(^|\D)(401|403)(\D|$)/.test(message) || /unauthori[sz]ed|forbidden/i.test(message)) {
      throw new AuthRequiredError(
        LIBTV_DOMAIN,
        `LibTV rejected the request (HTTP 401/403): ${message}`,
        "Re-open https://www.liblib.tv and make sure you are signed in."
      );
    }
    throw new CommandExecutionError(`LibTV API ${method} ${apiPath} request failed: ${message}`);
  }
  if (res === null || res === void 0) {
    throw new CommandExecutionError(`LibTV API ${method} ${apiPath} returned an empty response.`);
  }
  let body;
  if (typeof res === "object" && typeof res.text === "string") {
    if (res.ok === false) {
      throw new CommandExecutionError(
        `LibTV API ${method} ${apiPath} failed: HTTP ${res.status ?? 0} ${res.statusText ?? ""}`
      );
    }
    try {
      body = JSON.parse(res.text);
    } catch {
      throw new CommandExecutionError(
        `LibTV API ${method} ${apiPath} returned non-JSON: ${String(res.text).slice(0, 120)}`
      );
    }
  } else {
    body = res;
  }
  const code = body?.code;
  if (code !== 0 && code !== "0") {
    const msg = body?.msg ? ` \u2014 ${body.msg}` : "";
    if (String(code) === "10001") {
      throw new AuthRequiredError(
        LIBTV_DOMAIN,
        `LibTV says "not authorised" (code 10001)${msg}`,
        "Re-open https://www.liblib.tv in the browser and make sure you are signed in."
      );
    }
    throw new CommandExecutionError(`LibTV API ${method} ${apiPath} error ${code}${msg}`);
  }
  return body?.data;
}
const PROJECT_PAGE_SIZE = 50;
async function listProjects(page, { limit = 200, search = "", spaceId = 0 } = {}) {
  const needle = search.trim().toLowerCase();
  const out = [];
  let pageNum = 1;
  let total = Infinity;
  while (out.length < limit && pageNum <= 40 && (pageNum - 1) * PROJECT_PAGE_SIZE < total) {
    const data = await callApi(page, CANVAS_HOST, "/api/canvas/project/list", {
      body: {
        page: pageNum,
        pageSize: PROJECT_PAGE_SIZE,
        ...spaceId > 0 ? { folderId: spaceId } : {}
      }
    });
    const items = Array.isArray(data?.projectMetaList) ? data.projectMetaList : [];
    total = Number(data?.total ?? items.length);
    for (const it of items) {
      const row = mapProject(it);
      if (!row) continue;
      if (needle && !`${row.name} ${row.uuid}`.toLowerCase().includes(needle)) continue;
      out.push(row);
      if (out.length >= limit) break;
    }
    if (items.length < PROJECT_PAGE_SIZE) break;
    pageNum++;
  }
  return out;
}
function mapProject(it) {
  const uuid = it?.uuid ?? it?.projectUuid;
  if (!uuid) return null;
  return {
    id: Number(it?.id ?? 0),
    uuid: String(uuid),
    name: String(it?.name ?? "(untitled)"),
    folderId: Number(it?.folderId ?? 0),
    projectSpaceId: Number(it?.projectSpaceId ?? it?.folderId ?? 0),
    projectType: Number(it?.projectType ?? 0),
    updatedAtMs: Number(it?.updatedAtMs ?? 0),
    createdAtMs: Number(it?.createdAtMs ?? 0),
    url: canvasUrl(String(uuid))
  };
}
const UUID_RE = /^[0-9a-f]{32}$/i;
function parseProjectRef(ref) {
  const raw = String(ref ?? "").trim();
  if (!raw) return { kind: "name", uuid: "", numericId: 0, spaceId: 0, problem: "empty" };
  if (/^https?:\/\//i.test(raw)) {
    let url = null;
    try {
      url = new URL(raw);
    } catch {
      return { kind: "url", uuid: "", numericId: 0, spaceId: 0, problem: "malformed URL" };
    }
    const params = url.searchParams;
    let uuid = "";
    let numericId = 0;
    for (const key of ["projectId", "projectUuid", "uuid", "canvasId", "canvasUuid"]) {
      const value = (params.get(key) ?? "").trim();
      if (!value) continue;
      if (UUID_RE.test(value)) {
        uuid = value.toLowerCase();
        break;
      }
      if (/^\d+$/.test(value) && !numericId) numericId = Number(value);
    }
    if (!uuid && !numericId) {
      const hit = url.pathname.match(/[0-9a-f]{32}/i);
      if (hit) uuid = hit[0].toLowerCase();
    }
    const spaceRaw = (params.get("spaceId") ?? params.get("projectSpaceId") ?? params.get("folderId") ?? "").trim();
    const spaceId = /^\d+$/.test(spaceRaw) ? Number(spaceRaw) : 0;
    return {
      kind: "url",
      uuid,
      numericId,
      spaceId,
      problem: uuid || numericId ? void 0 : "no projectId/projectUuid in the URL"
    };
  }
  if (UUID_RE.test(raw)) return { kind: "uuid", uuid: raw.toLowerCase(), numericId: 0, spaceId: 0 };
  if (/^\d+$/.test(raw)) return { kind: "id", uuid: "", numericId: Number(raw), spaceId: 0 };
  return { kind: "name", uuid: "", numericId: 0, spaceId: 0 };
}
function stubProject(uuid, spaceId = 0) {
  return {
    id: 0,
    uuid,
    name: "",
    folderId: 0,
    projectSpaceId: spaceId,
    projectType: 0,
    updatedAtMs: 0,
    createdAtMs: 0,
    url: canvasUrl(uuid)
  };
}
async function resolveProject(page, ref, limit = 400) {
  const parsed = parseProjectRef(ref);
  const needle = String(ref ?? "").trim();
  if (parsed.kind === "url" && parsed.problem) {
    throw new CommandExecutionError(
      `Could not read a project id from "${needle}" (${parsed.problem}). Expected a canvas URL like https://www.liblib.tv/canvas?projectId=<uuid>.`
    );
  }
  if (parsed.uuid) return stubProject(parsed.uuid, parsed.spaceId);
  if (!needle) throw new CommandExecutionError("A project URL, uuid, id or name is required.");
  const all = await listProjects(page, { limit });
  if (parsed.kind === "id" || parsed.numericId) {
    const byId = all.find((p) => p.id === parsed.numericId);
    if (byId) return byId;
    if (parsed.kind === "url") {
      throw new CommandExecutionError(
        `No LibTV project with id ${parsed.numericId}. Run \`opencli libtv projects\` to list them.`
      );
    }
  }
  const lower = needle.toLowerCase();
  const byName = all.filter((p) => p.name.toLowerCase().includes(lower));
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new CommandExecutionError(
      `"${needle}" matches ${byName.length} projects: ${byName.slice(0, 8).map((p) => `${p.name} (${p.uuid})`).join(", ")}. Pass the exact uuid or a canvas URL instead.`
    );
  }
  throw new CommandExecutionError(
    `No LibTV project matches "${needle}". Run \`opencli libtv projects\` to list them, or pass the canvas URL directly.`
  );
}
function nodeData(node) {
  const d = node?.data;
  if (!d) return {};
  if (typeof d === "object") return d;
  try {
    return JSON.parse(d);
  } catch {
    return {};
  }
}
function nodeUrls(data) {
  const raw = data?.url;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.filter((u) => typeof u === "string" && /^https?:\/\//.test(u)).map((u) => u.split("?x-oss-process=")[0]);
}
function extOf(url, type) {
  const pathname = url.split("?")[0].split("#")[0];
  const base = pathname.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > -1 ? base.slice(dot + 1).toLowerCase() : "";
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : TYPE_EXTS[type] ?? "bin";
}
function enrichProject(project, meta) {
  if (!meta || typeof meta !== "object") return project;
  const uuid = String(meta.uuid ?? project.uuid);
  return {
    id: Number(meta.id ?? project.id) || project.id,
    uuid,
    name: String(meta.name ?? project.name ?? "") || uuid.slice(0, 8),
    folderId: Number(meta.folderId ?? project.folderId) || project.folderId,
    projectSpaceId: Number(meta.projectSpaceId ?? project.projectSpaceId) || project.projectSpaceId,
    projectType: Number(meta.projectType ?? project.projectType) || project.projectType,
    updatedAtMs: Number(meta.updatedAtMs ?? project.updatedAtMs) || project.updatedAtMs,
    createdAtMs: Number(meta.createdAtMs ?? project.createdAtMs) || project.createdAtMs,
    url: canvasUrl(uuid)
  };
}
async function fetchCanvas(page, project) {
  let detail = null;
  let lastError = null;
  try {
    const data = await callApi(page, CANVAS_HOST, `/api/canvas/project/detail?uuid=${encodeURIComponent(project.uuid)}`, {
      method: "GET"
    });
    const nested = data?.projectDetail;
    const candidate = Array.isArray(data?.nodeList) ? data : nested && Array.isArray(nested.nodeList) ? nested : null;
    if (candidate) {
      detail = candidate.projectMeta ? candidate : { ...candidate, projectMeta: data?.projectMeta };
    }
  } catch (err) {
    lastError = err;
  }
  if (!detail && project.projectSpaceId) {
    try {
      const data = await callApi(
        page,
        CANVAS_HOST,
        `/api/canvas/project/detail-by-space?spaceId=${encodeURIComponent(String(project.projectSpaceId))}&projectUuid=${encodeURIComponent(project.uuid)}`,
        { method: "GET" }
      );
      const nested = data?.projectDetail;
      if (nested && Array.isArray(nested.nodeList)) detail = nested;
    } catch (err) {
      lastError = lastError ?? err;
    }
  }
  if (!detail) {
    if (lastError) throw lastError;
    throw new CommandExecutionError(
      `Canvas ${project.uuid} could not be loaded (empty, deleted, or not shared with this account?).`
    );
  }
  return parseCanvas(enrichProject(project, detail.projectMeta), detail);
}
function parseCanvas(project, detail) {
  const nodes = Array.isArray(detail?.nodeList) ? detail.nodeList : [];
  const edges = Array.isArray(detail?.connectionList) ? detail.connectionList : [];
  const groups = [];
  const groupName = /* @__PURE__ */ new Map();
  const childGroup = /* @__PURE__ */ new Map();
  for (const n of nodes) {
    if (Number(n?.type) !== 5) continue;
    const data = nodeData(n);
    const key = String(n.nodeKey);
    const name = String(n.name ?? data?.name ?? key);
    groupName.set(key, name);
    if (Array.isArray(data?.childNodeIds)) {
      for (const child of data.childNodeIds) childGroup.set(String(child), key);
    }
    const ca = data?.characterAsset;
    groups.push({
      key,
      name,
      childCount: Array.isArray(data?.childNodeIds) ? data.childNodeIds.length : 0,
      roleId: ca?.roleId ? String(ca.roleId) : ""
    });
  }
  const groupKeyOf = (n) => {
    const parent = String(n?.parentKey ?? "");
    if (groupName.has(parent)) return parent;
    return childGroup.get(String(n?.nodeKey ?? "")) ?? "";
  };
  const assets = [];
  const flatNodes = [];
  for (const n of nodes) {
    const typeNum = Number(n?.type);
    const type = NODE_TYPES[typeNum] ?? "other";
    const data = nodeData(n);
    const urls = nodeUrls(data);
    const metaItems = data?._resourceMeta?.items;
    const metaList = Array.isArray(metaItems) ? metaItems : [];
    const groupKey = groupKeyOf(n);
    const group = groupKey ? groupName.get(groupKey) ?? "" : "";
    const identity = {
      nodeKey: String(n?.nodeKey ?? ""),
      name: String(n?.name ?? "(untitled)"),
      type,
      model: String(n?.toolKey || data?.params?.model || "-"),
      group,
      groupKey
    };
    const firstMeta = metaList[0] ?? {};
    flatNodes.push({
      ...identity,
      width: firstMeta.width ?? "",
      height: firstMeta.height ?? "",
      durationSec: firstMeta.durationSec ?? "",
      bytes: Number(firstMeta.byteSize ?? 0),
      url: urls[0] ?? ""
    });
    if (typeNum === 5 || !urls.length) continue;
    const prompt = String(data?.params?.prompt ?? "") || (Array.isArray(data?.params?.textList) ? data.params.textList.join("\n") : "");
    for (let i = 0; i < urls.length; i++) {
      const meta = metaList[i] ?? firstMeta;
      const url = urls[i];
      assets.push({
        ...identity,
        project: project.name,
        projectUuid: project.uuid,
        type,
        width: meta?.width ?? "",
        height: meta?.height ?? "",
        durationSec: meta?.durationSec ?? "",
        bytes: Number(meta?.byteSize ?? 0),
        mime: String(meta?.mimeType ?? ""),
        prompt,
        url,
        ext: extOf(url, type)
      });
    }
  }
  return {
    project,
    nodes,
    edges,
    groups,
    assets,
    flatNodes,
    nodeCount: nodes.length
  };
}
async function loadCanvas(page, ref) {
  const project = await resolveProject(page, ref);
  return fetchCanvas(page, project);
}
async function readAccount(page) {
  const acc = await callApi(page, WWW_HOST, "/api/www/member/account?isApp=false", { method: "GET" });
  const attr = acc?.attr ?? {};
  let freePower = 0;
  try {
    const fp = await callApi(page, WWW_HOST, "/api/www/member/libtvFreePower", { body: {} });
    freePower = Number(fp?.freePower ?? 0);
  } catch {
  }
  return {
    name: String(acc?.name ?? ""),
    level: String(acc?.accountLevelName ?? ""),
    packageType: String(acc?.packageType ?? ""),
    totalPower: Number(attr?.totalPower ?? 0),
    usablePower: Number(attr?.usablePower ?? 0),
    libtvUsablePower: Number(attr?.libtvUsablePower ?? 0),
    freePower,
    concurrent: Number(attr?.concurrent ?? 0)
  };
}
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function safeName(input, max = 70) {
  const cleaned = String(input ?? "").replace(/[\\/:*?"<>|\r\n\t]/g, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, max).trim().replace(/[. ]+$/, "");
  const base = cleaned || "unnamed";
  return WINDOWS_RESERVED.test(base) ? `_${base}` : base;
}
function trimToBytes(input, maxBytes) {
  let out = "";
  let bytes = 0;
  for (const ch of String(input ?? "")) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  return out;
}
function groupDirs(canvas) {
  const counts = /* @__PURE__ */ new Map();
  for (const g of canvas.groups) counts.set(g.name, (counts.get(g.name) ?? 0) + 1);
  const dirs = /* @__PURE__ */ new Map();
  for (const g of canvas.groups) {
    const duplicate = (counts.get(g.name) ?? 0) > 1;
    const label = duplicate ? `${g.name} (${g.key.slice(-6)})` : g.name;
    dirs.set(g.key, safeName(label, 60));
  }
  return dirs;
}
function fileNameFor(seq, asset) {
  const prefix = `${seq}_`;
  const suffix = `_${safeName(asset.nodeKey, 24)}`;
  const ext = asset.ext;
  const budget = 190 - Buffer.byteLength(prefix + suffix, "utf8") - Buffer.byteLength(ext, "utf8") - 1;
  const name = trimToBytes(safeName(asset.name, 60), Math.max(16, budget));
  return `${prefix}${name}${suffix}.${ext}`;
}
function planExport(canvas, opts = {}) {
  const wanted = opts.types && opts.types.length ? new Set(opts.types) : null;
  const hasGroups = canvas.groups.length > 0;
  const dirs = groupDirs(canvas);
  const counters = {};
  const planned = [];
  for (const a of canvas.assets) {
    if (wanted && !wanted.has(a.type)) continue;
    const typeDir = TYPE_DIRS[a.type] ?? a.type;
    const groupDir = hasGroups ? a.groupKey ? dirs.get(a.groupKey) ?? safeName(a.group || "_ungrouped", 60) : "_ungrouped" : "";
    const bucket = `${groupDir}/${typeDir}`;
    counters[bucket] = (counters[bucket] ?? 0) + 1;
    const seq = String(counters[bucket]).padStart(3, "0");
    planned.push({ asset: a, relPath: path.posix.join(...[groupDir, typeDir, fileNameFor(seq, a)].filter(Boolean)) });
  }
  return planned;
}
async function downloadFile(url, dest, expectedBytes, tempTag, retries = 4) {
  let lastErr = "";
  const tmp = `${dest}.${tempTag}.part`;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; opencli-libtv)" },
        redirect: "follow"
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      const got = fs.statSync(tmp).size;
      const declared = Number(res.headers.get("content-length") ?? 0);
      const want = declared || expectedBytes;
      if (want && got !== want) throw new Error(`size mismatch (${got}/${want})`);
      fs.renameSync(tmp, dest);
      return got;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
      }
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  throw new Error(lastErr || "download failed");
}
async function runExport(planned, outDir, opts = {}) {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 6, 16));
  const results = new Array(planned.length);
  let cursor = 0;
  let done = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= planned.length) return;
      const job = planned[i];
      const dest = path.join(outDir, job.relPath);
      let result;
      try {
        let existing = 0;
        if (!opts.overwrite && fs.existsSync(dest)) existing = fs.statSync(dest).size;
        const expected = job.asset.bytes;
        if (existing > 0 && (!expected || existing === expected)) {
          result = { relPath: job.relPath, status: "skipped", bytes: existing };
        } else {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const bytes = await downloadFile(job.asset.url, dest, expected, `${process.pid}-${i}`);
          result = { relPath: job.relPath, status: "ok", bytes };
        }
      } catch (err) {
        result = {
          relPath: job.relPath,
          status: "failed",
          bytes: 0,
          error: err instanceof Error ? err.message : String(err)
        };
      }
      results[i] = result;
      opts.onProgress?.(++done, planned.length, result);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}
function csvCell(value) {
  const text = String(value ?? "");
  const isNumber = /^-?\d+(\.\d+)?$/.test(text);
  const safe = !isNumber && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
function writeManifest(outDir, canvas, planned, results) {
  const byRel = new Map(results.map((r) => [r.relPath, r]));
  const header = [
    "group",
    "type",
    "name",
    "model",
    "width",
    "height",
    "duration_sec",
    "bytes",
    "status",
    "rel_path",
    "node_key",
    "url"
  ];
  const rows = planned.map((p) => {
    const a = p.asset;
    const r = byRel.get(p.relPath);
    return [
      a.group || "",
      a.type,
      a.name,
      a.model,
      a.width === "" ? "" : String(a.width),
      a.height === "" ? "" : String(a.height),
      a.durationSec === "" ? "" : String(a.durationSec),
      String(r?.bytes ?? a.bytes),
      r?.status ?? "missing",
      p.relPath,
      a.nodeKey,
      a.url
    ];
  });
  const csv = [header, ...rows].map((cols) => cols.map(csvCell).join(",")).join("\n");
  const manifestPath = path.join(outDir, "manifest.csv");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(manifestPath, `\uFEFF${csv}
`, "utf-8");
  return manifestPath;
}
function formatDate(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function mb(bytes) {
  return Math.round(Number(bytes) / 1048576 * 100) / 100;
}
function sumBytes(assets) {
  return assets.reduce((acc, a) => acc + (Number(a.bytes) || 0), 0);
}
function byType(assets, type) {
  return assets.filter((a) => a.type === type);
}
export {
  ASSET_TYPES,
  CANVAS_HOST,
  LIBTV_DOMAIN,
  LIBTV_HOME,
  NODE_TYPES,
  TYPE_DIRS,
  TYPE_EXTS,
  WWW_HOST,
  byType,
  callApi,
  canvasUrl,
  enrichProject,
  extOf,
  fetchCanvas,
  formatDate,
  getAuth,
  listProjects,
  loadCanvas,
  mb,
  parseCanvas,
  parseProjectRef,
  planExport,
  readAccount,
  resolveProject,
  runExport,
  safeName,
  sumBytes,
  trimToBytes,
  writeManifest
};
