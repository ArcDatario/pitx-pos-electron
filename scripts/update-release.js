const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const stagingDir = path.join(projectRoot, "release-fixed-new");
const releaseDir = path.join(projectRoot, "release-fixed");

if (!fs.existsSync(stagingDir)) {
  throw new Error(`Build output not found: ${stagingDir}`);
}

fs.mkdirSync(releaseDir, { recursive: true });
for (const entry of fs.readdirSync(stagingDir)) {
  fs.cpSync(path.join(stagingDir, entry), path.join(releaseDir, entry), {
    recursive: true,
    force: true,
  });
}
fs.rmSync(stagingDir, { recursive: true, force: true });
console.log(`Updated ${path.relative(projectRoot, releaseDir)}`);
