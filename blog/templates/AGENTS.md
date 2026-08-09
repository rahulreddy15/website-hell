# `blog/templates/`

This directory contains the blog's Tera templates. `base.html` is the shared layout, and the other page templates extend it.

## Layout

```text
templates/
├── base.html
├── index.html
├── section.html
├── page.html
├── taxonomy_list.html
├── taxonomy_single.html
├── 404.html
├── nav.html
├── macros.html
├── og.html
├── seo_tags.html
├── security_tags.html
├── language_switcher.html
└── style.css.html
```

## Commands

Run from the repository root:

```sh
zola --root blog check
zola --root blog serve
```

## Conventions

- Zola recognizes the special names `index.html`, `section.html`, `page.html`, `taxonomy_list.html`, `taxonomy_single.html`, and `404.html`.
- `nav.html`, `macros.html`, `og.html`, `seo_tags.html`, `security_tags.html`, `language_switcher.html`, and `style.css.html` are non-special partials/helpers.
- Templates receive `page` in `page.html`, `section` in `index.html` and `section.html`, and global `config`.
- `base.html` uses `get_url(path="styles/main.css", trailing_slash=false)`, which resolves `blog/static/styles/main.css`.

## Gotchas

- `base.html` near line 52 hard-codes `/blog/atom.xml` for the RSS icon.
- `section.html` and `taxonomy_single.html` call `get_url(path="@/blog/_index.md", lang=lang)`.
- Navigation is configured by `[[extra.main_menu]]` in `blog/config.toml`; do not add menu items directly to templates.
