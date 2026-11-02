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

## Connect Unreal (for "Send selected FBX")

In your Unreal project:

1. **Edit > Plugins**: enable **Remote Control API** and **Python Editor Script Plugin**, then restart the editor.
2. **Project Settings > Plugins > Remote Control**: turn on **Allow Remote Python Execution**.

Asset Shelf checks for the editor every 5 seconds. When it's connected, the inspector shows the project name.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app UI: folder scanning, library, inspector, tags |
| `preview-viewer.js` | 3D preview and thumbnails (three.js) |
| `preview-viewer.bundle.js` | Built from `preview-viewer.js` with `npm run build:preview` |
| `server.js` | Local web server and Unreal bridge (Remote Control API on port 30010) |

After editing `preview-viewer.js`, run `npm run build:preview`.

Environment variables: `PORT` (default 5173), `UNREAL_URL` (default `http://127.0.0.1:30010`).
