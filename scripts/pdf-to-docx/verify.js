"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");
const { toolPath } = require("./checkDeps");

/**
 * Renders the generated .docx back to page images so a human (or a
 * follow-up vision step) can sanity-check headings/tables/images landed
 * correctly before trusting the output.
 *
 *   soffice --headless --convert-to pdf <docx> --outdir <tmpDir>
 *   pdftoppm -png <tmpDir>/<name>.pdf <tmpDir>/check
 *
 * Each run gets its own LibreOffice user profile: two headless soffice
 * processes sharing the default profile lock each other out, which
 * matters when several conversions run at once (e.g. behind the web app).
 *
 * Returns the list of rendered check-image paths.
 */
function verifyDocx(docxPath, tmpDir) {
  const profileDir = path.join(tmpDir, "lo-profile");
  const convert = spawnSync(
    toolPath("soffice"),
    [
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      "--headless",
      "--convert-to",
      "pdf",
      docxPath,
      "--outdir",
      tmpDir,
    ],
    { encoding: "utf8", timeout: 120000 },
  );
  fs.rmSync(profileDir, { recursive: true, force: true });
  if (convert.status !== 0) {
    throw new Error(`soffice conversion failed: ${convert.stderr || convert.stdout || convert.error}`);
  }

  const baseName = path.basename(docxPath, path.extname(docxPath));
  const renderedPdf = path.join(tmpDir, `${baseName}.pdf`);
  if (!fs.existsSync(renderedPdf)) {
    throw new Error(`soffice did not produce expected file: ${renderedPdf}`);
  }

  const checkPrefix = path.join(tmpDir, "check");
  const render = spawnSync(toolPath("pdftoppm"), ["-png", renderedPdf, checkPrefix], { encoding: "utf8" });
  if (render.status !== 0) {
    throw new Error(`pdftoppm failed: ${render.stderr || render.error}`);
  }

  return fs
    .readdirSync(tmpDir)
    .filter((name) => name.startsWith("check") && name.endsWith(".png"))
    .sort()
    .map((name) => path.join(tmpDir, name));
}

module.exports = { verifyDocx };
