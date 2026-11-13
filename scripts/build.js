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

function copySqlJs() {
  try {
    fs.mkdirSync('dist', { recursive: true });
    const sqlWasmJs = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.js');
    const sqlWasmBinary = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
    if (fs.existsSync(sqlWasmJs)) {
      fs.copyFileSync(sqlWasmJs, 'dist/sql-wasm.js');
      console.log('Copied sql-wasm.js to dist/sql-wasm.js');
    }
    if (fs.existsSync(sqlWasmBinary)) {
      fs.copyFileSync(sqlWasmBinary, 'dist/sql-wasm.wasm');
      console.log('Copied sql-wasm.wasm to dist/sql-wasm.wasm');
    }
  } catch (err) {
    console.error('Failed to copy sql.js files:', err.message);
  }
}

/**
 * Ships the Windows Credential Manager helper next to the worker. The agent
 * (agy.exe --hub) authenticates with the "gemini:antigravity" generic credential,
 * so switching accounts has to update that credential as well.
 */
function copyCredentialHelper() {
  try {
    fs.mkdirSync('dist', { recursive: true });
    const src = path.join(__dirname, '..', 'src', 'infrastructure', 'storage', 'write-cred.ps1');
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, 'dist/write-cred.ps1');
      console.log('Copied write-cred.ps1 to dist/write-cred.ps1');
    }
  } catch (err) {
    console.error('Failed to copy credential helper:', err.message);
  }
}

/**
 * The IDE keys extensions by folder name, the version inside package.json, and the
 * extensions.json/.obsolete registries. Writing a new package.json into an old
 * folder leaves those three disagreeing, and the IDE then reports the extension
 * as removed. Rename the folder and repair the registries before syncing.
 */
function reconcileExtensionFolder(extensionsDir, pkg) {
  const id = `${String(pkg.publisher).toLowerCase()}.${pkg.name}`;
  const canonical = `${id}-${pkg.version}`;

  const candidates = fs.readdirSync(extensionsDir)
    .filter(f => f.startsWith(`${id}-`) && f !== canonical);

  for (const dir of candidates) {
    const from = path.join(extensionsDir, dir);
    const to = path.join(extensionsDir, canonical);
    if (fs.existsSync(to)) {
      console.warn(`Extension folder ${dir} is stale next to ${canonical}; leaving it alone.`);
      continue;
    }
    try {
      fs.renameSync(from, to);
      updateExtensionRegistry(extensionsDir, dir, canonical, pkg.version);
      console.log(`Renamed stale extension folder ${dir} -> ${canonical}`);
    } catch (err) {
      console.warn(`Could not rename ${dir} to ${canonical} (${err.message}). Close the IDE and rebuild.`);
    }
  }

  clearObsoleteEntry(extensionsDir, canonical);
}

function updateExtensionRegistry(extensionsDir, oldRelative, newRelative, version) {
  const registryPath = path.join(extensionsDir, 'extensions.json');
  if (!fs.existsSync(registryPath)) return;
  try {
    const entries = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    let changed = false;
    for (const entry of entries) {
      if (entry.relativeLocation !== oldRelative) continue;
      entry.version = version;
      entry.relativeLocation = newRelative;
      if (entry.location && typeof entry.location.path === 'string') {
        entry.location.path = entry.location.path.slice(0, entry.location.path.length - oldRelative.length) + newRelative;
      }
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(registryPath, JSON.stringify(entries), 'utf8');
      console.log(`Updated extensions.json for ${newRelative}`);
    }
  } catch (err) {
    console.warn(`Could not update extensions.json: ${err.message}`);
  }
}

function clearObsoleteEntry(extensionsDir, relative) {
  const obsoletePath = path.join(extensionsDir, '.obsolete');
  if (!fs.existsSync(obsoletePath)) return;
  try {
    const obsolete = JSON.parse(fs.readFileSync(obsoletePath, 'utf8'));
    if (!(relative in obsolete)) return;
    delete obsolete[relative];
    fs.writeFileSync(obsoletePath, JSON.stringify(obsolete), 'utf8');
    console.log(`Removed ${relative} from .obsolete`);
  } catch (err) {
    console.warn(`Could not update .obsolete: ${err.message}`);
  }
}

function syncToIDE() {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const homeDir = os.homedir();
    const extensionsDir = path.join(homeDir, '.antigravity-ide', 'extensions');
    
    if (!fs.existsSync(extensionsDir)) {
      console.warn(`Local IDE extensions directory not found: ${extensionsDir}`);
      return;
    }

    reconcileExtensionFolder(extensionsDir, pkg);

    const files = fs.readdirSync(extensionsDir);
    const targetDirs = files.filter(f => f.startsWith('davissss2.antigravity-account-'));
    
    if (targetDirs.length === 0) {
      console.warn('No active extension folder found in IDE extensions directory.');
      return;
    }

    function copyRecursive(src, dest) {
      if (!fs.existsSync(src)) return;
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const child of fs.readdirSync(src)) {
          copyRecursive(path.join(src, child), path.join(dest, child));
        }
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }

    for (const dir of targetDirs) {
      const targetBaseDir = path.join(extensionsDir, dir);
      const targetDistDir = path.join(targetBaseDir, 'dist');
      const targetThemeDir = path.join(targetDistDir, 'presentation', 'theme');

      fs.mkdirSync(targetDistDir, { recursive: true });
      fs.copyFileSync('dist/extension.js', path.join(targetDistDir, 'extension.js'));
      if (fs.existsSync('dist/sql-wasm.js')) {
        fs.copyFileSync('dist/sql-wasm.js', path.join(targetDistDir, 'sql-wasm.js'));
      }
      if (fs.existsSync('dist/sql-wasm.wasm')) {
        fs.copyFileSync('dist/sql-wasm.wasm', path.join(targetDistDir, 'sql-wasm.wasm'));
      }
      if (fs.existsSync('dist/write-cred.ps1')) {
        fs.copyFileSync('dist/write-cred.ps1', path.join(targetDistDir, 'write-cred.ps1'));
      }
      
      fs.mkdirSync(targetThemeDir, { recursive: true });
      fs.copyFileSync('dist/presentation/theme/global.css', path.join(targetThemeDir, 'global.css'));

      fs.copyFileSync(pkgPath, path.join(targetBaseDir, 'package.json'));

      // Sync README, CHANGELOG, and Logo assets
      if (fs.existsSync('README.md')) fs.copyFileSync('README.md', path.join(targetBaseDir, 'README.md'));
      if (fs.existsSync('CHANGELOG.md')) fs.copyFileSync('CHANGELOG.md', path.join(targetBaseDir, 'CHANGELOG.md'));
      if (fs.existsSync('AntigravityAccountLogo.png')) fs.copyFileSync('AntigravityAccountLogo.png', path.join(targetBaseDir, 'AntigravityAccountLogo.png'));

      copyRecursive('resources', path.join(targetBaseDir, 'resources'));
      copyRecursive('images', path.join(targetBaseDir, 'images'));

      console.log(`Synced built files & assets to IDE extensions folder: ${targetBaseDir}`);
    }
  } catch (err) {
    console.error('Failed to sync to IDE extension folder:', err.message);
  }
}

const syncPlugin = {
  name: 'sync-plugin',
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length === 0) {
        copySqlJs();
        copyTheme();
        copyCredentialHelper();
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
