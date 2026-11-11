/**
 * Unit tests for the pure (browser-free) parts of the LibTV adapter:
 * canvas parsing, export planning and filesystem-name safety.
 *
 * Run with: npm test   (node --test tests/)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeName, extOf, parseCanvas, planExport, mb, formatDate, canvasUrl, parseProjectRef, enrichProject } from '../lib/utils.js';

const project = {
    id: 1,
    uuid: '5110c03295d34f64aff6e398cb91d764',
    name: 'Demo',
    folderId: 10,
    projectSpaceId: 11161198,
    projectType: 0,
    updatedAtMs: 1700000000000,
    createdAtMs: 1700000000000,
    url: canvasUrl('5110c03295d34f64aff6e398cb91d764'),
};

/** Build a canvas detail payload shaped like /detail-by-space returns. */
function detailFixture() {
    return {
        nodeList: [
            {
                nodeKey: 'g-1',
                type: 5,
                name: '护士',
                data: JSON.stringify({
                    type: 'group',
                    childNodeIds: ['i-1', 'i-2'],
                    characterAsset: { roleId: 'role-abc' },
                }),
            },
            {
                nodeKey: 'i-1',
                type: 2,
                name: '护士 · 头像',
                toolKey: 'lib-image-2.5-s',
                parentKey: 'g-1',
                data: JSON.stringify({
                    url: ['https://cdn.example.com/a/1_full.png?x-oss-process=image/resize,w_100'],
                    params: { prompt: 'a nurse, portrait' },
                    _resourceMeta: { items: [{ width: 1024, height: 1024, byteSize: 2048, mimeType: 'image/png' }] },
                }),
            },
            {
                nodeKey: 'v-1',
                type: 3,
                name: '镜头 1',
                toolKey: 'star-video2.5',
                data: JSON.stringify({
                    url: 'https://cdn.example.com/v/1.mp4',
                    params: { prompt: 'dolly in' },
                    _resourceMeta: { items: [{ width: 1920, height: 1080, durationSec: 5.05, byteSize: 4096 }] },
                }),
            },
            {
                // Group node with no media — must not become an asset.
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
    assert.equal(canvas.groups[0].name, '护士');
    assert.equal(canvas.groups[0].childCount, 2);
    assert.equal(canvas.groups[0].roleId, 'role-abc');

    // 3 media nodes (image, video) + the media-less audio is skipped → 2 assets.
    assert.equal(canvas.assets.length, 2);
    assert.equal(canvas.flatNodes.length, 4);

    const img = canvas.assets.find((a) => a.type === 'image');
    assert.ok(img);
    assert.equal(img.group, '护士');
    assert.equal(img.model, 'lib-image-2.5-s');
    assert.equal(img.width, 1024);
    assert.equal(img.ext, 'png');
    assert.equal(img.prompt, 'a nurse, portrait');
    // OSS thumbnail transform must be stripped to keep the original file.
    assert.equal(img.url, 'https://cdn.example.com/a/1_full.png');

    const vid = canvas.assets.find((a) => a.type === 'video');
    assert.equal(vid.durationSec, 5.05);
    assert.equal(vid.bytes, 4096);
    assert.equal(vid.group, '');
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
    assert.deepEqual(paths, [
        '护士/images/001_护士 · 头像_i-1.png',
        '_ungrouped/videos/001_镜头 1_v-1.mp4',
    ].sort());

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
    second.name = '护士 · 全身图';
    detail.nodeList.push(second);
    const planned = planExport(parseCanvas(project, detail), { types: ['image'] });
    const inGroup = planned.filter((p) => p.relPath.startsWith('护士/'));
    assert.equal(inGroup.length, 2);
    assert.ok(inGroup.some((p) => p.relPath.includes('/001_')));
    assert.ok(inGroup.some((p) => p.relPath.includes('/002_')));
});

test('safeName keeps CJK, strips path separators, caps length', () => {
    assert.equal(safeName('护士 · 头像'), '护士 · 头像');
    assert.equal(safeName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
    assert.equal(safeName('   '), 'unnamed');
    assert.equal(safeName('x'.repeat(200)).length, 70);
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
    const ref = parseProjectRef(
        'https://www.liblib.tv/canvas?spaceId=11161198&projectId=5110c03295d34f64aff6e398cb91d764',
    );
    assert.equal(ref.kind, 'url');
    assert.equal(ref.uuid, '5110c03295d34f64aff6e398cb91d764');
    assert.equal(ref.spaceId, 11161198);
    assert.equal(ref.problem, undefined);
});

test('parseProjectRef works without spaceId, with reordered or extra params', () => {
    const a = parseProjectRef('https://www.liblib.tv/canvas?projectId=5110c03295d34f64aff6e398cb91d764');
    assert.equal(a.uuid, '5110c03295d34f64aff6e398cb91d764');
    assert.equal(a.spaceId, 0);

    const b = parseProjectRef(
        'https://www.liblib.tv/canvas?projectId=5110c03295d34f64aff6e398cb91d764&spaceId=42&from=share&tab=assets',
    );
    assert.equal(b.uuid, '5110c03295d34f64aff6e398cb91d764');
    assert.equal(b.spaceId, 42);
});

test('parseProjectRef accepts projectUuid/uuid/canvasId params and uuid in path', () => {
    const u = '5110c03295d34f64aff6e398cb91d764';
    assert.equal(parseProjectRef(`https://www.liblib.tv/canvas?projectUuid=${u}`).uuid, u);
    assert.equal(parseProjectRef(`https://www.liblib.tv/canvas?uuid=${u}`).uuid, u);
    assert.equal(parseProjectRef(`https://www.liblib.tv/canvas?canvasId=${u}`).uuid, u);
    assert.equal(parseProjectRef(`https://www.liblib.tv/canvas/${u}`).uuid, u);
});

test('parseProjectRef classifies bare uuids, numeric ids and names', () => {
    assert.equal(parseProjectRef('5110c03295d34f64aff6e398cb91d764').kind, 'uuid');
    assert.equal(parseProjectRef('14839047').kind, 'id');
    assert.equal(parseProjectRef('14839047').numericId, 14839047);
    assert.equal(parseProjectRef('科技篇').kind, 'name');
    assert.equal(parseProjectRef('').problem, 'empty');
});

test('parseProjectRef reports a URL that carries no project id', () => {
    const ref = parseProjectRef('https://www.liblib.tv/projects');
    assert.equal(ref.kind, 'url');
    assert.equal(ref.uuid, '');
    assert.match(ref.problem, /no projectId/);
});

test('enrichProject takes name/id/space from projectMeta', () => {
    const stub = { id: 0, uuid: 'abc', name: '', folderId: 0, projectSpaceId: 0, projectType: 0, updatedAtMs: 0, createdAtMs: 0, url: '' };
    const out = enrichProject(stub, {
        id: 14839047,
        uuid: '5110c03295d34f64aff6e398cb91d764',
        name: '全景篇',
        projectSpaceId: 11161198,
        folderId: 11161198,
        updatedAtMs: 1791800939000,
    });
    assert.equal(out.name, '全景篇');
    assert.equal(out.id, 14839047);
    assert.equal(out.projectSpaceId, 11161198);
    assert.equal(out.updatedAtMs, 1791800939000);
});
