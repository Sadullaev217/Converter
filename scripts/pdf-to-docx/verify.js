"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/**
 * Renders the generated .docx back to page images so a human (or a
 * follow-up vision step) can sanity-check headings/tables/images landed
 * correctly before trusting the output.
 *
 *   soffice --headless --convert-to pdf <docx> --outdir <tmpDir>
 *   pdftoppm -png <tmpDir>/<name>.pdf <tmpDir>/check
 *
 * Returns the list of rendered check-image paths.
 */
function verifyDocx(docxPath, tmpDir) {
  const convert = spawnSync(
    "soffice",
    ["--headless", "--convert-to", "pdf", docxPath, "--outdir", tmpDir],
    { encoding: "utf8", timeout: 120000 },
  );
  if (convert.status !== 0) {
    throw new Error(`soffice conversion failed: ${convert.stderr || convert.stdout || convert.error}`);
  }

  const baseName = path.basename(docxPath, path.extname(docxPath));
  const renderedPdf = path.join(tmpDir, `${baseName}.pdf`);
  if (!fs.existsSync(renderedPdf)) {
    throw new Error(`soffice did not produce expected file: ${renderedPdf}`);
  }

  const checkPrefix = path.join(tmpDir, "check");
  const render = spawnSync("pdftoppm", ["-png", renderedPdf, checkPrefix], { encoding: "utf8" });
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
