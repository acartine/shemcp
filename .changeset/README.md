# Changesets

We use Changesets for semantic versioning and release notes.

When your PR changes published code, add a changeset:

```bash
npx changeset
```

Choose the bump type (patch/minor/major) and write a short summary.

On merge to `main`, a release PR will be opened automatically; merging that PR publishes to npm and updates the changelog.