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

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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
      return handleRender(req, res);
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
  const contentType = req.headers["content-type"] || "";
  const boundary = getBoundary(contentType);

  if (!boundary) {
    return sendJson(res, 400, { error: "Expected a multipart upload." });
  }

  const body = await readRequestBody(req);
  const parts = parseMultipartBody(body, boundary);
  const files = parts.filter((part) => part.filename && part.data.length > 0);

  if (files.length < 2) {
    return sendJson(res, 400, { error: "Add at least two video files." });
  }

  const fields = Object.fromEntries(
    parts
      .filter((part) => !part.filename)
      .map((part) => [part.name, part.data.toString("utf8").trim()])
  );

  const height = makeEven(clampNumber(fields.height, 360, 3840, 1280));
  const crf = clampNumber(fields.quality, 16, 32, 20);
  const preset = ["ultrafast", "veryfast", "faster", "fast", "medium", "slow"].includes(fields.preset)
    ? fields.preset
    : "fast";
  const audio = fields.audio === "none" ? "none" : "first";
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
  const result = await renderWithFfmpeg(inputPaths, outputPath, { height, crf, preset, audio });

  await Promise.all(inputPaths.map((inputPath) => unlink(inputPath).catch(() => {})));
  await rm(jobDir, { recursive: true, force: true });

  sendJson(res, 200, {
    ok: true,
    filename: outputFilename,
    url: `/renders/${encodeURIComponent(outputFilename)}`,
    downloadUrl: `/download/${encodeURIComponent(outputFilename)}`,
    settings: { height, crf, preset, audio, inputs: inputPaths.length },
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

  const scaledVideos = inputPaths
    .map((_, index) => `[${index}:v]scale=-2:${options.height},setsar=1[v${index}]`)
    .join(";");
  const stackInputs = inputPaths.map((_, index) => `[v${index}]`).join("");
  const filter = `${scaledVideos};${stackInputs}hstack=inputs=${inputPaths.length}:shortest=1[outv]`;

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
