"use strict";

const folderInput = document.getElementById("folderInput");
const folderStatus = document.getElementById("folderStatus");
const emptyState = document.getElementById("emptyState");
const libraryContent = document.getElementById("libraryContent");
const packageGrid = document.getElementById("packageGrid");
const packageCount = document.getElementById("packageCount");
const resultSummary = document.getElementById("resultSummary");
const filterSummary = document.getElementById("filterSummary");
const noResults = document.getElementById("noResults");
const searchInput = document.getElementById("searchInput");
const inspector = document.getElementById("inspector");
const toast = document.getElementById("toast");
const sortButton = document.getElementById("sortButton");
const supportedExtensions = new Set(["fbx", "obj", "gltf", "glb", "usd", "usdz"]);
const unrealAssetExtensions = new Set(["uasset", "umap"]);
const unrealContentExtensions = new Set(["uasset", "umap", "uexp", "ubulk", "uptnl"]);
const unrealTypeOrder = ["All", "Meshes", "Materials", "Textures", "Blueprints", "Animation", "Effects", "Audio", "Maps", "Other"];
const galleryLimit = 300;
// Unreal files by content root + path inside Content, used to find dependencies.
let unrealContentFiles = new Map();
let galleryTypeFilter = "All";
let unrealPreviewCache = new Map();
let unrealProgressText = "";
const tagsStorageKey = "assetShelfPrototype.tags.v1";
let packages = [];
let localFilesByPath = new Map();
let activeFilter = "all";
let selectedPackageKey = "";
let selectedAssetKey = "";
let sortMode = "name";
let tagMap = readTags();
let thumbnailDataByKey = new Map();
let thumbnailMissingTexturesByKey = new Set();
let thumbnailPendingKeys = new Set();
let libraryScanGeneration = 0;
let assetThumbnailObserver = null;
let selectedModelPreview = null;
let toastTimer = 0;
let unrealBridge = { connected: false, projectName: "" };
let isSendingToUnreal = false;
let selectedDirectoryHandle = null;
const directoryDatabaseName = "assetShelfPrototype";
const directoryStoreName = "settings";
const selectedDirectoryKey = "selectedDirectory";
const reconnectFolderButton = document.getElementById("reconnectFolder");

document.getElementById("chooseFolder").addEventListener("click", openFolderPicker);
document.getElementById("emptyChoose").addEventListener("click", openFolderPicker);
reconnectFolderButton.addEventListener("click", reconnectSavedDirectory);
folderInput.addEventListener("change", async function () {
  if (!folderInput.files || !folderInput.files.length) return;
  selectedDirectoryHandle = null;
  reconnectFolderButton.hidden = true;
  await removeSavedDirectoryHandle();
  const entries = Array.from(folderInput.files).map(function (file) {
    return { file: file, path: normalizePath(file.webkitRelativePath || file.name) };
  });
  const rootName = entries[0].path.split("/")[0] || "selected folder";
  await scanSelectedFolder(entries, rootName, true);
});
searchInput.addEventListener("input", renderLibrary);
sortButton.addEventListener("click", function () {
  sortMode = sortMode === "name" ? "size" : "name";
  sortButton.innerHTML = (sortMode === "name" ? "A–Z" : "Most files") + " <span>⌄</span>";
  renderLibrary();
});
window.addEventListener("keydown", function (event) {
  if (event.ctrlKey && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchInput.focus();
  }
});
document.querySelectorAll(".filter-button").forEach(function (button) {
  button.addEventListener("click", function () {
    activeFilter = button.dataset.filter || "all";
    document.querySelectorAll(".filter-button").forEach(function (item) {
      item.classList.toggle("active", item === button);
    });
    filterSummary.textContent = activeFilter === "all" ? "Showing all packages" : "Filtered: " + button.textContent.trim();
    renderLibrary();
  });
});
void restoreSavedDirectory();
refreshUnrealStatus();
window.setInterval(refreshUnrealStatus, 5000);

async function openFolderPicker() {
  if (typeof window.showDirectoryPicker === "function") {
    let pickedDirectory = null;
    try {
      const directory = await window.showDirectoryPicker({ mode: "read" });
      pickedDirectory = directory;
      selectedDirectoryHandle = directory;
      reconnectFolderButton.hidden = true;
      const saved = await saveDirectoryHandle(directory);
      if (!saved) await removeSavedDirectoryHandle();
      await readAndScanDirectory(directory);
      if (!saved) showToast("Folder selected, but this browser could not save it for next time.");
    } catch (error) {
      if (error && error.name === "AbortError") return;
      if (pickedDirectory) showDirectoryReconnectState(pickedDirectory);
      else folderStatus.textContent = "Could not read the selected folder";
      showToast("Could not read that folder. Try selecting FabLibrary.");
    }
    return;
  }
  showToast("This browser uses its folder file picker. Files are read locally and are not sent.");
  folderInput.click();
}

async function restoreSavedDirectory() {
  if (typeof window.showDirectoryPicker !== "function" || !window.indexedDB) return;
  try {
    const directory = await loadSavedDirectoryHandle();
    if (!directory) return;
    selectedDirectoryHandle = directory;
    const permission = await directory.queryPermission({ mode: "read" });
    if (permission === "granted") {
      folderStatus.textContent = "Restoring " + directory.name + " locally…";
      await readAndScanDirectory(directory);
    } else {
      showDirectoryReconnectState(directory);
    }
  } catch (_error) {
    if (selectedDirectoryHandle) showDirectoryReconnectState(selectedDirectoryHandle);
    else folderStatus.textContent = "Could not restore the saved folder. Choose it again.";
  }
}

async function reconnectSavedDirectory() {
  const directory = selectedDirectoryHandle;
  if (!directory || typeof directory.requestPermission !== "function") {
    showToast("Choose the library folder again to restore access.");
    return;
  }
  try {
    const permission = await directory.requestPermission({ mode: "read" });
    if (permission !== "granted") {
      folderStatus.textContent = directory.name + " · permission not granted";
      showToast("Folder access was not granted.");
      return;
    }
    reconnectFolderButton.hidden = true;
    await readAndScanDirectory(directory);
  } catch (_error) {
    showDirectoryReconnectState(directory);
    showToast("Could not read the saved folder. Choose it again.");
  }
}

function showDirectoryReconnectState(directory) {
  folderStatus.textContent = directory.name + " · permission needed";
  reconnectFolderButton.hidden = false;
}

async function readAndScanDirectory(directory) {
  const entries = [];
  folderStatus.textContent = "Reading " + directory.name + " locally…";
  await collectDirectoryFiles(directory, "", entries);
  await scanSelectedFolder(entries, directory.name, false);
}

