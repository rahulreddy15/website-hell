# Symptom Tracker

Stdlib-only authenticated capture server and SQLite store for the V1 contract in `PLAN.md`.

```sh
SYMPTOM_TRACKER_PASSWORD='use-a-secret' python3 app.py  # password used only on first run
python3 app.py --set-password                           # preferred interactive setup
python3 smoke_test.py
```

Configuration: `SYMPTOM_TRACKER_DB`, `HOST`, `PORT`, and `BASE_PATH` (default `/tracker`).
The password is scrypt-hashed with a random installation salt; it is never stored plaintext.

### Local development and LAN testing

The session cookie is `Secure` by default, and browsers refuse to store a `Secure` cookie on
a plain `http://` origin. Chrome makes an exception for `localhost`; Safari and phones on the
LAN do not, so login appears to succeed and the session is silently dropped.

For local use only, opt in explicitly:

```sh
SYMPTOM_TRACKER_DEV_INSECURE_COOKIE=1 HOST=0.0.0.0 python3 app.py
```

`HOST=0.0.0.0` also exposes the app to your LAN so a phone can reach it at
`http://<your-lan-ip>:8011/tracker/`.

**Never set `SYMPTOM_TRACKER_DEV_INSECURE_COOKIE` in production.** It is opt-in precisely so
the deployed service, which sits behind Caddy's TLS, cannot lose `Secure` by accident. The
systemd unit does not set it.

`schema.sql` preserves the authoritative DDL and adds FTS synchronization plus server-only
authentication tables. SQLite accepts the generated `date()`/`unixepoch()` expressions as
deterministic (tested by `smoke_test.py`, including explicit offsets around a DST transition).
Migrations are versioned by `schema_version`; future versions are applied in order by
`db.ensure_schema()`. Version 2 adds reviewed-attribute state and retained deletion tombstones.
Version 3 rebuilds only `symptom_event` so Bristol can be NULL and adds `is_bm`; existing rows
are preserved as bowel movements. Version 4 adds structured ordinal `nausea`.

## Pinned API shapes

- `GET /api/auth/session` returns
  `{ "authenticated": boolean, "configured": boolean }`.
- `GET /api/meals` returns `{ "meals": [...] }`. Every meal contains a nested
  `consumption_events` array. `POST /api/meals` accepts one meal with that same nested array;
  `/api/sync` instead accepts sibling `meals` and `consumption_events` arrays.
- `day_log.missing_kinds` is a JSON **string**, matching its SQLite `TEXT` column. Native
  arrays are rejected rather than silently transformed.
- Unknown `portion_ordinal` is JSON `null` and remains SQL NULL; no portion is inferred.
- Canonical analysis/timeline lag windows are 0–6h, 6–24h, and 24–48h. The rates endpoint
  defaults to 0–6h and accepts the other canonical bounds explicitly.
- Review endpoints are `GET /api/attributes`, `GET|PUT /api/items/:id/attributes`,
  `GET /api/review/queue?limit=`, and `GET /api/review/impact`.

`GET /api/review/impact?top_n=6` returns `n_total_observations`,
`n_unknown_exposure`, `n_classified`, `n_would_become_analyzable`, and the effective `top_n`.
Unknown exposure is the maximum candidate-specific count, never a sum across candidates.
Review queue items expose `n_consumptions`, `blocks`, marginal `unlocks`, `review_score`,
`last_used`, and item identity/review fields.

The review queue score is `consumption_count × 30-day recency weight ×
(1 + blocked_BM_observations)`. It prioritizes frequently consumed recent items and strongly
promotes items whose missing review currently prevents descriptive analysis.

Analysis HTTP responses are descriptive, use Wilson intervals, preserve unknown attributes,
and never persist derived lag features. `analysis/` is reserved for read-only scientific-stack
notebooks; dependencies placed there must never be imported by the capture server.

## Database protection and deployment

Production data is `/var/lib/symptom-tracker/symptom_tracker.sqlite3`. `deploy/install.sh`
preserves that directory. Before restarting a release, it creates a mandatory consistent
snapshot in `backups/pre-migration/`, with the current schema version in its name. Deployment
aborts if that snapshot fails. The ten newest pre-migration snapshots are retained separately
and are never included in the nightly 30-snapshot rotation.

After the service passes its loopback health check, deployment automatically installs the
contents of `deploy/caddy-symptom-tracker.caddy` inside the `rahulreddy.in` TLS site block,
validates the complete Caddyfile, and reloads Caddy. The uniquely marked
`# BEGIN symptom-tracker` / `# END symptom-tracker` block is replaced in place on later
deploys. The pre-edit Caddyfile is retained as
`/etc/caddy/Caddyfile.symptom-tracker.bak.TIMESTAMP`; validation failure restores it and
aborts. Set `CADDYFILE=/alternate/path` when deploying against a nonstandard location. If
Caddy or its configuration file is absent, deployment warns and leaves the healthy loopback
service running rather than failing the application install.

The local snapshot timer runs `VACUUM INTO` at 03:15. The off-VM timer starts at 04:00,
orders itself after the snapshot service, and uploads only the newest standalone snapshot—not
the live WAL database. It refuses to upload if no snapshot newer than 24 hours exists.

### Configure off-VM restic backups

1. Install `restic` using the VM's package manager.
2. Create a private B2 or S3-compatible bucket with versioning/object lock if available, and
   create credentials limited to that bucket.
