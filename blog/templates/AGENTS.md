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
- `nav.html`, `og.html`, `seo_tags.html`, `security_tags.html`, `language_switcher.html`, and `style.css.html` are non-special partials/helpers.
- Templates receive `page` in `page.html`, `section` in `index.html` and `section.html`, and global `config`.
- `base.html` uses `get_url(path="styles/main.css", trailing_slash=false)`, which resolves `blog/static/styles/main.css`.

## Tera v2 rules (Zola 0.22+)

Zola compiles every file in this directory as a Tera template, including this
guide. The examples below are wrapped in a raw block so they are not parsed.

{% raw %}

These templates were migrated from the old Tera v1 syntax. Do not reintroduce the v1 forms.

- Test arguments are keyword-only: `is matching(pat="https?://")`, not `is matching("https?://")`.
- Undefined variables raise an error instead of being falsy. Guard with `is defined`, e.g. `{% if page is defined and page.title %}`. `page` is undefined in section/taxonomy contexts and `taxonomy` is undefined in `section.html`.
- `{% block %}` cannot be nested inside `{% if %}` or `{% for %}`. Declare the block, then put the condition inside it.
- Macros were removed from Tera v2. `macros.html` was deleted because nothing imported it. Use components if a reusable snippet is needed.
- `trim_start_matches(pat=)` is now `trim_start(pat=)`.
- `date(format='%+')` is rejected; use an explicit format such as `%Y-%m-%d`.
- `get_taxonomy_url` takes `term=`, not the deprecated `name=`.
- Feeds are a list: use `config.feed_filenames[0]`, not `config.feed_filename`.

{% endraw %}

## Gotchas

- `base.html` hard-codes `/blog/atom.xml` for the RSS footer icon.
- `section.html` and `taxonomy_single.html` call `get_url(path="@/blog/_index.md", lang=lang)`.
- Navigation is configured by `[[extra.main_menu]]` in `blog/config.toml`; do not add menu items directly to templates.
- `nav.html`, `seo_tags.html`, `security_tags.html`, and `style.css.html` are currently not referenced by any rendered template. `base.html` inlines its own nav and its own `<style>`-less stylesheet link.

