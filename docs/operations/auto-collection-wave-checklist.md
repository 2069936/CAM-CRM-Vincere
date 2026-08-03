# Auto-collection production wave checklist

Use one copy per rollout wave. This template contains no live approval and does
not authorize production installation by itself.

| Field | Private value/reference |
|---|---|
| Wave record | `________________` |
| Wave number | `0 / 1 / 2 / _____` |
| Signed collector version | `________________` |
| Release-manifest SHA-256 | `________________` |
| Planned device count | `________________` |
| Same-day rollback capacity | `________________` |

## Release freeze

- [ ] The release checklist is fully approved for this exact commit, version,
      artifact hashes, signer, and release manifest.
- [ ] The immutable release path contains the EXE, both MSIs, manifest, and CMS
      signature; none will be replaced during the wave.
- [ ] Staging E2E/load and the shadow pilot meet their required thresholds.
- [ ] Manual four-CSV upload is available for every device in the wave.
- [ ] Wave size does not exceed what the named support owner can revert the
      same day. Wave 0 is the pilot; later waves contain 10–20 VPSs.
- [ ] Device selection spans representative CAMs/providers without creating a
      single operational failure domain.

## Per-device enrollment

For each opaque private VPS reference:

- [ ] Correct client Profile independently confirmed.
- [ ] Fresh one-time enrollment code generated immediately before installation.
- [ ] Pinned installer downloaded from Profile and signer/hash verified.
- [ ] Returned client name matches the intended Profile.
- [ ] NinjaTrader restarted; all-four-section test capture is green.
- [ ] Manager shows heartbeat, signed version, New York schedule, queue health,
      and enrollment audit event.
- [ ] Operator knows manual fallback, diagnostics, and private support contact.

| Installation aggregate | Count |
|---|---:|
| Installed / expected devices | `_____ / _____` |
| Failed installations with owned disposition | `_____` |

## Daily hold gate

Each wave remains fixed for at least two successful trading days.

| Aggregate status | Day 1 | Day 2 | Additional day |
|---|---:|---:|---:|
| Expected devices | `___` | `___` | `___` |
| Received | `___` | `___` | `___` |
| Incomplete/failed | `___` | `___` | `___` |
| Late/offline | `___` | `___` | `___` |
| Duplicate retries | `___` | `___` | `___` |
| Unique normalized captures | `___` | `___` | `___` |
| Unexplained items | `___` | `___` | `___` |
| Daily audit equals Manager | `___` | `___` | `___` |

- [ ] Every miss, late batch, incomplete section, and retry has an owner and
      disposition before expansion.
- [ ] No accepted duplicate created another raw object or normalized day.
- [ ] Gross fallback counts were reviewed without exposing P&L values.
- [ ] No device routed to another client and no revoked device uploaded.

## Stop and rollback

Stop the wave on cross-client routing, token/secret exposure, unsigned or
tampered update, systematic P&L mismatch, duplicate normalization, missing
acknowledged data, or possible data loss.

Rollback order:

1. Pause new enrollments and set the release download unavailable if needed.
2. Revoke only affected device credentials; retain immutable batches, queue,
   audit, and diagnostics evidence.
3. Restore the prior approved package or uninstall Vincere-owned components.
4. Resume manual four-CSV collection and CRM review.
5. Investigate and publish a new version/hash; never replace bits beneath the
   failed version.

## Expansion decision

- [ ] Two or more successful trading days completed on the frozen version.
- [ ] Acceptance thresholds remain satisfied and unexplained item count is zero.
- [ ] Operations confirms capacity to install and revert the next wave.
- [ ] Engineering, CRM owner, and operations approve expansion privately.

| Decision | Private reference |
|---|---|
| `EXPAND / HOLD / ROLLBACK` | `________________` |
