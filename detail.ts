/**
 * `opencli libtv detail` — one-line overview of a canvas.
 *
 * Node/asset counts by type, group count, total asset size, the model mix
 * and the top groups. This is the "what is in this canvas" answer before
 * drilling into `nodes` / `assets` / `export`.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { LIBTV_DOMAIN, LIBTV_HOME, byType, formatDate, loadCanvas, mb, sumBytes } from './lib/utils.js';

cli({
    site: 'libtv',
    name: 'detail',
    description: 'Summarise one LibTV canvas: nodes, assets by type, groups, size, models.',
    access: 'read',
    domain: LIBTV_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: LIBTV_HOME,
    example: 'opencli libtv detail 5110c03295d34f64aff6e398cb91d764',
    args: [
        { name: 'project', positional: true, required: true, help: 'Project uuid, numeric id, or name substring' },
    ],
    columns: ['name', 'uuid', 'nodes', 'images', 'videos', 'audio', 'groups', 'assets', 'size_mb', 'size_unknown', 'models', 'updated', 'url'],
    func: async (page: any, kwargs: any) => {
        const canvas = await loadCanvas(page, String(kwargs.project));
        const p = canvas.project;
        const models = new Map<string, number>();
        for (const a of canvas.assets) models.set(a.model, (models.get(a.model) ?? 0) + 1);
        const modelMix = [...models.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([m, n]) => `${m}:${n}`)
            .join(', ');
        const unknown = canvas.assets.filter((a) => !a.bytes).length;
        return [
            {
                name: p.name,
                uuid: p.uuid,
                nodes: canvas.nodeCount,
                images: byType(canvas.assets, 'image').length,
                videos: byType(canvas.assets, 'video').length,
                audio: byType(canvas.assets, 'audio').length,
                groups: canvas.groups.length,
                assets: canvas.assets.length,
                size_mb: mb(sumBytes(canvas.assets)),
                size_unknown: unknown,
                models: modelMix,
                updated: formatDate(p.updatedAtMs),
                url: p.url,
            },
        ];
    },
});
