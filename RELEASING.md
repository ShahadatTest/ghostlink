# Releasing the npm packages

GhostLink publishes seven packages under the `@ghostlink` scope: `common`, `sdk`, `verify`, `prover-wasm`, `react`, `service-kit` and `bot`. They are experimental 0.x releases for local and test networks only; see the README's project status.

Publishing runs only from the manual `release` workflow in GitHub Actions. It builds and tests the workspace, packs every archive, installs the archives into a clean consumer project, then publishes them in dependency order with [npm provenance](https://docs.npmjs.com/generating-provenance-statements). Versions that already exist on npm are skipped.

## One-time setup (repository owner)

1. Create the `ghostlink` organization on npm, which is free for public packages ([guide](https://docs.npmjs.com/creating-an-organization)). It reserves the `@ghostlink` scope. If the name is taken, choose another scope and rename the packages before the first release.
2. Create a granular access token that can publish packages in that scope, with the shortest practical expiry ([guide](https://docs.npmjs.com/creating-and-viewing-access-tokens)).
3. In the repository, open Settings → Environments → `npm` (create it if it does not exist yet) and add the token as the secret `NPM_TOKEN` ([guide](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)). Add yourself as a required reviewer so that every publish waits for your approval.

## Each release

1. Bump the versions of the packages you are releasing, keeping their internal dependencies consistent, and merge the change through a pull request.
2. Open Actions → `release` → Run workflow, with **dry_run** checked ([guide](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/manually-running-a-workflow)). It runs every check and `npm publish --dry-run` for each archive.
3. Run it again with dry-run unchecked to publish.
4. Tag the release commit (`vX.Y.Z`) and write release notes.

npm never allows a version number to be reused, even after unpublishing, so read the dry-run output before publishing.

After the first release you can switch to [trusted publishing](https://docs.npmjs.com/trusted-publishers), which needs no long-lived token, and then delete `NPM_TOKEN`.