function openDirectoryDatabase() {
  return new Promise(function (resolve, reject) {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = window.indexedDB.open(directoryDatabaseName, 1);
    request.onupgradeneeded = function () {
      if (!request.result.objectStoreNames.contains(directoryStoreName)) request.result.createObjectStore(directoryStoreName);
    };
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error || new Error("Could not open browser storage")); };
  });
}

async function loadSavedDirectoryHandle() {
  let database;
  try {
    database = await openDirectoryDatabase();
    return await new Promise(function (resolve, reject) {
      const request = database.transaction(directoryStoreName, "readonly").objectStore(directoryStoreName).get(selectedDirectoryKey);
      request.onsuccess = function () { resolve(request.result || null); };
      request.onerror = function () { reject(request.error || new Error("Could not read saved folder")); };
    });
  } finally {
    if (database) database.close();
  }
}

async function saveDirectoryHandle(directory) {
  let database;
  try {
    database = await openDirectoryDatabase();
    await new Promise(function (resolve, reject) {
      const transaction = database.transaction(directoryStoreName, "readwrite");
      transaction.objectStore(directoryStoreName).put(directory, selectedDirectoryKey);
      transaction.oncomplete = resolve;
      transaction.onerror = function () { reject(transaction.error || new Error("Could not save folder")); };
      transaction.onabort = function () { reject(transaction.error || new Error("Could not save folder")); };
    });
    return true;
  } catch (_error) {
    return false;
  } finally {
    if (database) database.close();
  }
}

async function removeSavedDirectoryHandle() {
  let database;
  try {
    database = await openDirectoryDatabase();
    await new Promise(function (resolve, reject) {
      const transaction = database.transaction(directoryStoreName, "readwrite");
      transaction.objectStore(directoryStoreName).delete(selectedDirectoryKey);
      transaction.oncomplete = resolve;
      transaction.onerror = function () { reject(transaction.error || new Error("Could not clear saved folder")); };
      transaction.onabort = function () { reject(transaction.error || new Error("Could not clear saved folder")); };
    });
  } catch (_error) {
    // The fallback file picker cannot restore a directory handle.
  } finally {
    if (database) database.close();
  }
}

async function collectDirectoryFiles(directory, relativePath, output) {
  for await (const entry of directory.values()) {
    const path = relativePath ? relativePath + "/" + entry.name : entry.name;
    if (entry.kind === "directory") {
      await collectDirectoryFiles(entry, path, output);
    } else if (entry.kind === "file") {
      output.push({ file: await entry.getFile(), path: path });
    }
  }
}

async function scanSelectedFolder(fileEntries, rootName, pathsIncludeRoot) {
  libraryScanGeneration += 1;
  thumbnailMissingTexturesByKey.clear();
  thumbnailPendingKeys.clear();
  unrealPreviewCache.clear();
  unrealContentFiles = new Map();
  fileEntries.forEach(function (entry) {
    if (!unrealContentExtensions.has(extensionOf(entry.file.name))) return;
    const location = getUnrealContentLocation(normalizePath(entry.path).split("/"), rootName, pathsIncludeRoot);
    unrealContentFiles.set(location.prefix + "|" + location.relative.toLowerCase(), { file: entry.file, relative: location.relative });
  });
  const files = fileEntries.map(function (entry) { return entry.file; });
  folderStatus.textContent = "Scanning " + files.length.toLocaleString() + " local files…";
  showToast("Scanning local files…");
  const fileByPath = new Map();
  fileEntries.forEach(function (entry) {
    fileByPath.set(normalizePath(entry.path).toLowerCase(), entry.file);
  });
  localFilesByPath = fileByPath;
  thumbnailDataByKey.clear();
  const unrealPackageFileCount = fileEntries.filter(function (entry) { return ["uasset", "umap"].includes(extensionOf(entry.file.name)); }).length;
  const fabUnrealManifestCount = fileEntries.filter(function (entry) { return normalizePath(entry.path).toLowerCase().endsWith("unreal-engine/manifest"); }).length;

  const packageMap = new Map();
  for (const fileEntry of fileEntries) {
    const file = fileEntry.file;
    const path = normalizePath(fileEntry.path);
    const segments = path.split("/");
    const extension = extensionOf(file.name);
    if (unrealAssetExtensions.has(extension)) {
      // Every Unreal asset belongs to the pack folder directly under Content.
      const location = getUnrealContentLocation(segments, rootName, pathsIncludeRoot);
      const relativeParts = location.relative.split("/");
      const packFolder = relativeParts.length > 1 ? relativeParts[0] : (rootName || "Unreal content");
      const packageKey = location.prefix + packFolder;
      const assetKey = packageKey + "|UNREAL|" + location.relative;
      let record = packageMap.get(packageKey);
      if (!record) {
        record = { key: packageKey, folderName: packFolder, title: prettifyName(packFolder), creator: "Unreal content", formats: new Map(), assets: [], thumbnail: null, metadata: {} };
        packageMap.set(packageKey, record);
      }
      record.assets.push({
        key: assetKey, name: file.name, path: path, format: "UNREAL",
        extension: extension.toUpperCase(), size: file.size, file: file,
        tags: tagMap[assetKey] || [], isUnrealPackageAsset: true,
        unrealType: getUnrealAssetType(file.name, relativeParts),
        contentPrefix: location.prefix, contentRelative: location.relative,
        gamePath: "/Game/" + location.relative.replace(/\.(uasset|umap)$/i, "")
      });
      if (!record.formats.has("UNREAL")) record.formats.set("UNREAL", { metadataFile: null, thumbnailFile: null });
      continue;
    }
    const sourceIndex = segments.findIndex(function (part) { return part.toLowerCase().endsWith("_extracted"); });
    // A selected folder may be the library root (Package/fbx/source_extracted)
    // or the package itself (fbx/source_extracted). In the latter case the
    // package name comes from the selected folder rather than a path segment.
    if (sourceIndex < 1 || !supportedExtensions.has(extension)) continue;

    const format = segments[sourceIndex - 1] || "source";
    const packageParts = segments.slice(0, sourceIndex - 1);
    if (!packageParts.length) packageParts.push(rootName || "Selected package");
    const packageKey = packageParts.join("/");
    const packageName = packageParts[packageParts.length - 1];
    const formatDirectory = segments.slice(0, sourceIndex).join("/");
    const assetKey = packageKey + "|" + format + "|" + segments.slice(sourceIndex + 1).join("/");
    let record = packageMap.get(packageKey);
    if (!record) {
      record = { key: packageKey, folderName: packageName, title: prettifyName(packageName), creator: "Unknown creator", formats: new Map(), assets: [], thumbnail: null, metadata: {} };
      packageMap.set(packageKey, record);
    }
    record.assets.push({
      key: assetKey, name: file.name, path: path, format: format.toUpperCase(),
      extension: extensionOf(file.name).toUpperCase(), size: file.size, file: file,
      tags: tagMap[assetKey] || []
    });
    if (!record.formats.has(format)) {
      const prefix = formatDirectory + "/";
      record.formats.set(format, {
        metadataFile: fileByPath.get((prefix + "metadata").toLowerCase()) || fileByPath.get((prefix + "metadata.json").toLowerCase()) || null,
        thumbnailFile: ["png", "jpg", "jpeg", "webp"].map(function (extension) {
          return fileByPath.get((prefix + "thumbnail." + extension).toLowerCase());
        }).find(Boolean) || null
      });
    }
  }

  packages = Array.from(packageMap.values());
  for (const record of packages) {
    if (record.formats.has("UNREAL")) record.assets.sort(function (a, b) { return a.name.localeCompare(b.name); });
    const firstFormat = record.formats.values().next().value;
    if (firstFormat && firstFormat.thumbnailFile) record.thumbnail = URL.createObjectURL(firstFormat.thumbnailFile);
    for (const formatRecord of record.formats.values()) {
      if (!formatRecord.metadataFile) continue;
      const metadata = await parseMetadata(formatRecord.metadataFile);
      if (Object.keys(metadata).length) record.metadata = Object.assign(record.metadata, metadata);
    }
    const title = findFirstValue(record.metadata, ["title", "productname", "assetname", "displayname", "name"]);
    const creator = findFirstValue(record.metadata, ["creatorname", "creator", "publisher", "publishername", "author", "developer", "seller"]);
    if (title) record.title = title;
    if (creator) record.creator = creator;
  }

  sortPackages();
  packageCount.textContent = String(packages.length);
  const statusNotes = [];
  if (unrealPackageFileCount) statusNotes.push(unrealPackageFileCount.toLocaleString() + " Unreal package files");
  if (fabUnrealManifestCount) statusNotes.push(fabUnrealManifestCount.toLocaleString() + " Fab Unreal manifest entries");
  folderStatus.textContent = rootName + " · " + files.length.toLocaleString() + " local files scanned · " + packages.length + " packages found" + (statusNotes.length ? " · " + statusNotes.join(" · ") : "");
  emptyState.hidden = packages.length > 0;
  libraryContent.hidden = packages.length === 0;
  noResults.hidden = true;
  if (packages.length === 0) {
    if (unrealPackageFileCount) {
      emptyState.querySelector("h3").textContent = "Unreal cache files found";
      emptyState.querySelector("p").textContent = "Read " + unrealPackageFileCount.toLocaleString() + " Unreal package files, but found no assets in a recognized Meshes or Models folder.";
      emptyState.querySelector(".empty-hint").textContent = "Choose the VaultCache data\\Content folder to show saved Unreal thumbnails.";
    } else if (fabUnrealManifestCount) {
      emptyState.querySelector("h3").textContent = "Fab entry contains an Unreal manifest";
      emptyState.querySelector("p").textContent = "This FabLibrary entry has a manifest but no model source files. Its Unreal content is stored separately in VaultCache.";
      emptyState.querySelector(".empty-hint").textContent = "Choose the matching VaultCache\\<package>\\data\\Content folder to show saved Unreal thumbnails.";
    } else {
      emptyState.querySelector("h3").textContent = "No model files found";
      emptyState.querySelector("p").textContent = "Read " + files.length.toLocaleString() + " local files from " + rootName + ", but found no supported 3D model files in a Fab extracted folder.";
      emptyState.querySelector(".empty-hint").textContent = "Choose the Fab library folder or the downloaded package folder that contains the extracted source files.";
    }
  } else {
    emptyState.querySelector("h3").textContent = "Choose your Fab library or package folder";
    emptyState.querySelector("p").textContent = "Choose your Fab library or one downloaded package. Asset Shelf scans the files locally and shows the individual models inside.";
    emptyState.querySelector(".empty-hint").textContent = "Choose either VaultCache\\FabLibrary or the downloaded package folder itself.";
  }
  selectPackage(packages[0] || null);
  renderLibrary();
  renderInspector();
  showToast(packages.length + " packages found · " + countAssets(packages) + " individual assets");
}

