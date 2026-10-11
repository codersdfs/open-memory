# Releasing

`publish.yml` publishes to npm with **trusted publishing**: GitHub mints a short-lived OIDC
token and npm exchanges it for a publish token. No `NPM_TOKEN` secret exists, so there is
nothing to leak, rotate or revoke.

## Requirements

- npm CLI **11.5.1** or newer and Node **22.14+**. The workflow runs Node 24, whose bundled
  npm is already past the floor.
- A GitHub-hosted runner. Trusted publishing does not support self-hosted runners.
- `package.json` `repository.url` must match the GitHub repository **exactly**. npm checks
  it, and a mismatch only surfaces as an authentication failure at publish time.
- A package that already exists on npm: the trusted publisher lives on the package's
  settings page, so the first version cannot use it.
- The workflow filename has to match what is configured on npmjs.com, `.yml` included.
  Every field is case-sensitive.

## One-time setup

1. **Publish the first version yourself** — this is the step the workflow cannot do:

   ```bash
   npm login
   npm publish --tag beta
   ```

2. On [npmjs.com](https://www.npmjs.com) open the package → **Settings** → **Trusted
   Publisher** → **GitHub Actions**, and fill in:

   | Field | Value |
   |---|---|
   | Organization or user | `codersdfs` |
   | Repository | `open-memory` |
   | Workflow filename | `publish.yml` |
   | Environment | *(leave empty — the workflow uses none)* |

   npm does not validate any of this when you save it. A typo appears later as
   `ENEEDAUTH`, which is why the table is here rather than in a memory.

3. Optional once a workflow publish has succeeded: restrict token access for the package,
   so that trusted publishing is the only way left to release it.

## Cutting a release

```bash
npm version 0.3.0-beta.2 --no-git-tag-version   # version + lockfile
$EDITOR CHANGELOG.md                            # what changed, dated

git commit -am "release: 0.3.0-beta.2"
git tag -a v0.3.0-beta.2 -m "open-memory 0.3.0-beta.2"
git push origin master --follow-tags            # this starts publish.yml
```

A version with a prerelease goes out as `beta` (`npm i open-memory@beta`), a plain version
as `latest`. The workflow refuses to publish when the tag and `package.json` disagree.

## When it fails

| Symptom | Cause |
|---|---|
| `ENEEDAUTH`, "Unable to authenticate" | filename, repository or owner does not match the npmjs.com config, or `id-token: write` is missing |
| `npm error 404` on publish | the package does not exist yet — publish the first version by hand |
| the tarball installs without the console | `npm --prefix ui run build` did not run before `npm run build` |
