import http from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3020);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 1_500_000_000);

const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const RENDER_DIR = path.join(__dirname, "renders");
const MAX_INPUT_VIDEOS = 120;
const MAX_GRID_SIDE = 120;
const MAX_GRID_CELLS = 120;
const MAX_GAP = 128;
const MIN_THUMBNAIL_CELL_SIZE = 8;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska"
};

await mkdir(UPLOAD_DIR, { recursive: true });
await mkdir(RENDER_DIR, { recursive: true });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, ffmpeg: "required", port: PORT });
    }

    if (req.method === "POST" && url.pathname === "/api/render") {
      return await handleRender(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/twitter-thumbnail") {
      return await handleTwitterThumbnail(req, res);
    }

    const isFileRequest = req.method === "GET" || req.method === "HEAD";

    if (isFileRequest && url.pathname.startsWith("/download/")) {
      const filename = path.basename(decodeURIComponent(url.pathname));
      return serveFile(res, path.join(RENDER_DIR, filename), { download: true, head: req.method === "HEAD" });
    }

    if (isFileRequest && url.pathname.startsWith("/renders/")) {
      const filename = path.basename(decodeURIComponent(url.pathname));
      return serveFile(res, path.join(RENDER_DIR, filename), { head: req.method === "HEAD" });
    }

    if (isFileRequest) {
      const safePath = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      return serveFile(res, path.join(PUBLIC_DIR, safePath), { head: req.method === "HEAD" });
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    sendJson(res, error.statusCode || 500, {
      error: error.publicMessage || "Something went wrong.",
      detail: error.stderr ? trimFfmpegLog(error.stderr) : undefined
    });
  }
});

server.listen(PORT, () => {
  console.log(`Side 2 Side is running at http://localhost:${PORT}`);
});

async function handleRender(req, res) {
  const { files, fields } = await readMultipartUpload(req);

  if (files.length < 2) {
    return sendJson(res, 400, { error: "Add at least two video files." });
  }

  if (files.length > MAX_INPUT_VIDEOS) {
    return sendJson(res, 400, { error: `Add ${MAX_INPUT_VIDEOS} videos or fewer.` });
  }

  const height = makeEven(clampNumber(fields.height, 360, 3840, 1280));
  const rows = clampNumber(fields.rows, 1, MAX_GRID_SIDE, 1);
  const columns = clampNumber(fields.columns, 1, MAX_GRID_SIDE, files.length);
  const cellCount = rows * columns;
  const gap = makeEvenDown(clampNumber(fields.gap, 0, MAX_GAP, 0));
  const fit = fields.fit === "contain" ? "contain" : "cover";
  const crf = clampNumber(fields.quality, 16, 32, 20);
  const preset = ["ultrafast", "veryfast", "faster", "fast", "medium", "slow"].includes(fields.preset)
    ? fields.preset
    : "fast";
  const audio = fields.audio === "none" ? "none" : "first";

  if (cellCount < files.length) {
    return sendJson(res, 400, {
      error: `The ${rows} x ${columns} grid only has ${cellCount} cells for ${files.length} videos.`
    });
  }

  if (cellCount > MAX_GRID_CELLS) {
    return sendJson(res, 400, { error: `Choose a layout with ${MAX_GRID_CELLS} cells or fewer.` });
  }

  const jobId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const jobDir = path.join(UPLOAD_DIR, jobId);
  await mkdir(jobDir, { recursive: true });

  const inputPaths = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const ext = videoExtension(file.filename);
    if (!ext) {
      return sendJson(res, 400, { error: `${file.filename} is not a supported video file.` });
    }

    const inputPath = path.join(jobDir, `${String(index + 1).padStart(2, "0")}-${safeFilename(file.filename, ext)}`);
    await writeFile(inputPath, file.data);
    inputPaths.push(inputPath);
  }

  const outputFilename = `side-by-side-${jobId}.mp4`;
  const outputPath = path.join(RENDER_DIR, outputFilename);
  const result = await renderWithFfmpeg(inputPaths, outputPath, { height, rows, columns, gap, fit, crf, preset, audio });

  await Promise.all(inputPaths.map((inputPath) => unlink(inputPath).catch(() => {})));
  await rm(jobDir, { recursive: true, force: true });

  sendJson(res, 200, {
    ok: true,
    filename: outputFilename,
    url: `/renders/${encodeURIComponent(outputFilename)}`,
    downloadUrl: `/download/${encodeURIComponent(outputFilename)}`,
    settings: { height, rows, columns, gap, fit, crf, preset, audio, inputs: inputPaths.length },
    log: trimFfmpegLog(result.stderr)
  });
}

