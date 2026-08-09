# Repository

This repository contains two independent projects: a Zola blog and a standard-library Python food planner. They share only this Git repository and one deployment workflow; do not mix their templates, static assets, configuration, or output.

## Layout

```text
.
├── blog/                    # Zola site root
├── food-planner/            # Standalone Python app
└── .github/workflows/       # Validation and VM deployment
```

The two `public/` directories are unrelated: `blog/public/` is generated and gitignored, while `food-planner/public/` is committed source.

## Agent Guides

| Path | Scope |
| --- | --- |
| [`blog/AGENTS.md`](blog/AGENTS.md) | Zola configuration, build, drafts, and static files |
| [`blog/content/AGENTS.md`](blog/content/AGENTS.md) | Sections, pages, bundles, links, and publishing |
| [`blog/templates/AGENTS.md`](blog/templates/AGENTS.md) | Tera layouts, special templates, and partials |
| [`food-planner/AGENTS.md`](food-planner/AGENTS.md) | Python server, frontend, tests, and deployment files |
| [`.github/workflows/AGENTS.md`](.github/workflows/AGENTS.md) | CI validation and self-hosted VM deployment |

## Commands

Run from the repository root:

```sh
zola --root blog check
zola --root blog build
zola --root blog serve
python3 food-planner/smoke_test.py
python3 -m py_compile food-planner/app.py food-planner/smoke_test.py
```

## Conventions and Gotchas

- Zola global flags precede the subcommand. Use `zola --root blog build`, not `zola build --root blog`.
- The blog deploys to the domain root; the food planner runs independently under `/food-planner/`.
- Production is a self-hosted VM behind Caddy, not Netlify, GitHub Pages, or Cloudflare.
- The removed `archive/` directory exists on the `valentine` branch, not on `main`.
