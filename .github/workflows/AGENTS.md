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

- `deploy.yml` runs on pushes to `main`, on pull requests targeting `main`, and on `workflow_dispatch`.
- **Pull requests build and validate only.** The `Setup SSH` and `Deploy to Server` steps are gated with `if: github.event_name != 'pull_request'`, so a PR never touches the production VM. This matters because the deploy step runs `sudo rm -rf /var/www/html/*` and restarts the food-planner service.
- On every trigger it installs a pinned Zola via `taiki-e/install-action`, builds with `zola --root blog build`, runs `zola --root blog check --skip-external-links`, and validates the food planner.
- External link checking is skipped in CI because third-party sites cause flaky failures. Run `zola --root blog check` locally to validate external links.
- On pushes to `main` it additionally deploys both projects using `sshpass` and `scp`.
- Generated `blog/public/` is deployed to `/var/www/html` and served at the domain root.
- The food planner is installed at `/opt/food-planner/current` through `deploy/install.sh` and health-checked at `/api/bootstrap`.
- The symptom tracker is installed at `/opt/symptom-tracker/current` through its own `deploy/install.sh` and health-checked on loopback at `http://127.0.0.1:8011/tracker/api/auth/session`, which is the only unauthenticated data-adjacent route. The public `https://…/tracker/` route is **not** checked, because the Caddy snippet is a one-time manual install and would fail the deploy before it exists.
- The symptom tracker holds health data. Its `install.sh` takes a versioned pre-migration snapshot before restarting into new code and aborts the deploy if that snapshot fails. It never touches `/var/lib/symptom-tracker/`.
- The restic off-VM backup units are installed but deliberately **not enabled** by `install.sh`. Enable `symptom-tracker-restic-backup.timer` by hand once `/etc/symptom-tracker-restic.env` exists, otherwise it would fail nightly.
- `check-vm-prereqs.yml` runs for pull requests to `main`, syntax-checks, and remotely executes `food-planner/deploy/check-vm-prereqs.sh`.
- Both workflows use `REMOTE_HOST`, `REMOTE_USER`, and `REMOTE_PASS` secrets.

## Conventions and Gotchas

- Keep the two projects' build and deployment paths separate.
- Zola global flags precede the subcommand: use `zola --root blog build`, not `zola build --root blog`.
- The intended Zola output path is `blog/public/`, not a root-level `public/` directory.
- Any new step that touches the remote VM must carry `if: github.event_name != 'pull_request'`. Forked-PR runs also receive no secrets, so ungated deploy steps would fail even when they are not destructive.
- Zola is pinned to `zola@0.23.2` via `taiki-e/install-action`. Do not replace this with `snap install zola --edge`: that channel served a pre-0.23 Tera v1 build which cannot parse these templates. If you bump the pin, re-verify the templates against `blog/templates/AGENTS.md`.