// Splits a file path into the part before the Unreal Content folder (prefix)
// and the path inside Content (relative), e.g. "Pack/Meshes/SM_Rock.uasset".
function getUnrealContentLocation(segments, rootName, pathsIncludeRoot) {
  const contentIndex = segments.findIndex(function (part) { return part.toLowerCase() === "content"; });
  if (contentIndex >= 0) {
    return { prefix: contentIndex > 0 ? segments.slice(0, contentIndex).join("/") + "/" : "", relative: segments.slice(contentIndex + 1).join("/") };
  }
  // No Content folder in the path: the chosen folder is a pack folder inside Content.
  const parts = pathsIncludeRoot ? segments.slice(1) : segments.slice();
  return { prefix: "", relative: [rootName || "Pack"].concat(parts).join("/") };
}

function getUnrealAssetType(fileName, relativeParts) {
  if (/\.umap$/i.test(fileName)) return "Maps";
  const name = fileName.replace(/\.uasset$/i, "").toLowerCase();
  if (/_(skeleton|physicsasset|physics)$/.test(name)) return "Animation";
  if (/_foliagetype$/.test(name)) return "Other";
  const prefixRules = [
    [/^(sm|sk|skm|mesh)_/, "Meshes"],
    [/^(m|mi|mic|mf|ml|mpc|mat)_/, "Materials"],
    [/^(t|tx|tex|hdr|hdri|rt)_/, "Textures"],
    [/^(bp|wbp|bpi)_/, "Blueprints"],
    [/^(abp|am|as|a|anim|bs|skel|pa|phys|ik|rtg)_/, "Animation"],
    [/^(ns|ne|fx|p|pfx|vfx)_/, "Effects"],
    [/^(s|sw|sc|cue|sfx|snd|mus|att)_/, "Audio"]
  ];
  for (const rule of prefixRules) if (rule[0].test(name)) return rule[1];
  const folderRules = [
    [/^(mesh|meshes|models?|staticmesh(es)?|skeletalmesh(es)?|geometry)$/, "Meshes"],
    [/^(materials?|materialinstances?|materialfunctions?)$/, "Materials"],
    [/^textures?$/, "Textures"],
    [/^blueprints?$/, "Blueprints"],
    [/^(anims?|animations?|skeletons?|rigs?)$/, "Animation"],
    [/^(fx|vfx|particles|niagara|effects)$/, "Effects"],
    [/^(audio|sounds?|sfx|music)$/, "Audio"],
    [/^(maps?|levels?)$/, "Maps"]
  ];
  const folders = relativeParts.slice(0, -1).reverse();
  for (const folder of folders) {
    const lower = folder.toLowerCase().replace(/[\s_-]/g, "");
    for (const rule of folderRules) if (rule[0].test(lower)) return rule[1];
  }
  return "Other";
}

