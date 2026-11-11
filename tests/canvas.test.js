/**
 * Unit tests for the pure (browser-free) parts of the LibTV adapter:
 * canvas parsing, export planning, project-reference resolution and
 * filesystem-name safety.
 *
 * Run with: npm test   (node --test tests/)
 *
 * All fixtures are synthetic: the uuid, ids, names and timestamps below are
 * placeholders and do not correspond to any real LibTV project.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
    safeName,
    trimToBytes,
    extOf,
    parseCanvas,
    planExport,
    writeManifest,
    mb,
    formatDate,
    canvasUrl,
    parseProjectRef,
    resolveProject,
    enrichProject,
} from '../lib/utils.js';

const UUID = '0123456789abcdef0123456789abcdef';

const project = {
    id: 1000001,
    uuid: UUID,
    name: 'Demo',
    folderId: 10001,
    projectSpaceId: 10001,
    projectType: 0,
    updatedAtMs: 1700000000000,
    createdAtMs: 1700000000000,
    url: canvasUrl(UUID),
};

/** Build a canvas detail payload shaped like /detail-by-space returns. */
function detailFixture() {
    return {
        nodeList: [
            {
                nodeKey: 'g-1',
                type: 5,
                name: 'characters',
                data: JSON.stringify({
                    type: 'group',
                    childNodeIds: ['i-1', 'i-2'],
                    characterAsset: { roleId: 'role-abc' },
                }),
            },
            {
                nodeKey: 'i-1',
                type: 2,
                name: 'characters · portrait',
                toolKey: 'lib-image-2.5-s',
                parentKey: 'g-1',
                data: JSON.stringify({
                    url: ['https://cdn.example.com/a/1_full.png?x-oss-process=image/resize,w_100'],
                    params: { prompt: 'a portrait, studio light' },
                    _resourceMeta: { items: [{ width: 1024, height: 1024, byteSize: 2048, mimeType: 'image/png' }] },
                }),
            },
            {
                nodeKey: 'v-1',
                type: 3,
                name: 'shot 1',
                toolKey: 'star-video2.5',
                data: JSON.stringify({
                    url: 'https://cdn.example.com/v/1.mp4',
                    params: { prompt: 'dolly in' },
                    _resourceMeta: { items: [{ width: 1920, height: 1080, durationSec: 5.05, byteSize: 4096 }] },
                }),
            },
            {
                // Media-less node — must not become an asset.
                nodeKey: 't-1',
                type: 4,
                name: 'empty audio',
                data: '{}',
            },
        ],
        connectionList: [{ id: 'e1' }],
    };
}

test('parseCanvas splits groups, assets and flat nodes', () => {
    const canvas = parseCanvas(project, detailFixture());
    assert.equal(canvas.nodeCount, 4);
    assert.equal(canvas.edges.length, 1);
    assert.equal(canvas.groups.length, 1);
    assert.equal(canvas.groups[0].name, 'characters');
    assert.equal(canvas.groups[0].childCount, 2);
    assert.equal(canvas.groups[0].roleId, 'role-abc');

    // 2 media nodes carry a URL; the media-less audio node is skipped.
    assert.equal(canvas.assets.length, 2);
    assert.equal(canvas.flatNodes.length, 4);

    const img = canvas.assets.find((a) => a.type === 'image');
    assert.ok(img);
    assert.equal(img.group, 'characters');
    assert.equal(img.groupKey, 'g-1');
    assert.equal(img.model, 'lib-image-2.5-s');
    assert.equal(img.width, 1024);
    assert.equal(img.ext, 'png');
    assert.equal(img.prompt, 'a portrait, studio light');
    // OSS thumbnail transform must be stripped to keep the original file.
    assert.equal(img.url, 'https://cdn.example.com/a/1_full.png');

    const vid = canvas.assets.find((a) => a.type === 'video');
    assert.equal(vid.durationSec, 5.05);
    assert.equal(vid.bytes, 4096);
    assert.equal(vid.group, '');
    assert.equal(vid.groupKey, '');
});

