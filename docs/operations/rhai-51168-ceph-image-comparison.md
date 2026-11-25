# RHAI-51168: Ceph RGW container image comparison

**Status:** investigation snapshot — 2026-11-25
**Ticket:** RHAI-51168
**Upstream change:** [ceph/ceph#74184](https://github.com/ceph/ceph/pull/74184) — *rgw/posix: support S3 object keys up to 1024 bytes* (open, unmerged at the time of writing)
**Related:** [rh-aiservices-bu/s4#30](https://github.com/rh-aiservices-bu/s4/issues/30) — Trino Parquet uploads failing with `File name too long`

> **Bottom line:** the two images are not variants of the same thing. The Quay image is a
> disposable **Ceph 22 development build on Fedora 44** that carries the unmerged long-key
> POSIX patch (PR #74184). The ICR image is the **Ceph 20.2.2 stable IBM package on RHEL 10.2
> UBI**, with a full runtime contract (entrypoint, `ceph` user, config, python3). The Quay
> image can exercise the long-key fix, but it is not a drop-in S4 base and it cannot validate
> Arrow/Parquet paths.

## 1. Images compared

| Property | Quay image | ICR image |
|---|---|---|
| Reference | `quay.io/rh-ee-mszewczy/mszewczy_public:RHAI-51168-ceph-image` | `icr.io/cpopen/ibm-ceph/rgw-standalone-rhel10:v9.9.2-27322` |
| Tag digest | `sha256:4df55be320c9bbb6cc0c0de0afd3dc57747e383d5526d4e80c6dcc4ddcaf7f82` | `sha256:743e902f902547c8efca57110a9277c9f62f330c8fc0f79ef983eb35c6874653` (multi-arch index) |
| amd64 manifest | same as tag (single manifest) | `sha256:932bcbc464b03ddb13346ae736e02acc40d4feacdbcd37458ee56c63439604cf` |
| Config digest | `sha256:1a1f36c114d1f20d18c46fe8039d99ea63796d62147878815d3f000e1258dc99` | `sha256:ce7543a0d5fec4442896132d1e17e3aeb093c05ea957be8f4712870ebf63a9a4` |
| Created | 2026-11-24T15:33:41Z | 2026-10-08T16:41:36Z |
| Platforms | `linux/amd64` only | `linux/amd64`, `linux/arm64`, `linux/s390x`, `linux/ppc64le` |
| Base OS | Fedora 44 Container Image (`fedora-20261101.tar`) | RHEL 10.2 UBI minimal (`cpe:/o:redhat:enterprise_linux:10.2`) |
| Ceph build | `3d7f1d (73d7f1d62b6…) vampire (dev - Release)` — Ceph 22 dev | `20.2.2-349.el10cp (aa79737c92…) tentacle (stable - RelWithDebInfo)` — Ceph 20 stable |
| Ceph packaging | No Ceph RPMs; `rgw-standalone{,-admin}` copied from a source build | `ceph-rgw-standalone-20.2.2-349.el10cp.x86_64` from the IBM-CEPH repo |
| Installed RPMs | 165 | 212 records / 210 distinct names |
| Entrypoint | none; `CMD ["/bin/bash"]` | `/usr/local/bin/entrypoint.sh` |
| Compressed size | 133,222,205 bytes (127.0 MiB), 5 layers | 379,364,973 bytes (361.8 MiB), 1 squashed layer |
| Unpacked size | 383,633,501 bytes (365.9 MiB) | 632,436,787 bytes (603.1 MiB) |

## 2. How this was verified

No container runtime is available in the analysis environment, so the images were inspected
directly through the registries and their layers:

1. Pulled manifests and config blobs anonymously over the OCI distribution API (Quay and ICR).
2. Extracted every layer into a scratch tree, preserving layer order.
3. Read `/etc/os-release`, `/etc/passwd`, `/etc/ceph/ceph.conf`, entrypoint scripts and
   `ld.so.conf.d` entries from the extracted root filesystems.
4. Queried both RPM databases (`rpm --root` for Fedora 44; `rpm --dbpath` against the
   extracted sqlite rpmdb for RHEL 10).
5. Executed both `rgw-standalone` and `rgw-standalone-admin` binaries with `LD_LIBRARY_PATH`
   pointing at the extracted image libraries, and compared `--version` output.
6. Inspected dynamic dependencies (`ldd`, `readelf -d`) and disassembled the Parquet entry
   point in the Quay build to determine build configuration.

Commands are listed in [section 10](#10-reproducing-the-inspection). The exact upstream state
(PR open/merged, main branch contents) is a snapshot from 2026-11-25 and can change.

## 3. Image anatomy

### 3.1 Quay image

**Build history:** a Fedora 44 base plus four buildah steps. The Ceph binaries were built
elsewhere and copied in; there is no Dockerfile, build script or Ceph source in the image, so
provenance is limited to the `org.opencontainers.image.revision` label and the binary version
string.

| # | Layer digest | Size (bytes) | Contents |
|---|---|---|---|
| 1 | `sha256:930206daf4a3182e3f085e476f524f544fef9541accece05637eb9d9db2fd364` | 72,036,611 | Fedora 44 base rootfs (`ADD fedora-20261101.tar /`) |
| 2 | `sha256:edad8b310e8216281f47021268963076f20a26e22dbe652d2a5149e65ab56e9b` | 435 | `/tmp/rgw-runtime-packages.txt` (556-byte runtime dependency list) |
| 3 | `sha256:3ff21fd0cd395d82b8ce2ece3ef12f1240233a994d8abaa4cace6825ce356681` | 20,799,119 | `dnf install` of the runtime RPMs |
| 4 | `sha256:2fb0dba61cb66a1249bcfa9e3d834818c7359068e2175d7705fd1c4b5447b646` | 40,378,514 | `/usr/bin/rgw-standalone`, `/usr/bin/rgw-standalone-admin`, `/usr/local/lib/ceph-rgw/libceph-common.so.2`, `/etc/ld.so.conf.d/ceph-rgw.conf` |
| 5 | `sha256:a374d08964daa68d2751c82ca9b0ebca63b10d828f064730fcffc9e213aefd3f` | 7,526 | `ldconfig` cache and `ldd` audit output (`/tmp/rgw-linked-libraries`) |

Config-derived runtime facts:

| Field | Value |
|---|---|
| `User` | unset (root) |
| `Entrypoint` | none |
| `Cmd` | `/bin/bash` |
| `WorkingDir` | `/` |
| `Env` | `PATH=…`, `DISTTAG=f44container`, `FGC=f44`, `FBR=f44` |
| `ExposedPorts` / `Volumes` | none |
| Labels | `io.buildah.version=1.45.0`, Fedora base `maintainer`, `org.opencontainers.image.revision=73d7f1d62b6ddafc5001e66fa49b125e4feaf340` |

Build history in full:

| Created | Step |
|---|---|
| 2026-11-02T20:43:44Z | `LABEL maintainer=Clement Verna <cverna@fedoraproject.org>` |
| 2026-11-02T20:43:44Z | `ENV DISTTAG=f44container FGC=f44 FBR=f44` |
| 2026-11-02T20:43:44Z | `ADD fedora-20261101.tar / # buildkit` |
| 2026-11-02T20:43:44Z | `CMD ["/bin/bash"]` |
| 2026-11-24T13:14:43Z | `LABEL org.opencontainers.image.revision="73d7f1d62b6ddafc5001e66fa49b125e4feaf340"` |
| 2026-11-24T15:32:28Z | `COPY … /tmp/rgw-runtime-packages.txt` |
| 2026-11-24T15:33:39Z | `dnf -y install bash ca-certificates shadow-utils $(cat /tmp/rgw-runtime-packages.txt) && dnf clean all` |
| 2026-11-24T15:33:40Z | `COPY dir:749aea8e… in /` (the two RGW binaries plus bundled `libceph-common`) |
| 2026-11-24T15:33:41Z | `ldconfig && ldd … && ! grep -F 'not found' … && rgw-standalone --version && rgw-standalone-admin --version` |

### 3.2 ICR image

A single squashed layer with the full RHEL 10.2 userspace and the IBM Ceph package:

| Layer digest | Size (bytes) | Diff ID |
|---|---|---|
| `sha256:1910021022f502ceffd2bd727cd6f910fda59fe150dd7071f7318c3aeda0d9d0` | 379,364,973 | `sha256:a3cf9ed109d75794104d69ef9600d8567413b03d85c07968603ec373ecab2d59` |

Significant build steps (full history in [Appendix B](#appendix-b-icr-build-history)):

1. `COPY /opt/zgw-posix`, `WORKDIR /opt/zgw-posix`.
2. Install `subscription-manager`, register the build with an activation key, enable
   CodeReady Builder, replace `ubi.repo` and `yum.conf` with IBM repository configuration.
3. Install `libarrow-glib-libs` and `libarrow` from the `IBM-CEPH` repo.
4. Create the `ceph` user/group (uid/gid 167).
5. Install `ceph-rgw-standalone` from the `IBM-CEPH` repo.
6. Install `/etc/ceph/ceph.conf`; `mkdir /var/run/ceph /home/ceph/.aws`; set ownership.
7. `ENV RGW_POSIX_BASE_PATH=/var/lib/ceph/rgw_posix_driver`, `RGW_POSIX_DATABASE_ROOT=/var/lib/ceph/rgw_posix_db`, `HOME=/home/ceph`.
8. Install `ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]` and the IBM/Red Hat labels.

Config-derived runtime facts:

| Field | Value |
|---|---|
| `User` | `root` |
| `Entrypoint` | `/usr/local/bin/entrypoint.sh` |
| `Cmd` | none |
| `WorkingDir` | `/opt/zgw-posix` |
| `Env` | `PATH=…`, `container=oci`, `RGW_POSIX_BASE_PATH=/var/lib/ceph/rgw_posix_driver`, `RGW_POSIX_DATABASE_ROOT=/var/lib/ceph/rgw_posix_db`, `HOME=/home/ceph` |
| `ExposedPorts` | none declared (the entrypoint serves `beast port=7480`, plus `ssl_port=7443` when TLS is enabled) |
| Labels | `cpe=cpe:/o:redhat:enterprise_linux:10.2`, `version=1.0.0`, `com.redhat.component=rgw-standalone`, `description=IBM Storage Ceph Object Gateway Developer Edition`, `vcs-ref=15b051dbd9dfffc387e455857eb5a01665969eb9`, `release=9-20261008161717` |

## 4. Base OS and system libraries

| Component | Quay (Fedora 44) | ICR (RHEL 10.2 UBI) |
|---|---|---|
| Distribution | Fedora Linux 44 (Container Image) | Red Hat Enterprise Linux 10.2 |
| glibc | 2.43-9.fc44 | 2.39-142.el10_2 |
| Boost | 1.90.0-7.fc44 | 1.83.0-7.el10 |
| SQLite | 3.51.2-2.fc44 | 3.46.1-6.el10_2 |
| LMDB | 0.9.34-2.fc44 | 0.9.32-4.el10 |
| Lua | 5.4.8-5.fc44 | 5.4.6-7.el10 |
| OpenSSL | 3.5.9-1.fc44 | 3.5.8-2.el10_2 |
| libcurl | 8.18.0-14.fc44 | 8.12.1-4.el10_2.6 (`libcurl-minimal`) |
| tcmalloc (gperftools) | 2.18.1-1.fc44 | 2.9.1-5.el10cp |
| Python | **not installed** | 3.12.15-1.el10_2 |
| Arrow / Parquet | **not installed** | 23.0.1-5.el10cp |
| Package manager | dnf5 | microdnf |
| Lifecycle signal | `SUPPORT_END=2027-05-19` (Fedora 44) | RHEL 10 lifecycle, subscription-backed base |

The runtime ABIs are therefore different. The Quay binaries need Fedora 44's Boost 1.90,
ICU 77 and glibc 2.43, and ship their own `libceph-common.so.2`; they are not portable to a
RHEL 10 base and vice versa.

## 5. Ceph build comparison

| Property | Quay | ICR |
|---|---|---|
| Version string | `ceph version 3d7f1d (73d7f1d62b6ddafc5001e66fa49b125e4feaf340) vampire (dev - Release)` | `ceph version 20.2.2-349.el10cp (aa79737c92b41a09aac056abcf932a7ded38d83e) tentacle (stable - RelWithDebInfo)` |
| Release line | Ceph main: `src/ceph_release` = `22 / vampire / dev` (checked 2026-11-25) | Ceph 20.2.2 stable, IBM build 349 |
| Source | `ceph/ceph` PR #74184 head, branch `dev-RHAI-51168` | IBM Ceph 20.2.2 source package (RPM) |
| Commit context | One commit on top of main `d3deea75c7825ed9f400da44557ae9fa2590e31a` (2026-11-23T09:40Z); PR still open | Release build; package version carries the build number |
| `rgw-standalone` | 50,192,512 bytes, ELF non-PIE, **with debug_info, not stripped** | 14,560,432 bytes, ELF PIE, **stripped** |
| `rgw-standalone-admin` | 40,837,112 bytes, not stripped | 12,742,048 bytes, stripped |
| `libceph-common.so.2` | 63,531,560 bytes at `/usr/local/lib/ceph-rgw/` | 11,363,176 bytes at `/usr/lib64/ceph/` |
| Arrow/Parquet linkage | no `libarrow`/`libparquet` in the image, no `NEEDED` entries; `RGWSelectObj_ObjStore_S3::run_s3select_on_parquet` is a stub returning 0 | dynamically links `libarrow.so.2300` and `libparquet.so.2300`; full Parquet S3 Select implementation |
| Debuginfo | embedded in the shipped binaries | stripped binaries; debuginfo split out of the runtime image |

### 5.1 What the Quay image adds

The `org.opencontainers.image.revision` label and the binary version string both point at
commit `73d7f1d62b6ddafc5001e66fa49b125e4feaf340`, which is the head of
[ceph/ceph#74184](https://github.com/ceph/ceph/pull/74184) — *"rgw/posix: support S3 object
keys up to 1024 bytes"* (branch `dev-RHAI-51168`, base `main`, one commit, four files,
opened 2026-11-23). The patch:

- SHA-256-hashes oversized object entries and multipart shadow directory names instead of
  exceeding `NAME_MAX`;
- keeps the original S3 key in metadata so listings still return the full key;
- groups long listing entries under bounded LMDB prefixes to preserve ordering/pagination;
- adds regression coverage for 1024-byte keys, UTF-8 keys, deletion and pagination.

The PR body explicitly references the S4 issue #30 comment, so this image is a test vehicle
for the long-key fix, not a general-purpose Ceph release.

### 5.2 Parquet/S3 Select caveat

The Quay build was configured without Arrow. Evidence:

- no `libarrow`/`libparquet` packages or libraries in the image;
- `readelf -d` shows no Arrow/Parquet `NEEDED` entries;
- `run_s3select_on_parquet` disassembles to `movl $0x0, -0x14(%rbp); mov …; pop; ret`
  (immediate success stub), i.e. Parquet processing is compiled out.

CSV/JSON S3 Select code is present. This matters only if RGW-side S3 Select on Parquet is
part of the test; the POSIX long-key fix is independent of Arrow. The ICR image, by contrast,
links Arrow 23 and implements the Parquet path.

## 6. Package inventory

The Quay image has 165 RPM records: only the Fedora base plus the runtime dependencies of the
copied binaries (`bash`, `ca-certificates`, `shadow-utils`, Boost 1.90, ICU, SQLite, LMDB,
Lua, OpenSSL, libcurl, tcmalloc, etc.). It contains **no Ceph RPM**, no `python3`, no
`libarrow`, and no `ceph-common` tooling beyond the two copied binaries.

The ICR image has 212 RPM records (210 distinct names): the UBI 10.2 minimal base,
`ceph-rgw-standalone-20.2.2-349.el10cp`, its Ceph/storage dependencies (`librados2`,
`libarrow`/`parquet-libs`/`liborc2`, `librdkafka`, `librabbitmq`, `re2`, `snappy`, `thrift`,
`protobuf`, `libibverbs`, `librdmacm`, `lttng-ust`, `numactl-libs`), `python3` and the
subscription-manager/dnf stack.

Packages present in only one image (name-level difference, versions ignored):

- **Only in ICR: 106** — includes `ceph-rgw-standalone`, `libarrow*`, `parquet-libs`,
  `python3*`, `librados2`, `librdkafka`, `librabbitmq`, `re2`, `snappy`, `thrift`,
  `protobuf`, `subscription-manager`, `systemd`, `util-linux`, `which`, fonts.
- **Only in Quay: 61** — mostly Fedora base/tooling packages: `dnf5*`, `fedora-release*`,
  `gnupg2*`, Boost subpackages, `libssh`, `libcurl`, `tar`, `sudo`, `vim-minimal`, `xz`,
  `zstd`, `nettle`, `libgcrypt`, `ngtcp2*`.

<details>
<summary>Complete list — packages only in the ICR image (106)</summary>

```text
attr
basesystem
ceph-rgw-standalone
coreutils-single
cracklib-dicts
cryptsetup-libs
dbus
dbus-broker
dbus-common
dbus-libs
default-fonts-core-sans
device-mapper
device-mapper-libs
diffutils
dmidecode
dnf-data
elfutils-debuginfod-client
fonts-filesystem
gobject-introspection
google-noto-fonts-common
google-noto-sans-mono-vf-fonts
google-noto-sans-vf-fonts
google-noto-serif-vf-fonts
ima-evm-utils
iproute
json-glib
keyutils
kmod-libs
langpacks-core-en
langpacks-en
langpacks-fonts-en
libarrow
libarrow-acero-libs
libarrow-compute-libs
libarrow-doc
libarrow-glib-libs
libbpf
libcomps
libcurl-minimal
libdnf
libdnf-plugin-subscription-manager
libfdisk
libibverbs
libmnl
libnl3
liborc2
libpeas1
librabbitmq
librados2
librdkafka
librdmacm
librhsm
libseccomp
libutempter
libxkbcommon
lttng-ust
microdnf
mpdecimal
numactl-libs
openssl-fips-provider
openssl-fips-provider-so
parquet-libs
protobuf
psmisc
python-unversioned-command
python3
python3-charset-normalizer
python3-cloud-what
python3-dateutil
python3-dbus
python3-decorator
python3-dnf
python3-dnf-plugins-core
python3-gobject-base
python3-gobject-base-noarch
python3-hawkey
python3-idna
python3-iniparse
python3-inotify
python3-libcomps
python3-libdnf
python3-librepo
python3-libs
python3-pip-wheel
python3-requests
python3-rpm
python3-six
python3-subscription-manager-rhsm
python3-systemd
python3-urllib3
re2
redhat-mono-vf-fonts
redhat-release
redhat-text-vf-fonts
rpm-plugin-systemd-inhibit
snappy
subscription-manager
subscription-manager-rhsm-certificates
systemd
systemd-pam
thrift
utf8proc
util-linux
virt-what
which
xkeyboard-config
```

</details>

<details>
<summary>Complete list — packages only in the Quay image (61)</summary>

```text
boost-atomic
boost-chrono
boost-container
boost-context
boost-date-time
boost-iostreams
boost-random
boost-regex
boost-thread
boost-url
bzip2
coreutils
coreutils-common
dnf5
dnf5-plugins
fedora-gpg-keys
fedora-release-common
fedora-release-container
fedora-release-identity-container
fedora-repos
fmt
gnulib-l10n
gnupg2
gnupg2-dirmngr
gnupg2-gpg-agent
gnupg2-gpgconf
gnupg2-keyboxd
gnupg2-verify
icu-tzdata
ima-evm-utils-libs
libassuan
libcbor
libcurl
libdnf5
libdnf5-cli
libfido2
libfsverity
libgcrypt
libgpg-error
libksba
libnghttp3
libnsl2
libpsl
libssh
libssh-config
libtirpc
libtool-ltdl
nettle
ngtcp2
ngtcp2-crypto-ossl
npth
publicsuffix-list-dafsa
sdbus-cpp
sudo
systemd-standalone-sysusers
tar
vim-data
vim-minimal
xz
zchunk-libs
zstd
```

</details>

## 7. Runtime contract

| Contract element | Quay | ICR |
|---|---|---|
| Entrypoint | none — container starts `/bin/bash` unless overridden | `/usr/local/bin/entrypoint.sh` |
| Default command | `/bin/bash` | RGW on `beast port=7480` (TLS on `ssl_port=7443` when `RGW_TLS_ENABLED=true`) |
| User | root | root (`USER root`) |
| Working directory | `/` | `/opt/zgw-posix` |
| `ceph.conf` | absent (`/etc/ceph` does not exist) | `/etc/ceph/ceph.conf` with `rgw backend store = posix`, `rgw config store = dbstore`, `debug rgw = 20` |
| Data directories | absent (`/var/lib/ceph` does not exist) | `/var/lib/ceph/radosgw` owned by `ceph`, `/run/ceph`, `/home/ceph/.aws`; `RGW_POSIX_*` dirs are created by the entrypoint |
| `ceph` user | absent | uid/gid 167 |
| Python 3 | absent | present (used by the entrypoint for JSON parsing) |
| zgw helper scripts | absent | `/opt/zgw-posix/bin/{start,stop,restart,status,release}-posix.sh` |
| Provisioning | none; caller must create config/user/dirs | creates `zippy` user (keys from `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`), quotas, key rotation, LMDB ownership fixes |
| Shared libraries | bundled `libceph-common` via `/etc/ld.so.conf.d/ceph-rgw.conf`; Fedora 44 system libs | `libceph-common` in `/usr/lib64/ceph`; RHEL 10.2 system libs |

Filesystem layout:

```text
# Quay image
/usr/bin/rgw-standalone
/usr/bin/rgw-standalone-admin
/usr/local/lib/ceph-rgw/libceph-common.so.2
/etc/ld.so.conf.d/ceph-rgw.conf
/tmp/rgw-runtime-packages.txt
(no /etc/ceph, /var/lib/ceph, /opt/zgw-posix, python3)
```

```text
# ICR image
/usr/bin/rgw-standalone
/usr/bin/rgw-standalone-admin
/usr/lib64/ceph/libceph-common.so.2
/etc/ceph/ceph.conf
/usr/local/bin/entrypoint.sh
/opt/zgw-posix/bin/*.sh
/opt/zgw-posix/{ceph.repo,docker/...}
/var/lib/ceph/radosgw        (ceph:ceph)
/run/ceph, /home/ceph/.aws
/var/lib/ceph/rgw_posix_driver, /var/lib/ceph/rgw_posix_db  (created by entrypoint)
/etc/passwd: ceph:x:167:167
```

## 8. Compatibility with S4

S4 currently builds `FROM icr.io/cpopen/ibm-ceph/rgw-standalone-rhel10:v9.9.2-27322` and
relies on the base image for `/usr/bin/rgw-standalone{,-admin}` and their libraries. S4
supplies its own `/etc/ceph/ceph.conf` and entrypoint (`docker/Dockerfile`,
`docker/entrypoint.sh`) and runs RGW as root.

| S4 requirement | Quay image | ICR image |
|---|---|---|
| `/usr/bin/rgw-standalone` + `rgw-standalone-admin` | yes | yes |
| Libraries needed by those binaries | internal to the image (Fedora 44 ABI) | internal to the image (RHEL 10 ABI) |
| `python3` for user-DB repair in `docker/entrypoint.sh` | **no** — repair block cannot run (`|| true` hides it) | yes |
| `/etc/ceph/ceph.conf` | S4 `COPY` creates it | present, replaced by S4 `COPY` |
| `/var/lib/ceph` tree | S4 entrypoint creates it | present |
| `ceph` user | not needed (S4 runs root) | present |
| Multi-arch build | amd64 only | amd64/arm64/s390x/ppc64le |
| Supported/stable Ceph | no (dev snapshot + unmerged PR) | yes (20.2.2 stable) |

Practical reading:

- **Do not swap the S4 base image** to the Quay image for a release. It is a Ceph 22 dev
  snapshot with an unmerged patch, on an unsupported-for-product Fedora base, without
  python3/entrypoint/config, and it cannot reproduce Arrow/Parquet behavior.
- **For validation only**, the Quay image can be used to exercise the long-key POSIX code
  path, provided the test supplies its own config, user and data directories (or wraps the
  image in a test entrypoint) and uses a disposable volume.
- **Production path:** wait for ceph/ceph#74184 to merge (or backport it), then rebuild the
  S4 base on the IBM Ceph 20.2.2 line and run the S4 regression suite. The patch changes
  on-disk naming for oversized keys and multipart shadow directories, so test both new
  writes and reads of existing short-key data.

## 9. Risks and limitations

- **Unmerged upstream patch.** PR #74184 is open; behavior may change before merge.
- **Development Ceph line.** Ceph main identifies as release 22 (`vampire`, `dev`), not the
  20.2.2 line S4 ships. On-disk POSIX/LMDB formats and defaults may differ in either
  direction; do not point it at production volumes.
- **No reproducible build recipe in the image.** Only the revision label and binary version
  identify the source; there is no Dockerfile or build script to rebuild it.
- **Fedora 44 base.** `SUPPORT_END=2027-05-19`; no Red Hat product support, no IBM Ceph
  repository metadata, no CVE stream for the hand-built binaries.
- **Debug binaries.** The Quay RGW binaries are unstripped (50 MB / 41 MB vs 14.5 MB /
  12.7 MB); larger image and no debuginfo separation.
- **Single architecture.** amd64 only; the ICR image covers four architectures.
- **No Arrow/Parquet.** S3 Select on Parquet is compiled out of the Quay build.
- **Snapshot in time.** Upstream state and image tags can move; digests in this report are
  the authoritative references.

## 10. Reproducing the inspection

Registry metadata (no runtime required):

```bash
ACCEPT='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'

# Quay: single manifest + config
curl -sH "Accept: $ACCEPT" \
  https://quay.io/v2/rh-ee-mszewczy/mszewczy_public/manifests/RHAI-51168-ceph-image \
  | jq .

# ICR: multi-arch index -> amd64 manifest -> config
curl -sH "Accept: $ACCEPT" \
  https://icr.io/v2/cpopen/ibm-ceph/rgw-standalone-rhel10/manifests/v9.9.2-27322 \
  | jq '.manifests[] | {digest, platform}'
```

Layer contents and package databases:

```bash
# Extract layers in manifest order (use a scratch dir; chmod between layers because
# the Fedora base ships read-only directories)
curl -sL https://quay.io/v2/rh-ee-mszewczy/mszewczy_public/blobs/sha256:<layer-digest> \
  | tar -xz -C quay-root

# Fedora rpmdb (host rpm can read it directly)
rpm --root=$PWD/quay-root -qa

# RHEL rpmdb: extract /usr/lib/sysimage/rpm and query it explicitly
rpm --dbpath=$PWD/icr-root/usr/lib/sysimage/rpm -qa
```

Version and dependency checks:

```bash
LD_LIBRARY_PATH=$PWD/quay-root/usr/local/lib/ceph-rgw:$PWD/quay-root/usr/lib64 \
  quay-root/usr/bin/rgw-standalone --version

LD_LIBRARY_PATH=$PWD/icr-libs:$PWD/icr-root/usr/lib64/ceph \
  icr-root/usr/bin/rgw-standalone --version

readelf -d quay-root/usr/bin/rgw-standalone | grep NEEDED
nm -C quay-root/usr/bin/rgw-standalone | grep -i parquet
```

Upstream provenance:

```bash
curl -s https://api.github.com/repos/ceph/ceph/commits/73d7f1d62b6ddafc5001e66fa49b125e4feaf340
curl -s https://api.github.com/repos/ceph/ceph/pulls/74184
curl -s https://raw.githubusercontent.com/ceph/ceph/main/src/ceph_release
```

## Appendix A: Quay build history

The nine history entries are reproduced in [section 3.1](#31-quay-image).

## Appendix B: ICR build history

| # | Created | Step |
|---|---|---|
| 1 | 2026-10-08T16:40:18Z | `USER root` |
| 2 | 2026-10-08T16:40:18Z | `COPY dir:bff1aa1b… in /opt/zgw-posix` |
| 3 | 2026-10-08T16:40:19Z | `WORKDIR /opt/zgw-posix/` |
| 4 | 2026-10-08T16:40:24Z | `microdnf install -y subscription-manager` |
| 5 | 2026-10-08T16:40:32Z | `subscription-manager register --activationkey=… --org=…` (build-time secrets) |
| 6 | 2026-10-08T16:41:00Z | `subscription-manager repos --enable=codeready-builder-for-rhel-10-$(arch)-rpms` |
| 7 | 2026-10-08T16:41:01Z | `rm -f /etc/yum.repos.d/ubi.repo` |
| 8 | 2026-10-08T16:41:01Z | `COPY file:73ef334f… in /etc/yum.repos.d` |
| 9 | 2026-10-08T16:41:01Z | `COPY file:813ba832… in /etc/yum.conf` |
| 10 | 2026-10-08T16:41:26Z | `microdnf install -y --enablerepo=IBM-CEPH libarrow-glib-libs libarrow` |
| 11 | 2026-10-08T16:41:27Z | `groupadd -r -g 167 ceph && useradd -r -u 167 -g ceph …` |
| 12 | 2026-10-08T16:41:32Z | `microdnf install -y --enablerepo=IBM-CEPH --setopt=install_weak_deps=0 ceph-rgw-standalone` |
| 13 | 2026-10-08T16:41:32Z | `COPY file:4f1272e1… in /etc/ceph/ceph.conf` |
| 14 | 2026-10-08T16:41:33Z | `chown ceph:ceph /etc/ceph/ceph.conf && chown -R ceph:ceph /var/lib/ceph/radosgw` |
| 15 | 2026-10-08T16:41:34Z | `mkdir -p /var/run/ceph /home/ceph/.aws && chown -R ceph:ceph …` |
| 16 | 2026-10-08T16:41:34Z | `ENV RGW_POSIX_BASE_PATH=… RGW_POSIX_DATABASE_ROOT=… HOME=/home/ceph` |
| 17 | 2026-10-08T16:41:34Z | `COPY file:40f3edfd… in /usr/local/bin/entrypoint.sh` |
| 18 | 2026-10-08T16:41:34Z | `ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]` |
| 19 | 2026-10-08T16:41:35Z | `LABEL maintainer="Daniel Gryniewicz <dang1@ibm.com>"` |
| 20 | 2026-10-08T16:41:35Z | `LABEL com.redhat.component="rgw-standalone"` |
| 21 | 2026-10-08T16:41:35Z | `LABEL version=1.0.0` |
| 22 | 2026-10-08T16:41:35Z | `LABEL name="rgw-standalone-container"` |
| 23 | 2026-10-08T16:41:35Z | `LABEL description="IBM Storage Ceph Object Gateway Developer Edition"` |
| 24 | 2026-10-08T16:41:35Z | `LABEL summary="rgw-standalone-container for IBM Ceph Storage"` |
| 25 | 2026-10-08T16:41:36Z | `LABEL io.k8s.display-name="rgw-standalone-container"` |
| 26 | 2026-10-08T16:41:36Z | `LABEL io.openshift.tags="ibm ceph rgw-standalone-container"` |
| 27 | 2026-10-08T16:41:41Z | `LABEL "release"="9-20261008161717"` |