async function handleTwitterThumbnail(req, res) {
  const { files, fields } = await readMultipartUpload(req);

  if (files.length < 1) {
    return sendJson(res, 400, { error: "Add at least one video file." });
  }

  if (files.length > MAX_INPUT_VIDEOS) {
    return sendJson(res, 400, { error: `Add ${MAX_INPUT_VIDEOS} videos or fewer.` });
  }

  const width = 1200;
  const height = 600;
  const rows = clampNumber(fields.rows, 1, MAX_GRID_SIDE, 1);
  const columns = clampNumber(fields.columns, 1, MAX_GRID_SIDE, files.length);
  const cellCount = rows * columns;
  const gap = thumbnailGap(fields.gap, rows, columns, width, height);
  const fit = fields.fit === "contain" ? "contain" : "cover";

  if (cellCount < files.length) {
    return sendJson(res, 400, {
      error: `The ${rows} x ${columns} grid only has ${cellCount} cells for ${files.length} videos.`
    });
  }

  if (cellCount > MAX_GRID_CELLS) {
    return sendJson(res, 400, { error: `Choose a layout with ${MAX_GRID_CELLS} cells or fewer.` });
  }

  const jobId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const jobDir = path.join(UPLOAD_DIR, jobId);
  await mkdir(jobDir, { recursive: true });

  const inputPaths = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const ext = videoExtension(file.filename);
    if (!ext) {
      return sendJson(res, 400, { error: `${file.filename} is not a supported video file.` });
    }

    const inputPath = path.join(jobDir, `${String(index + 1).padStart(2, "0")}-${safeFilename(file.filename, ext)}`);
    await writeFile(inputPath, file.data);
    inputPaths.push(inputPath);
  }

  const outputFilename = `twitter-article-thumbnail-${jobId}.png`;
  const outputPath = path.join(RENDER_DIR, outputFilename);
  const result = await renderTwitterThumbnail(inputPaths, outputPath, { width, height, rows, columns, gap, fit });

  await Promise.all(inputPaths.map((inputPath) => unlink(inputPath).catch(() => {})));
  await rm(jobDir, { recursive: true, force: true });

  sendJson(res, 200, {
    ok: true,
    filename: outputFilename,
    url: `/renders/${encodeURIComponent(outputFilename)}`,
    downloadUrl: `/download/${encodeURIComponent(outputFilename)}`,
    kind: "twitter-thumbnail",
    settings: { width, height, rows, columns, gap, fit, inputs: inputPaths.length },
    log: trimFfmpegLog(result.stderr)
  });
}

async function serveFile(res, filePath, options = {}) {
  const root = filePath.includes(`${path.sep}renders${path.sep}`) ? RENDER_DIR : PUBLIC_DIR;
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(root))) {
    return sendJson(res, 403, { error: "Forbidden" });
  }

  try {
    const fileStat = await stat(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const headers = {
      "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream",
      "Content-Length": fileStat.size,
      "Cache-Control": "no-store"
    };

    if (options.download) {
      headers["Content-Disposition"] = `attachment; filename="${path.basename(resolved)}"`;
    }

    res.writeHead(200, headers);
    if (options.head) return res.end();
    createReadStream(resolved).pipe(res);
  } catch {
    const fallback = path.join(PUBLIC_DIR, "index.html");
    if (resolved !== fallback && root === PUBLIC_DIR) {
      const html = await readFile(fallback);
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[".html"] });
      return res.end(html);
    }
    sendJson(res, 404, { error: "Not found" });
  }
}

