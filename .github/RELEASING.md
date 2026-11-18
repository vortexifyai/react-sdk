# Release the React SDK

Releases are published by `.github/workflows/release.yml` when a stable version tag is pushed. Run the commands below from this SDK repository root.

## Registry setup

In npm package settings for `@vortexify/react`, configure GitHub Actions with organization `vortexifyai`, repository `react-sdk`, and workflow `release.yml`. Leave the environment field blank and enable direct `npm publish`. Separate dist-tag management permission is not required.

GitHub Actions must be enabled. Publishing uses GitHub OIDC; no registry token secret or interactive login is needed. The workflow does not specify a GitHub environment, matching the blank environment field in the trusted publisher.

## Publish a version

Update `version` in `package.json` and `package-lock.json` (including the root package entry), and add the matching `### vVERSION` entry to the README changelog. `npm version VERSION --no-git-tag-version` updates both version files.

Commit those files with the source changes, merge and push them to `main`, then tag that commit. For the prepared release:

```sh
git tag v0.1.4
git push origin v0.1.4
```

The workflow installs locked dependencies, tests and builds the SDK, and verifies the packed npm package name and version. The tag must match the committed package version and changelog. A separate job publishes the built files to npm. After publication, another job creates a GitHub Release containing those same files and generated release notes.

Watch the run in **Actions** and verify `@vortexify/react` on npm after it completes. Versions and changelogs are committed before release; the workflow does not push commits back or use the parent repository's release JSON files.

## Check locally without publishing

```sh
npm ci
npm test
npm run build
npm pack --dry-run
```

## Retry a failed release

A failure before publication can be retried after resolving its cause. If npm accepted the upload and only the GitHub Release job failed, rerun only that failed job. Do not move a published tag or reuse its package version for changed contents; publish a new version instead.
