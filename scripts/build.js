const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const os = require('os');

const isWatch = process.argv.includes('--watch');

function copyTheme() {
  try {
    fs.mkdirSync('dist/presentation/theme', { recursive: true });
    fs.copyFileSync('src/presentation/theme/global.css', 'dist/presentation/theme/global.css');
    console.log('Copied global.css to dist/presentation/theme/global.css');
  } catch (err) {
    console.error('Failed to copy theme:', err.message);
  }
}

function syncToIDE() {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const version = pkg.version;
    const extensionDirName = `davissss2.antigravity-account-${version}`;
    const homeDir = os.homedir();
    const targetBaseDir = path.join(homeDir, '.antigravity-ide', 'extensions', extensionDirName);
    
    if (!fs.existsSync(targetBaseDir)) {
      console.warn(`Local IDE extension target directory not found: ${targetBaseDir}`);
      console.warn('Skipping automatic sync to IDE folder.');
      return;
    }

    const targetDistDir = path.join(targetBaseDir, 'dist');
    const targetThemeDir = path.join(targetDistDir, 'presentation', 'theme');

    fs.mkdirSync(targetDistDir, { recursive: true });
    fs.copyFileSync('dist/extension.js', path.join(targetDistDir, 'extension.js'));
    
    fs.mkdirSync(targetThemeDir, { recursive: true });
    fs.copyFileSync('dist/presentation/theme/global.css', path.join(targetThemeDir, 'global.css'));

    fs.copyFileSync(pkgPath, path.join(targetBaseDir, 'package.json'));
    console.log(`Synced built files to IDE extensions folder: ${targetBaseDir}`);
  } catch (err) {
    console.error('Failed to sync to IDE extension folder:', err.message);
  }
}

const syncPlugin = {
  name: 'sync-plugin',
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length === 0) {
        copyTheme();
        syncToIDE();
        console.log('Build output generated and synchronized.');
      } else {
        console.error('Build failed with errors.');
      }
    });
  }
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['./src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode', 'sql.js'],
    format: 'cjs',
    platform: 'node',
    minify: !isWatch,
    sourcemap: isWatch,
    plugins: [syncPlugin]
  });

  if (isWatch) {
    console.log('Watching for file changes...');
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log('Build complete.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
