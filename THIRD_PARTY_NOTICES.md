# Third-Party Notices

## Chromium / Brave / Chrome

Aifrost launches an installed Chromium-family browser as a separate process over
the Chrome DevTools Protocol. Browser binaries are **not** distributed in this
repository — their licenses and terms apply separately.

## Runtime dependencies (npm)

| Package          | License |
| ---------------- | ------- |
| `better-sqlite3` | MIT     |
| `fastify`        | MIT     |
| `nanoid`         | MIT     |
| `pino`           | MIT     |
| `ws`             | MIT     |
| `zod`            | MIT     |

Transitive dependencies are covered by `package-lock.json`. Regenerate this
table before release if `dependencies` change.

## Optional integrations

- **pifrost** (`packages/pifrost`) integrates with
  `@earendil-works/pi-coding-agent` as a peer dependency; that package's license
  applies to Pi itself, not to this repository's code.