// Selects a package and its first mesh (or first asset).
function selectPackage(record) {
  selectedPackageKey = record ? record.key : "";
  const hasMeshes = !!record && record.assets.some(function (asset) { return asset.unrealType === "Meshes"; });
  galleryTypeFilter = hasMeshes ? "Meshes" : "All";
  const first = record ? (record.assets.find(function (asset) { return !hasMeshes || asset.unrealType === "Meshes"; }) || record.assets[0]) : null;
  selectedAssetKey = first ? first.key : "";
}

function normalizePath(path) {
  return String(path || "").replace(/\\/g, "/").replace(/^\/+/, "");
}
function extensionOf(filename) {
  const index = filename.lastIndexOf(".");
  return index < 0 ? "" : filename.slice(index + 1).toLowerCase();
}
function prettifyName(name) {
  return String(name || "").replace(/-[a-f0-9]{6,}$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}
async function parseMetadata(file) {
  try {
    const value = JSON.parse(await file.text());
    return value && typeof value === "object" ? value : {};
  } catch (_error) {
    return {};
  }
}
function findFirstValue(value, wantedKeys, depth) {
  const level = depth || 0;
  if (!value || typeof value !== "object" || level > 6) return "";
  const wanted = new Set(wantedKeys);
  const entries = Array.isArray(value) ? value.map(function (item, index) { return [String(index), item]; }) : Object.entries(value);
  for (const entry of entries) {
    const key = String(entry[0]).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (wanted.has(key) && typeof entry[1] === "string" && entry[1].trim()) return entry[1].trim();
  }
  for (const entry of entries) {
    const found = findFirstValue(entry[1], wantedKeys, level + 1);
    if (found) return found;
  }
  return "";
}

function renderLibrary() {
  if (!packages.length) return;
  sortPackages();
  const query = searchInput.value.trim().toLowerCase();
  const visible = packages.filter(function (record) {
    if (activeFilter !== "all" && !matchesFilter(record, activeFilter)) return false;
    if (!query) return true;
    const values = [record.title, record.creator, record.folderName];
    record.assets.forEach(function (asset) {
      values.push(asset.name, asset.format, asset.extension);
      values.push.apply(values, asset.tags || []);
    });
    return values.join(" ").toLowerCase().includes(query);
  });
  packageGrid.innerHTML = visible.map(function (record) {
    const selected = record.key === selectedPackageKey ? " selected" : "";
    const image = record.thumbnail ? '<img src="' + escapeHtml(record.thumbnail) + '" alt="">' : '<span class="image-fallback">◇</span>';
    const tags = uniqueTags(record).slice(0, 2).map(function (tag) { return '<span class="tag-chip">' + escapeHtml(tag) + '</span>'; }).join("");
    return '<article class="package-card' + selected + '" data-package="' + escapeHtml(record.key) + '">' +
      '<div class="card-image">' + image + '<span class="card-count">' + record.assets.length + (record.assets.length === 1 ? " file" : " files") + '</span></div>' +
      '<div class="card-body"><div class="card-title" title="' + escapeHtml(record.title) + '">' + escapeHtml(record.title) + '</div>' +
      '<div class="card-creator">' + escapeHtml(record.creator) + '</div><div class="card-tags">' + tags + '</div></div></article>';
  }).join("");
  resultSummary.textContent = visible.length + (visible.length === 1 ? " package" : " packages");
  noResults.hidden = visible.length > 0;
  packageGrid.hidden = visible.length === 0;
  packageCount.textContent = String(packages.length);
  packageGrid.querySelectorAll(".package-card").forEach(function (card) {
    card.addEventListener("click", function () {
      const key = card.dataset.package || "";
      if (key !== selectedPackageKey) selectPackage(packages.find(function (record) { return record.key === key; }) || null);
      renderLibrary();
      renderInspector();
    });
  });
}
function matchesFilter(record, filter) {
  const text = (record.title + " " + record.folderName + " " + record.assets.map(function (asset) { return asset.name; }).join(" ")).toLowerCase();
  if (filter === "characters") return /character|human|zombie|person|people|builder|soldier/.test(text);
  if (filter === "environment") return /environment|village|city|interior|street|building|room|corridor/.test(text);
  if (filter === "props") return /prop|door|lamp|chair|weapon|locker|meter|object/.test(text);
  return true;
}

function renderInspector() {
  if (assetThumbnailObserver) {
    assetThumbnailObserver.disconnect();
    assetThumbnailObserver = null;
  }
  if (selectedModelPreview) {
    selectedModelPreview.destroy();
    selectedModelPreview = null;
  }
  const record = getSelectedPackage();
  if (!record) {
    inspector.innerHTML = '<div class="inspector-empty"><div class="inspector-icon">◇</div><h3>Select a package</h3><p>Package details and individual files will appear here.</p></div>';
    return;
  }
  const asset = record.assets.find(function (item) { return item.key === selectedAssetKey; }) || record.assets[0];
  if (asset) selectedAssetKey = asset.key;
  const isUnrealAsset = !!(asset && asset.isUnrealPackageAsset);
  const unrealMeshFbx = isUnrealAsset ? unrealPreviewCache.get(asset.key) : null;
  // Unreal assets show their saved thumbnail until Unreal has exported the mesh for 3D.
  const showThumbnail = isUnrealAsset && !unrealMeshFbx;
  const canLoadUnreal3d = showThumbnail && asset.unrealType === "Meshes";
  const selectedThumbnail = asset ? thumbnailDataByKey.get(asset.key) || "" : "";

  const typeCounts = new Map();
  record.assets.forEach(function (item) {
    if (item.unrealType) typeCounts.set(item.unrealType, (typeCounts.get(item.unrealType) || 0) + 1);
  });
  if (galleryTypeFilter !== "All" && !typeCounts.has(galleryTypeFilter)) galleryTypeFilter = "All";
  const typeChips = typeCounts.size ? '<div class="type-filter">' + unrealTypeOrder.filter(function (type) { return type === "All" || typeCounts.has(type); }).map(function (type) {
    const count = type === "All" ? record.assets.length : typeCounts.get(type);
    return '<button type="button" class="type-chip' + (type === galleryTypeFilter ? " active" : "") + '" data-type="' + type + '">' + type + ' <span>' + count + '</span></button>';
  }).join("") + '</div>' : "";
  const galleryAssets = record.assets.filter(function (item) { return galleryTypeFilter === "All" || item.unrealType === galleryTypeFilter; });
  const shownAssets = galleryAssets.slice(0, galleryLimit);
  const galleryNote = galleryAssets.length > shownAssets.length ? "Showing " + shownAssets.length + " of " + galleryAssets.length : "Select an asset to inspect";

  const cards = shownAssets.map(function (item) {
    const selected = asset && item.key === asset.key ? " selected" : "";
    const thumbnail = thumbnailDataByKey.get(item.key) || "";
    const imageAlt = item.isUnrealPackageAsset ? "Saved Unreal thumbnail for " : "3D preview of ";
    const image = thumbnail ? '<img class="asset-card-image" src="' + thumbnail + '" alt="' + imageAlt + escapeHtml(item.name) + '">' : '<img class="asset-card-image" alt="" hidden>';
    const previewLabel = thumbnail ? (item.isUnrealPackageAsset ? "Unreal thumbnail ready" : "3D preview ready") : (item.isUnrealPackageAsset ? "Reading Unreal thumbnail…" : "Building preview…");
    return '<button type="button" class="asset-card' + selected + '" data-asset="' + escapeHtml(item.key) + '" title="Preview ' + escapeHtml(item.name) + '">' +
      '<span class="asset-card-visual">' + image + '<span class="asset-card-placeholder">' + escapeHtml(item.extension) + '</span>' +
      '<span class="asset-card-preview-status">' + previewLabel + '</span></span>' +
      '<span class="asset-card-body"><span class="asset-card-name">' + escapeHtml(item.name) + '</span>' +
      '<span class="asset-card-meta">' + escapeHtml(item.unrealType || item.format) + ' · ' + formatSize(item.size) + '</span></span></button>';
  }).join("");
  const tags = asset ? asset.tags || [] : [];
  const tagChips = tags.map(function (tag) {
    return '<span class="tag-chip" data-remove-tag="' + escapeHtml(tag) + '" title="Remove tag">' + escapeHtml(tag) + ' ×</span>';
  }).join("");

  let previewHtml;
  if (showThumbnail) {
    previewHtml = (selectedThumbnail ? '<img id="unrealAssetPreview" class="unreal-asset-preview-image" src="' + selectedThumbnail + '" alt="Saved Unreal thumbnail for ' + escapeHtml(asset.name) + '">' : '<img id="unrealAssetPreview" class="unreal-asset-preview-image" alt="" hidden>') +
      '<div class="model-preview-status" id="modelPreviewStatus" role="status">' + (selectedThumbnail ? "Saved Unreal thumbnail · static preview" : "Reading embedded Unreal thumbnail…") + '</div>' +
      (canLoadUnreal3d ? '<button class="load-unreal-3d" id="loadUnreal3d" type="button">Load 3D from Unreal</button>' : "");
  } else {
    previewHtml = '<canvas id="modelCanvas" aria-label="3D preview of selected asset"></canvas>' +
      '<div class="model-preview-status" id="modelPreviewStatus" role="status">Loading ' + escapeHtml(asset ? asset.name : "model") + '…</div>' +
      '<button class="model-preview-reset" id="resetModelView" type="button" aria-label="Reset model view" title="Reset view">↺</button>';
  }

  const sendHtml = isUnrealAsset
    ? '<div class="ue-next"><strong>Add to Unreal project</strong><p id="unrealStatus">Checking for the Unreal Editor…</p>' +
      '<div class="ue-destination-label">Goes to (fixed, so its references keep working)</div><code class="ue-destination-fixed">' + escapeHtml(asset.gamePath) + '</code>' +
      '<button type="button" id="sendSelectedButton" disabled>Add to project</button></div>'
    : '<div class="ue-next"><strong>Send one asset to Unreal</strong><p id="unrealStatus">Checking for the Unreal Editor…</p>' +
      '<label class="ue-destination-label" for="unrealDestination">Unreal Content folder</label><input id="unrealDestination" class="ue-destination" type="text" value="/Game/AssetShelf" spellcheck="false">' +
      '<button type="button" id="sendSelectedButton" disabled>Send selected FBX</button></div>';

  inspector.innerHTML = '<div class="inspector-content">' +
    '<div class="inspector-topline"><span class="eyebrow">PACKAGE INSPECTOR</span><span class="source-badge">LOCAL CACHE</span></div>' +
    '<h3 class="inspector-title">' + escapeHtml(record.title) + '</h3>' +
    '<div class="inspector-creator">In package: ' + escapeHtml(record.title) + ' · ' + escapeHtml(asset ? asset.unrealType || asset.format : "") + '</div>' +
    '<div class="metadata-row"><span class="meta-pill">' + record.assets.length + (record.assets.length === 1 ? " file" : " files") + '</span>' +
    '<span class="meta-pill">' + escapeHtml(uniqueFormats(record).join(", ") || "Unknown format") + '</span></div>' +
    '<div class="section-heading"><h4>Package contents</h4><span>' + galleryNote + '</span></div>' + typeChips + '<div class="asset-gallery">' + cards + '</div>' +
    '<div class="section-heading selected-preview-heading"><h4>' + (showThumbnail ? "Selected Unreal asset" : "Selected model") + '</h4><span>' + (showThumbnail ? "Saved thumbnail · static view" : "Drag to orbit · scroll to zoom") + '</span></div>' +
    '<div class="model-preview" id="modelPreview">' + previewHtml + '</div>' +
    '<h3 class="inspector-title selected-asset-title">' + escapeHtml(asset ? asset.name : record.title) + '</h3>' +
    '<div class="section-heading"><h4>Tags for selected file</h4><span>Saved on this computer</span></div>' +
    '<div class="tag-editor"><input id="tagInput" type="text" maxlength="32" placeholder="Add a tag, e.g. zombie"><button id="addTagButton" type="button" aria-label="Add tag">＋</button></div>' +
    '<div class="asset-tags">' + tagChips + '</div><div class="tag-help">Press Enter or + to add. Click a tag to remove it.</div>' +
    sendHtml + '</div>';

  inspector.querySelectorAll(".asset-card").forEach(function (button) {
    button.addEventListener("click", function () {
      selectedAssetKey = button.dataset.asset || "";
      renderLibrary();
      renderInspector();
    });
  });
  inspector.querySelectorAll(".type-chip").forEach(function (button) {
    button.addEventListener("click", function () {
      galleryTypeFilter = button.dataset.type || "All";
      renderInspector();
    });
  });
  loadVisibleAssetThumbnails(record);
  const canvas = document.getElementById("modelCanvas");
  const previewStatus = document.getElementById("modelPreviewStatus");
  const resetPreviewButton = document.getElementById("resetModelView");
  const previewAsset = unrealMeshFbx || asset;
  if (canvas && previewAsset && window.AssetShelfPreview && typeof window.AssetShelfPreview.createModelPreview === "function") {
    try {
      selectedModelPreview = window.AssetShelfPreview.createModelPreview(canvas, previewStatus);
      selectedModelPreview.load(previewAsset, unrealMeshFbx ? new Map() : localFilesByPath).then(function () {
        if (unrealMeshFbx && previewStatus) previewStatus.textContent = "Mesh exported by Unreal · geometry only";
      }).catch(function (error) {
        console.warn("Asset Shelf model preview failed:", error);
      });
      resetPreviewButton.addEventListener("click", function () {
        if (selectedModelPreview) selectedModelPreview.resetView();
      });
    } catch (error) {
      if (previewStatus) previewStatus.textContent = error && error.message ? error.message : "3D preview could not start.";
    }
  } else if (canvas && previewStatus) {
    previewStatus.textContent = "3D preview engine is unavailable. Reload the local page to retry.";
  }
  const load3dButton = document.getElementById("loadUnreal3d");
  if (load3dButton) load3dButton.addEventListener("click", function () { void loadUnrealMeshIn3d(asset); });
  const addButton = document.getElementById("addTagButton");
  const tagInput = document.getElementById("tagInput");
  addButton.addEventListener("click", addCurrentTag);
  tagInput.addEventListener("keydown", function (event) { if (event.key === "Enter") addCurrentTag(); });
  inspector.querySelectorAll("[data-remove-tag]").forEach(function (chip) {
    chip.addEventListener("click", function () { removeCurrentTag(chip.dataset.removeTag || ""); });
  });
  document.getElementById("sendSelectedButton").addEventListener("click", sendSelectedAssetToUnreal);
  updateUnrealControls();
}

function loadVisibleAssetThumbnails(record) {
  const generation = libraryScanGeneration;
  const cards = Array.from(inspector.querySelectorAll(".asset-card"));
  if (!cards.length) return;
  const loadCard = function (card) {
    const key = card.dataset.asset || "";
    if (!key || thumbnailDataByKey.has(key) || thumbnailPendingKeys.has(key) || card.dataset.thumbnailState) return;
    const item = record.assets.find(function (entry) { return entry.key === key; });
    if (!item || (!item.isUnrealPackageAsset && (!window.AssetShelfPreview || typeof window.AssetShelfPreview.renderAssetThumbnail !== "function"))) {
      card.dataset.thumbnailState = "failed";
      const status = card.querySelector(".asset-card-preview-status");
      if (status) status.textContent = "Preview unavailable";
      return;
    }
    card.dataset.thumbnailState = "loading";
    thumbnailPendingKeys.add(key);
    const renderPromise = item.isUnrealPackageAsset
      ? extractEmbeddedUnrealThumbnail(item.file).then(function (image) { return { image: image, isUnrealThumbnail: true }; })
      : window.AssetShelfPreview.renderAssetThumbnail(item, localFilesByPath);
    renderPromise.then(function (result) {
      if (generation !== libraryScanGeneration) return;
      if (!result || !result.image) throw new Error("No preview image was produced.");
      thumbnailDataByKey.set(key, result.image);
      if (result.missingTextures) thumbnailMissingTexturesByKey.add(key);
      else thumbnailMissingTexturesByKey.delete(key);
      thumbnailPendingKeys.delete(key);
      // Unreal packs have no cover image, so use the first mesh thumbnail.
      if (item.isUnrealPackageAsset && !record.thumbnail && item.unrealType === "Meshes") {
        record.thumbnail = result.image;
        renderLibrary();
      }
      if (item.isUnrealPackageAsset && key === selectedAssetKey) {
        const selectedImage = document.getElementById("unrealAssetPreview");
        const selectedStatus = document.getElementById("modelPreviewStatus");
        if (selectedImage) { selectedImage.src = result.image; selectedImage.alt = "Saved Unreal thumbnail for " + item.name; selectedImage.hidden = false; }
        if (selectedStatus) selectedStatus.textContent = "Saved Unreal thumbnail · static preview";
      }
      const currentCard = Array.from(inspector.querySelectorAll(".asset-card")).find(function (candidate) { return candidate.dataset.asset === key; });
      if (!currentCard) return;
      const image = currentCard.querySelector(".asset-card-image");
      const placeholder = currentCard.querySelector(".asset-card-placeholder");
      const status = currentCard.querySelector(".asset-card-preview-status");
      if (image) { image.src = result.image; image.hidden = false; image.alt = (item.isUnrealPackageAsset ? "Saved Unreal thumbnail for " : "3D preview of ") + item.name; }
      if (placeholder) placeholder.hidden = true;
      if (status) status.textContent = item.isUnrealPackageAsset ? "Unreal thumbnail · static" : (result.missingTextures ? "Geometry preview · textures missing" : "3D preview ready");
      currentCard.dataset.thumbnailState = "ready";
    }).catch(function (error) {
      if (generation !== libraryScanGeneration) return;
      thumbnailPendingKeys.delete(key);
      if (item && item.isUnrealPackageAsset && key === selectedAssetKey) {
        const selectedStatus = document.getElementById("modelPreviewStatus");
        if (selectedStatus) selectedStatus.textContent = "No embedded Unreal thumbnail";
      }
      const currentCard = Array.from(inspector.querySelectorAll(".asset-card")).find(function (candidate) { return candidate.dataset.asset === key; });
      if (!currentCard) return;
      currentCard.dataset.thumbnailState = "failed";
      const status = currentCard.querySelector(".asset-card-preview-status");
      const placeholder = currentCard.querySelector(".asset-card-placeholder");
      if (status) status.textContent = item && item.isUnrealPackageAsset ? "No embedded thumbnail" : "No 3D preview";
      if (placeholder) placeholder.textContent = item ? item.extension : "UASSET";
      console.info("Asset Shelf thumbnail unavailable for " + (item ? item.name : "asset") + ":", error);
    });
  };

  if (typeof IntersectionObserver === "function") {
    const observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        loadCard(entry.target);
      });
    }, { rootMargin: "160px" });
    assetThumbnailObserver = observer;
    cards.forEach(function (card) {
      const key = card.dataset.asset || "";
      const item = record.assets.find(function (entry) { return entry.key === key; });
      if (thumbnailDataByKey.has(key)) {
        const image = card.querySelector(".asset-card-image");
        const placeholder = card.querySelector(".asset-card-placeholder");
        const status = card.querySelector(".asset-card-preview-status");
        image.src = thumbnailDataByKey.get(key);
        image.hidden = false;
        image.alt = item && item.isUnrealPackageAsset ? "Saved Unreal thumbnail for " + item.name : "3D preview of " + (item ? item.name : "asset");
        if (placeholder) placeholder.hidden = true;
        if (status) status.textContent = item && item.isUnrealPackageAsset ? "Unreal thumbnail · static" : (thumbnailMissingTexturesByKey.has(key) ? "Geometry preview · textures missing" : "3D preview ready");
        card.dataset.thumbnailState = "ready";
      } else {
        observer.observe(card);
      }
    });
  } else {
    cards.forEach(loadCard);
  }
}

