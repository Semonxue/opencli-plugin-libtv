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
async function getToken(page) {
  const raw = await page.evaluate("document.cookie");
  const m = String(raw ?? "").match(/usertoken=([^;]+)/);
  if (!m) {
    throw new AuthRequiredError(
      LIBTV_DOMAIN,
      "LibTV session not found (usertoken cookie missing).",
      "Log in at https://www.liblib.tv first, then retry."
    );
  }
  return decodeURIComponent(m[1]);
}
async function callApi(page, host, apiPath, opts = {}) {
  const token = await getToken(page);
  const method = opts.method ?? "POST";
  const res = await page.fetchJson(`${host}${apiPath}`, {
    method,
    headers: {
      token,
      webid: await getWebId(page),
      "x-client-type": "web",
      "x-language": "zh"
    },
    ...opts.body !== void 0 ? { body: opts.body } : {},
    timeoutMs: opts.timeoutMs ?? 6e4
  });
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
async function getWebId(page) {
  const raw = await page.evaluate("document.cookie");
  const m = String(raw ?? "").match(/(?:^|;\s*)webid=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}
const PROJECT_PAGE_SIZE = 50;
async function listProjects(page, { limit = 200, search = "" } = {}) {
  const needle = search.trim().toLowerCase();
  const out = [];
  let pageNum = 1;
  let total = Infinity;
  while (out.length < limit && pageNum <= 40 && (pageNum - 1) * PROJECT_PAGE_SIZE < total) {
    const data = await callApi(page, CANVAS_HOST, "/api/canvas/project/list", {
      body: { page: pageNum, pageSize: PROJECT_PAGE_SIZE }
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
        uuid = value;
        break;
      }
      if (/^\d+$/.test(value) && !numericId) numericId = Number(value);
    }
    if (!uuid && !numericId) {
      const hit = url.pathname.match(/[0-9a-f]{32}/i);
      if (hit) uuid = hit[0];
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
  if (UUID_RE.test(raw)) return { kind: "uuid", uuid: raw, numericId: 0, spaceId: 0 };
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
  if (parsed.kind === "id") {
    const byId = all.find((p) => p.id === parsed.numericId);
    if (byId) return byId;
    throw new CommandExecutionError(
      `No LibTV project with id ${parsed.numericId}. Run \`opencli libtv projects\` to list them.`
    );
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
    if (data && Array.isArray(data.nodeList)) detail = data;
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
  for (const n of nodes) {
    if (Number(n?.type) !== 5) continue;
    const data = nodeData(n);
    const key = String(n.nodeKey);
    const name = String(n.name ?? data?.name ?? key);
    groupName.set(key, name);
    const ca = data?.characterAsset;
    groups.push({
      key,
      name,
      childCount: Array.isArray(data?.childNodeIds) ? data.childNodeIds.length : 0,
      roleId: ca?.roleId ? String(ca.roleId) : ""
    });
  }
  const assets = [];
  const flatNodes = [];
  for (const n of nodes) {
    const typeNum = Number(n?.type);
    const type = NODE_TYPES[typeNum] ?? "other";
    const data = nodeData(n);
    const urls = nodeUrls(data);
    const metaItems = data?._resourceMeta?.items;
    const meta = Array.isArray(metaItems) && metaItems.length ? metaItems[0] : {};
    const group = groupName.get(String(n?.parentKey ?? "")) ?? "";
    const base = {
      nodeKey: String(n?.nodeKey ?? ""),
      name: String(n?.name ?? "(untitled)"),
      type,
      model: String(n?.toolKey || data?.params?.model || "-"),
      group,
      width: meta?.width ?? "",
      height: meta?.height ?? "",
      durationSec: meta?.durationSec ?? "",
      bytes: Number(meta?.byteSize ?? 0)
    };
    flatNodes.push({ ...base, url: urls[0] ?? "" });
    if (typeNum === 5 || !urls.length) continue;
    const prompt = String(data?.params?.prompt ?? "") || (Array.isArray(data?.params?.textList) ? data.params.textList.join("\n") : "");
    for (const url of urls) {
      assets.push({
        ...base,
        project: project.name,
        projectUuid: project.uuid,
        type,
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
    usedPower: Number(attr?.usedPower ?? 0),
    freePower,
    concurrent: Number(attr?.concurrent ?? 0),
    downloadCount: Number(attr?.downloadCount ?? 0)
  };
}
async function listCharacters(page, limit = 100) {
  const out = [];
  let pageNum = 1;
  while (out.length < limit && pageNum <= 20) {
    const data = await callApi(page, CANVAS_HOST, "/api/user/character/list", {
      body: { page: pageNum, pageSize: 50 }
    });
    const items = Array.isArray(data?.list) ? data.list : [];
    for (const it of items) {
      out.push({
        uuid: String(it?.characterUuid ?? ""),
        name: String(it?.name ?? ""),
        gender: String(it?.gender ?? ""),
        ageStage: String(it?.ageStage ?? ""),
        region: String(it?.region ?? ""),
        era: String(it?.era ?? ""),
        version: Number(it?.currentVersion ?? 0),
        cover: String(it?.coverUrl ?? ""),
        updatedAtMs: Number(it?.updatedAtMs ?? 0)
      });
      if (out.length >= limit) break;
    }
    if (!data?.hasMore || items.length === 0) break;
    pageNum++;
  }
  return out;
}
async function listArtifacts(page, { limit = 50, projectUuid = "", mediaType = "" } = {}) {
  const out = [];
  let pageNum = 1;
  while (out.length < limit && pageNum <= 40) {
    const data = await callApi(page, CANVAS_HOST, "/api/task/artifact/list", {
      body: { page: pageNum, pageSize: 50, projectUuid: projectUuid || void 0 }
    });
    const items = Array.isArray(data?.list) ? data.list : [];
    for (const it of items) {
      const media = String(it?.mediaType ?? "");
      if (mediaType && media !== mediaType) continue;
      if (projectUuid && String(it?.projectUuid ?? "") !== projectUuid) continue;
      let extra = {};
      try {
        extra = typeof it?.extra === "string" ? JSON.parse(it.extra) : it?.extra ?? {};
      } catch {
        extra = {};
      }
      out.push({
        artifactId: String(it?.artifactId ?? ""),
        taskId: String(it?.taskId ?? ""),
        mediaType: media,
        projectUuid: String(it?.projectUuid ?? ""),
        nodeKey: String(it?.nodeKey ?? ""),
        rating: Number(it?.rating ?? 0),
        width: extra?.width ? String(extra.width) : "",
        height: extra?.height ? String(extra.height) : "",
        url: String(it?.previewPath ?? ""),
        createdAtMs: Number(it?.createdAtMs ?? 0)
      });
      if (out.length >= limit) break;
    }
    if (items.length < 50) break;
    pageNum++;
  }
  return out;
}
async function listWorkflows(page, limit = 100) {
  const data = await callApi(page, CANVAS_HOST, "/api/canvas/workflow/list", {
    body: { page: 1, pageSize: Math.min(Math.max(limit, 1), 200) }
  });
  const items = Array.isArray(data?.workflowList) ? data.workflowList : [];
  return items.slice(0, limit).map((it) => ({
    uuid: String(it?.uuid ?? it?.workflowUuid ?? ""),
    name: String(it?.name ?? "(untitled)"),
    updatedAtMs: Number(it?.updatedAtMs ?? 0)
  }));
}
async function listVersions(page, project, limit = 50) {
  const data = await callApi(page, CANVAS_HOST, "/api/canvas/project/version/list", {
    body: { projectUuid: project.uuid, page: 1, pageSize: Math.min(Math.max(limit, 1), 100) }
  });
  const items = Array.isArray(data?.versionList) ? data.versionList : [];
  return items.slice(0, limit).map((it) => ({
    versionId: String(it?.versionId ?? it?.id ?? ""),
    name: String(it?.versionName ?? it?.name ?? ""),
    createdAtMs: Number(it?.createdAtMs ?? it?.createAtMs ?? 0)
  }));
}
function safeName(input, max = 70) {
  const cleaned = String(input ?? "").replace(/[\\/:*?"<>|\r\n\t]/g, "_").replace(/\s+/g, " ").trim().replace(/^\.+$/, "").slice(0, max).trim();
  return cleaned || "unnamed";
}
function planExport(canvas, opts = {}) {
  const wanted = opts.types && opts.types.length ? new Set(opts.types) : null;
  const hasGroups = canvas.groups.length > 0;
  const counters = {};
  const planned = [];
  for (const a of canvas.assets) {
    if (wanted && !wanted.has(a.type)) continue;
    const typeDir = TYPE_DIRS[a.type] ?? a.type;
    const groupDir = hasGroups ? safeName(a.group || "_ungrouped", 60) : "";
    const bucket = `${groupDir}/${typeDir}`;
    counters[bucket] = (counters[bucket] ?? 0) + 1;
    const seq = String(counters[bucket]).padStart(3, "0");
    const fileName = `${seq}_${safeName(a.name)}_${a.nodeKey}.${a.ext}`;
    planned.push({ asset: a, relPath: path.posix.join(...[groupDir, typeDir, fileName].filter(Boolean)) });
  }
  return planned;
}
async function downloadFile(url, dest, expectedBytes, retries = 4) {
  let lastErr = "";
  for (let attempt = 0; attempt < retries; attempt++) {
    const tmp = `${dest}.part`;
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
        if (!opts.overwrite && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
          result = { relPath: job.relPath, status: "skipped", bytes: fs.statSync(dest).size };
        } else {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const bytes = await downloadFile(job.asset.url, dest, job.asset.bytes);
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
function writeManifest(outDir, canvas, planned, results) {
  const byRel = new Map(results.map((r) => [r.relPath, r]));
  const header = ["group", "type", "name", "model", "width", "height", "duration_sec", "bytes", "rel_path", "node_key", "url"];
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
      p.relPath,
      a.nodeKey,
      a.url
    ];
  });
  const csv = [header, ...rows].map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
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
  getToken,
  listArtifacts,
  listCharacters,
  listProjects,
  listVersions,
  listWorkflows,
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
  writeManifest
};
