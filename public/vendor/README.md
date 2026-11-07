# Vendored third-party code

Files here are **not** part of this project and are **not** covered by its MIT
licence. They are committed rather than installed so the application has no
runtime dependency on a CDN or on `node_modules` being present — it is
designed to run on shared hosting and on networks with no outbound access.

## jsQR 1.4.0

- **Licence:** Apache License 2.0 — see [LICENSE-jsQR.txt](LICENSE-jsQR.txt)
- **Source:** https://github.com/cozmo/jsQR
- **File:** `jsQR.js`, copied verbatim from the published package's `dist/`
- **Used for:** decoding QR codes from a camera frame in browsers that do not
  implement the native `BarcodeDetector` API — principally Safari. Where
  `BarcodeDetector` exists it is preferred, and this file is never loaded.

Retaining this notice is a condition of the Apache 2.0 licence. If you update
the file, update the version above and re-copy the licence.