async function extractEmbeddedUnrealThumbnail(file) {
  if (!file || typeof file.arrayBuffer !== "function") throw new Error("The Unreal asset file cannot be read.");
  // The thumbnail sits in the file header, so read only the start of large files.
  const headerBytes = 8 * 1024 * 1024;
  let bytes = new Uint8Array(await file.slice(0, headerBytes).arrayBuffer());
  if (file.size > headerBytes && findJpegStart(bytes) < 0) bytes = new Uint8Array(await file.arrayBuffer());
  const start = findJpegStart(bytes);
  if (start < 0) throw new Error("This Unreal asset has no embedded JPEG thumbnail.");
  return await jpegBytesToDataUrl(bytes, start);
}

function findJpegStart(bytes) {
  for (let index = 0; index < bytes.length - 2; index += 1) {
    if (bytes[index] === 0xff && bytes[index + 1] === 0xd8 && bytes[index + 2] === 0xff) return index;
  }
  return -1;
}

async function jpegBytesToDataUrl(bytes, start) {
  let end = -1;
  for (let index = start + 3; index < bytes.length - 1; index += 1) {
    if (bytes[index] === 0xff && bytes[index + 1] === 0xd9) { end = index + 1; break; }
  }
  if (end < 0) throw new Error("The embedded Unreal thumbnail is incomplete.");
  const blob = new Blob([bytes.subarray(start, end + 1)], { type: "image/jpeg" });
  if (typeof window.createImageBitmap === "function") {
    const bitmap = await window.createImageBitmap(blob);
    try {
      if (bitmap.width > 1024 || bitmap.height > 1024) throw new Error("The embedded image is larger than an Unreal thumbnail.");
    } finally { bitmap.close(); }
  }
  return await new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result || "")); };
    reader.onerror = function () { reject(reader.error || new Error("Could not read the Unreal thumbnail.")); };
    reader.readAsDataURL(blob);
  });
}

