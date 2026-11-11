/**
 * `opencli libtv projects` — list canvas projects.
 *
 * One row per canvas with the uuid needed by every other command, the
 * owning space id, timestamps and a clickable URL. `--search` filters by
 * name substring so agents can resolve "the 科技篇 canvas" without paging.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { LIBTV_DOMAIN, LIBTV_HOME, formatDate, listProjects } from './lib/utils.js';

cli({
    site: 'libtv',
    name: 'projects',
    aliases: ['ls'],
    description: 'List LibTV canvas projects (uuid, name, space, updated, url).',
    access: 'read',
    domain: LIBTV_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: LIBTV_HOME,
    example: 'opencli libtv projects --limit 20 -f json',
    args: [
        { name: 'limit', type: 'int', default: 50, help: 'Max projects to return (default: 50)' },
        { name: 'search', default: '', help: 'Filter by project name substring' },
    ],
    columns: ['uuid', 'name', 'space_id', 'updated', 'url'],
    func: async (page: any, kwargs: any) => {
        const limit = Number(kwargs.limit) > 0 ? Number(kwargs.limit) : 50;
        const rows = await listProjects(page, { limit, search: String(kwargs.search ?? '') });
        return rows.map((p) => ({
            uuid: p.uuid,
            name: p.name,
            space_id: p.projectSpaceId,
            updated: formatDate(p.updatedAtMs),
            url: p.url,
        }));
    },
});