test('parseCanvas assigns membership from childNodeIds when parentKey is absent', () => {
    const detail = detailFixture();
    delete detail.nodeList[1].parentKey;
    const canvas = parseCanvas(project, detail);
    const img = canvas.assets.find((a) => a.type === 'image');
    assert.equal(img.group, 'characters');
    assert.equal(img.groupKey, 'g-1');
});

test('parseCanvas aligns multi-URL nodes with their own metadata', () => {
    const detail = {
        nodeList: [
            {
                nodeKey: 'm-1',
                type: 2,
                name: 'variants',
                data: JSON.stringify({
                    url: ['https://cdn.example.com/m/v1.png', 'https://cdn.example.com/m/v2.png'],
                    _resourceMeta: {
                        items: [
                            { width: 10, height: 20, byteSize: 100 },
                            { width: 30, height: 40, byteSize: 300 },
                        ],
                    },
                }),
            },
        ],
        connectionList: [],
    };
    const canvas = parseCanvas(project, detail);
    assert.equal(canvas.assets.length, 2);
    assert.deepEqual(
        canvas.assets.map((a) => [a.width, a.height, a.bytes]),
        [
            [10, 20, 100],
            [30, 40, 300],
        ],
    );
    // The node-level size is not duplicated into the flat-node summary.
    assert.equal(canvas.flatNodes[0].bytes, 100);
});

test('parseCanvas tolerates object-encoded node data', () => {
    const detail = detailFixture();
    detail.nodeList[1].data = {
        url: 'https://cdn.example.com/a/object.png',
        _resourceMeta: { items: [{ width: 10, height: 20 }] },
    };
    const canvas = parseCanvas(project, detail);
    const img = canvas.assets.find((a) => a.type === 'image');
    assert.equal(img.url, 'https://cdn.example.com/a/object.png');
    assert.equal(img.width, 10);
});

test('planExport mirrors groups and falls back to flat type dirs', () => {
    const grouped = planExport(parseCanvas(project, detailFixture()));
    const paths = grouped.map((p) => p.relPath).sort();
    assert.deepEqual(
        paths,
        ['characters/images/001_characters · portrait_i-1.png', '_ungrouped/videos/001_shot 1_v-1.mp4'].sort(),
    );

    const imagesOnly = planExport(parseCanvas(project, detailFixture()), { types: ['image'] });
    assert.equal(imagesOnly.length, 1);
    assert.equal(imagesOnly[0].asset.type, 'image');
});

test('planExport drops the group level when the canvas has no groups', () => {
    const detail = {
        nodeList: [
            {
                nodeKey: 'i-9',
                type: 2,
                name: 'solo',
                data: JSON.stringify({ url: 'https://cdn.example.com/solo.png', _resourceMeta: { items: [{}] } }),
            },
        ],
        connectionList: [],
    };
    const planned = planExport(parseCanvas(project, detail));
    assert.deepEqual(planned.map((p) => p.relPath), ['images/001_solo_i-9.png']);
});

test('planExport sequences per group+type bucket', () => {
    const detail = detailFixture();
    const second = JSON.parse(JSON.stringify(detail.nodeList[1]));
    second.nodeKey = 'i-2';
    second.name = 'characters · full body';
    detail.nodeList.push(second);
    const planned = planExport(parseCanvas(project, detail), { types: ['image'] });
    const inGroup = planned.filter((p) => p.relPath.startsWith('characters/'));
    assert.equal(inGroup.length, 2);
    assert.ok(inGroup.some((p) => p.relPath.includes('/001_')));
    assert.ok(inGroup.some((p) => p.relPath.includes('/002_')));
});

