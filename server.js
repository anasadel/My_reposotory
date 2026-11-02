"use strict";

// Asset Shelf local server.
// Serves the app on http://127.0.0.1:5173 and talks to the Unreal Editor
// through its Remote Control API: imports FBX files, copies Unreal assets
// into the project's Content folder, and exports meshes for 3D preview.
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
const UNREAL_FILE_EXTENSIONS = new Set([".uasset", ".umap", ".uexp", ".ubulk", ".uptnl"]);
let projectInfo = null;

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
      "  'engineVersion': unreal.SystemLibrary.get_engine_version().split('-')[0],",
      "  'contentDir': unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_content_dir())",
      "}))"
    ].join("\n"), 1500);
    projectInfo = state;
    return { connected: true, projectName: state.projectName, engineVersion: "UE " + state.engineVersion };
  } catch (error) {
    projectInfo = null;
    return { connected: false, reason: error && error.message ? error.message : "Unreal Editor is not reachable." };
  }
}

async function getContentDir() {
  if (!projectInfo) await getUnrealStatus();
  if (!projectInfo || !projectInfo.contentDir) throw new Error("Unreal Editor is not connected.");
  return path.resolve(projectInfo.contentDir);
}

// Runs a Python script in Unreal with `data` available as a dict.
function pythonWithData(data, lines) {
  return ["import json, os, unreal", "data = json.loads(" + JSON.stringify(JSON.stringify(data)) + ")"].concat(lines).join("\n");
}

