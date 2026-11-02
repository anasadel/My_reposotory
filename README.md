# Asset Shelf

A local browser app for browsing your Fab / Unreal asset library, previewing models in 3D, tagging them, and sending a selected FBX straight into the Unreal Editor.

Your files are read in the browser and never leave your computer.

## Run it

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Open http://127.0.0.1:5173 in Chrome or Edge, then click **Choose local folder** and pick `VaultCache\FabLibrary` or a downloaded package folder.

## Connect Unreal

In your Unreal project:

1. **Edit > Plugins**: enable **Remote Control API** and **Python Editor Script Plugin**, then restart the editor.
2. **Project Settings > Plugins > Remote Control**: turn on **Allow Remote Python Execution**.

Asset Shelf checks for the editor every 5 seconds. When it's connected, the inspector shows the project name.

## Unreal assets from Fab

Choose your `VaultCache` folder (or one pack's `data\Content` folder). Every `.uasset` and `.umap` is listed, grouped by type: Meshes, Materials, Textures, Blueprints, Animation, Effects, Audio and Maps.

- **Add to project** copies the selected asset and every asset it uses (materials, textures, skeletons, and so on) into your project's `Content` folder, at the same `/Game/...` path Fab uses so references keep working. Files already in the project are never overwritten.
- **Load 3D from Unreal** (meshes only) asks Unreal to export the mesh so it can be rotated in 3D. Files copied only for the preview are deleted again afterwards. The preview shows geometry, not materials.

Unreal assets only open in the Unreal version they were made for, or newer.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app UI: folder scanning, library, inspector, tags |
| `preview-viewer.js` | 3D preview and thumbnails (three.js) |
| `preview-viewer.bundle.js` | Built from `preview-viewer.js` with `npm run build:preview` |
| `server.js` | Local web server and Unreal bridge (Remote Control API on port 30010) |

After editing `preview-viewer.js`, run `npm run build:preview`.

Environment variables: `PORT` (default 5173), `UNREAL_URL` (default `http://127.0.0.1:30010`).
