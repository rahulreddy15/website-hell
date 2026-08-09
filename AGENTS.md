# Repository

This repository contains three independent projects: a Zola blog, a standard-library Python food planner, and a standard-library Python symptom tracker. They share only this Git repository and one deployment workflow; do not mix their templates, static assets, configuration, or output.

## Layout

```text
.
├── blog/                    # Zola site root
├── food-planner/            # Standalone Python app
├── symptom-tracker/         # Standalone Python app (food ↔ GI symptom research tool)
└── .github/workflows/       # Validation and VM deployment
```

The three `public/` directories are unrelated: `blog/public/` is generated and gitignored, while `food-planner/public/` and `symptom-tracker/public/` are committed source.

`food-planner` and `symptom-tracker` are separate applications that happen to share a stack (stdlib `http.server` + SQLite + vanilla JS). They have distinct schemas, ports, data directories, and systemd units. Do not merge their models or import across them.

## Agent Guides

| Path | Scope |
| --- | --- |
| [`blog/AGENTS.md`](blog/AGENTS.md) | Zola configuration, build, drafts, and static files |
| [`blog/content/AGENTS.md`](blog/content/AGENTS.md) | Sections, pages, bundles, links, and publishing |
| [`blog/templates/AGENTS.md`](blog/templates/AGENTS.md) | Tera layouts, special templates, and partials |
| [`food-planner/AGENTS.md`](food-planner/AGENTS.md) | Python server, frontend, tests, and deployment files |
| [`symptom-tracker/AGENTS.md`](symptom-tracker/AGENTS.md) | Schema, API, PWA, analysis, and the study-design rules |
| [`.github/workflows/AGENTS.md`](.github/workflows/AGENTS.md) | CI validation and self-hosted VM deployment |

`symptom-tracker/PLAN.md` is the authoritative contract for that project. Read it before changing its schema, API, or analysis code.

## Commands

Run from the repository root:

```sh
zola --root blog check
zola --root blog build
zola --root blog serve
python3 food-planner/smoke_test.py
python3 -m py_compile food-planner/app.py food-planner/smoke_test.py
python3 symptom-tracker/smoke_test.py
python3 -m py_compile symptom-tracker/app.py symptom-tracker/db.py symptom-tracker/smoke_test.py
```

## Conventions and Gotchas

- Zola global flags precede the subcommand. Use `zola --root blog build`, not `zola build --root blog`.
- The blog deploys to the domain root; the food planner runs independently under `/food-planner/`; the symptom tracker under `/tracker/`.
- Ports are distinct and both apps bind loopback only: food planner `8010`, symptom tracker `8011`.
- Production is a self-hosted VM behind Caddy, not Netlify, GitHub Pages, or Cloudflare.
- The symptom tracker holds health data and **requires authentication on every data endpoint**. The food planner has none by design. Do not copy the food planner's unauthenticated routing into it.
- The symptom tracker's server is stdlib-only; only `symptom-tracker/analysis/` may use the scientific Python stack.
- The removed `archive/` directory exists on the `valentine` branch, not on `main`.
