# Contributing to QuillMD

Thanks for taking the time to contribute! 🎉

## Development setup

```bash
# Clone your own independent repository
cd QuillMD-independent
npm install        # if Electron's binary download is blocked (e.g. in China):
                   #   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
npm run dev        # hot-reload dev mode
```

See [`docs/development.md`](./docs/development.md) for the full build, packaging,
and architecture notes, and [`CLAUDE.md`](./CLAUDE.md) if you work with an AI agent.

## Before you open a pull request

- Run `npm run build` and make sure it bundles without errors (CI runs the same check).
- Keep changes focused; one logical change per PR.
- Match the surrounding code style (no linter is enforced — read the neighbours).
- If your change is user-facing, add a line under `## [Unreleased]` in [`CHANGELOG.md`](./CHANGELOG.md).

## Reporting bugs / requesting features

Use your own repository's issue templates or contact the independent maintainer. Include OS, app version, and clear steps to reproduce.

## Commit messages

Write imperative, descriptive subjects (e.g. "Fix tab focus loss on rename").
There's no strict convention — clarity over ceremony.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).
