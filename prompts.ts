/**
 * `opencli libtv prompts` — export the generation prompts behind a canvas.
 *
 * Each asset node carries `data.params.prompt`. Useful for auditing what a
 * storyboard was generated from, or for reproducing a shot elsewhere.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { LIBTV_DOMAIN, LIBTV_HOME, loadCanvas } from './lib/utils.js';

cli({
    site: 'libtv',
    name: 'prompts',
    description: 'List generation prompts for canvas asset nodes.',
    access: 'read',
    domain: LIBTV_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: LIBTV_HOME,
    example: 'opencli libtv prompts 5110c03295d34f64aff6e398cb91d764 --type video',
    args: [
        { name: 'project', positional: true, required: true, help: 'Canvas URL, project uuid, numeric id, or name substring' },
        { name: 'type', choices: ['all', 'image', 'video', 'audio'], default: 'all', help: 'Filter by media type' },
        { name: 'group', default: '', help: 'Filter by group name substring' },
        { name: 'limit', type: 'int', default: 0, help: 'Max rows (0 = all)' },
    ],
    columns: ['#', 'type', 'group', 'name', 'model', 'prompt'],
    func: async (page: any, kwargs: any) => {
        const canvas = await loadCanvas(page, String(kwargs.project));
        const type = String(kwargs.type ?? 'all');
        const groupNeedle = String(kwargs.group ?? '').toLowerCase();
        const limit = Number(kwargs.limit) > 0 ? Number(kwargs.limit) : 0;
        return canvas.assets
            .filter((a) => (type === 'all' ? true : a.type === type))
            .filter((a) => (groupNeedle ? a.group.toLowerCase().includes(groupNeedle) : true))
            .filter((a) => a.prompt)
            .slice(0, limit || undefined)
            .map((a, i) => ({
                '#': i + 1,
                type: a.type,
                group: a.group || '—',
                name: a.name,
                model: a.model,
                prompt: a.prompt,
            }));
    },
});
