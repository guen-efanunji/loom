# Publishing Loom on `loomworkspace.bond`

This runbook covers the two things a visitor needs from the public domain:

1. `https://loomworkspace.bond/` — the product site and documentation.
2. `https://loomworkspace.bond/install.sh` and `/install.ps1` — the one-line installers, which must always resolve to the current committed script and to a published GitHub release.

Everything is driven by `.github/workflows/cloudflare-pages.yml` plus `scripts/cloudflare-setup.ts`. The setup script is idempotent, so CI and a local run do the same thing.

## One-time account setup

1. The domain is registered at NicNames and its nameservers already point at Cloudflare (`brad`/`mona.ns.cloudflare.com`). The zone must live in the **same Cloudflare account** that hosts the Pages project, otherwise Pages cannot manage the apex record.
2. Create an API token at <https://dash.cloudflare.com/profile/api-tokens> with:
   - Account · Cloudflare Pages · **Edit**
   - Zone · DNS · **Edit**
   - Zone · Zone · **Read**
   - Zone · Cache Purge · **Edit** (optional, avoids a warning during the switch)
3. Add two repository secrets (`Settings → Secrets and variables → Actions`):

   ```bash
   gh secret set CLOUDFLARE_API_TOKEN --repo guen-efanunji/loom      # paste the token
   gh secret set CLOUDFLARE_ACCOUNT_ID --repo guen-efanunji/loom      # 32-char account id
   ```

4. Run the setup locally once. The parked apex record has to go before Pages can own the domain:

   ```bash
   export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
   bun run domain:prepare                  # token, zone and Pages project only
   bun run domain:setup -- --fix-dns       # attach the domain, purge cache, verify URLs
   ```

   `--dry-run` prints the same plan without writing anything, `--fix-dns` deletes apex `A`/`AAAA`/`CNAME` records that do not point at `*.pages.dev`, and `--create-zone` adds the zone if the domain was never imported into Cloudflare.

## Every deploy

`cloudflare-pages.yml` runs on pushes that touch the site, the installers, the distribution contract or the workflow itself. It

1. fails early with a clear message if either Cloudflare secret is missing,
2. checks the zone and creates the Pages project `loomworkspace` if it does not exist,
3. copies `install.sh` and `install.ps1` into `apps/site/static/` so the published installers are the ones from the same commit,
4. builds the static site with `PUBLIC_INSTALL_BASE=https://loomworkspace.bond`,
5. deploys to Pages production (`main`),
6. attaches `loomworkspace.bond` to the project and purges the edge cache for `/`, `/install.sh` and `/install.ps1`,
7. diffs `https://loomworkspace.bond/install.sh` against `install.sh` in the commit, which catches a stale deployment or a lingering parking page.

`workflow_dispatch` inputs: **Only wire and verify the domain** skips the build and re-runs steps 1–2 and 6–7; **Delete parked apex DNS records that block the Pages domain** adds `--fix-dns`.

## Making an install actually succeed

The installers download release assets, so a device can only install when a release exists. `channel-stable/manifest.json` and `channel-stable/version.txt` are the pointers they read.

```bash
git tag v0.1.0 && git push origin v0.1.0
gh workflow run "Release binaries" --repo guen-efanunji/loom -f tag=v0.1.0
gh run watch --repo guen-efanunji/loom                      # builds 5 platforms, then publishes
```

Later releases go through `Version release` (release-please), which calls the same `release.yml`. Verify the published contract from a clean machine:

```bash
curl -fsSI https://loomworkspace.bond/install.sh | grep -i content-type   # text/plain
curl -fsSL https://loomworkspace.bond/install.sh | sh                    # real install on a clean device
LOOM_HOME=/tmp/loom-check sh -c 'curl -fsSL https://loomworkspace.bond/install.sh | sh'   # throwaway check
```

An existing installation is never overwritten by the installer; use `loom update` for that, which keeps the rollback path.

`scripts/test-installer.ts` (also `bun run installer:test`) runs the installer end to end against fixture release files with a fake `curl`, so the log, the checksum rejection and the PATH step stay covered without network access.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `/install.sh` returns HTML | The apex record still points at the registrar parking page. Run `bun run domain:setup -- --fix-dns`, then purge (`Cloudflare → Caching → Purge → Custom`). |
| Pages reports the domain is already in use | Another record or app owns the apex name. Remove it in the zone's DNS list, then re-run the setup. |
| `The zone does not belong to this account` | The domain was added under a different Cloudflare account. Use that account's id, or move the zone. |
| Installer says no published release | No `channel-stable` pointer exists yet. Run the release workflow above. |
| Certificate not issued on the apex | Wait for Pages to provision it; the domain status stays `Initializing` in Pages settings until DNS resolves to `*.pages.dev`. |

## Local state to keep in sync

`LOOM_DOMAIN`, `LOOM_PAGES_PROJECT` and `LOOM_PAGES_BRANCH` are read by the setup script and set as workflow-level `env`. The same names appear in `apps/site/src/lib/config.ts` through `PUBLIC_INSTALL_BASE`; changing the domain means updating both places and re-running this workflow.