async function refreshUnrealStatus() {
  if (!window.location.protocol.startsWith("http")) {
    unrealBridge = { connected: false, projectName: "", localServerRequired: true };
    updateUnrealControls();
    return;
  }
  try {
    const response = await fetch("/api/unreal/status", { cache: "no-store" });
    if (!response.ok) throw new Error("Local Asset Shelf service is not available.");
    const state = await response.json();
    unrealBridge = { connected: !!state.connected, projectName: state.projectName || "Unreal project", engineVersion: state.engineVersion || "" };
  } catch (_error) {
    unrealBridge = { connected: false, projectName: "", localServerRequired: false };
  }
  updateUnrealControls();
}

function updateUnrealControls() {
  const status = document.getElementById("unrealStatus");
  const button = document.getElementById("sendSelectedButton");
  const load3dButton = document.getElementById("loadUnreal3d");
  if (load3dButton) {
    load3dButton.disabled = isSendingToUnreal || !unrealBridge.connected;
    load3dButton.textContent = isSendingToUnreal ? "Working…" : "Load 3D from Unreal";
    load3dButton.title = unrealBridge.connected ? "Unreal exports this mesh so it can be shown in 3D" : "Open Unreal Editor to load this mesh in 3D";
  }
  if (!status || !button) return;
  const asset = getSelectedAsset();
  const isUnreal = !!asset && !!asset.isUnrealPackageAsset;
  const isFbx = !!asset && asset.extension.toLowerCase() === "fbx";
  if (isSendingToUnreal) status.textContent = unrealProgressText || "Working with Unreal…";
  else if (unrealBridge.localServerRequired) status.textContent = "Run Asset Shelf with npm start, then open its local address to connect Unreal.";
  else if (!unrealBridge.connected) status.textContent = "Open Unreal Editor with Remote Control and Python enabled (see README) to send assets.";
  else if (isUnreal) status.textContent = "Connected to " + unrealBridge.projectName + ". Copies this asset and the files it uses into your project. Existing files are never overwritten.";
  else if (isFbx) status.textContent = "Connected to " + unrealBridge.projectName + (unrealBridge.engineVersion ? " · " + unrealBridge.engineVersion : "") + ". Only the selected FBX is sent.";
  else status.textContent = "Connected to " + unrealBridge.projectName + ". Only FBX files and Unreal assets can be sent.";
  button.disabled = isSendingToUnreal || !unrealBridge.connected || !(isUnreal || isFbx);
  button.textContent = isSendingToUnreal ? "Working…" : (isUnreal ? "Add to project" : "Send selected FBX");
}

