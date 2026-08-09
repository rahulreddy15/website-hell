# `blog/content/`

This directory contains all Markdown that Zola can publish. Directory structure and index filenames determine whether content is a section, page, or page bundle.

## Layout

```text
content/
├── _index.md                # Homepage section
├── bear.md                  # Page
├── contact.md               # Page
├── blog/
│   ├── _index.md            # "Posts" section
│   └── *.md                 # Post pages
└── health/
    ├── _index.md            # "Health Updates" section
    └── *.md                 # Health pages
```

## Commands

Run validation from the repository root:

```sh
zola --root blog check
zola --root blog serve
```

## Conventions

- A directory is a section only when it contains `_index.md`; otherwise Markdown files within it become orphan pages.
- `_index.md` defines a section index. Any other `.md` file defines a page.
- Section front matter in use includes `title`, `description`, `sort_by = "date"`, `insert_anchor_links = "left"`, and `generate_feeds = true`.
- A directory containing `index.md` rather than `_index.md` is a page bundle and may colocate images or other assets.
- Use `@/path.md` for internal links. Paths start at this directory, for example `@/blog/_index.md`.

## Gotchas

- Section descriptions currently hard-code root-relative feed URLs such as `/blog/atom.xml` and `/health/atom.xml`.
- `blog/drafts/` is outside this directory, so Zola never builds it. Moving a draft into `content/blog/` publishes it.
