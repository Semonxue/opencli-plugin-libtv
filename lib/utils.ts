/**
 * Shared helpers for the LibTV (liblib.tv) opencli plugin.
 *
 * LibTV is LiblibAI's AI-video product. Everything the UI shows comes from
 * two JSON hosts:
 *
 *   - `api.liblib.tv`      canvas graphs, nodes, media assets, workflows, tasks
 *   - `api2.liblib.art`    legacy account / membership / power endpoints
 *
 * Both authenticate with the `usertoken` cookie forwarded as a `token`
 * request header (plus `webid` / `x-client-type` / `x-language`). There is no
 * public API and no API key, so every call is made from inside the logged-in
 * page context with `page.fetchJson`.
 *
 * Canvas shape (verified 2026-11, opencli 2.0.2):
 *   GET /api/canvas/project/detail-by-space?spaceId=&projectUuid=
 *     data.projectDetail.nodeList[]  — one entry per node on the canvas
 *       .type      2=image 3=video 4=audio 5=group
 *       .toolKey   model id, e.g. lib-image-2.5-s / star-video2.5 / seed-audio-1.0
 *       .name      user-visible node title
 *       .parentKey grouping node key (group nodes carry `childNodeIds` too)
 *       .data      JSON string; `.url` holds the asset (string or string[]),
 *                  `._resourceMeta.items[0]` the width/height/duration/byteSize,
 *                  `.params.prompt` the generation prompt
 */
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const LIBTV_DOMAIN = 'www.liblib.tv';
export const LIBTV_HOME = 'https://www.liblib.tv/';
export const CANVAS_HOST = 'https://api.liblib.tv';
export const WWW_HOST = 'https://api2.liblib.art';

export const canvasUrl = (projectUuid: string) =>
    `https://www.liblib.tv/canvas?projectId=${projectUuid}`;

/** Node `type` → stable label. 2=image 3=video 4=audio 5=group. */
export const NODE_TYPES: Record<number, string> = { 2: 'image', 3: 'video', 4: 'audio', 5: 'group' };