function setUnrealProgress(text) {
  unrealProgressText = text;
  updateUnrealControls();
}

async function sendSelectedAssetToUnreal() {
  const asset = getSelectedAsset();
  if (!asset || isSendingToUnreal) return;
  if (asset.isUnrealPackageAsset) {
    await addUnrealAssetToProject(asset);
    return;
  }
  const destinationInput = document.getElementById("unrealDestination");
  if (!asset.file || asset.extension.toLowerCase() !== "fbx" || !destinationInput) return;
  const destination = destinationInput.value.trim();
  if (!destination) {
    showToast("Enter an Unreal Content folder, such as /Game/AssetShelf.");
    return;
  }
  isSendingToUnreal = true;
  setUnrealProgress("Sending " + asset.name + " to Unreal…");
  try {
    const response = await fetch("/api/unreal/import?filename=" + encodeURIComponent(asset.name) + "&destination=" + encodeURIComponent(destination), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: asset.file
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || "Unreal could not import this FBX.");
    showToast("Imported " + asset.name + " to " + destination);
  } catch (error) {
    showToast(error && error.message ? error.message : "Could not send this asset to Unreal.");
  } finally {
    isSendingToUnreal = false;
    setUnrealProgress("");
  }
}

// Finds the /Game/... packages an Unreal asset refers to. Package paths are
// stored as plain text in the file header, so a text scan finds them.
async function readUnrealReferences(file) {
  const limit = 8 * 1024 * 1024;
  const buffer = await (file.size > limit ? file.slice(0, limit) : file).arrayBuffer();
  const text = new TextDecoder("latin1").decode(buffer);
  const references = new Set();
  for (const match of text.matchAll(/\/Game\/[A-Za-z0-9_\-\/ ]+/g)) {
    const path = match[0].replace(/[\/ ]+$/, "");
    if (path.length > 6) references.add(path);
  }
  return references;
}

