# Vendored libraries

## zip-full.min.js

- Library: zip.js (`@zip.js/zip.js`) — https://github.com/gildas-lormeau/zip.js
- Build: `zip-full` UMD bundle (exposes `window.zip`), includes inline
  Web Worker booted from a Blob URL (CSP: requires `worker-src blob:`).
- Version: unknown — the bundle carries no version banner and predates this
  note. When upgrading, download the dist from the GitHub releases page,
  record the version here, and re-test data loading on both Live and PTU.
- Used by: `js/dataLoader.js` (reads `data/Live.zip` / `data/PTU.zip` in the
  browser).
