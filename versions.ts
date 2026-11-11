/**
 * `opencli libtv versions` — snapshot history for one canvas.
 *
 * LibTV keeps project versions (manual snapshots + auto checkpoints). A
 * canvas with no snapshot history legitimately returns zero rows.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { LIBTV_DOMAIN, LIBTV_HOME, formatDate, listVersions, resolveProject } from './lib/utils.js';

cli({
    site: 'libtv',
    name: 'versions',
    description: 'List saved versions/snapshots of a canvas.',
    access: 'read',
    domain: LIBTV_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: LIBTV_HOME,
    example: 'opencli libtv versions 5110c03295d34f64aff6e398cb91d764',
    args: [
        { name: 'project', positional: true, required: true, help: 'Canvas URL, project uuid, numeric id, or name substring' },
        { name: 'limit', type: 'int', default: 50, help: 'Max versions (default: 50)' },
    ],
    columns: ['version_id', 'name', 'created'],
    func: async (page: any, kwargs: any) => {
        const project = await resolveProject(page, String(kwargs.project));
        const limit = Number(kwargs.limit) > 0 ? Number(kwargs.limit) : 50;
        const rows = await listVersions(page, project, limit);
        return rows.map((v) => ({
            version_id: v.versionId,
            name: v.name,
            created: formatDate(v.createdAtMs),
        }));
    },
});
