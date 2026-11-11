/**
 * `opencli libtv characters` — the reusable character library.
 *
 * LibTV stores persistent characters (avatar / full-body / expressions /
 * turnaround) that canvases reference. Their `characterUuid` is what the
 * `characterAsset.roleId` on canvas groups points back to.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { LIBTV_DOMAIN, LIBTV_HOME, formatDate, listCharacters } from './lib/utils.js';

cli({
    site: 'libtv',
    name: 'characters',
    description: 'List reusable LibTV characters (uuid, name, gender, age, cover).',
    access: 'read',
    domain: LIBTV_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: LIBTV_HOME,
    example: 'opencli libtv characters --limit 20',
    args: [
        { name: 'limit', type: 'int', default: 100, help: 'Max characters (default: 100)' },
        { name: 'search', default: '', help: 'Filter by character name substring' },
    ],
    columns: ['uuid', 'name', 'gender', 'age_stage', 'region', 'era', 'version', 'updated', 'cover'],
    func: async (page: any, kwargs: any) => {
        const limit = Number(kwargs.limit) > 0 ? Number(kwargs.limit) : 100;
        const needle = String(kwargs.search ?? '').toLowerCase();
        const rows = await listCharacters(page, limit);
        return rows
            .filter((c) => (needle ? c.name.toLowerCase().includes(needle) : true))
            .map((c) => ({
                uuid: c.uuid,
                name: c.name,
                gender: c.gender,
                age_stage: c.ageStage,
                region: c.region,
                era: c.era,
                version: c.version,
                updated: formatDate(c.updatedAtMs),
                cover: c.cover,
            }));
    },
});