test('planExport keeps same-named groups in separate folders', () => {
    const detail = {
        nodeList: [
            { nodeKey: 'g-1', type: 5, name: 'dup', data: JSON.stringify({ childNodeIds: ['i-1'] }) },
            { nodeKey: 'g-2', type: 5, name: 'dup', data: JSON.stringify({ childNodeIds: ['i-2'] }) },
            {
                nodeKey: 'i-1',
                type: 2,
                name: 'a',
                data: JSON.stringify({ url: 'https://cdn.example.com/a.png', _resourceMeta: { items: [{}] } }),
            },
            {
                nodeKey: 'i-2',
                type: 2,
                name: 'b',
                data: JSON.stringify({ url: 'https://cdn.example.com/b.png', _resourceMeta: { items: [{}] } }),
            },
        ],
        connectionList: [],
    };
    const dirs = planExport(parseCanvas(project, detail)).map((p) => p.relPath.split('/')[0]);
    assert.equal(new Set(dirs).size, 2);
    assert.ok(dirs.some((d) => d.includes('g-1')));
    assert.ok(dirs.some((d) => d.includes('g-2')));
});

test('safeName keeps CJK, strips path separators, caps length', () => {
    assert.equal(safeName('示例角色 · 头像'), '示例角色 · 头像');
    assert.equal(safeName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
    assert.equal(safeName('   '), 'unnamed');
    assert.equal(safeName('CON'), '_CON');
    assert.equal(safeName('name...'), 'name');
    assert.equal(safeName('x'.repeat(200)).length, 70);
});

test('trimToBytes never splits a CJK character or exceeds the byte budget', () => {
    const out = trimToBytes('示例角色示例角色', 10);
    assert.ok(Buffer.byteLength(out, 'utf8') <= 10);
    assert.ok(!out.endsWith('\uFFFD'));
    assert.equal(trimToBytes('abcdef', 3), 'abc');
});

test('extOf falls back to the media type default', () => {
    assert.equal(extOf('https://x/y/photo.PNG', 'image'), 'png');
    assert.equal(extOf('https://x/y/clip.mp4?token=1', 'video'), 'mp4');
    assert.equal(extOf('https://x/y/no-extension', 'audio'), 'wav');
});

test('small formatting helpers', () => {
    assert.equal(mb(1048576), 1);
    assert.equal(mb(1572864), 1.5);
    assert.equal(formatDate(0), '');
    assert.match(formatDate(1700000000000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(canvasUrl('abc'), 'https://www.liblib.tv/canvas?projectId=abc');
});

// ── parseProjectRef: pasted canvas URLs ─────────────────────────────────────

test('parseProjectRef reads uuid + spaceId from a canvas URL', () => {
    const ref = parseProjectRef(`https://www.liblib.tv/canvas?spaceId=10001&projectId=${UUID}`);
    assert.equal(ref.kind, 'url');
    assert.equal(ref.uuid, UUID);
    assert.equal(ref.spaceId, 10001);
    assert.equal(ref.problem, undefined);
});

test('parseProjectRef works without spaceId, with reordered or extra params', () => {
    const a = parseProjectRef(`https://www.liblib.tv/canvas?projectId=${UUID}`);
    assert.equal(a.uuid, UUID);
    assert.equal(a.spaceId, 0);

    const b = parseProjectRef(
        `https://www.liblib.tv/canvas?projectId=${UUID}&spaceId=42&from=share&tab=assets`,
    );
    assert.equal(b.uuid, UUID);
    assert.equal(b.spaceId, 42);
});

test('parseProjectRef accepts projectUuid/uuid/canvasId params and uuid in path', () => {
    assert.equal(parseProjectRef(`https://www.liblib.tv/canvas?projectUuid=${UUID}`).uuid, UUID);
    assert.equal(parseProjectRef(`https://www.liblib.tv/canvas?uuid=${UUID}`).uuid, UUID);
    assert.equal(parseProjectRef(`https://www.liblib.tv/canvas?canvasId=${UUID}`).uuid, UUID);
    assert.equal(parseProjectRef(`https://www.liblib.tv/canvas/${UUID}`).uuid, UUID);
});

test('parseProjectRef lowercases uuids', () => {
    assert.equal(parseProjectRef(UUID.toUpperCase()).uuid, UUID);
    assert.equal(parseProjectRef(`https://www.liblib.tv/canvas?projectId=${UUID.toUpperCase()}`).uuid, UUID);
});

test('parseProjectRef classifies bare uuids, numeric ids and names', () => {
    assert.equal(parseProjectRef(UUID).kind, 'uuid');
    assert.equal(parseProjectRef('1000001').kind, 'id');
    assert.equal(parseProjectRef('1000001').numericId, 1000001);
    assert.equal(parseProjectRef('示例画布').kind, 'name');
    assert.equal(parseProjectRef('').problem, 'empty');
});

test('parseProjectRef reports a URL that carries no project id', () => {
    const ref = parseProjectRef('https://www.liblib.tv/projects');
    assert.equal(ref.kind, 'url');
    assert.equal(ref.uuid, '');
    assert.match(ref.problem, /no projectId/);
});

// ── resolveProject: id forms ────────────────────────────────────────────────

/** Minimal page stub: session cookie + project list endpoint. */
function pageStub() {
    return {
        evaluate: async () => 'usertoken=test-token; webid=test-webid',
        fetchJson: async () => ({
            code: 0,
            data: {
                projectMetaList: [{ id: 1000001, uuid: UUID, name: 'Demo' }],
                total: 1,
            },
        }),
    };
}

test('resolveProject resolves a numeric projectId inside a canvas URL', async () => {
    const project = await resolveProject(pageStub(), 'https://www.liblib.tv/canvas?projectId=1000001');
    assert.equal(project.uuid, UUID);
    assert.equal(project.name, 'Demo');
});

test('resolveProject resolves a bare numeric id', async () => {
    const project = await resolveProject(pageStub(), '1000001');
    assert.equal(project.uuid, UUID);
});

test('resolveProject resolves a name substring', async () => {
    const project = await resolveProject(pageStub(), 'dem');
    assert.equal(project.uuid, UUID);
});

// ── manifest ────────────────────────────────────────────────────────────────

test('writeManifest records per-file status and neutralises CSV formulas', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'libtv-manifest-'));
    try {
        const canvas = parseCanvas(project, detailFixture());
        const planned = planExport(canvas);
        const results = planned.map((p, i) => ({
            relPath: p.relPath,
            status: i === 0 ? 'ok' : 'failed',
            bytes: i === 0 ? 2048 : 0,
        }));
        // Force a formula-looking name into the manifest.
        planned[0].asset = { ...planned[0].asset, name: '=HYPERLINK("x")' };
        writeManifest(dir, canvas, planned, results);

        const csv = readFileSync(path.join(dir, 'manifest.csv'), 'utf-8').replace(/^\uFEFF/, '');
        const [header, first] = csv.trim().split('\n');
        assert.match(header, /status/);
        assert.match(first, /"'=HYPERLINK/);
        assert.match(first, /"ok"/);
        assert.match(csv, /"failed"/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('enrichProject takes name/id/space from projectMeta', () => {
    const stub = {
        id: 0,
        uuid: 'abc',
        name: '',
        folderId: 0,
        projectSpaceId: 0,
        projectType: 0,
        updatedAtMs: 0,
        createdAtMs: 0,
        url: '',
    };
    const out = enrichProject(stub, {
        id: 1000001,
        uuid: UUID,
        name: 'Demo canvas',
        projectSpaceId: 10001,
        folderId: 10001,
        updatedAtMs: 1700000000000,
    });
    assert.equal(out.name, 'Demo canvas');
    assert.equal(out.id, 1000001);
    assert.equal(out.projectSpaceId, 10001);
    assert.equal(out.updatedAtMs, 1700000000000);
});