function isValidGamePath(value) {
  return typeof value === "string" && /^\/Game(\/[^\/\\:*?"<>|.\x00-\x1f]+)+$/.test(value);
}

function isValidContentPath(value) {
  const parts = String(value || "").split("/");
  return parts.length > 0 && parts.every(function (part) {
    return part && part !== "." && part !== ".." && !/[\\:*?"<>|\x00-\x1f]/.test(part);
  }) && UNREAL_FILE_EXTENSIONS.has(path.extname(value).toLowerCase());
}

function readJson(req) {
  return new Promise(function (resolve, reject) {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", function (chunk) {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) { req.destroy(); reject(new Error("Request is too large.")); }
    });
    req.on("end", function () {
      try { resolve(JSON.parse(body || "{}")); } catch (_error) { reject(new Error("Request is not valid JSON.")); }
    });
    req.on("error", reject);
  });
}

// Folders that contain the given packages, e.g. /Game/Pack/Meshes.
function packageFolders(packages) {
  return Array.from(new Set(packages.map(function (item) { return item.split("/").slice(0, -1).join("/"); })));
}

// Copies one Unreal file into the project's Content folder. Never overwrites.
async function writeContentFile(req, res, url) {
  const relative = String(url.searchParams.get("path") || "");
  if (!isValidContentPath(relative)) {
    req.resume();
    return sendJson(res, 400, { success: false, error: "Not an Unreal content file path: " + relative });
  }
  const contentDir = await getContentDir();
  const target = path.resolve(contentDir, relative);
  if (!target.startsWith(contentDir + path.sep)) {
    req.resume();
    return sendJson(res, 400, { success: false, error: "Path is outside the Content folder." });
  }
  if (fs.existsSync(target)) {
    req.resume();
    return sendJson(res, 200, { success: true, written: false });
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const partial = target + ".assetshelf-part";
  try {
    await saveRequestBody(req, partial);
    fs.renameSync(partial, target);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
  sendJson(res, 200, { success: true, written: true });
}

// Tells Unreal about newly copied files and shows the asset in the Content Browser.
async function registerContent(req, res) {
  const body = await readJson(req);
  const packages = Array.isArray(body.packages) ? body.packages.filter(isValidGamePath) : [];
  if (!packages.length || !isValidGamePath(body.select)) return sendJson(res, 400, { success: false, error: "No Unreal assets to register." });
  await runUnrealPython(pythonWithData({ folders: packageFolders(packages), select: body.select }, [
    "unreal.AssetRegistryHelpers.get_asset_registry().scan_paths_synchronous(data['folders'], True)",
    "unreal.EditorAssetLibrary.sync_browser_to_objects([data['select']])",
    "print(" + JSON.stringify(RESULT_MARKER) + " + json.dumps({'ok': True}))"
  ]), 5 * 60 * 1000);
  sendJson(res, 200, { success: true });
}

// Exports a mesh to FBX for the 3D preview, then deletes packages that were
// copied only for this preview.
async function previewMesh(req, res) {
  const body = await readJson(req);
  const packages = Array.isArray(body.packages) ? body.packages.filter(isValidGamePath) : [];
  const cleanup = Array.isArray(body.cleanup) ? body.cleanup.filter(isValidGamePath) : [];
  if (!isValidGamePath(body.package)) return sendJson(res, 400, { success: false, error: "Not an Unreal asset path." });
  // Folders to remove if the preview left them empty, deepest first.
  const emptyFolders = new Set();
  cleanup.forEach(function (item) {
    const parts = item.split("/");
    for (let length = parts.length - 1; length > 2; length -= 1) emptyFolders.add(parts.slice(0, length).join("/"));
  });
  const folder = path.join(UPLOAD_DIR, crypto.randomUUID());
  fs.mkdirSync(folder, { recursive: true });
  const output = path.join(folder, "preview.fbx");
  try {
    const result = await runUnrealPython(pythonWithData({
      package: body.package, output: output, cleanup: cleanup,
      scan: packageFolders(packages.concat([body.package])),
      folders: Array.from(emptyFolders).sort(function (a, b) { return b.length - a.length; })
    }, [
      "lib = unreal.EditorAssetLibrary",
      "result = {'exported': False, 'error': '', 'leftover': []}",
      "try:",
      "    unreal.AssetRegistryHelpers.get_asset_registry().scan_paths_synchronous(data['scan'], True)",
      "    asset = lib.load_asset(data['package'])",
      "    exporter = None",
      "    if asset is None:",
      "        result['error'] = 'Unreal could not load this asset. It may have been made with a newer Unreal version.'",
      "    elif isinstance(asset, unreal.StaticMesh):",
      "        exporter = unreal.StaticMeshExporterFBX()",
      "    elif isinstance(asset, unreal.SkeletalMesh):",
      "        exporter = unreal.SkeletalMeshExporterFBX()",
      "    else:",
      "        result['error'] = 'This asset is a ' + asset.get_class().get_name() + ', not a mesh.'",
      "    if exporter is not None:",
      "        task = unreal.AssetExportTask()",
      "        task.object = asset",
      "        task.filename = data['output']",
      "        task.automated = True",
      "        task.prompt = False",
      "        task.replace_identical = True",
      "        task.exporter = exporter",
      "        result['exported'] = bool(unreal.Exporter.run_asset_export_task(task)) and os.path.exists(data['output'])",
      "        if not result['exported']:",
      "            result['error'] = 'Unreal could not export this mesh.'",
      "        task = None",
      "    asset = None",
      "except Exception as error:",
      "    result['error'] = str(error)",
      "finally:",
      "    for item in data['cleanup']:",
      "        if lib.does_asset_exist(item) and not lib.delete_asset(item):",
      "            result['leftover'].append(item)",
      "    for item in data['folders']:",
      "        if lib.does_directory_exist(item) and not lib.does_directory_have_assets(item, True):",
      "            lib.delete_directory(item)",
      "    print(" + JSON.stringify(RESULT_MARKER) + " + json.dumps(result))"
    ]), 10 * 60 * 1000);
    if (!result.exported) return sendJson(res, 422, { success: false, error: result.error || "Unreal could not export this mesh." });
    const data = fs.readFileSync(output);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": data.length, "X-Asset-Shelf-Leftover": String(result.leftover.length) });
    res.end(data);
  } finally {
    fs.rm(folder, { recursive: true, force: true }, function () {});
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
    if (url.pathname === "/api/unreal/content" && req.method === "PUT") return await writeContentFile(req, res, url);
    if (url.pathname === "/api/unreal/content/register" && req.method === "POST") return await registerContent(req, res);
    if (url.pathname === "/api/unreal/preview" && req.method === "POST") return await previewMesh(req, res);
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
