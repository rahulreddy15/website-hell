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
- `ignored_content = ["**/AGENTS.md"]` keeps these agent guides from being parsed as pages. Any new non-page Markdown under `content/` needs a matching entry, or Zola fails with "Couldn't find front matter".
- `[link_checker] skip_prefixes` skips LinkedIn, which answers HTTP 999 to non-browser clients and would otherwise fail `zola check`.
- Navigation comes from `[[extra.main_menu]]` entries in `config.toml` using `@/` paths. Add navigation there, not in templates.
- `config.toml` is the legacy configuration filename. Modern Zola prefers `zola.toml`, but `config.toml` remains a supported fallback; do not rename it casually.
- **TOML ordering trap:** bare top-level keys such as `taxonomies` and `default_language` must appear *above* the first table header (`[link_checker]`, `[translations]`, `[markdown]`, `[extra]`). A bare key placed after a header is silently absorbed into that table. This has already caused two real bugs here.

## Conventions and Gotchas

- Internal links use `@/path.md`, resolved from `blog/content/`, for example `@/blog/_index.md`. Moving the site under `blog/` does not change these links.
- Files under `drafts/` are outside `content/` and are never built. Moving one into `content/blog/` publishes it.
- Do not confuse generated `blog/public/` with the committed `food-planner/public/` frontend.
- Templates target Tera v2 (Zola 0.22+). See `templates/AGENTS.md` before editing them.
- `content/health/test.md` has no `date`, so the date-sorted `health` section drops it and the build warns. Add a `date` to publish it.

