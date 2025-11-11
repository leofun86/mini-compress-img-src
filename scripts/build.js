import fs from "fs";
import path from "path";

const SRC = "public";
const DIST = "dist";

if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

function copyDir(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of fs.readdirSync(srcDir)) {
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(destDir, file);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) copyDir(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}
copyDir(SRC, DIST);

if (fs.existsSync("compress-images.mjs")) {
  fs.copyFileSync("compress-images.mjs", path.join(DIST, "compress-images.mjs"));
}

const now = new Date().toISOString();
fs.writeFileSync(path.join(DIST, "deploy-log.txt"), `Build: ${now}\n`);
console.log("✅ /dist listo para deploy manual.");
