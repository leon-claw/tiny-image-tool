# Deploy Guide

This project builds desktop installers with Tauri. Windows release artifacts must be built on a Windows machine or the GitHub Actions Windows runner.

Release artifact versions must come from the Git tag. For example, tag `v1.0.0` builds application version `1.0.0`.

## Windows Artifacts

Windows bundles are produced by:

```bash
npm run tauri:build:windows
```

That command generates:

```text
src-tauri/target/release/bundle/nsis/*.exe
src-tauri/target/release/bundle/msi/*.msi
```

For a local Windows machine, use the wrapper:

```bash
npm run build:windows
```

The wrapper installs dependencies with `npm ci`, runs the Tauri Windows bundle build, and prints the artifact paths. It intentionally exits on macOS/Linux because Windows installers should be built on Windows.

## GitHub Actions Build

The Windows CI workflow lives at:

```text
.github/workflows/build-windows.yml
```

It runs on `windows-latest`, reads the release version from the Git tag, updates the build metadata for that run, and uploads an artifact named:

```text
tiny-image-tool-windows-x64
```

Inside that artifact, expect the NSIS `.exe` and MSI `.msi` installers.

For tag builds, the workflow also creates a GitHub Release and uploads the same `.exe` and `.msi` files to it. The release must remain in draft state until a human reviews and publishes it.

## Release Flow

Use Git tags to trigger the Windows artifact build. The first release tag is:

```text
v1.0.0
```

Recommended flow for another agent:

```bash
git status --short
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
git tag v1.0.0
git push origin v1.0.0
```

After pushing the tag:

1. Open GitHub Actions and wait for `Build Windows` to finish.
2. Confirm the uploaded Actions artifact is named `tiny-image-tool-windows-x64`.
3. Open GitHub Releases and confirm a draft release for the same tag exists.
4. Confirm the draft release contains the Windows `.exe` and `.msi` assets.
5. Leave the release as draft unless the user explicitly asks to publish it.

## Manual Workflow Dispatch

If a tag build needs to be rerun without creating a new tag, trigger `Build Windows` manually from GitHub Actions and provide the version input without a leading `v`, for example:

```text
1.0.0
```

Manual workflow dispatch uploads the Actions artifact, but it does not create a GitHub Release because there is no tag ref. To create release assets, prefer pushing a version tag.

## Notes

- `npm run tauri:build` remains the generic Tauri build command for the current platform.
- `npm run tauri:build:windows` is the Windows-specific bundle command.
- Do not expect `.exe` or `.msi` artifacts from macOS builds.
- Do not manually invent release versions. Use the Git tag as the source of truth.
- GitHub Releases created by automation are drafts by default.
