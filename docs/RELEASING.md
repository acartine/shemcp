# Releasing shemcp as a public npm package

This execution plan prepares, automates, and governs releases to npm with clear docs, semantic versioning, and changelogs. It assumes GitHub-hosted repo and Node 18+.

## Goals

- Installation docs prioritize npm install first (global and project-local).
- Automated releases from GitHub Actions with secure npm publish.
- Enforced semantic versioning (semver) on every change.
- Guaranteed release notes/changelog updates for each version.

## Overview of the approach

- Use Changesets for versioning and changelog generation.
  - Developers add a small “changeset” file in PRs to describe changes and bump semver.
  - A GitHub Action verifies a changeset is present on PRs that change published code.
  - On merge to main, the action opens a release PR or publishes directly (recommended: release PR for visibility). Merge of the release PR publishes to npm, updates `CHANGELOG.md`, and bumps versions.
- Keep a simple CI that runs build/tests on PRs and main.

Why Changesets? It gives explicit control over semver bumps (patch/minor/major), produces human-readable release notes, and can block merges if a changeset is missing.

## Phase 0 – Prerequisites and decisions

- Confirm npm package name availability (e.g., `shemcp`).
- Confirm license (e.g., MIT) and author/company details.
- Node support policy: recommend Node >= 18.
- Decide publish visibility: public (default).
- Decide release cadence: on merge to main.

## Phase 1 – Package hygiene and metadata

Update `package.json` (examples):

- name, version (semantic), description, keywords
- repository, bugs, homepage
- license (e.g., MIT) and author
- main/module/types/exports (sensible ESM/CJS strategy)
- files: only ship built artifacts (e.g., `dist/**`), and relevant assets (README, license, config examples). Exclude tests and TS sources unless desired.
- engines: `{ "node": ">=18" }`
- publishConfig: `{ "access": "public", "provenance": true }` (provenance requires GitHub OIDC)
- scripts: `build`, `test`, `prepublishOnly: "npm run build && npm test --silent"`
- If you intend to expose a CLI, add `bin` pointing to the compiled entry file.

Checklist:

- [ ] Ensure `dist/` is generated and consumed by `main`/`exports`
- [ ] Add `.npmignore` or rely on `files` to exclude tests/docs
- [ ] Verify types are emitted and `types` points to `dist/**/*.d.ts`

## Phase 2 – Docs update (installation first)

README changes to prioritize npm installation:

1) Global install (if appropriate)
   - `npm install -g shemcp`
2) Project install
   - `npm install -D shemcp`
3) Basic usage section (quick start), with a minimal working example
4) Configuration overview referencing `config.example.toml`
5) Security and sandbox notes
6) Supported Node versions

Optional: Add a small “Try it” block.

## Phase 3 – Versioning and changelog via Changesets

Install and initialize Changesets:

- `npm install -D @changesets/cli`
- `npx changeset init`

This creates a `.changeset/` directory. Developers will run `npx changeset` to create a changeset when opening feature or fix PRs. The prompt selects semver bump (patch/minor/major) and asks for a human-readable summary. On release, Changesets updates `CHANGELOG.md` and the version in `package.json` automatically.

Policy:

- Every PR that changes published code must include a changeset.
- Use Conventional Commit-style titles where possible (feat:, fix:, chore:, docs:) to help scanning and consistency.

## Phase 4 – CI workflows

Create two GitHub Actions workflows:

1) `.github/workflows/ci.yml`
   - Triggers: `pull_request`, `push` (main)
   - Steps: checkout, setup Node, install, build, test, typecheck (if any)
   - Optional: Linting (ESLint), format check (Prettier)

2) `.github/workflows/release.yml` (Changesets)
   - Triggers: `push` to `main`
   - Uses `changesets/action` to open a release PR automatically when changesets exist. When the release PR is merged, it publishes to npm (or you can configure immediate publish on main—release PR is recommended).

Secrets required:

- `NPM_TOKEN` with publish rights (team account, 2FA recommended)
- Optional: set up npm provenance (requires public repo, GitHub OIDC, and npm provenance support)

High-level example for release workflow (pseudocode):

```yaml
name: Release
on:
  push:
    branches: [ main ]

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write # create tags/releases
      id-token: write # for npm provenance (optional)
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npm run build
      - name: Create Release PR or Publish
        uses: changesets/action@v1
        with:
          publish: npm publish --provenance --access public
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

And CI workflow outline:

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [ main ]

jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build
      - run: npm test --silent
```

## Phase 5 – Enforce changesets on PRs

We want to block merging PRs that modify publishable files without a changeset. Two approaches:

- Simple convention: reviewers check.
- Automated: use a lightweight PR check that looks for `.changeset/*.md` files when `src/**` or `package.json` changes. Several community Actions exist, or write a tiny script and run it in CI.

Policy recommendation (practical):

- If `src/**` or `package.json` is changed, require at least one `.changeset/*.md` file.

## Phase 6 – Security and provenance

- Use an npm automation token with publish rights only.
- Enable 2FA on the npm org/user accounts.
- Use GitHub OIDC to enable npm provenance (`publishConfig.provenance: true` and `npm publish --provenance`).
- Limit `GITHUB_TOKEN` permissions in workflows to least privilege.

## Phase 7 – Dry run and first release

1) Run CI on main (green build/tests).
2) Open a small PR with a changeset (e.g., docs tweak) to validate the pipeline creates a release PR.
3) Merge the release PR → confirm:
   - `CHANGELOG.md` updated
   - version bumped in `package.json`
   - tag created on GitHub
   - package published on npm
4) Update README’s installation to reference the published version badge if desired.

## Ongoing maintenance

- Keep the `files`/exports aligned with built artifacts.
- Periodically rotate `NPM_TOKEN`.
- Consider adding `commitlint` + `husky` for Conventional Commits if you want stricter commit hygiene.
- Consider release channels (pre-release tags) if needed:
  - Use branches like `next` and Changesets pre-releases (`changeset pre enter/exit`).

## Acceptance criteria

- README shows npm install first and has a minimal quick start.
- CI runs on PRs and main, and is green.
- PRs that change published code require a changeset.
- Merges to main produce a release PR.
- Merging the release PR publishes to npm, bumps the version, updates `CHANGELOG.md`, and creates a Git tag.
- npm package contains only expected artifacts (`dist/**`, docs) and has correct metadata (license, repository, homepage).

---

Appendix: Minimal package.json fields checklist

- `name`, `version`, `description`, `keywords`
- `license`, `author`
- `repository`, `bugs`, `homepage`
- `main`/`module`/`types` (or `exports` map)
- `files` or `.npmignore`
- `scripts` including `prepublishOnly`
- `engines.node >= 18`
- `publishConfig.access = public`, `publishConfig.provenance = true`