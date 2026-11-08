# App update compatibility

An app update pauses Prism until `/prism repair` approves the newly installed package. Repair discovers the registered official x64 app, hashes its executable and archive, and accepts either the shipped verified baseline or an exact locally approved fingerprint.

For an unfamiliar fingerprint, repair launches an owned isolated app profile and checks package metadata, the reviewed profile-isolation mechanism, actual process identity, loopback listener ownership, renderer readiness, wallpaper visibility, settings changes, restoration, unchanged installed files, and listener shutdown. The active helper is stopped only after this preflight passes. A failed check does not replace its manifest or preferences.

Passing proofs are stored in `state/builds.json`, capped at sixteen entries and tied to the current renderer contract. Package version, executable path, and both hashes must match. The worker still verifies the installation at startup and pauses on a package change. Each app version receives its own short executable junction directly under the installation root, avoiding a stale link to the old package. Ordinary startup checks that the alias plus debugging flag fits within the original executable-token length.

Implementation version 4 fixes a version-3 regression: the extra `links` directory made the alias exceed the ordinary startup buffer. Existing prepared app views had concealed that problem during the version-3 upgrade check. Native activation logs exposed it on subsequent normal launches. The shortened alias preserves version separation without the extra directory; old junctions are retained. Already-running unprepared app processes still need one full quit and reopen after this fix.

The current installed package passed the forced isolated probe. Unit tests reject changed package versions, changed hashes, outdated approval contracts, and incomplete proofs. A newer app release is not available in this environment: actual cross-release acceptance remains unverified. The check deliberately fails when the isolation mechanism or supported app layout changes; future structural changes may require a Prism code update.

Local probe artifacts are recorded in `docs/evidence/update-compatibility.json`. Use `install.ps1 -Upgrade -CheckBuild` for an explicit fresh probe even for a previously approved build. Normal `/prism repair` reuses an exact approval.
