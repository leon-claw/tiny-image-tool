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

## Troubleshooting

### macOS — 应用提示已损坏，无法打开

```
“Tiny Image Tool.app” is damaged and can’t be opened. You should move it to the Trash.
```

本地构建的 DMG **没有 Apple Developer 证书签名**，macOS Gatekeeper 会拦截。解决方法：

1. **右键 → 打开**（不要双击），在弹出的对话框点「打开」，一次放行即可。
2. 或终端清除隔离标记：

```bash
xattr -d com.apple.quarantine "/Applications/Tiny Image Tool.app"
```

> 如果应用不在 Applications 文件夹，替换成实际路径即可。

