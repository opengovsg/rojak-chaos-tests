# Release

## Tagging a release

To tag a new release

```bash
pnpm release
```

This will show an interactive prompt for the version you want to release. After confirming, it will:

* Bump all package.json files to the new version
* Commit the changes
* Tag the commit

After verifying that everything is correct, push the tag.

After the tag is pushed, the CI will automatically publish a new version on GitHub.
