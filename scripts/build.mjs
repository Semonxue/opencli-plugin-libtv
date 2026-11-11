/**
 * Build the plugin: transpile every command module plus lib/utils.ts to ESM JS.
 *
 * opencli only auto-transpiles .ts files sitting in the plugin ROOT, so
 * lib/*.ts must be compiled here (and the compiled .js committed / shipped).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const run = (args) => execFileSync('esbuild', args, { stdio: 'inherit' });
const shared = ['--format=esm', '--platform=node'];

run(['lib/utils.ts', '--outfile=lib/utils.js', ...shared]);
for (const file of readdirSync('.').filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))) {
    run([file, `--outfile=${file.replace(/\.ts$/, '.js')}`, ...shared]);
}
console.log('built lib/utils.js + root commands');
