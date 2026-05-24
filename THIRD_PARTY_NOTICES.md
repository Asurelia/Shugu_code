# Third-Party Notices

Shugu Forge bundles third-party material. Their licenses are reproduced below
and under `vendor/`.

## open-design (nexu-io/open-design)

- Source: https://github.com/nexu-io/open-design
- License: Apache License 2.0 — see [`vendor/open-design/LICENSE`](vendor/open-design/LICENSE)

Vendored, unmodified, into this repository:

- `public/design-systems/` — the design-system catalogue (`DESIGN.md`,
  `components.html`, `tokens.css` per system), from the upstream
  `design-systems/` directory.
- `public/design-skills/` — the skill catalogue (`SKILL.md` per skill), from
  the upstream `skills/` directory. Many entries are catalogue stubs that point
  at their own upstream sources, which carry their own licenses.

`public/design-systems/index.json` and `public/design-skills/index.json` are
generated manifests produced by `scripts/vendor-open-design.mjs` (run that
script to refresh the vendored copy from upstream).

Only the framework-agnostic catalogue is vendored; the upstream application
(`apps/`, `packages/`) is not included.
