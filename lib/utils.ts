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

interface LibtvAuth {
    token: string;
    webid: string;
}

/** Read one cookie value from a raw `document.cookie` string. */
function cookieValue(cookie: string, name: string): string {
    const m = String(cookie ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    if (!m) return '';
    try {
        return decodeURIComponent(m[1]);
    } catch {
        return m[1];
    }
}

/** Read `usertoken` + `webid` in a single page evaluation. */
export async function getAuth(page: any): Promise<LibtvAuth> {
    const raw = String((await page.evaluate('document.cookie')) ?? '');
    const token = cookieValue(raw, 'usertoken');
    if (!token) {
        throw new AuthRequiredError(
            LIBTV_DOMAIN,
            'LibTV session not found (usertoken cookie missing).',
            'Log in at https://www.liblib.tv first, then retry.',
        );
    }
    return { token, webid: cookieValue(raw, 'webid') };
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
    const auth = await getAuth(page);
    const method = opts.method ?? 'POST';
    let res: any;
    try {
        res = await page.fetchJson(`${host}${apiPath}`, {
            method,
            headers: {
                token: auth.token,
                webid: auth.webid,
                'x-client-type': 'web',
                'x-language': 'zh',
            },
            ...(opts.body !== undefined ? { body: opts.body } : {}),
            timeoutMs: opts.timeoutMs ?? 60_000,
        });
    } catch (err: any) {
        const message = String(err?.message ?? err);
        // page.fetchJson throws on HTTP errors; surface auth failures as such
        // instead of a generic "fetch failed".
        if (/(^|\D)(401|403)(\D|$)/.test(message) || /unauthori[sz]ed|forbidden/i.test(message)) {
            throw new AuthRequiredError(
                LIBTV_DOMAIN,
                `LibTV rejected the request (HTTP 401/403): ${message}`,
                'Re-open https://www.liblib.tv and make sure you are signed in.',
            );
        }
        throw new CommandExecutionError(`LibTV API ${method} ${apiPath} request failed: ${message}`);
    }
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
 * `limit` caps returned rows; `search` is a case-insensitive name substring;
 * `spaceId` restricts the listing to one space/folder.
 */
export async function listProjects(
    page: any,
    { limit = 200, search = '', spaceId = 0 }: { limit?: number; search?: string; spaceId?: number } = {},
): Promise<LibtvProject[]> {
    const needle = search.trim().toLowerCase();
    const out: LibtvProject[] = [];
    let pageNum = 1;
    let total = Infinity;
    while (out.length < limit && pageNum <= 40 && (pageNum - 1) * PROJECT_PAGE_SIZE < total) {
        const data = await callApi(page, CANVAS_HOST, '/api/canvas/project/list', {
            body: {
                page: pageNum,
                pageSize: PROJECT_PAGE_SIZE,
                ...(spaceId > 0 ? { folderId: spaceId } : {}),
            },
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

/** Canonical 32-char hex project uuid. */
const UUID_RE = /^[0-9a-f]{32}$/i;

/**
 * What a `<project>` argument turned out to be.
 * `spaceId` is only a hint — canvas loading no longer requires it.
 */
export interface ProjectRef {
    kind: 'url' | 'uuid' | 'id' | 'name';
    uuid: string;
    numericId: number;
    spaceId: number;
    /** Detailed error string when the argument looked like a URL but had no project id. */
    problem?: string;
}

/**
 * Parse a `<project>` argument. Accepts, in this order:
 *
 *   https://www.liblib.tv/canvas?spaceId=10001&projectId=0123456789abcdef0123456789abcdef
 *   https://www.liblib.tv/canvas?projectId=0123456789abcdef0123456789abcdef  (spaceId optional)
 *   .../canvas/0123456789abcdef0123456789abcdef               (uuid in the path)
 *   0123456789abcdef0123456789abcdef                          (bare uuid)
 *   1000001                                                   (numeric project id)
 *   demo                                                      (name substring)
 *
 * URL params checked for the uuid: `projectId`, `projectUuid`, `uuid`, `canvasId`.
 * Space hints: `spaceId`, `projectSpaceId`, `folderId`.
 */
export function parseProjectRef(ref: string): ProjectRef {
    const raw = String(ref ?? '').trim();
    if (!raw) return { kind: 'name', uuid: '', numericId: 0, spaceId: 0, problem: 'empty' };

    if (/^https?:\/\//i.test(raw)) {
        let url: URL | null = null;
        try {
            url = new URL(raw);
        } catch {
            return { kind: 'url', uuid: '', numericId: 0, spaceId: 0, problem: 'malformed URL' };
        }
        const params = url.searchParams;
        let uuid = '';
        let numericId = 0;
        for (const key of ['projectId', 'projectUuid', 'uuid', 'canvasId', 'canvasUuid']) {
            const value = (params.get(key) ?? '').trim();
            if (!value) continue;
            if (UUID_RE.test(value)) {
                uuid = value.toLowerCase();
                break;
            }
            if (/^\d+$/.test(value) && !numericId) numericId = Number(value);
        }
        if (!uuid && !numericId) {
            // Some routes carry the uuid as a path segment instead of a param.
            const hit = url.pathname.match(/[0-9a-f]{32}/i);
            if (hit) uuid = hit[0].toLowerCase();
        }
        const spaceRaw = (
            params.get('spaceId') ??
            params.get('projectSpaceId') ??
            params.get('folderId') ??
            ''
        ).trim();
        const spaceId = /^\d+$/.test(spaceRaw) ? Number(spaceRaw) : 0;
        return {
            kind: 'url',
            uuid,
            numericId,
            spaceId,
            problem: uuid || numericId ? undefined : 'no projectId/projectUuid in the URL',
        };
    }

    if (UUID_RE.test(raw)) return { kind: 'uuid', uuid: raw.toLowerCase(), numericId: 0, spaceId: 0 };
    if (/^\d+$/.test(raw)) return { kind: 'id', uuid: '', numericId: Number(raw), spaceId: 0 };
    return { kind: 'name', uuid: '', numericId: 0, spaceId: 0 };
}

/** Bare project record for a known uuid — filled in from `projectMeta` on load. */
function stubProject(uuid: string, spaceId = 0): LibtvProject {
    return {
        id: 0,
        uuid,
        name: '',
        folderId: 0,
        projectSpaceId: spaceId,
        projectType: 0,
        updatedAtMs: 0,
        createdAtMs: 0,
        url: canvasUrl(uuid),
    };
}

/**
 * Resolve a `<project>` argument into a project record.
 *
 * URLs and bare uuids resolve **without any API call** — canvas loading only
 * needs the uuid, and the real name/space/id come back in `projectMeta`.
 * Numeric ids and names fall back to paging `/api/canvas/project/list`.
 */
export async function resolveProject(page: any, ref: string, limit = 400): Promise<LibtvProject> {
    const parsed = parseProjectRef(ref);
    const needle = String(ref ?? '').trim();

    if (parsed.kind === 'url' && parsed.problem) {
        throw new CommandExecutionError(
            `Could not read a project id from "${needle}" (${parsed.problem}). ` +
                'Expected a canvas URL like https://www.liblib.tv/canvas?projectId=<uuid>.',
        );
    }
    if (parsed.uuid) return stubProject(parsed.uuid, parsed.spaceId);
    if (!needle) throw new CommandExecutionError('A project URL, uuid, id or name is required.');

    const all = await listProjects(page, { limit });
    if (parsed.kind === 'id' || parsed.numericId) {
        const byId = all.find((p) => p.id === parsed.numericId);
        if (byId) return byId;
        if (parsed.kind === 'url') {
            throw new CommandExecutionError(
                `No LibTV project with id ${parsed.numericId}. Run \`opencli libtv projects\` to list them.`,
            );
        }
        // A bare number can also be a project *name* (some canvases are named
        // like "20261111"), so fall through to name matching before failing.
    }

    const lower = needle.toLowerCase();
    const byName = all.filter((p) => p.name.toLowerCase().includes(lower));
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
        throw new CommandExecutionError(
            `"${needle}" matches ${byName.length} projects: ${byName.slice(0, 8).map((p) => `${p.name} (${p.uuid})`).join(', ')}` +
                '. Pass the exact uuid or a canvas URL instead.',
        );
    }
    throw new CommandExecutionError(
        `No LibTV project matches "${needle}". Run \`opencli libtv projects\` to list them, ` +
            'or pass the canvas URL directly.',
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
    /** nodeKey of the owning group node ('' when ungrouped). */
    groupKey: string;
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
    /** nodeKey of the owning group node ('' when ungrouped). */
    groupKey: string;
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

/**
 * Fill in the real name/id/space/timestamps for a canvas.
 *
 * A `<project>` argument may arrive as a bare uuid or URL, in which case the
 * record is only a stub — `projectMeta` in the canvas payload is authoritative.
 */
export function enrichProject(project: LibtvProject, meta: any): LibtvProject {
    if (!meta || typeof meta !== 'object') return project;
    const uuid = String(meta.uuid ?? project.uuid);
    return {
        id: Number(meta.id ?? project.id) || project.id,
        uuid,
        name: String(meta.name ?? project.name ?? '') || uuid.slice(0, 8),
        folderId: Number(meta.folderId ?? project.folderId) || project.folderId,
        projectSpaceId: Number(meta.projectSpaceId ?? project.projectSpaceId) || project.projectSpaceId,
        projectType: Number(meta.projectType ?? project.projectType) || project.projectType,
        updatedAtMs: Number(meta.updatedAtMs ?? project.updatedAtMs) || project.updatedAtMs,
        createdAtMs: Number(meta.createdAtMs ?? project.createdAtMs) || project.createdAtMs,
        url: canvasUrl(uuid),
    };
}

/**
 * Fetch and normalise one canvas.
 *
 * Primary endpoint is `GET /api/canvas/project/detail?uuid=` — it needs no
 * spaceId, so a pasted canvas URL is enough. Older `detail-by-space` (nested
 * under `projectDetail`) is kept as a fallback for shapes it alone serves.
 */
export async function fetchCanvas(page: any, project: LibtvProject): Promise<LibtvCanvas> {
    let detail: any = null;
    let lastError: unknown = null;

    try {
        const data = await callApi(page, CANVAS_HOST, `/api/canvas/project/detail?uuid=${encodeURIComponent(project.uuid)}`, {
            method: 'GET',
        });
        // Accept both shapes: the payload directly, or wrapped in projectDetail.
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
                { method: 'GET' },
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
            `Canvas ${project.uuid} could not be loaded (empty, deleted, or not shared with this account?).`,
        );
    }
    return parseCanvas(enrichProject(project, detail.projectMeta), detail);
}

export function parseCanvas(project: LibtvProject, detail: any): LibtvCanvas {
    const nodes: any[] = Array.isArray(detail?.nodeList) ? detail.nodeList : [];
    const edges: any[] = Array.isArray(detail?.connectionList) ? detail.connectionList : [];

    const groups: LibtvGroup[] = [];
    const groupName = new Map<string, string>();
    /** child nodeKey → owning group nodeKey (the group's `childNodeIds` list). */
    const childGroup = new Map<string, string>();
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
            roleId: ca?.roleId ? String(ca.roleId) : '',
        });
    }
    /** Membership is `parentKey` when it points at a group, else the group's childNodeIds. */
    const groupKeyOf = (n: any): string => {
        const parent = String(n?.parentKey ?? '');
        if (groupName.has(parent)) return parent;
        return childGroup.get(String(n?.nodeKey ?? '')) ?? '';
    };

    const assets: LibtvAsset[] = [];
    const flatNodes: LibtvFlatNode[] = [];
    for (const n of nodes) {
        const typeNum = Number(n?.type);
        const type = NODE_TYPES[typeNum] ?? 'other';
        const data = nodeData(n);
        const urls = nodeUrls(data);
        const metaItems = data?._resourceMeta?.items;
        const metaList: any[] = Array.isArray(metaItems) ? metaItems : [];
        const groupKey = groupKeyOf(n);
        const group = groupKey ? groupName.get(groupKey) ?? '' : '';
        const identity = {
            nodeKey: String(n?.nodeKey ?? ''),
            name: String(n?.name ?? '(untitled)'),
            type,
            model: String(n?.toolKey || data?.params?.model || '-'),
            group,
            groupKey,
        };
        const firstMeta = metaList[0] ?? {};
        flatNodes.push({
            ...identity,
            width: firstMeta.width ?? '',
            height: firstMeta.height ?? '',
            durationSec: firstMeta.durationSec ?? '',
            bytes: Number(firstMeta.byteSize ?? 0),
            url: urls[0] ?? '',
        });
        if (typeNum === 5 || !urls.length) continue;
        const prompt =
            String(data?.params?.prompt ?? '') ||
            (Array.isArray(data?.params?.textList) ? data.params.textList.join('\n') : '');
        // A node may carry several URLs; align each with its own metadata entry
        // (falling back to the first) so sizes/dimensions are not double-counted.
        for (let i = 0; i < urls.length; i++) {
            const meta = metaList[i] ?? firstMeta;
            const url = urls[i];
            assets.push({
                ...identity,
                project: project.name,
                projectUuid: project.uuid,
                type: type as AssetType,
                width: meta?.width ?? '',
                height: meta?.height ?? '',
                durationSec: meta?.durationSec ?? '',
                bytes: Number(meta?.byteSize ?? 0),
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

// ── Account ─────────────────────────────────────────────────────────────────

export interface LibtvAccount {
    name: string;
    level: string;
    packageType: string;
    totalPower: number;
    usablePower: number;
    libtvUsablePower: number;
    freePower: number;
    concurrent: number;
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
        freePower,
        concurrent: Number(attr?.concurrent ?? 0),
    };
}

// ── Export ──────────────────────────────────────────────────────────────────

/** Windows device names that cannot be used as a file/dir base name. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Filesystem-safe file/dir name that keeps CJK characters readable. */
export function safeName(input: string, max = 70): string {
    const cleaned = String(input ?? '')
        .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/, '') // trailing dots/spaces are invalid on Windows
        .slice(0, max)
        .trim()
        .replace(/[. ]+$/, '');
    const base = cleaned || 'unnamed';
    return WINDOWS_RESERVED.test(base) ? `_${base}` : base;
}

/** Trim a string to at most `maxBytes` UTF-8 bytes without splitting CJK characters. */
export function trimToBytes(input: string, maxBytes: number): string {
    let out = '';
    let bytes = 0;
    for (const ch of String(input ?? '')) {
        const size = Buffer.byteLength(ch, 'utf8');
        if (bytes + size > maxBytes) break;
        out += ch;
        bytes += size;
    }
    return out;
}

export interface PlannedFile {
    asset: LibtvAsset;
    /** Path relative to the export root. */
    relPath: string;
}

/**
 * Folder name per group node key. Distinct groups may share a display name;
 * when they do, a short suffix from the group node key keeps their export
 * folders apart instead of silently merging them.
 */
function groupDirs(canvas: LibtvCanvas): Map<string, string> {
    const counts = new Map<string, number>();
    for (const g of canvas.groups) counts.set(g.name, (counts.get(g.name) ?? 0) + 1);
    const dirs = new Map<string, string>();
    for (const g of canvas.groups) {
        const duplicate = (counts.get(g.name) ?? 0) > 1;
        const label = duplicate ? `${g.name} (${g.key.slice(-6)})` : g.name;
        dirs.set(g.key, safeName(label, 60));
    }
    return dirs;
}

/** File name for one asset: `NNN_name_nodeKey.ext`, bounded in UTF-8 bytes. */
function fileNameFor(seq: string, asset: LibtvAsset): string {
    const prefix = `${seq}_`;
    const suffix = `_${safeName(asset.nodeKey, 24)}`;
    const ext = asset.ext;
    // Keep the whole component under 190 bytes, leaving headroom below the
    // common 255-byte per-component limit even for long CJK names.
    const budget = 190 - Buffer.byteLength(prefix + suffix, 'utf8') - Buffer.byteLength(ext, 'utf8') - 1;
    const name = trimToBytes(safeName(asset.name, 60), Math.max(16, budget));
    return `${prefix}${name}${suffix}.${ext}`;
}

/**
 * Plan the export tree: `<group>/<typeDir>/<NNN_name_nodeKey>.<ext>`.
 * Projects without groups drop the group level entirely.
 */
export function planExport(canvas: LibtvCanvas, opts: { types?: string[] } = {}): PlannedFile[] {
    const wanted = opts.types && opts.types.length ? new Set(opts.types) : null;
    const hasGroups = canvas.groups.length > 0;
    const dirs = groupDirs(canvas);
    const counters: Record<string, number> = {};
    const planned: PlannedFile[] = [];
    for (const a of canvas.assets) {
        if (wanted && !wanted.has(a.type)) continue;
        const typeDir = TYPE_DIRS[a.type] ?? a.type;
        const groupDir = hasGroups
            ? a.groupKey
                ? dirs.get(a.groupKey) ?? safeName(a.group || '_ungrouped', 60)
                : '_ungrouped'
            : '';
        const bucket = `${groupDir}/${typeDir}`;
        counters[bucket] = (counters[bucket] ?? 0) + 1;
        const seq = String(counters[bucket]).padStart(3, '0');
        planned.push({ asset: a, relPath: path.posix.join(...[groupDir, typeDir, fileNameFor(seq, a)].filter(Boolean)) });
    }
    return planned;
}

export interface DownloadResult {
    relPath: string;
    status: 'ok' | 'skipped' | 'failed';
    bytes: number;
    error?: string;
}

/**
 * Download one file with size verification and retries.
 * The temporary file carries a per-file tag so concurrent exports of the same
 * canvas cannot race each other on the same `.part` path.
 */
async function downloadFile(url: string, dest: string, expectedBytes: number, tempTag: string, retries = 4): Promise<number> {
    let lastErr = '';
    const tmp = `${dest}.${tempTag}.part`;
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; opencli-libtv)' },
                redirect: 'follow',
            });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmp));
            const got = fs.statSync(tmp).size;
            // Verify against Content-Length when the CDN sends one, else the
            // declared byteSize when known.
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
                let existing = 0;
                if (!opts.overwrite && fs.existsSync(dest)) existing = fs.statSync(dest).size;
                const expected = job.asset.bytes;
                if (existing > 0 && (!expected || existing === expected)) {
                    result = { relPath: job.relPath, status: 'skipped', bytes: existing };
                } else {
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    const bytes = await downloadFile(job.asset.url, dest, expected, `${process.pid}-${i}`);
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

/** Quote one CSV cell, neutralising spreadsheet formula injection. */
function csvCell(value: unknown): string {
    const text = String(value ?? '');
    const isNumber = /^-?\d+(\.\d+)?$/.test(text);
    const safe = !isNumber && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
}

/** Write a UTF-8 (BOM) CSV manifest for one exported canvas. */
export function writeManifest(
    outDir: string,
    canvas: LibtvCanvas,
    planned: PlannedFile[],
    results: DownloadResult[],
): string {
    const byRel = new Map(results.map((r) => [r.relPath, r]));
    const header = [
        'group',
        'type',
        'name',
        'model',
        'width',
        'height',
        'duration_sec',
        'bytes',
        'status',
        'rel_path',
        'node_key',
        'url',
    ];
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
            r?.status ?? 'missing',
            p.relPath,
            a.nodeKey,
            a.url,
        ];
    });
    const csv = [header, ...rows].map((cols) => cols.map(csvCell).join(',')).join('\n');
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
