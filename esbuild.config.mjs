import * as esbuild from 'esbuild';
const ctx = await esbuild.context({entryPoints:['src/main.ts'],bundle:true,external:['obsidian'],format:'cjs',target:'es2020',platform:'browser',outfile:'main.js',banner:{js:'/* Simple Memo — independent local-first implementation, MIT */'}});
if(process.argv.includes('--watch')) await ctx.watch();
else { await ctx.rebuild(); await ctx.dispose(); }
