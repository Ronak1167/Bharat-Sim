# Isolated Android worker: open-source design decision

**Status:** Architecture decision and implementation checklist. This document does not claim that a production worker host has been provisioned or that APK execution is enabled.

## Decision

Use a **disposable KVM-backed Firecracker microVM per customer job** as the production trust boundary. Keep the existing Python polling worker and Android emulator inside the guest. The API remains the control plane; it must never execute uploaded APKs inside its own Vercel function/container.

Firecracker is selected over a plain Docker container because uploaded APKs are untrusted code and the current worker performs installation, launch, ADB and Appium operations. Firecracker provides a hardware-virtualization boundary and recommends its `jailer`, seccomp, namespaces, cgroups and privilege dropping for production. The guest still requires strict egress filtering: Firecracker explicitly does not filter guest network traffic.

### Open-source references

- [Firecracker design and threat containment](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md) — microVM isolation, KVM, I/O boundaries, and host-level egress filtering.
- [Firecracker production host setup](https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md) — production hardening, jailer, cgroups, memory and CPU limits.
- [Firecracker jailer](https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md) — chroot, namespace, resource-limit and privilege-drop behavior.
- [gVisor security model](https://gvisor.dev/docs/architecture_guide/security/) — useful defense-in-depth for containerized helper services; not a replacement for the selected VM boundary.
- [Appium documentation](https://appium.io/docs/en/latest/) — existing open-source Android UI automation stack.
- [Android application sandbox](https://source.android.com/docs/security/app-sandbox) — Android's per-app UID/process isolation; it does not isolate an uploaded APK from the worker host.

## Security advisory and version floor

Before provisioning any worker host, select a currently supported Firecracker release and pin the exact VMM and matching jailer binaries by version and checksum. **Do not deploy Firecracker v1.13.1 or earlier, or v1.14.0**: AWS disclosed CVE-2026-1386, an arbitrary host-file-overwrite issue in the jailer under certain symlink conditions. The published fixed versions are v1.13.2 and v1.14.1. Prefer a newer supported patched release after checking upstream advisories; verify that the jailer and statically linked Firecracker binary are from the same release. Keep the jailer directory root-owned and inaccessible to untrusted users (for example, mode 0700), and ensure all jailer input paths and parents are trusted and non-writable by unprivileged users.

- [AWS security bulletin: CVE-2026-1386 and fixed versions](https://aws.amazon.com/security/security-bulletins/2026-003-AWS/)
- [Firecracker production host setup](https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md)
- [Firecracker jailer trust and path requirements](https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md)

This is a deployment acceptance requirement, not a claim that BharatSim currently runs Firecracker. No worker host has yet been provisioned.

## Target job lifecycle

1. API authenticates the user, checks quota, validates APK metadata and creates a tenant-owned run.
2. APK bytes are written to the private Supabase Storage bucket under a server-generated object key. The API records SHA-256, byte length and content metadata.
3. Scheduler leases one run to a worker controller. The lease is short-lived, tenant/run scoped and single-use for the job.
4. Controller creates a fresh microVM from a read-only, versioned golden image. No customer-to-customer VM reuse.
5. Guest obtains a narrowly scoped, short-lived job capability over a mutually authenticated control channel. It receives only the leased APK and job configuration.
6. Guest verifies SHA-256 before installing the APK. ADB, emulator and Appium run only inside the guest.
7. Guest uploads bounded logs, screenshots and a structured result through the authenticated callback. The API validates lease, run, owner, size limits and hashes before persisting.
8. Controller destroys the VM, disks, snapshots, temporary credentials and network namespace even on timeout or crash. Cleanup is verified by the controller, not trusted to guest code.

## Mandatory host controls

- Hardware virtualization enabled; patched host kernel and microcode.
- Firecracker release binary and matching `jailer`; production seccomp defaults enabled. Never use `--no-seccomp` or debug binaries.
- Dedicated unprivileged Firecracker UID/GID, root-owned non-writable jailer paths, separate cgroup per VM.
- Per-job hard CPU, memory, disk, process, file-descriptor and wall-clock limits; enforce at the host/VM boundary.
- No Docker socket, host filesystem mounts, host credentials, cloud metadata access, host control socket or shared ADB port inside the guest.
- Guest network attached to a host-controlled egress proxy. Default deny; allow only the control-plane endpoints and explicit public test destinations. Reject loopback, RFC1918, link-local, IPv6 ULA, IPv4-mapped IPv6, metadata IPs, internal DNS names and redirects to blocked destinations. Resolve and validate every DNS answer at connection time to mitigate rebinding.
- Do not give the guest a general cloud credential or broad Supabase key. Use short-lived, run-scoped upload/download capabilities.
- Host watchdog kills stuck VMMs and guest processes. A timeout is terminal; it must not leave a worker lease or emulator running.
- Emit host-side audit events for VM create/start/stop/destroy, policy version, image digest, resource limit profile and cleanup outcome.

## Network policy design

The guest cannot choose its own unrestricted route. Put a host-owned proxy/firewall between its TAP interface and the internet. The controller owns policy and DNS resolution. The guest may access:
- the BharatSim API control endpoint needed for lease/heartbeat/callback; and
- explicitly configured test destinations that pass the public-address and policy checks.

Never allow access to the Vercel management plane, Supabase database port, cloud metadata, private subnets, host gateway administration ports, or other tenant VMs. Do not treat a hostname allowlist alone as sufficient: validate resolved addresses and the final socket destination.

If arbitrary-app internet access is a product requirement, provide it through the constrained proxy and record the effective destination, bytes, duration and policy decision. If a destination is blocked, report it as a policy restriction, not as an app crash.

## Resource profile (initial conservative baseline)

These are starting limits to benchmark, not proven capacity commitments:
- 4 vCPU and 8–12 GiB guest RAM per active Android emulator job.
- 30 GiB ephemeral disk, with a hard quota.
- 20-minute default job wall-clock limit, configurable only within an operator maximum.
- Bounded logcat, screenshots, Appium output and callback payloads.
- One active customer APK per microVM; destroy after every run.

Benchmark actual emulator image requirements before committing a host density or customer-facing SLA.

## Implementation phases

### Phase A — host prototype (not yet done)
- Provision a dedicated Linux x86_64 host with KVM; verify `/dev/kvm` and hardware virtualization.
- Install a pinned Firecracker release and matching jailer; verify checksums/signatures.
- Build a minimal Ubuntu 24.04 guest image with Android SDK/emulator, Appium and the BharatSim worker.
- Add TAP networking, host firewall, DNS policy proxy, cgroup quotas and a watchdog.
- Run malicious-network tests from inside the guest: metadata, localhost, private IPv4/IPv6, DNS rebinding, redirects, alternate encodings and IPv4-mapped IPv6 must all be denied.
- Run repeated create → execute fixture → collect → destroy cycles; prove cleanup after forced VMM kill, guest crash and controller restart.

### Phase B — control-plane integration (not yet done)
- Add a worker-controller adapter that creates/destroys microVMs and reports attested host policy state.
- Issue per-run, expiring credentials; do not distribute the API worker token or Supabase secret to the guest.
- Add idempotent cleanup/reconciliation for orphaned VMs and leases.
- Persist reports/artifacts in private Storage with owner-scoped metadata, retention and deletion.
- Add tests for duplicate callbacks, stale leases, expired credentials, cross-tenant object access and API restart during an active run.

### Phase C — production acceptance (not yet done)
- Independently review host configuration and network policy.
- Execute clean, crash, ANR, timeout, malicious-egress and worker-crash fixtures.
- Verify no guest can reach another guest, the host, private services or metadata.
- Verify VM destruction and storage cleanup after every terminal path.
- Deploy the API with production database and server-only Storage credentials; validate Auth, upload, lease, callback and report retrieval against the real project.
- Enable the three production worker flags only after signed-off evidence exists. Until then they must remain false.

## Why not use a plain container?

A container shares the host kernel. Namespaces, seccomp, cgroups and AppArmor are valuable defense-in-depth, but a container alone is not the isolation boundary selected for hostile customer APKs. gVisor can reduce host system-call exposure for auxiliary services; it is not a substitute for a separately controlled VM for the Android execution worker.

## Release rule

A READY Vercel deployment, green unit tests, a successful CI emulator fixture, or a worker heartbeat does not prove production isolation. Public APK execution remains disabled until Phases A–C are completed and the evidence is attached to the exact production release commit.
