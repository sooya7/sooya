# Google Drive backups

SOOYA keeps the live database and media on the server. Google Drive is used only for verified backup archives, never as the live SQLite filesystem.

## What is backed up

`deploy/backup.sh` creates a WAL-safe SQLite snapshot and bundles it with media and `shared/config`. The live `.env` is excluded by default because it contains API keys. The Google Drive layer uploads the resulting `sooya-backup-*.tar.gz` and its `.sha256` file.

## One-time setup

After the release containing this feature is active:

```bash
sudo /opt/sooya/current/deploy/setup-gdrive-backup.sh
```

If rclone has no remote named `gdrive`, the script opens `rclone config`. Choose Google Drive (`drive`) and complete OAuth. The token is stored in `/root/.config/rclone/rclone.conf`; it is not included in SOOYA backups.

Defaults:

- schedule: every 6 hours (with up to 10 minutes randomized delay)
- Drive path: `gdrive:SOOYA/backups`
- local full archives: 14
- Google Drive full archives: 30
- first verified upload runs immediately after setup

The settings file is `/opt/sooya/shared/gdrive-backup.env`.

## Operations

Run a backup immediately:

```bash
sudo systemctl start sooya-gdrive-backup.service
```

Check the timer:

```bash
systemctl list-timers sooya-gdrive-backup.timer
```

List cloud backups:

```bash
sudo /opt/sooya/current/deploy/gdrive-restore.sh --list
```

Restore the newest cloud backup:

```bash
sudo /opt/sooya/current/deploy/gdrive-restore.sh --latest
```

Restore a specific cloud backup:

```bash
sudo /opt/sooya/current/deploy/gdrive-restore.sh --name sooya-backup-YYYYMMDDTHHMMSSZ.tar.gz
```

The existing restore path still verifies the archive and SQLite database before stopping SOOYA, preserves the pre-restore state, and rolls back automatically if the restored service fails its readiness check.

## Security

Do not set `DATA_DIR` to an rclone/Google Drive mount. SQLite WAL locking expects a local filesystem. Keep `/opt/sooya/shared/data` local and upload only snapshots.

The Google OAuth token and SOOYA `.env` are intentionally not uploaded by this feature. On a completely new server, configure rclone and the SOOYA secrets first, then restore the data archive.
