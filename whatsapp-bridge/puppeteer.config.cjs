/**
 * Puppeteer configuration file.
 * Puppeteer (v19+) reads this automatically when it lives next to package.json.
 * This ensures the system Chromium is used instead of Puppeteer's downloaded bundle.
 */
const fs = require("fs");

// Prefer the env var (set in Dockerfile), then fall back through known Alpine paths.
function findChromium() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const candidates = [
    "/usr/local/bin/chromium-wr",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/lib/chromium/chromium",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

const executablePath = findChromium();

module.exports = {
  executablePath,
  skipDownload: true,
};
