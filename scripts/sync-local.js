const fs = require('fs');
const path = require('path');
const os = require('os');

// Read the version from package.json
const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = pkg.version;
const extensionDirName = `davissss2.antigravity-account-${version}`;

const homeDir = os.homedir();
const targetBaseDir = path.join(homeDir, '.antigravity-ide', 'extensions', extensionDirName);
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
  if (!fs.existsSync(targetBaseDir)) {
    console.error(`Error: Active extension directory does not exist at ${targetBaseDir}`);
    console.error(`Please install version ${version} of the extension first.`);
    process.exit(1);
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

  console.log('Sync complete! Reload the Antigravity IDE window to see changes.');
} catch (error) {
  console.error('Failed to sync files:', error);
  process.exit(1);
}