function renderWithFfmpeg(inputPaths, outputPath, options) {
  const args = ["-y"];
  for (const inputPath of inputPaths) {
    args.push("-i", inputPath);
  }

  const cellWidth = makeEven(Math.round(options.height * 9 / 16));
  const cellCount = options.rows * options.columns;
  const gap = options.gap || 0;
  const filters = [];

  for (let index = 0; index < cellCount; index += 1) {
    if (index < inputPaths.length) {
      filters.push(
        videoCellFilter(`[${index}:v]`, `cell${index}`, {
          width: cellWidth,
          height: options.height,
          fit: options.fit,
          background: "black"
        })
      );
    } else {
      filters.push(`color=c=black:s=${cellWidth}x${options.height},setsar=1[cell${index}]`);
    }
  }

  stackGridWithXstack(filters, {
    rows: options.rows,
    columns: options.columns,
    cellWidth,
    cellHeight: options.height,
    gap,
    outputLabel: "outv",
    fill: "black",
    shortest: true
  });

  const filter = filters.join(";");

  args.push("-filter_complex", filter, "-map", "[outv]");

  if (options.audio === "first") {
    args.push("-map", "0:a?", "-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-an");
  }

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    options.preset,
    "-crf",
    String(options.crf),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-shortest",
    outputPath
  );

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", args);
    let stderr = "";

    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 80_000) stderr = stderr.slice(-80_000);
    });

    ffmpeg.on("error", (error) => {
      error.publicMessage = "FFmpeg could not start. Make sure ffmpeg is installed.";
      reject(error);
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve({ stderr, args });
      } else {
        const error = new Error(`FFmpeg exited with code ${code}`);
        error.statusCode = 500;
        error.publicMessage = "FFmpeg could not render these videos.";
        error.stderr = stderr;
        error.args = args;
        reject(error);
      }
    });
  });
}

function renderTwitterThumbnail(inputPaths, outputPath, options) {
  const args = ["-y"];
  for (const inputPath of inputPaths) {
    args.push("-i", inputPath);
  }

  const gap = options.gap || 0;
  const cellWidth = Math.max(1, Math.floor((options.width - gap * (options.columns - 1)) / options.columns));
  const cellHeight = Math.max(1, Math.floor((options.height - gap * (options.rows - 1)) / options.rows));
  const cellCount = options.rows * options.columns;
  const canvasColor = "0x080808";
  const filters = [];

  for (let index = 0; index < cellCount; index += 1) {
    if (index < inputPaths.length) {
      filters.push(
        videoCellFilter(`[${index}:v]trim=start_frame=0:end_frame=1,setpts=PTS-STARTPTS`, `cell${index}`, {
          width: cellWidth,
          height: cellHeight,
          fit: options.fit,
          background: canvasColor
        })
      );
    } else {
      filters.push(`color=c=${canvasColor}:s=${cellWidth}x${cellHeight}:d=1,setsar=1[cell${index}]`);
    }
  }

  stackGridWithXstack(filters, {
    rows: options.rows,
    columns: options.columns,
    cellWidth,
    cellHeight,
    gap,
    outputLabel: "grid",
    fill: canvasColor,
    shortest: false
  });

  filters.push(
    `[grid]pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2:color=${canvasColor},format=rgb24[outv]`
  );

  args.push("-filter_complex", filters.join(";"), "-map", "[outv]", "-frames:v", "1", "-update", "1", outputPath);

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", args);
    let stderr = "";

    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 80_000) stderr = stderr.slice(-80_000);
    });

    ffmpeg.on("error", (error) => {
      error.publicMessage = "FFmpeg could not start. Make sure ffmpeg is installed.";
      reject(error);
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve({ stderr, args });
      } else {
        const error = new Error(`FFmpeg exited with code ${code}`);
        error.statusCode = 500;
        error.publicMessage = "FFmpeg could not make the thumbnail image.";
        error.stderr = stderr;
        error.args = args;
        reject(error);
      }
    });
  });
}

function videoCellFilter(inputLabel, outputLabel, options) {
  const scaleMode = options.fit === "contain" ? "decrease" : "increase";
  const fitFilter =
    options.fit === "contain"
      ? `pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2:color=${options.background}`
      : `crop=${options.width}:${options.height}:(iw-ow)/2:(ih-oh)/2`;

  return `${inputLabel},scale=${options.width}:${options.height}:force_original_aspect_ratio=${scaleMode},${fitFilter},setsar=1[${outputLabel}]`;
}

function stackGridWithXstack(filters, options) {
  const cellCount = options.rows * options.columns;

  if (cellCount === 1) {
    filters.push(`[cell0]null[${options.outputLabel}]`);
    return;
  }

  const inputs = Array.from({ length: cellCount }, (_, index) => `[cell${index}]`).join("");
  const layout = Array.from({ length: cellCount }, (_, index) => {
    const column = index % options.columns;
    const row = Math.floor(index / options.columns);
    return `${column * (options.cellWidth + options.gap)}_${row * (options.cellHeight + options.gap)}`;
  }).join("|");
  const xstackOptions = [`inputs=${cellCount}`, `layout=${layout}`, `fill=${options.fill}`];
  if (options.shortest) xstackOptions.push("shortest=1");

  filters.push(`${inputs}xstack=${xstackOptions.join(":")}[${options.outputLabel}]`);
}