export const ASSET_TYPES = ['image', 'video', 'audio'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

/** Directory name used by `export` for each media type. */
export const TYPE_DIRS: Record<string, string> = { image: 'images', video: 'videos', audio: 'audio' };

/** Default file extension when the URL carries none. */
export const TYPE_EXTS: Record<string, string> = { image: 'png', video: 'mp4', audio: 'wav' };

// ── Auth ────────────────────────────────────────────────────────────────────

/** Read the `usertoken` cookie from the logged-in page. */
export async function getToken(page: any): Promise<string> {
    const raw = await page.evaluate('document.cookie');
    const m = String(raw ?? '').match(/usertoken=([^;]+)/);
    if (!m) {
        throw new AuthRequiredError(
            LIBTV_DOMAIN,
            'LibTV session not found (usertoken cookie missing).',
            'Log in at https://www.liblib.tv first, then retry.',
        );
    }
    return decodeURIComponent(m[1]);
}

// ── API plumbing ────────────────────────────────────────────────────────────

interface ApiOptions {
    method?: 'GET' | 'POST';
    body?: unknown;
    timeoutMs?: number;
}

/**
 * Call a LibTV JSON endpoint with the session token.
 * Returns `data` on `code === 0`, throws a typed error otherwise.
 */
export async function callApi(page: any, host: string, apiPath: string, opts: ApiOptions = {}): Promise<any> {
    const token = await getToken(page);
    const method = opts.method ?? 'POST';
    const res: any = await page.fetchJson(`${host}${apiPath}`, {
        method,
        headers: {
            token,
            webid: await getWebId(page),
            'x-client-type': 'web',
            'x-language': 'zh',
        },
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        timeoutMs: opts.timeoutMs ?? 60_000,
    });
    // Runtime shapes differ by opencli version: some builds return the raw
    // JSON body, others a `{ ok, status, text }` envelope. Accept both.
    if (res === null || res === undefined) {
        throw new CommandExecutionError(`LibTV API ${method} ${apiPath} returned an empty response.`);
    }
    let body: any;
    if (typeof res === 'object' && typeof (res as any).text === 'string') {
        if ((res as any).ok === false) {
            throw new CommandExecutionError(
                `LibTV API ${method} ${apiPath} failed: HTTP ${(res as any).status ?? 0} ${(res as any).statusText ?? ''}`,
            );
        }
        try {
            body = JSON.parse((res as any).text);
        } catch {
            throw new CommandExecutionError(
                `LibTV API ${method} ${apiPath} returned non-JSON: ${String((res as any).text).slice(0, 120)}`,
            );
        }
    } else {
        body = res;
    }
    const code = body?.code;
    if (code !== 0 && code !== '0') {
        const msg = body?.msg ? ` — ${body.msg}` : '';
        if (String(code) === '10001') {
            throw new AuthRequiredError(
                LIBTV_DOMAIN,
                `LibTV says "not authorised" (code 10001)${msg}`,
                'Re-open https://www.liblib.tv in the browser and make sure you are signed in.',
            );
        }
        throw new CommandExecutionError(`LibTV API ${method} ${apiPath} error ${code}${msg}`);
    }
    return body?.data;
}

async function getWebId(page: any): Promise<string> {
    const raw = await page.evaluate('document.cookie');
    const m = String(raw ?? '').match(/(?:^|;\s*)webid=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
}

// ── Projects ────────────────────────────────────────────────────────────────

export interface LibtvProject {
    id: number;
    uuid: string;
    name: string;
    folderId: number;
    projectSpaceId: number;
    projectType: number;
    updatedAtMs: number;
    createdAtMs: number;
    url: string;
}

const PROJECT_PAGE_SIZE = 50;

/**
 * Page through `/api/canvas/project/list`.
 * `limit` caps returned rows; `search` is a case-insensitive name substring.
 */
export async function listProjects(
    page: any,
    { limit = 200, search = '' }: { limit?: number; search?: string } = {},
): Promise<LibtvProject[]> {
    const needle = search.trim().toLowerCase();
    const out: LibtvProject[] = [];
    let pageNum = 1;
    let total = Infinity;
    while (out.length < limit && pageNum <= 40 && (pageNum - 1) * PROJECT_PAGE_SIZE < total) {
        const data = await callApi(page, CANVAS_HOST, '/api/canvas/project/list', {
            body: { page: pageNum, pageSize: PROJECT_PAGE_SIZE },
        });
        const items: any[] = Array.isArray(data?.projectMetaList) ? data.projectMetaList : [];
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

function mapProject(it: any): LibtvProject | null {
    const uuid = it?.uuid ?? it?.projectUuid;
    if (!uuid) return null;
    return {
        id: Number(it?.id ?? 0),
        uuid: String(uuid),
        name: String(it?.name ?? '(untitled)'),
        folderId: Number(it?.folderId ?? 0),
        projectSpaceId: Number(it?.projectSpaceId ?? it?.folderId ?? 0),
        projectType: Number(it?.projectType ?? 0),
        updatedAtMs: Number(it?.updatedAtMs ?? 0),
        createdAtMs: Number(it?.createdAtMs ?? 0),
        url: canvasUrl(String(uuid)),
    };
}

/**
 * Resolve a project reference — uuid, numeric id, or name substring —
 * into a full project record (needed for `projectSpaceId`).
 */
export async function resolveProject(page: any, ref: string, limit = 400): Promise<LibtvProject> {
    const needle = String(ref ?? '').trim();
    if (!needle) throw new CommandExecutionError('A project id, uuid or name is required.');

    // Exact uuid / id match is the common case — avoid paging everything.
    const all = await listProjects(page, { limit });
    const exact = all.find((p) => p.uuid === needle || String(p.id) === needle);
    if (exact) return exact;

    const lower = needle.toLowerCase();
    const byName = all.filter((p) => p.name.toLowerCase().includes(lower));
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
        throw new CommandExecutionError(
            `"${needle}" matches ${byName.length} projects: ${byName.slice(0, 8).map((p) => `${p.name} (${p.uuid})`).join(', ')}` +
                '. Pass the exact uuid instead.',
        );
    }
    throw new CommandExecutionError(
        `No LibTV project matches "${needle}". Run \`opencli libtv projects\` to list them.`,
    );
}

// ── Canvas graph ────────────────────────────────────────────────────────────

export interface LibtvGroup {
    key: string;
    name: string;
    childCount: number;
    roleId: string;
}

export interface LibtvAsset {
    project: string;
    projectUuid: string;
    group: string;
    type: AssetType;
    name: string;
    model: string;
    width: number | '';
    height: number | '';
    durationSec: number | '';
    bytes: number;
    mime: string;
    prompt: string;
    nodeKey: string;
    url: string;
    ext: string;
}

export interface LibtvCanvas {
    project: LibtvProject;
    nodes: any[];
    edges: any[];
    groups: LibtvGroup[];
    assets: LibtvAsset[];
    flatNodes: LibtvFlatNode[];
    nodeCount: number;
}

export interface LibtvFlatNode {
    nodeKey: string;
    name: string;
    type: string;
    model: string;
    group: string;
    width: number | '';
    height: number | '';
    durationSec: number | '';
    bytes: number;
    url: string;
}

/** Parse a node's `data` field (JSON string in practice, object defensively). */
function nodeData(node: any): any {
    const d = node?.data;
    if (!d) return {};
    if (typeof d === 'object') return d;
    try {
        return JSON.parse(d);
    } catch {
        return {};
    }
}

/** Collect every asset URL on a node, stripping OSS thumbnail transforms. */
function nodeUrls(data: any): string[] {
    const raw = data?.url;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list
        .filter((u: unknown): u is string => typeof u === 'string' && /^https?:\/\//.test(u))
        .map((u: string) => u.split('?x-oss-process=')[0]);
}

export function extOf(url: string, type: string): string {
    const pathname = url.split('?')[0].split('#')[0];
    const base = pathname.split('/').pop() ?? '';
    const dot = base.lastIndexOf('.');
    const ext = dot > -1 ? base.slice(dot + 1).toLowerCase() : '';
    return /^[a-z0-9]{1,5}$/.test(ext) ? ext : TYPE_EXTS[type] ?? 'bin';
}

/** Fetch and normalise one canvas. */
export async function fetchCanvas(page: any, project: LibtvProject): Promise<LibtvCanvas> {
    const spaceId = project.projectSpaceId;
    const data = await callApi(
        page,
        CANVAS_HOST,
        `/api/canvas/project/detail-by-space?spaceId=${encodeURIComponent(String(spaceId))}&projectUuid=${encodeURIComponent(project.uuid)}`,
        { method: 'GET' },
    );
    const detail = data?.projectDetail;
    if (!detail) {
        throw new CommandExecutionError(
            `Canvas ${project.uuid} returned no projectDetail (is the canvas empty or deleted?).`,
        );
    }
    return parseCanvas(project, detail);
}

export function parseCanvas(project: LibtvProject, detail: any): LibtvCanvas {
    const nodes: any[] = Array.isArray(detail?.nodeList) ? detail.nodeList : [];
    const edges: any[] = Array.isArray(detail?.connectionList) ? detail.connectionList : [];

    const groups: LibtvGroup[] = [];
    const groupName = new Map<string, string>();
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
            roleId: ca?.roleId ? String(ca.roleId) : '',
        });
    }

    const assets: LibtvAsset[] = [];
    const flatNodes: LibtvFlatNode[] = [];
    for (const n of nodes) {
        const typeNum = Number(n?.type);
        const type = NODE_TYPES[typeNum] ?? 'other';
        const data = nodeData(n);
        const urls = nodeUrls(data);
        const metaItems = data?._resourceMeta?.items;
        const meta = Array.isArray(metaItems) && metaItems.length ? metaItems[0] : {};
        const group = groupName.get(String(n?.parentKey ?? '')) ?? '';
        const base = {
            nodeKey: String(n?.nodeKey ?? ''),
            name: String(n?.name ?? '(untitled)'),
            type,
            model: String(n?.toolKey || data?.params?.model || '-'),
            group,
            width: meta?.width ?? '',
            height: meta?.height ?? '',
            durationSec: meta?.durationSec ?? '',
            bytes: Number(meta?.byteSize ?? 0),
        };
        flatNodes.push({ ...base, url: urls[0] ?? '' });
        if (typeNum === 5 || !urls.length) continue;
        const prompt =
            String(data?.params?.prompt ?? '') ||
            (Array.isArray(data?.params?.textList) ? data.params.textList.join('\n') : '');
        for (const url of urls) {
            assets.push({
                ...base,
                project: project.name,
                projectUuid: project.uuid,
                type: type as AssetType,
                mime: String(meta?.mimeType ?? ''),
                prompt,
                url,
                ext: extOf(url, type),
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
        nodeCount: nodes.length,
    };
}

/** Convenience: resolve a project ref and load its canvas in one go. */
export async function loadCanvas(page: any, ref: string): Promise<LibtvCanvas> {
    const project = await resolveProject(page, ref);
    return fetchCanvas(page, project);
}

// ── Account / library endpoints ─────────────────────────────────────────────

export interface LibtvAccount {
    name: string;
    level: string;
    packageType: string;
    totalPower: number;
    usablePower: number;
    libtvUsablePower: number;
    usedPower: number;
    freePower: number;
    concurrent: number;
    downloadCount: number;
}

export async function readAccount(page: any): Promise<LibtvAccount> {
    const acc = await callApi(page, WWW_HOST, '/api/www/member/account?isApp=false', { method: 'GET' });
    const attr = acc?.attr ?? {};
    let freePower = 0;
    try {
        const fp = await callApi(page, WWW_HOST, '/api/www/member/libtvFreePower', { body: {} });
        freePower = Number(fp?.freePower ?? 0);
    } catch {
        // Free-power endpoint is optional (not every account has it).
    }
    return {
        name: String(acc?.name ?? ''),
        level: String(acc?.accountLevelName ?? ''),
        packageType: String(acc?.packageType ?? ''),
        totalPower: Number(attr?.totalPower ?? 0),
        usablePower: Number(attr?.usablePower ?? 0),
        libtvUsablePower: Number(attr?.libtvUsablePower ?? 0),
        usedPower: Number(attr?.usedPower ?? 0),
        freePower,
        concurrent: Number(attr?.concurrent ?? 0),
        downloadCount: Number(attr?.downloadCount ?? 0),
    };
}

export interface LibtvCharacter {
    uuid: string;
    name: string;
    gender: string;
    ageStage: string;
    region: string;
    era: string;
    version: number;
    cover: string;
    updatedAtMs: number;
}

export async function listCharacters(page: any, limit = 100): Promise<LibtvCharacter[]> {
    const out: LibtvCharacter[] = [];
    let pageNum = 1;
    while (out.length < limit && pageNum <= 20) {
        const data = await callApi(page, CANVAS_HOST, '/api/user/character/list', {
            body: { page: pageNum, pageSize: 50 },
        });
        const items: any[] = Array.isArray(data?.list) ? data.list : [];
        for (const it of items) {
            out.push({
                uuid: String(it?.characterUuid ?? ''),
                name: String(it?.name ?? ''),
                gender: String(it?.gender ?? ''),
                ageStage: String(it?.ageStage ?? ''),
                region: String(it?.region ?? ''),
                era: String(it?.era ?? ''),
                version: Number(it?.currentVersion ?? 0),
                cover: String(it?.coverUrl ?? ''),
                updatedAtMs: Number(it?.updatedAtMs ?? 0),
            });
            if (out.length >= limit) break;
        }
        if (!data?.hasMore || items.length === 0) break;
        pageNum++;
    }
    return out;
}

export interface LibtvArtifact {
    artifactId: string;
    taskId: string;
    mediaType: string;
    projectUuid: string;
    nodeKey: string;
    rating: number;
    width: string;
    height: string;
    url: string;
    createdAtMs: number;
}

export async function listArtifacts(
    page: any,
    { limit = 50, projectUuid = '', mediaType = '' }: { limit?: number; projectUuid?: string; mediaType?: string } = {},
): Promise<LibtvArtifact[]> {
    const out: LibtvArtifact[] = [];
    let pageNum = 1;
    while (out.length < limit && pageNum <= 40) {
        const data = await callApi(page, CANVAS_HOST, '/api/task/artifact/list', {
            body: { page: pageNum, pageSize: 50, projectUuid: projectUuid || undefined },
        });
        const items: any[] = Array.isArray(data?.list) ? data.list : [];
        for (const it of items) {
            const media = String(it?.mediaType ?? '');
            if (mediaType && media !== mediaType) continue;
            if (projectUuid && String(it?.projectUuid ?? '') !== projectUuid) continue;
            let extra: any = {};
            try {
                extra = typeof it?.extra === 'string' ? JSON.parse(it.extra) : it?.extra ?? {};
            } catch {
                extra = {};
            }
            out.push({
                artifactId: String(it?.artifactId ?? ''),
                taskId: String(it?.taskId ?? ''),
                mediaType: media,
                projectUuid: String(it?.projectUuid ?? ''),
                nodeKey: String(it?.nodeKey ?? ''),
                rating: Number(it?.rating ?? 0),
                width: extra?.width ? String(extra.width) : '',
                height: extra?.height ? String(extra.height) : '',
                url: String(it?.previewPath ?? ''),
                createdAtMs: Number(it?.createdAtMs ?? 0),
            });
            if (out.length >= limit) break;
        }
        if (items.length < 50) break;
        pageNum++;
    }
    return out;
}

export interface LibtvWorkflow {
    uuid: string;
    name: string;
    updatedAtMs: number;
}

export async function listWorkflows(page: any, limit = 100): Promise<LibtvWorkflow[]> {
    const data = await callApi(page, CANVAS_HOST, '/api/canvas/workflow/list', {
        body: { page: 1, pageSize: Math.min(Math.max(limit, 1), 200) },
    });
    const items: any[] = Array.isArray(data?.workflowList) ? data.workflowList : [];
    return items.slice(0, limit).map((it) => ({
        uuid: String(it?.uuid ?? it?.workflowUuid ?? ''),
        name: String(it?.name ?? '(untitled)'),
        updatedAtMs: Number(it?.updatedAtMs ?? 0),
    }));
}

export interface LibtvVersion {
    versionId: string;
    name: string;
    createdAtMs: number;
}

export async function listVersions(page: any, project: LibtvProject, limit = 50): Promise<LibtvVersion[]> {
    const data = await callApi(page, CANVAS_HOST, '/api/canvas/project/version/list', {
        body: { projectUuid: project.uuid, page: 1, pageSize: Math.min(Math.max(limit, 1), 100) },
    });
    const items: any[] = Array.isArray(data?.versionList) ? data.versionList : [];
    return items.slice(0, limit).map((it) => ({
        versionId: String(it?.versionId ?? it?.id ?? ''),
        name: String(it?.versionName ?? it?.name ?? ''),
        createdAtMs: Number(it?.createdAtMs ?? it?.createAtMs ?? 0),
    }));
}

// ── Export ──────────────────────────────────────────────────────────────────

/** Filesystem-safe file/dir name that keeps CJK characters readable. */
export function safeName(input: string, max = 70): string {
    const cleaned = String(input ?? '')
        .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+$/, '')
        .slice(0, max)
        .trim();
    return cleaned || 'unnamed';
}

export interface PlannedFile {
    asset: LibtvAsset;
    /** Path relative to the export root. */
    relPath: string;
}

/**
 * Plan the export tree: `<group>/<typeDir>/<NNN_name_nodeKey>.<ext>`.
 * Projects without groups drop the group level entirely.
 */
export function planExport(canvas: LibtvCanvas, opts: { types?: string[] } = {}): PlannedFile[] {
    const wanted = opts.types && opts.types.length ? new Set(opts.types) : null;
    const hasGroups = canvas.groups.length > 0;
    const counters: Record<string, number> = {};
    const planned: PlannedFile[] = [];
    for (const a of canvas.assets) {
        if (wanted && !wanted.has(a.type)) continue;
        const typeDir = TYPE_DIRS[a.type] ?? a.type;
        const groupDir = hasGroups ? safeName(a.group || '_ungrouped', 60) : '';
        const bucket = `${groupDir}/${typeDir}`;
        counters[bucket] = (counters[bucket] ?? 0) + 1;
        const seq = String(counters[bucket]).padStart(3, '0');
        const fileName = `${seq}_${safeName(a.name)}_${a.nodeKey}.${a.ext}`;
        planned.push({ asset: a, relPath: path.posix.join(...[groupDir, typeDir, fileName].filter(Boolean)) });
    }
    return planned;
}

export interface DownloadResult {
    relPath: string;
    status: 'ok' | 'skipped' | 'failed';
    bytes: number;
    error?: string;
}

/** Download one file with content-length verification and retries. */
async function downloadFile(url: string, dest: string, expectedBytes: number, retries = 4): Promise<number> {
    let lastErr = '';
    for (let attempt = 0; attempt < retries; attempt++) {
        const tmp = `${dest}.part`;
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; opencli-libtv)' },
                redirect: 'follow',
            });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmp));
            const got = fs.statSync(tmp).size;
            const declared = Number(res.headers.get('content-length') ?? 0);
            const want = declared || expectedBytes;
            if (want && got !== want) throw new Error(`size mismatch (${got}/${want})`);
            fs.renameSync(tmp, dest);
            return got;
        } catch (err) {
            lastErr = err instanceof Error ? err.message : String(err);
            try {
                fs.rmSync(tmp, { force: true });
            } catch {
                /* ignore */
            }
            await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        }
    }
    throw new Error(lastErr || 'download failed');
}

