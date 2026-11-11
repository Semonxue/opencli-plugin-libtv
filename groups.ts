/**
 * `opencli libtv groups` — the canvas grouping tree.
 *
 * Groups are LibTV's canvas-level containers (character sets, storyboards).
 * Each row reports how many nodes and which media types it holds, which is
 * exactly the shape `export` mirrors as directories.
 *
 * Membership comes from `parentKey`, cross-checked against each group's
 * `childNodeIds`. Two groups that share a display name are listed with a short
 * key suffix so their counts never bleed into each other.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { LIBTV_DOMAIN, LIBTV_HOME, loadCanvas, mb } from './lib/utils.js';

cli({
    site: 'libtv',
    name: 'groups',
    aliases: ['tree'],
    description: 'Core: list canvas groups with child counts and per-type asset totals.',
    access: 'read',
    domain: LIBTV_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: LIBTV_HOME,
    example: 'opencli libtv groups 0123456789abcdef0123456789abcdef',
    args: [
        { name: 'project', positional: true, required: true, help: 'Canvas URL, project uuid, numeric id, or name substring' },
        { name: 'ungrouped', type: 'bool', default: true, help: 'Include a row for ungrouped assets' },
    ],
    columns: ['group', 'nodes', 'images', 'videos', 'audio', 'size_mb', 'size_unknown', 'role_id'],
    func: async (page: any, kwargs: any) => {
        const canvas = await loadCanvas(page, String(kwargs.project));
        const nameCounts = new Map<string, number>();
        for (const g of canvas.groups) nameCounts.set(g.name, (nameCounts.get(g.name) ?? 0) + 1);
        const rows = canvas.groups.map((g) => {
            const inGroup = canvas.assets.filter((a) => a.groupKey === g.key);
            const label = (nameCounts.get(g.name) ?? 0) > 1 ? `${g.name} (${g.key.slice(-6)})` : g.name;
            return {
                group: label,
                // Count every node we actually assigned to this group (media-less
                // nodes included), not just the group's declared childNodeIds.
                nodes: canvas.flatNodes.filter((n) => n.groupKey === g.key).length,
                images: inGroup.filter((a) => a.type === 'image').length,
                videos: inGroup.filter((a) => a.type === 'video').length,
                audio: inGroup.filter((a) => a.type === 'audio').length,
                size_mb: mb(inGroup.reduce((s, a) => s + (a.bytes || 0), 0)),
                size_unknown: inGroup.filter((a) => !a.bytes).length,
                role_id: g.roleId || '',
            };
        });
        if (kwargs.ungrouped !== false) {
            const loose = canvas.assets.filter((a) => !a.groupKey);
            if (loose.length) {
                rows.push({
                    group: '_ungrouped',
                    nodes: canvas.flatNodes.filter((n) => !n.groupKey).length,
                    images: loose.filter((a) => a.type === 'image').length,
                    videos: loose.filter((a) => a.type === 'video').length,
                    audio: loose.filter((a) => a.type === 'audio').length,
                    size_mb: mb(loose.reduce((s, a) => s + (a.bytes || 0), 0)),
                    size_unknown: loose.filter((a) => !a.bytes).length,
                    role_id: '',
                });
            }
        }
        return rows;
    },
});