async function readMultipartUpload(req) {
  const contentType = req.headers["content-type"] || "";
  const boundary = getBoundary(contentType);

  if (!boundary) {
    const error = new Error("Expected a multipart upload.");
    error.statusCode = 400;
    error.publicMessage = "Expected a multipart upload.";
    throw error;
  }

  const body = await readRequestBody(req);
  const parts = parseMultipartBody(body, boundary);
  const files = parts.filter((part) => part.filename && part.data.length > 0);
  const fields = Object.fromEntries(
    parts
      .filter((part) => !part.filename)
      .map((part) => [part.name, part.data.toString("utf8").trim()])
  );

  return { files, fields };
}

async function readRequestBody(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_UPLOAD_BYTES) {
      const error = new Error("Upload too large");
      error.statusCode = 413;
      error.publicMessage = "Upload is too large for this local app run.";
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function parseMultipartBody(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const sections = splitBuffer(buffer, delimiter);
  const parts = [];

  for (const section of sections) {
    if (section.length < 6) continue;

    let part = section;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(0, 2).toString() === "--") continue;

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;

    const rawHeaders = part.subarray(0, headerEnd).toString("latin1");
    let data = part.subarray(headerEnd + 4);
    if (data.subarray(data.length - 2).toString() === "\r\n") data = data.subarray(0, data.length - 2);

    const headers = parseHeaders(rawHeaders);
    const disposition = parseDisposition(headers["content-disposition"] || "");

    if (disposition.name) {
      parts.push({
        name: disposition.name,
        filename: disposition.filename,
        contentType: headers["content-type"],
        data
      });
    }
  }

  return parts;
}

function splitBuffer(buffer, delimiter) {
  const chunks = [];
  let start = 0;
  let index = buffer.indexOf(delimiter, start);

  while (index !== -1) {
    chunks.push(buffer.subarray(start, index));
    start = index + delimiter.length;
    index = buffer.indexOf(delimiter, start);
  }

  chunks.push(buffer.subarray(start));
  return chunks;
}

function parseHeaders(rawHeaders) {
  return Object.fromEntries(
    rawHeaders
      .split("\r\n")
      .map((line) => {
        const index = line.indexOf(":");
        return index === -1 ? null : [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
      })
      .filter(Boolean)
  );
}

function parseDisposition(value) {
  const result = {};
  for (const segment of value.split(";")) {
    const [rawKey, rawValue] = segment.trim().split("=");
    if (!rawValue) continue;
    result[rawKey] = rawValue.replace(/^"|"$/g, "");
  }
  return result;
}

function getBoundary(contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match ? match[1] || match[2] : "";
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function makeEven(value) {
  return value % 2 === 0 ? value : value + 1;
}

function makeEvenDown(value) {
  return value % 2 === 0 ? value : value - 1;
}

function thumbnailGap(value, rows, columns, width, height) {
  const requested = makeEvenDown(clampNumber(value, 0, MAX_GAP, 0));
  const maxHorizontalGap =
    columns > 1 ? Math.floor((width - columns * MIN_THUMBNAIL_CELL_SIZE) / (columns - 1)) : MAX_GAP;
  const maxVerticalGap =
    rows > 1 ? Math.floor((height - rows * MIN_THUMBNAIL_CELL_SIZE) / (rows - 1)) : MAX_GAP;
  const maxGap = Math.max(0, Math.min(MAX_GAP, maxHorizontalGap, maxVerticalGap));
  return Math.max(0, makeEvenDown(Math.min(requested, maxGap)));
}

function videoExtension(filename) {
  const ext = path.extname(filename).toLowerCase();
  return [".mp4", ".mov", ".webm", ".mkv", ".m4v"].includes(ext) ? ext : "";
}

function safeFilename(filename, ext) {
  const base = path.basename(filename, path.extname(filename)).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return `${base || "video"}${ext}`;
}

function trimFfmpegLog(log) {
  return log
    .split("\n")
    .filter(Boolean)
    .slice(-18)
    .join("\n");
}