3. Create the root-only environment file (do not put these values in a unit):

   ```sh
   sudo install -o root -g root -m 0600 /dev/null /etc/symptom-tracker-restic.env
   sudoedit /etc/symptom-tracker-restic.env
   ```

   For Backblaze B2:

   ```sh
   RESTIC_REPOSITORY=b2:BUCKET_NAME:symptom-tracker
   RESTIC_PASSWORD=A_LONG_UNIQUE_REPOSITORY_PASSWORD
   B2_ACCOUNT_ID=YOUR_KEY_ID
   B2_ACCOUNT_KEY=YOUR_APPLICATION_KEY
   ```

   For S3-compatible storage:

   ```sh
   RESTIC_REPOSITORY=s3:https://OBJECT_STORAGE_ENDPOINT/BUCKET_NAME/symptom-tracker
   RESTIC_PASSWORD=A_LONG_UNIQUE_REPOSITORY_PASSWORD
   AWS_ACCESS_KEY_ID=YOUR_ACCESS_KEY
   AWS_SECRET_ACCESS_KEY=YOUR_SECRET_KEY
   AWS_DEFAULT_REGION=YOUR_REGION
   ```

4. Initialize and test the repository without printing secrets:

   ```sh
   sudo bash -c 'set -a; source /etc/symptom-tracker-restic.env; set +a; restic init'
   sudo systemctl start symptom-tracker-backup.service
   sudo /opt/symptom-tracker/current/deploy/restic-backup.sh
   sudo systemctl enable --now symptom-tracker-restic-backup.timer
   systemctl list-timers 'symptom-tracker*'
   ```

The script keeps 14 daily, 8 weekly, and 12 monthly restic snapshots and prunes expired
data. Sunday runs also execute `restic check`; any missing tool/configuration, stale local
snapshot, upload, retention, or repository-check failure makes the systemd service fail and
appear in `systemctl --failed`/the journal. Configure external monitoring for that unit.

### One-time local database migration

First stop the local server so no process can create new WAL writes. Then checkpoint and
verify the source (replace the path if `SYMPTOM_TRACKER_DB` points elsewhere):

```sh
cd symptom-tracker
sqlite3 data/symptom_tracker.sqlite3 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA integrity_check; SELECT MAX(version) FROM schema_version;'
test ! -e data/symptom_tracker.sqlite3-wal
scp data/symptom_tracker.sqlite3 USER@VM:/tmp/symptom-tracker-local.sqlite3
```

If checkpointing is impossible, stop every writer and copy the `.sqlite3`, `-wal`, and `-shm`
files together before opening any copy. Checkpointing is strongly preferred because copying
only the main file while a WAL exists silently loses recent writes. The migration script
therefore rejects an incoming path with adjacent WAL/SHM files.

On the VM, deploy the matching app release first, then run:

```sh
sudo /opt/symptom-tracker/current/deploy/migrate-local-db.sh /tmp/symptom-tracker-local.sqlite3
rm /tmp/symptom-tracker-local.sqlite3
```

Before touching production, the script runs `PRAGMA integrity_check` and requires schema v4.
It refuses to replace a destination containing study rows. If replacement is truly intended,
rerun with `--force`; even then it stops the service and writes a `backups/pre-import/`
snapshot first. It installs the file as `symptom-tracker:symptom-tracker` mode `0600`, starts
the service, and checks `/api/auth/session` on loopback.

### Restore rehearsal and emergency restore

Rehearse both paths once while the database is small. A backup is not trustworthy until a
restore has passed `PRAGMA integrity_check` and the service health check. Restore into a
temporary file first and preserve the damaged database instead of deleting it.

From a nightly or pre-migration local snapshot:

```sh
sudo systemctl stop symptom-tracker.service
sudo cp -a /var/lib/symptom-tracker/symptom_tracker.sqlite3 /var/lib/symptom-tracker/symptom_tracker.sqlite3.damaged.$(date -u +%Y%m%dT%H%M%SZ)
sudo cp /var/lib/symptom-tracker/backups/symptom-tracker-YYYY-MM-DDTHHMMSSZ.sqlite3 /var/lib/symptom-tracker/restore.sqlite3
sudo sqlite3 /var/lib/symptom-tracker/restore.sqlite3 'PRAGMA integrity_check; SELECT MAX(version) FROM schema_version;'
sudo install -o symptom-tracker -g symptom-tracker -m 0600 /var/lib/symptom-tracker/restore.sqlite3 /var/lib/symptom-tracker/symptom_tracker.sqlite3
sudo rm -f /var/lib/symptom-tracker/symptom_tracker.sqlite3-wal /var/lib/symptom-tracker/symptom_tracker.sqlite3-shm /var/lib/symptom-tracker/restore.sqlite3
sudo systemctl start symptom-tracker.service
curl -fsS http://127.0.0.1:8011/api/auth/session
```

From restic, first list snapshots, then restore the selected snapshot into an empty staging
directory. Restic stores the snapshot's absolute path beneath that directory:

```sh
sudo bash -c 'set -a; source /etc/symptom-tracker-restic.env; set +a; restic snapshots --tag symptom-tracker-nightly'
sudo rm -rf /var/lib/symptom-tracker/restic-restore
sudo install -d -o root -g root -m 0700 /var/lib/symptom-tracker/restic-restore
sudo bash -c 'set -a; source /etc/symptom-tracker-restic.env; set +a; restic restore SNAPSHOT_ID --target /var/lib/symptom-tracker/restic-restore'
sudo /opt/symptom-tracker/current/deploy/migrate-local-db.sh --force /var/lib/symptom-tracker/restic-restore/var/lib/symptom-tracker/backups/symptom-tracker-YYYY-MM-DDTHHMMSSZ.sqlite3
sudo rm -rf /var/lib/symptom-tracker/restic-restore
```

The migration helper validates the restored file, snapshots the current destination, applies
ownership and permissions, restarts the service, and verifies health.
