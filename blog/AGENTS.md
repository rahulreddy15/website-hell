# `blog/`

This directory is the Zola static-site root. Run Zola with `--root blog` when working from the repository root.

## Layout

```text
blog/
├── config.toml              # Zola configuration and navigation
├── content/                 # Published Markdown content
├── drafts/                  # Unpublished Markdown; never built by Zola
├── templates/               # Tera templates
├── static/styles/main.css   # Source static stylesheet
└── public/                  # Generated output; gitignored
```

## Commands

Run from the repository root:

```sh
zola --root blog serve
zola --root blog build
zola --root blog check
```

`blog/public/` is deleted and recreated by each build.

## Configuration

- `base_url = "https://rahulreddy.in"`.
- Global `generate_feeds = false`; the `blog` and `health` sections enable feeds.
- Taxonomies are `categories` and `tags`, both with feeds.
- `compile_sass = false` and `build_search_index = false`; there are no `sass/` or `themes/` directories.
- Navigation comes from `[[extra.main_menu]]` entries in `config.toml` using `@/` paths. Add navigation there, not in templates.
- `config.toml` is the legacy configuration filename. Modern Zola prefers `zola.toml`, but `config.toml` remains a supported fallback; do not rename it casually.

## Conventions and Gotchas

- Internal links use `@/path.md`, resolved from `blog/content/`, for example `@/blog/_index.md`. Moving the site under `blog/` does not change these links.
- Files under `drafts/` are outside `content/` and are never built. Moving one into `content/blog/` publishes it.
- Do not confuse generated `blog/public/` with the committed `food-planner/public/` frontend.
