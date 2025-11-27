const { rcedit } = require('rcedit');
const path = require('path');
const fs = require('fs');

const exePath = path.join(__dirname, 'dist', 'win-unpacked', 'Tilbi.exe');
const iconPath = path.join(__dirname, 'icons', 'icon.ico');

if (!fs.existsSync(exePath)) {
  console.error('Error: Tilbi.exe not found at', exePath);
  process.exit(1);
}

if (!fs.existsSync(iconPath)) {
  console.error('Error: icon.ico not found at', iconPath);
  process.exit(1);
}

console.log('Embedding icon into Tilbi.exe...');
console.log('EXE:', exePath);
console.log('Icon:', iconPath);

(async () => {
  try {
    await rcedit(exePath, {
      icon: iconPath
    });
    console.log('✓ Icon embedded successfully!');
  } catch (error) {
    console.error('Error embedding icon:', error);
    process.exit(1);
  }
})();

