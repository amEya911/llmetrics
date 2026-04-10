// @ts-check
const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: !isWatch,
  treeShaking: true,
};

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('\x1b[32m✓\x1b[0m Watching for changes...');
  } else {
    const result = await esbuild.build(buildOptions);
    if (result.errors.length === 0) {
      console.log('\x1b[32m✓\x1b[0m Build complete');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
