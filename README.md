# Tiny Image Tool

Cross-platform desktop image compression for macOS and Windows, built with Tauri, React, and TypeScript.

## Features

- Batch image compression from local files or folders.
- Providers: Compresto and Tinify.
- Supported inputs: JPG, JPEG, PNG, WebP, AVIF.
- Output modes: source `compressed/` folder, custom folder, or overwrite.
- Local API key configuration.
- API usage view:
  - Compresto uses its usage endpoint.
  - Tinify stores the latest `Compression-Count` response header.

## Development

```bash
npm install
npm run tauri:dev
```

## Checks

```bash
npm test
npm run build
cd src-tauri && cargo test
```

## Notes

API keys are stored in the local application config file. The UI masks saved keys after persistence, but this first version intentionally does not use macOS Keychain or Windows Credential Manager.

