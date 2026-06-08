const fs = require('fs');
const path = require('path');
const os = require('os');

// Read the version from package.json
const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = pkg.version;
const homeDir = os.homedir();
const extensionsDir = path.join(homeDir, '.antigravity-ide', 'extensions');

// Determine the suffix (e.g. -universal) from the existing folder
let suffix = '';
if (fs.existsSync(extensionsDir)) {
  const dirs = fs.readdirSync(extensionsDir);
  const matchingDirs = dirs.filter(d => d.startsWith('davissss2.antigravity-account-'));
  if (matchingDirs.length > 0) {
    matchingDirs.sort();
    const latestDir = matchingDirs[matchingDirs.length - 1];
    const match = latestDir.match(/davissss2\.antigravity-account-\d+\.\d+\.\d+(.*)/);
    if (match) {
      suffix = match[1];
    }
  }
}

const extensionDirName = `davissss2.antigravity-account-${version}${suffix}`;
const targetBaseDir = path.join(extensionsDir, extensionDirName);
const targetDistDir = path.join(targetBaseDir, 'dist');
const targetThemeDir = path.join(targetDistDir, 'presentation', 'theme');

console.log(`Syncing compiled extension to: ${targetBaseDir}`);

// Helper to copy directory/file recursively
function copySync(src, dest) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();
  if (isDirectory) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    fs.readdirSync(src).forEach((childItemName) => {
      copySync(path.join(src, childItemName), path.join(dest, childItemName));
    });
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

try {
  // Ensure target folder exists
  if (!fs.existsSync(targetBaseDir)) {
    console.log(`Creating target extension directory at: ${targetBaseDir}`);
    fs.mkdirSync(targetBaseDir, { recursive: true });
  }

  // Copy dist/extension.js
  const srcExtensionJs = path.join(__dirname, '..', 'dist', 'extension.js');
  const destExtensionJs = path.join(targetDistDir, 'extension.js');
  if (fs.existsSync(srcExtensionJs)) {
    copySync(srcExtensionJs, destExtensionJs);
    console.log(`Copied extension.js -> ${destExtensionJs}`);
  } else {
    console.error('Source extension.js not found in dist/. Run build first.');
    process.exit(1);
  }

  // Copy dist/presentation/theme/global.css
  const srcCss = path.join(__dirname, '..', 'dist', 'presentation', 'theme', 'global.css');
  const destCss = path.join(targetThemeDir, 'global.css');
  if (fs.existsSync(srcCss)) {
    copySync(srcCss, destCss);
    console.log(`Copied global.css -> ${destCss}`);
  }

  // Copy package.json (just in case contributions change)
  const destPkg = path.join(targetBaseDir, 'package.json');
  fs.copyFileSync(pkgPath, destPkg);
  console.log(`Copied package.json -> ${destPkg}`);

  // Copy node_modules recursively if not present
  const srcNodeModules = path.join(__dirname, '..', 'node_modules');
  const destNodeModules = path.join(targetBaseDir, 'node_modules');
  if (fs.existsSync(srcNodeModules) && !fs.existsSync(destNodeModules)) {
    console.log('Copying node_modules dependencies...');
    copySync(srcNodeModules, destNodeModules);
  }

  // Copy resources recursively if not present
  const srcResources = path.join(__dirname, '..', 'resources');
  const destResources = path.join(targetBaseDir, 'resources');
  if (fs.existsSync(srcResources) && !fs.existsSync(destResources)) {
    console.log('Copying resources assets...');
    copySync(srcResources, destResources);
  }

  console.log('Sync complete! Reload the Antigravity IDE window to see changes.');
} catch (error) {
  console.error('Failed to sync files:', error);
  process.exit(1);
}
