# `.github/workflows/`

These workflows validate pull requests and deploy both independent projects to a self-hosted VM behind Caddy. This repository does not deploy through Netlify, GitHub Pages, or Cloudflare.

## Layout

```text
.github/workflows/
├── check-vm-prereqs.yml      # PR validation and remote prerequisite check
└── deploy.yml                # Main-branch build and deployment
```

## Commands

Equivalent local checks, run from the repository root:

```sh
zola --root blog check
zola --root blog build
python3 food-planner/smoke_test.py
python3 -m py_compile food-planner/app.py food-planner/smoke_test.py
```

## Workflow Behavior

- `deploy.yml` runs on pushes to `main` and `workflow_dispatch`.
- It installs Zola through Snap, builds with `zola --root blog build`, validates the food planner, and deploys both projects using `sshpass` and `scp`.
- Generated `blog/public/` is deployed to `/var/www/html` and served at the domain root.
- The food planner is installed at `/opt/food-planner/current` through `deploy/install.sh` and health-checked at `/api/bootstrap`.
- `check-vm-prereqs.yml` runs for pull requests to `main`, syntax-checks, and remotely executes `food-planner/deploy/check-vm-prereqs.sh`.
- Both workflows use `REMOTE_HOST`, `REMOTE_USER`, and `REMOTE_PASS` secrets.

## Conventions and Gotchas

- Keep the two projects' build and deployment paths separate.
- Zola global flags precede the subcommand: use `zola --root blog build`, not `zola build --root blog`.
- The intended Zola output path is `blog/public/`, not a root-level `public/` directory.
