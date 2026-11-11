/**
 * `opencli libtv export` — download every asset on a canvas to local disk.
 *
 * Layout mirrors the canvas grouping, which is what makes an export usable:
 *
 *   <out>/<group>/<images|videos|audio>/<NNN_node-name_nodeKey>.<ext>
 *   <out>/<images|videos|audio>/...              (projects without groups)
 *   <out>/manifest.csv                           (group/type/size/url per file)
 *
 * Downloads run with bounded concurrency, resume-by-skip, and verify each
 * file against the CDN `Content-Length` — LibTV's CDN occasionally closes a
 * response early and a naive download silently truncates.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import * as path from 'node:path';
import {
    LIBTV_DOMAIN,
    LIBTV_HOME,
    loadCanvas,
    mb,
    planExport,
    runExport,
    safeName,
    writeManifest,
} from './lib/utils.js';

cli({
    site: 'libtv',
    name: 'export',
    aliases: ['download'],
    description: 'Download all canvas assets into <out>/<group>/<type>/ folders, plus manifest.csv.',
    access: 'read',
    domain: LIBTV_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: LIBTV_HOME,
    example: 'opencli libtv export 5110c03295d34f64aff6e398cb91d764 --out ./exports',
    args: [
        { name: 'project', positional: true, required: true, help: 'Canvas URL, project uuid, numeric id, or name substring' },
        { name: 'out', default: './libtv-export', help: 'Parent output directory (a project subfolder is created)' },
        { name: 'type', choices: ['all', 'image', 'video', 'audio'], default: 'all', help: 'Only export this media type' },
        { name: 'group', default: '', help: 'Only export assets in groups matching this substring' },
        { name: 'concurrency', type: 'int', default: 6, help: 'Parallel downloads, 1-16 (default: 6)' },
        { name: 'overwrite', type: 'bool', default: false, help: 'Re-download files that already exist' },
        { name: 'manifest', type: 'bool', default: true, help: 'Write manifest.csv next to the files' },
        { name: 'summary', type: 'bool', default: false, help: 'Return per-type totals instead of one row per file' },
    ],
    columns: ['file', 'group', 'type', 'size_mb', 'status'],
    func: async (page: any, kwargs: any) => {
        const canvas = await loadCanvas(page, String(kwargs.project));
        const types = String(kwargs.type ?? 'all') === 'all' ? [] : [String(kwargs.type)];
        const groupNeedle = String(kwargs.group ?? '').toLowerCase();

        let planned = planExport(canvas, { types });
        if (groupNeedle) {
            planned = planned.filter((p) => p.asset.group.toLowerCase().includes(groupNeedle));
        }
        const outDir = path.resolve(String(kwargs.out ?? './libtv-export'), safeName(canvas.project.name, 80));
        process.stderr.write(
            `libtv export: ${canvas.project.name} — ${planned.length} files → ${outDir}\n`,
        );

        const results = await runExport(planned, outDir, {
            concurrency: Number(kwargs.concurrency) || 6,
            overwrite: Boolean(kwargs.overwrite),
            onProgress: (done, total, r) => {
                if (done % 10 === 0 || done === total || r.status === 'failed') {
                    process.stderr.write(`  ${done}/${total} ${r.status}${r.error ? ` (${r.error})` : ''}\n`);
                }
            },
        });

        if (kwargs.manifest !== false) {
            const manifestPath = writeManifest(outDir, canvas, planned, results);
            process.stderr.write(`  manifest → ${manifestPath}\n`);
        }

        const failed = results.filter((r) => r.status === 'failed');
        process.stderr.write(
            `libtv export: done — ${results.filter((r) => r.status === 'ok').length} downloaded, ` +
                `${results.filter((r) => r.status === 'skipped').length} skipped, ${failed.length} failed\n`,
        );

        if (kwargs.summary) {
            const buckets = new Map<string, { files: number; bytes: number; failed: number }>();
            for (let i = 0; i < planned.length; i++) {
                const type = planned[i].asset.type;
                const b = buckets.get(type) ?? { files: 0, bytes: 0, failed: 0 };
                b.files++;
                b.bytes += results[i]?.bytes ?? 0;
                if (results[i]?.status === 'failed') b.failed++;
                buckets.set(type, b);
            }
            return [...buckets.entries()].map(([type, b]) => ({
                file: `${b.files} files`,
                group: '—',
                type,
                size_mb: mb(b.bytes),
                status: b.failed ? `${b.failed} failed` : 'ok',
            }));
        }

        return planned.map((p, i) => ({
            file: p.relPath,
            group: p.asset.group || '—',
            type: p.asset.type,
            size_mb: mb(results[i]?.bytes ?? 0),
            status: results[i]?.status ?? 'failed',
        }));
    },
});
