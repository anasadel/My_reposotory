"use strict";

// Asset Shelf local server.
// Serves the app on http://127.0.0.1:5173 and forwards "send to Unreal"
// requests to the Unreal Editor through its Remote Control API.
//
// Unreal needs these plugins enabled: "Remote Control API" and
// "Python Editor Script Plugin", plus "Allow Remote Python Execution"
// in Project Settings > Plugins > Remote Control.

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 5173;
const HOST = "127.0.0.1";
const UNREAL_URL = (process.env.UNREAL_URL || "http://127.0.0.1:30010").replace(/\/+$/, "");
const ROOT = __dirname;
const UPLOAD_DIR = path.join(os.tmpdir(), "asset-shelf-imports");
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;
const PYTHON_LIBRARY = "/Script/PythonScriptPlugin.Default__PythonScriptLibrary";
const RESULT_MARKER = "ASSET_SHELF_RESULT:";

const STATIC_FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/styles.css": "styles.css",
  "/preview-viewer.bundle.js": "preview-viewer.bundle.js"
};
const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

// Run Python inside the Unreal Editor and return the JSON the script prints after RESULT_MARKER.
async function runUnrealPython(code, timeoutMs) {
  const response = await fetch(UNREAL_URL + "/remote/object/call", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs || 3000),
    body: JSON.stringify({
      objectPath: PYTHON_LIBRARY,
      functionName: "ExecutePythonCommandEx",
      parameters: { PythonCommand: code, ExecutionMode: "ExecuteFile", FileExecutionScope: "Private" }
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(/python/i.test(text)
      ? "Unreal refused the Python call. Enable \"Allow Remote Python Execution\" in Project Settings > Remote Control."
      : "Unreal Remote Control returned HTTP " + response.status + ".");
  }
  const result = JSON.parse(text);
  const lines = (result.LogOutput || []).map(function (entry) { return String(entry.Output || ""); });
  const line = lines.find(function (item) { return item.startsWith(RESULT_MARKER); });
  if (!line) {
    const errors = lines.filter(function (item) { return item.trim(); }).join("\n");
    throw new Error(errors || result.CommandResult || "Unreal did not return a result.");
  }
  return JSON.parse(line.slice(RESULT_MARKER.length));
}

async function getUnrealStatus() {
  try {
    const state = await runUnrealPython([
      "import json, unreal",
      "print(" + JSON.stringify(RESULT_MARKER) + " + json.dumps({",
      "  'projectName': unreal.SystemLibrary.get_game_name(),",
      "  'engineVersion': unreal.SystemLibrary.get_engine_version().split('-')[0]",
      "}))"
    ].join("\n"), 1500);
    return { connected: true, projectName: state.projectName, engineVersion: "UE " + state.engineVersion };
  } catch (error) {
    return { connected: false, reason: error && error.message ? error.message : "Unreal Editor is not reachable." };
  }
}

function isValidDestination(value) {
  return /^\/Game(\/[A-Za-z0-9_\-]+)*\/?$/.test(value);
}

function safeFilename(value) {
  const name = path.basename(String(value || "")).replace(/[^A-Za-z0-9_.\-]/g, "_");
  return /\.fbx$/i.test(name) ? name : "";
}

function saveRequestBody(req, filePath) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const output = fs.createWriteStream(filePath);
    req.on("data", function (chunk) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        req.destroy();
        output.destroy();
        reject(new Error("File is too large."));
      }
    });
    req.on("error", reject);
    output.on("error", reject);
    output.on("finish", resolve);
    req.pipe(output);
  });
}

async function importIntoUnreal(req, res, url) {
  const filename = safeFilename(url.searchParams.get("filename"));
  const destination = String(url.searchParams.get("destination") || "").trim().replace(/\/+$/, "");
  if (!filename) return sendJson(res, 400, { success: false, error: "Only .fbx files can be sent." });
  if (!isValidDestination(destination)) return sendJson(res, 400, { success: false, error: "Destination must be a Content folder such as /Game/AssetShelf." });

  const folder = path.join(UPLOAD_DIR, crypto.randomUUID());
  fs.mkdirSync(folder, { recursive: true });
  const filePath = path.join(folder, filename);
  try {
    await saveRequestBody(req, filePath);
    const result = await runUnrealPython([
      "import json, unreal",
      "task = unreal.AssetImportTask()",
      "task.filename = " + JSON.stringify(filePath),
      "task.destination_path = " + JSON.stringify(destination),
      "task.automated = True",
      "task.replace_existing = False",
      "task.save = True",
      "unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])",
      "paths = list(task.imported_object_paths or [])",
      "print(" + JSON.stringify(RESULT_MARKER) + " + json.dumps({'imported': paths}))"
    ].join("\n"), 10 * 60 * 1000);
    if (!result.imported.length) return sendJson(res, 500, { success: false, error: "Unreal did not import anything. Check the Output Log in Unreal." });
    sendJson(res, 200, { success: true, imported: result.imported });
  } catch (error) {
    sendJson(res, 502, { success: false, error: error && error.message ? error.message : "Import failed." });
  } finally {
    fs.rm(folder, { recursive: true, force: true }, function () {});
  }
}

const server = http.createServer(async function (req, res) {
  const url = new URL(req.url, "http://" + HOST);
  try {
    if (url.pathname === "/api/unreal/status" && req.method === "GET") return sendJson(res, 200, await getUnrealStatus());
    if (url.pathname === "/api/unreal/import" && req.method === "POST") return await importIntoUnreal(req, res, url);
    const file = STATIC_FILES[url.pathname];
    if (file && req.method === "GET") {
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[path.extname(file)], "Cache-Control": "no-cache" });
      return fs.createReadStream(path.join(ROOT, file)).pipe(res);
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (error) {
    sendJson(res, 500, { success: false, error: error && error.message ? error.message : "Server error." });
  }
});

server.listen(PORT, HOST, function () {
  console.log("Asset Shelf running at http://" + HOST + ":" + PORT);
  console.log("Looking for Unreal Remote Control at " + UNREAL_URL);
});