/**
 * Download a planned file list into `outDir`.
 * `onProgress` is called after every finished file (used for stderr progress).
 */
export async function runExport(
    planned: PlannedFile[],
    outDir: string,
    opts: { concurrency?: number; overwrite?: boolean; onProgress?: (done: number, total: number, r: DownloadResult) => void } = {},
): Promise<DownloadResult[]> {
    const concurrency = Math.max(1, Math.min(opts.concurrency ?? 6, 16));
    const results: DownloadResult[] = new Array(planned.length);
    let cursor = 0;
    let done = 0;

    const worker = async () => {
        while (true) {
            const i = cursor++;
            if (i >= planned.length) return;
            const job = planned[i];
            const dest = path.join(outDir, job.relPath);
            let result: DownloadResult;
            try {
                if (!opts.overwrite && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
                    result = { relPath: job.relPath, status: 'skipped', bytes: fs.statSync(dest).size };
                } else {
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    const bytes = await downloadFile(job.asset.url, dest, job.asset.bytes);
                    result = { relPath: job.relPath, status: 'ok', bytes };
                }
            } catch (err) {
                result = {
                    relPath: job.relPath,
                    status: 'failed',
                    bytes: 0,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
            results[i] = result;
            opts.onProgress?.(++done, planned.length, result);
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return results;
}

/** Write a UTF-8 (BOM) CSV manifest for one exported canvas. */
export function writeManifest(
    outDir: string,
    canvas: LibtvCanvas,
    planned: PlannedFile[],
    results: DownloadResult[],
): string {
    const byRel = new Map(results.map((r) => [r.relPath, r]));
    const header = ['group', 'type', 'name', 'model', 'width', 'height', 'duration_sec', 'bytes', 'rel_path', 'node_key', 'url'];
    const rows = planned.map((p) => {
        const a = p.asset;
        const r = byRel.get(p.relPath);
        return [
            a.group || '',
            a.type,
            a.name,
            a.model,
            a.width === '' ? '' : String(a.width),
            a.height === '' ? '' : String(a.height),
            a.durationSec === '' ? '' : String(a.durationSec),
            String(r?.bytes ?? a.bytes),
            p.relPath,
            a.nodeKey,
            a.url,
        ];
    });
    const csv = [header, ...rows]
        .map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
        .join('\n');
    const manifestPath = path.join(outDir, 'manifest.csv');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(manifestPath, `\uFEFF${csv}\n`, 'utf-8');
    return manifestPath;
}

// ── Misc formatting ─────────────────────────────────────────────────────────

export function formatDate(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function mb(bytes: number): number {
    return Math.round((Number(bytes) / 1048576) * 100) / 100;
}

export function sumBytes(assets: LibtvAsset[]): number {
    return assets.reduce((acc, a) => acc + (Number(a.bytes) || 0), 0);
}

export function byType(assets: LibtvAsset[], type: string): LibtvAsset[] {
    return assets.filter((a) => a.type === type);
}
