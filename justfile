set shell := ["bash", "-euo", "pipefail", "-c"]

# Show available commands
default:
    @just --list

# Run formatter, linter, typechecks, and tests
check:
    npm run check

# Format all files with Biome
format:
    npm run format

# Preview the package that npm would publish
pack:
    npm pack --dry-run

# Try the package from this working tree as a temporary pi package
try:
    pi -e .

# Publish the package to npm
publish:
    npm publish --access public

# Bump the package version without creating a git tag
bump part="patch":
    npm version {{quote(part)}} --no-git-tag-version
