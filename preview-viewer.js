import {
  AmbientLight, ACESFilmicToneMapping, Box3, Color, DirectionalLight, HemisphereLight,
  LoadingManager, MathUtils, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";

var transparentPixel = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
var thumbnailRenderer = null;
var thumbnailRenderQueue = Promise.resolve();
function normalizeThumbnailPath(path) {
  const stack = [];
  String(path || "").replace(/\\/g, "/").split("/").forEach(function(part) {
    if (!part || part === ".") return;
    if (part === "..") {
      if (stack.length) stack.pop();
      return;
    }
    stack.push(part);
  });
  return stack.join("/");
}
function findThumbnailFile(reference, modelPath, fileByPath) {
  if (!reference || /^(data:|blob:)/i.test(reference)) return null;
  let clean = String(reference).trim().replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
  try {
    clean = decodeURIComponent(clean);
  } catch (_error) {
  }
  clean = clean.replace(/^file:\/\//i, "").replace(/^\/+([a-z]:\/)/i, "$1").replace(/[?#].*$/, "");
  const modelDirectory = String(modelPath || "").replace(/\\/g, "/").split("/").slice(0, -1).join("/");
  const candidates = [normalizeThumbnailPath(modelDirectory + "/" + clean), normalizeThumbnailPath(clean)];
  for (const [path, file] of fileByPath.entries()) {
    if (candidates.some(function(candidate) {
      return candidate && path.toLowerCase() === candidate.toLowerCase();
    })) return file;
  }
  const basename = clean.split("/").pop().toLowerCase();
  const matches = [];
  for (const [path, file] of fileByPath.entries()) {
    if (path.toLowerCase().split("/").pop() === basename) matches.push(file);
  }
  return matches.length === 1 ? matches[0] : null;
}
function disposeThumbnailObject(object) {
  if (!object) return;
  object.traverse(function(node) {
    if (node.geometry && typeof node.geometry.dispose === "function") node.geometry.dispose();
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    materials.forEach(function(material) {
      if (!material) return;
      Object.keys(material).forEach(function(key) {
        const value = material[key];
        if (value && value.isTexture && typeof value.dispose === "function") value.dispose();
      });
      if (typeof material.dispose === "function") material.dispose();
    });
  });
}
function getThumbnailRenderer() {
  if (thumbnailRenderer) return thumbnailRenderer;
  const canvas = document.createElement("canvas");
  thumbnailRenderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: "low-power" });
  thumbnailRenderer.setPixelRatio(1);
  thumbnailRenderer.outputColorSpace = SRGBColorSpace;
  thumbnailRenderer.toneMapping = ACESFilmicToneMapping;
  thumbnailRenderer.toneMappingExposure = 1.05;
  return thumbnailRenderer;
}
async function makeAssetThumbnail(asset, fileByPath) {
  const renderer = getThumbnailRenderer();
  const width = 240;
  const height = 150;
  renderer.setSize(width, height, false);
  const scene = new Scene();
  scene.background = new Color(1514526);
  scene.add(new HemisphereLight(14479103, 4080964, 2));
  scene.add(new AmbientLight(16777215, 0.55));
  const keyLight = new DirectionalLight(16773852, 2.7);
  keyLight.position.set(4, 7, 5);
  scene.add(keyLight);
  const fillLight = new DirectionalLight(10209791, 1.3);
  fillLight.position.set(-5, 3, -4);
  scene.add(fillLight);
  const camera = new PerspectiveCamera(38, width / height, 0.01, 1e4);
  const missingTextures = [];
  const objectUrls = [];
  const manager = new LoadingManager();
  manager.setURLModifier(function(url) {
    if (/^(data:|blob:)/i.test(url)) return url;
    const clean = findThumbnailFile(url, asset.path, fileByPath);
    if (!clean) {
      missingTextures.push(url);
      return transparentPixel;
    }
    const objectUrl = URL.createObjectURL(clean);
    objectUrls.push(objectUrl);
    return objectUrl;
  });
  let object = null;
  try {
    const extension = String(asset.extension || "").toLowerCase();
    const buffer = await asset.file.arrayBuffer();
    const basePath = String(asset.path || "").replace(/\\/g, "/").split("/").slice(0, -1).join("/") + "/";
    if (extension === "fbx") {
      object = new FBXLoader(manager).parse(buffer, basePath);
    } else if (extension === "obj") {
      object = new OBJLoader(manager).parse(new TextDecoder().decode(buffer));
    } else if (extension === "glb" || extension === "gltf") {
      object = await new Promise(function(resolve, reject) {
        new GLTFLoader(manager).parse(buffer, basePath, function(result) {
          resolve(result.scene);
        }, reject);
      });
    } else {
      throw new Error("3D preview is not available for this file type.");
    }
    object.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(object);
    if (bounds.isEmpty()) throw new Error("No visible mesh geometry in this file.");
    const size = bounds.getSize(new Vector3());
    const center = bounds.getCenter(new Vector3());
    const longestSide = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(longestSide) || longestSide <= 0) throw new Error("Could not measure this model.");
    object.position.sub(center);
    scene.add(object);
    const fitDistance = longestSide * 0.64 / Math.tan(MathUtils.degToRad(camera.fov * 0.5));
    camera.near = Math.max(longestSide / 1e4, 1e-3);
    camera.far = Math.max(longestSide * 100, 100);
    camera.position.set(fitDistance * 0.85, fitDistance * 0.55, fitDistance);
    camera.updateProjectionMatrix();
    camera.lookAt(0, 0, 0);
    await new Promise(function(resolve) {
      let finished = false;
      function finish() {
        if (finished) return;
        finished = true;
        resolve();
      }
      manager.onLoad = finish;
      window.setTimeout(finish, 350);
      if (manager.itemsTotal === 0) finish();
    });
    renderer.render(scene, camera);
    return { image: renderer.domElement.toDataURL("image/webp", 0.82), missingTextures: missingTextures.length };
  } finally {
    if (object) {
      scene.remove(object);
      disposeThumbnailObject(object);
    }
    objectUrls.forEach(function(url) {
      URL.revokeObjectURL(url);
    });
  }
}
export function renderAssetThumbnail(asset, fileByPath) {
  const next = thumbnailRenderQueue.then(function() {
    return makeAssetThumbnail(asset, fileByPath || new Map());
  });
  thumbnailRenderQueue = next.catch(function() {
    return null;
  });
  return next;
}
export function createModelPreview(canvas, statusElement) {
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new Scene();
  scene.background = new Color(1185561);
  scene.add(new HemisphereLight(14479103, 4080964, 2));
  scene.add(new AmbientLight(16777215, 0.55));
  const keyLight = new DirectionalLight(16773852, 2.7);
  keyLight.position.set(4, 7, 5);
  scene.add(keyLight);
  const fillLight = new DirectionalLight(10209791, 1.3);
  fillLight.position.set(-5, 3, -4);
  scene.add(fillLight);
  const camera = new PerspectiveCamera(38, 1, 0.01, 1e4);
  camera.position.set(2.8, 2.1, 3.6);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.05;
  controls.maxDistance = 1e4;
  controls.enablePan = true;
  let currentObject = null;
  let animationFrame = 0;
  let resizeObserver = null;
  let objectUrls = [];
  let destroyed = false;
  function resize() {
    if (destroyed) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
  }
  function renderLoop() {
    if (destroyed) return;
    animationFrame = window.requestAnimationFrame(renderLoop);
    controls.update();
    renderer.render(scene, camera);
  }
  function disposeCurrentObject() {
    if (!currentObject) return;
    scene.remove(currentObject);
    currentObject.traverse(function(node) {
      if (node.geometry && typeof node.geometry.dispose === "function") node.geometry.dispose();
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach(function(material) {
        if (!material) return;
        Object.keys(material).forEach(function(key) {
          const value = material[key];
          if (value && value.isTexture && typeof value.dispose === "function") value.dispose();
        });
        if (typeof material.dispose === "function") material.dispose();
      });
    });
    currentObject = null;
    objectUrls.forEach(function(url) {
      URL.revokeObjectURL(url);
    });
    objectUrls = [];
  }
  function resolveLocalFile(reference, modelPath, fileByPath) {
    if (!reference || /^(data:|blob:)/i.test(reference)) return null;
    let clean = String(reference).trim().replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
    try {
      clean = decodeURIComponent(clean);
    } catch (_error) {
    }
    clean = clean.replace(/^file:\/\//i, "").replace(/^\/+([a-z]:\/)/i, "$1");
    clean = clean.replace(/[?#].*$/, "");
    const modelDirectory = String(modelPath || "").replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    const candidates = [normalizeRelativePath(modelDirectory + "/" + clean), normalizeRelativePath(clean)];
    for (const [path, file] of fileByPath.entries()) {
      const lowerPath = path.toLowerCase();
      if (candidates.some(function(candidate) {
        return candidate && lowerPath === candidate.toLowerCase();
      })) return file;
    }
    const basename = clean.split("/").pop().toLowerCase();
    const basenameMatches = [];
    for (const [path, file] of fileByPath.entries()) {
      if (path.toLowerCase().split("/").pop() === basename) basenameMatches.push(file);
    }
    return basenameMatches.length === 1 ? basenameMatches[0] : null;
  }
  function normalizeRelativePath(path) {
    const stack = [];
    String(path || "").replace(/\\/g, "/").split("/").forEach(function(part) {
      if (!part || part === ".") return;
      if (part === "..") {
        if (stack.length) stack.pop();
        return;
      }
      stack.push(part);
    });
    return stack.join("/");
  }
  function prepareManager(asset, fileByPath, missingTextures) {
    const manager = new LoadingManager();
    manager.setURLModifier(function(url) {
      if (/^(data:|blob:)/i.test(url)) return url;
      const file = resolveLocalFile(url, asset.path, fileByPath);
      if (!file) {
        missingTextures.push(url);
        return transparentPixel;
      }
      const objectUrl = URL.createObjectURL(file);
      objectUrls.push(objectUrl);
      return objectUrl;
    });
    return manager;
  }
  function fitObject(object) {
    object.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(object);
    if (bounds.isEmpty()) throw new Error("This file contains no visible mesh geometry.");
    const size = bounds.getSize(new Vector3());
    const center = bounds.getCenter(new Vector3());
    const longestSide = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(longestSide) || longestSide <= 0) throw new Error("Could not measure this model.");
    object.position.sub(center);
    scene.add(object);
    currentObject = object;
    const fitDistance = longestSide * 0.62 / Math.tan(MathUtils.degToRad(camera.fov * 0.5));
    camera.near = Math.max(longestSide / 1e4, 1e-3);
    camera.far = Math.max(longestSide * 100, 100);
    camera.position.set(fitDistance * 0.85, fitDistance * 0.55, fitDistance);
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.minDistance = Math.max(longestSide * 0.03, 0.02);
    controls.maxDistance = Math.max(longestSide * 20, 2);
    controls.update();
  }
  async function load(asset, fileByPath) {
    disposeCurrentObject();
    if (statusElement) {
      statusElement.classList.remove("model-preview-status-ready");
      statusElement.hidden = false;
      statusElement.textContent = "Loading " + asset.name + "\u2026";
    }
    await new Promise(function(resolve) {
      window.requestAnimationFrame(resolve);
    });
    if (destroyed) return;
    resize();
    const missingTextures = [];
    const manager = prepareManager(asset, fileByPath || new Map(), missingTextures);
    try {
      const extension = String(asset.extension || "").toLowerCase();
      const buffer = await asset.file.arrayBuffer();
      if (destroyed) return;
      let object;
      if (extension === "fbx") {
        const basePath = String(asset.path || "").replace(/\\/g, "/").split("/").slice(0, -1).join("/") + "/";
        object = new FBXLoader(manager).parse(buffer, basePath);
      } else if (extension === "obj") {
        object = new OBJLoader(manager).parse(new TextDecoder().decode(buffer));
      } else if (extension === "glb" || extension === "gltf") {
        const basePath = String(asset.path || "").replace(/\\/g, "/").split("/").slice(0, -1).join("/") + "/";
        object = await new Promise(function(resolve, reject) {
          new GLTFLoader(manager).parse(buffer, basePath, function(result) {
            resolve(result.scene);
          }, reject);
        });
      } else {
        throw new Error("3D preview currently supports FBX, OBJ, GLB, and glTF files.");
      }
      fitObject(object);
      if (statusElement) {
        statusElement.textContent = missingTextures.length ? "Geometry loaded \xB7 texture files are not included in this local cache" : "Model loaded \xB7 drag to rotate \xB7 scroll to zoom";
        statusElement.classList.add("model-preview-status-ready");
      }
    } catch (error) {
      disposeCurrentObject();
      if (statusElement) {
        statusElement.classList.remove("model-preview-status-ready");
        statusElement.textContent = error && error.message ? error.message : "Could not preview this model.";
      }
      throw error;
    }
  }
  function resetView() {
    if (currentObject) fitObject(currentObject);
  }
  function destroy() {
    destroyed = true;
    window.cancelAnimationFrame(animationFrame);
    if (resizeObserver) resizeObserver.disconnect();
    controls.dispose();
    disposeCurrentObject();
    renderer.dispose();
  }
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas.parentElement || canvas);
  resize();
  renderLoop();
  return { load, resetView, destroy };
}