// Collects the asset plus every asset it depends on, with their companion files.
async function collectUnrealDependencies(asset) {
  const packagesFound = [];
  const missing = [];
  const seen = new Set();
  const queue = [asset.gamePath];
  while (queue.length) {
    const gamePath = queue.shift();
    const lowerPath = gamePath.toLowerCase();
    if (seen.has(lowerPath)) continue;
    seen.add(lowerPath);
    const base = gamePath.slice("/Game/".length);
    const main = ["uasset", "umap"].map(function (extension) {
      return unrealContentFiles.get(asset.contentPrefix + "|" + (base + "." + extension).toLowerCase());
    }).find(Boolean);
    if (!main) {
      missing.push(gamePath);
      continue;
    }
    const files = [main].concat(["uexp", "ubulk", "uptnl"].map(function (extension) {
      return unrealContentFiles.get(asset.contentPrefix + "|" + (base + "." + extension).toLowerCase());
    }).filter(Boolean));
    packagesFound.push({ gamePath: gamePath, files: files });
    if (packagesFound.length > 5000) throw new Error("This asset references too many files.");
    setUnrealProgress("Finding files used by " + asset.name + "… (" + packagesFound.length + ")");
    (await readUnrealReferences(main.file)).forEach(function (reference) {
      if (!seen.has(reference.toLowerCase())) queue.push(reference);
    });
  }
  return { packages: packagesFound, missing: missing };
}

// Copies an asset and its dependencies into the project's Content folder.
// Returns the packages that were newly written (not already in the project).
async function copyUnrealAssetFiles(asset) {
  const dependencies = await collectUnrealDependencies(asset);
  const total = dependencies.packages.reduce(function (sum, item) { return sum + item.files.length; }, 0);
  const newPackages = [];
  let copied = 0;
  let skipped = 0;
  for (const item of dependencies.packages) {
    let isNew = false;
    for (const entry of item.files) {
      setUnrealProgress("Copying file " + (copied + skipped + 1) + " of " + total + "…");
      const response = await fetch("/api/unreal/content?path=" + encodeURIComponent(entry.relative), {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: entry.file
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "Could not copy " + entry.relative);
      if (result.written) { copied += 1; if (entry === item.files[0]) isNew = true; } else skipped += 1;
    }
    if (isNew) newPackages.push(item.gamePath);
  }
  return { packages: dependencies.packages.map(function (item) { return item.gamePath; }), newPackages: newPackages, missing: dependencies.missing, copied: copied, skipped: skipped };
}

async function postJson(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const type = response.headers.get("Content-Type") || "";
  if (type.includes("application/json")) {
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || "Unreal could not finish this step.");
    return result;
  }
  if (!response.ok) throw new Error("Unreal could not finish this step.");
  return response;
}

async function addUnrealAssetToProject(asset) {
  isSendingToUnreal = true;
  setUnrealProgress("Finding files used by " + asset.name + "…");
  try {
    const result = await copyUnrealAssetFiles(asset);
    setUnrealProgress("Asking Unreal to load the new files…");
    await postJson("/api/unreal/content/register", { packages: result.packages, select: asset.gamePath });
    let message = "Added " + asset.name + " · " + result.copied + " files copied";
    if (result.skipped) message += ", " + result.skipped + " already in project";
    if (result.missing.length) message += " · " + result.missing.length + " referenced assets not in this download";
    showToast(message);
    if (result.missing.length) console.info("Asset Shelf: referenced assets not found in the download:", result.missing);
  } catch (error) {
    showToast(error && error.message ? error.message : "Could not add this asset to Unreal.");
  } finally {
    isSendingToUnreal = false;
    setUnrealProgress("");
  }
}

// Unreal exports the mesh as FBX so the browser can show it in 3D.
// Files copied only for this preview are removed from the project afterwards.
async function loadUnrealMeshIn3d(asset) {
  if (!asset || isSendingToUnreal) return;
  isSendingToUnreal = true;
  const status = document.getElementById("modelPreviewStatus");
  const showStatus = function (text) {
    setUnrealProgress(text);
    if (status && asset.key === selectedAssetKey) status.textContent = text;
  };
  try {
    showStatus("Finding files used by " + asset.name + "…");
    const copy = await copyUnrealAssetFiles(asset);
    showStatus("Unreal is exporting the mesh… (first time can take a while)");
    const response = await postJson("/api/unreal/preview", { package: asset.gamePath, packages: copy.packages, cleanup: copy.newPackages });
    const blob = await response.blob();
    const leftover = Number(response.headers.get("X-Asset-Shelf-Leftover") || 0);
    const name = asset.name.replace(/\.(uasset|umap)$/i, "") + ".fbx";
    unrealPreviewCache.set(asset.key, { name: name, extension: "FBX", path: name, size: blob.size, file: new File([blob], name) });
    if (leftover) showToast(leftover + " preview files could not be removed from your project.");
    if (asset.key === selectedAssetKey) renderInspector();
  } catch (error) {
    const message = error && error.message ? error.message : "Could not load this mesh from Unreal.";
    if (status && asset.key === selectedAssetKey) status.textContent = message;
    showToast(message);
  } finally {
    isSendingToUnreal = false;
    setUnrealProgress("");
  }
}

function addCurrentTag() {
  const input = document.getElementById("tagInput");
  const asset = getSelectedAsset();
  if (!input || !asset) return;
  const value = input.value.trim().replace(/\s+/g, " ");
  if (!value) return;
  if (!asset.tags.some(function (tag) { return tag.toLowerCase() === value.toLowerCase(); })) {
    asset.tags.push(value);
    tagMap[asset.key] = asset.tags;
    persistTags();
  }
  renderLibrary();
  renderInspector();
  showToast("Tag saved for " + asset.name);
}
function removeCurrentTag(value) {
  const asset = getSelectedAsset();
  if (!asset) return;
  asset.tags = asset.tags.filter(function (tag) { return tag !== value; });
  tagMap[asset.key] = asset.tags;
  persistTags();
  renderLibrary();
  renderInspector();
}
function readTags() {
  try {
    const parsed = JSON.parse(localStorage.getItem(tagsStorageKey) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) { return {}; }
}
function persistTags() {
  try { localStorage.setItem(tagsStorageKey, JSON.stringify(tagMap)); }
  catch (_error) { showToast("Tags could not be saved by this browser."); }
}
function getSelectedPackage() {
  return packages.find(function (record) { return record.key === selectedPackageKey; }) || null;
}
function getSelectedAsset() {
  const record = getSelectedPackage();
  return record ? record.assets.find(function (asset) { return asset.key === selectedAssetKey; }) || null : null;
}
function uniqueFormats(record) {
  return Array.from(new Set(record.assets.map(function (asset) { return asset.format; })));
}
function sortPackages() {
  packages.sort(function (a, b) {
    if (sortMode === "size") return b.assets.length - a.assets.length || a.title.localeCompare(b.title);
    return a.title.localeCompare(b.title);
  });
}
function uniqueTags(record) {
  const values = [];
  record.assets.forEach(function (asset) {
    (asset.tags || []).forEach(function (tag) {
      if (!values.some(function (item) { return item.toLowerCase() === tag.toLowerCase(); })) values.push(tag);
    });
  });
  return values;
}
function countAssets(records) {
  return records.reduce(function (total, record) { return total + record.assets.length; }, 0);
}
function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "Size unknown";
  return bytes < 1024 * 1024 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
  });
}
function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(function () { toast.classList.remove("show"); }, 2600);
}
