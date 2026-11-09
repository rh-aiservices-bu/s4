# Upgrading to S4 0.4: Breaking Changes

**Applies to**: upgrading from S4 0.3.x (or earlier) to 0.4.0 and later.

> **Warning — data loss**: existing data from a prior installation is **not**
> compatible with the 0.4 storage engine. Buckets, objects, users and
> configuration created by 0.3.x will be lost on upgrade. There is no in-place
> migration path; back up anything you need before upgrading.

## What changed

### New base image and storage engine

S4 0.4 ships the Ceph RGW binary from the IBM Storage Ceph
`rgw-standalone-rhel10` base image (`icr.io/cpopen/ibm-ceph/rgw-standalone-rhel10:v9.9.2-27322`,
Ceph 20.2.2 "Tentacle", UBI 10 minimal) instead of the previous
`quay.io/rh-aiservices-bu/radosgw-posix` build.

The RGW now uses the **POSIX driver natively**: `rgw backend store = posix`
replaces the old `rgw backend store = dbstore` + `rgw filter = posix`
combination. The practical benefit: **files inside the backend storage
(`/var/lib/ceph/radosgw/buckets`) are directly readable on the volume** —
object data is stored as plain files on disk, so you can inspect, back up or
re-import them with ordinary filesystem tools, no RADOS layer involved.

On-disk layout under `/var/lib/ceph/radosgw`:

| Path | Contents |
| --- | --- |
| `buckets/` | Object data (POSIX driver, plain files) |
| `db/rgw_posix_lmdbs/` | LMDB metadata partitions (bucket/user indexes) |
| `dbstore-config.db` | SQLite config store (realm/zone/period) |
| `dbstore-default_ns.db` | SQLite user/bucket metadata |

### Process supervision

The new base image ships no init system, so `supervisord` is gone.
`docker/entrypoint.sh` supervises the RGW and Node.js processes directly with
a bounded restart policy (`S4_MAX_RESTARTS`, default 3) and SIGTERM
forwarding. Behavior from the outside (ports, logs on stdout/stderr, graceful
shutdown) is unchanged.

### Other changes

- **Node.js 22.15+** is required (Node.js 20 is EOL); the bundled runtime is
  Node.js 22.
- `s5cmd` is no longer bundled in the image (see
  [Container Architecture → S3 Debugging](../architecture/container.md#s3-debugging)
  for running S3 CLIs against S4 from outside the pod).
- Binaries are renamed: `radosgw-admin` → `rgw-standalone-admin`,
  `radosgw` → `rgw-standalone` (relevant only for manual `kubectl exec`
  debugging).

## Migration path

There is **no automated migration**: the 0.3.x metadata format (DBStore
databases and the posix-filter layout) is not understood by the 0.4 engine.
Perform a fresh install and re-upload your data.

### 1. Back up what you need from the old installation

```bash
# List buckets and copy objects out with any S3 client (run outside the pod)
export AWS_ACCESS_KEY_ID=<your-access-key>
export AWS_SECRET_ACCESS_KEY=<your-secret-key>
aws --endpoint-url http://<s4-s3-endpoint> s3 ls

# Example: sync everything to a local directory
aws --endpoint-url http://<s4-s3-endpoint> s3 sync s3:// ./s4-backup/
```

Or copy the volume contents directly — with 0.3.x the object files under
`/var/lib/ceph/radosgw` are also readable on disk, but re-uploading via S3
(above) is the reliable path since it rebuilds metadata.

### 2. Undeploy the old release

```bash
# Helm
helm uninstall s4 -n s4

# Then delete the old data volume (or create the new release with a new PVC)
kubectl delete pvc -n s4 -l app.kubernetes.io/instance=s4
```

### 3. Install 0.4 fresh

```bash
helm install s4 ./charts/s4 --namespace s4 --create-namespace \
  --set auth.username=admin \
  --set auth.password=your-secure-password
```

A fresh volume starts empty: the first boot recreates the `s4admin` S3 user
(from `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, defaults `s4admin` /
`s4secret`). Use the same values as before if you want clients to keep their
existing credentials.

### 4. Restore your data

```bash
# Recreate buckets
aws --endpoint-url http://<s4-s3-endpoint> s3 mb s3://my-bucket

# Upload the backup
aws --endpoint-url http://<s4-s3-endpoint> s3 sync ./s4-backup/ s3://my-bucket
```

## Checklist

- [ ] Backed up buckets/objects from the old installation (S3 sync or volume copy)
- [ ] Noted S3 credentials (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) to reuse
- [ ] Noted UI username/password and JWT secret, if authentication was enabled
- [ ] Undeployed the old release and removed/rotated the old data PVC
- [ ] Installed 0.4 and verified login + S3 operations
- [ ] Re-uploaded data and verified bucket/object listings
