# Unbacked secrets: design

Date: 2026-11-09. Status: approved. The implementation plan (`docs/superpowers/plans/2026-11-09-unbacked-secrets.md`) changes four things after reading the code: secrets is its own on-demand scan rather than part of the clutter scan; saving runs in a controller rather than `apply.js`; Fix all integration is deferred; and the MCP refusal is enforced in the engine.

## Goal

Flag dev secrets that exist only on this machine, so a lost or wiped disk doesn't take them with it. The user links a password manager CLI once in Settings, and GutCheck backs up the flagged files there, following its usual plan, preview, apply flow.

**What the user said:**
- Look for any key or secret related to dev repos and workspaces, inside or outside them.
- Decide what is backed up from a local record, plus an on-demand "Verify with vault".
- Support Proton Pass, 1Password, Bitwarden, KeePassXC and pass/gopass.

**Out of scope:**
- Google Password Manager. It has no CLI and no write API, so the Settings panel says so instead of offering it.
- Restoring from the vault. Each manager's own app or CLI already does this. GutCheck shows the item title so the user can find it.
- Syncing or rotating secrets, and reading values out of a vault.
- Backing up secrets that are committed to git. `env-tracked` already treats these as an error that needs rotating, not saving.

## Rules this must keep (from AGENTS.md)

- **Scans stay read-only.** A scan only reads metadata and hashes files. It never calls a vault CLI.
- **Contents stay out of everything GutCheck shows or stores.** No findings, reports, plans, previews, logs, the audit file or the backup record ever hold secret contents. Paths, sizes, hashes (in the record only) and item titles are fine.
- **Saving goes plan, preview, apply.** Nothing deletes or moves the local file.
- **New modules stay under 400 lines.** Each new rule's source goes in `docs/sources.md`.

## 1. Finding secrets: `src/secrets.js`

**What counts as a secret:**
- **Repo files** are git-ignored or untracked, not committed. The names come from `actions.js`'s `SECRET_NAME`, moved into `secrets.js` and shared by both: `.env*` (except templates: `.example`, `.sample`, `.template`, `.dist`, `.defaults`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `id_rsa|dsa|ecdsa|ed25519`, `.netrc`, `.pgpass`. The list also adds `credentials.json`, `service-account*.json`, `*-credentials.json`, `client_secret*.json`, `key.properties` (Android signing) and `*.mobileprovision`.
- **Files never flagged:** `*.pub`; anything under `node_modules`, `.git`, `vendor`, or the folders `clutter.js` never enters (`NO_DESCEND`); files over 1 MB, since a secret is never that large and big files are usually fixtures or bundles.
- **Fixture keys** under `test/`, `tests/`, `testdata/`, `fixtures/` or `__fixtures__/` are reported at `low` confidence in a separate "Probably test keys" group. They don't count toward the finding's severity.
- **Workspace root:** loose `.env*` files, reusing `workspaceAdvice`'s list.
- **Home folder** (dev credentials only, at fixed paths):
  - `~/.ssh/*`: only files whose first line is a `-----BEGIN … PRIVATE KEY-----` header. GutCheck reads that header line and, for OpenSSH keys, the unencrypted public part used for the fingerprint (§5a), and nothing more.
  - `~/.npmrc`: only when it has a line with `_authToken` or `_auth`. The match runs line by line in memory and nothing is kept.
  - `~/.pypirc`, `~/.cargo/credentials` and `~/.cargo/credentials.toml`, `~/.netrc`, `~/.pgpass`, `~/.git-credentials`.
  - `~/.docker/config.json`: only when `auths` has an entry with an `auth` key.
  - `~/.aws/credentials`, `~/.config/gcloud/application_default_credentials.json`, `~/.kube/config`, `~/.android/*.keystore` / `*.jks`, `~/.gnupg/private-keys-v1.d/` (one entry for the folder, flagged when it isn't empty).
  - Respects `XDG_CONFIG_HOME`.

**How each file gets its status:** `<dataDir>/secret-backups.json` (the record, see §3) is keyed by absolute path, and each file gets one of these:
- `unbacked`: there is no record entry for the path.
- `changed`: there is an entry, but its `sha256` differs from the file now.
- `backed`: the entry's hash matches.
- `skipped`: the user chose "Don't back up" with a reason (a throwaway dev key, say).
- `missing`: Verify found the vault item gone. It is treated like `unbacked` and the finding says so.
- `mismatch`: an SSH key item's fingerprint in the vault differs from the local key's (§5a). It is treated like `unbacked`.

Copies count once: when a file's hash matches any backed entry, it is shown as `backed (same as <other path>)`.

**Findings:**
- `secret-unbacked` (warn) on each repo, plus one `ws-secret-unbacked` (warn) for the workspace root and home files: "3 secret files exist only on this machine", with the paths listed.
- `secret-changed` (info): "changed since its last backup".
- Both carry `fix: { type: 'secret-backup', paths }` when a vault is linked. When none is linked, the fix opens the Settings panel.
- A whole finding can be ignored the usual way (`policy.js`). Per-file skips live in the record.

**Cost:** hashing uses streamed SHA-256, and files have to be 1 MB or less. Home checks are a fixed list of `stat` calls. The repo walk reuses the file list `clutter.js` already collects, so the tree isn't walked a second time; `scanClutter` gains a `secrets` array in its result.

## 2. Linking a password manager: `src/vault.js` and `src/vault-adapters.js`

**Setting** (in `settings.json`):
```json
"vault": { "tool": "proton", "target": "Dev secrets" }
```
`tool` is one of `proton`, `1password`, `bitwarden`, `keepassxc`, `pass`, `gopass`. What `target` means depends on the tool:
- Proton: vault name
- 1Password: vault name
- Bitwarden: folder name (optional)
- KeePassXC: path to the `.kdbx` file plus a group
- pass/gopass: subfolder (default `gutcheck/`)

**Each adapter has the same shape:**
```js
{ id, label, bin, available(env), status(ctx) -> { ok, locked, hint },
  planSave(file, title, target) -> { cmd, args, encode(buffer) -> stdinBytes, parseId(stdout) | lookupId(ctx) },
  exists(ctx, itemId, target) -> { ok, exists } }
```
- `planSave` never puts content in `args`.
- `apply.js` reads the file into memory once and hands the adapter that buffer, which `encode(buffer)` turns into the bytes written to stdin: the raw file, or the item JSON / base64 that some tools need. No adapter re-reads the file by path (see §5).

**Settings panel:**
- Lists only the CLIs found on `PATH`, plus a disabled Google entry with the reason.
- "Test connection" runs `status()` and shows signed in, locked (with the unlock hint) or not found.
- No master passwords, session tokens or API keys are ever typed into GutCheck. The tool's own session is used (`BW_SESSION` from the environment, 1Password's desktop app integration or `op signin`, Proton's `pass-cli login`, gpg-agent, or KeePassXC's key file or interactive prompt).

**Before every run:** `which`-style resolution checks that the binary is a real executable on `PATH`, not inside a scanned repo, which is the same check `agent-context.js` uses.

## 3. Backup action and record

**`secret-backup` plan** (built in `actions-secrets.js`, so `actions.js` stays under 400 lines):
- For each path, it re-derives the file list from a fresh `secrets.js` check. It never trusts the caller's list, the same rule `agent-tidy.js` follows.
- Steps per file:
  - A `check` step: the file's sha256 still equals the one the plan was built with.
  - A `vault-save` step `{ tool, title, path, sha256, cmd, args }`. The preview shows `pass-cli item create note --vault-name "Dev secrets" --from-template -  ← contents of .env (412 bytes)`.
- Item title: `gutcheck: <repo-name>/<rel-path>`, `gutcheck: ~/<rel-to-home>`, or `gutcheck: workspace/<name>`.
- The item's note field also records the host name and the absolute path, so the user knows where it came from. This is metadata, not the secret.
- Risk is `caution`, and the note reads: "Copies the file's contents into <tool> (<target>). The local file is not changed."

**`vault-save` step in `apply.js`:**
1. Run `lstat`. Refuse symlinks, and refuse a file that has grown over 1 MB.
2. Read the file into a buffer once, hash the buffer, and stop if the hash differs from the planned one.
3. Run the CLI with `encode(buffer)` on stdin (`ctx.run(cmd, args, { input })`; `exec.run` already supports `input`).
4. Read the item ID with `parseId(stdout)`. Without an ID the step fails: nothing is recorded, and stdout is not echoed because it might contain the item. Only the CLI's exit code and stderr are shown, cut to 300 characters, after any line that contains the file's text is removed.
5. Write the record entry. Results and the audit log get only `{ title, tool, ok }`.

**Record:** `<dataDir>/secret-backups.json`, mode 0600, written atomically (temp file then rename, like `settings.js`):
```json
{ "version": 1, "entries": { "/abs/path/.env": { "sha256": "…", "tool": "proton", "target": "Dev secrets", "itemId": "…", "title": "gutcheck: api/.env", "at": "2026-11-09T…Z" } },
  "skipped": { "/abs/path/test.key": { "reason": "throwaway local key", "at": "…" } } }
```
Hashes of short secrets could in theory be brute-forced. The file is 0600 in the user's own data folder next to `settings.json`, and it holds nothing a local attacker couldn't read from the secrets themselves, so this is acceptable. `docs/sources.md` says so.

**Verify with vault:** a read-only action that calls `exists()` for each entry, one CLI call per item (Proton and Bitwarden can list all items in a single call). Entries whose item is gone get `missing: true`. A locked vault returns the unlock hint and changes nothing.

**Don't back up:** this writes a `skipped` entry with the user's reason. The UI can remove it again.

## 4. Where it shows up

- **App:**
  - A "Secrets" card in the workspace overview, showing counts by status, buttons for "Back up all", "Verify with vault" and "Settings", and a per-file list with "Back up" and "Don't back up".
  - Repo findings appear in the repo view as usual, and Fix all includes `secret-backup` as a step after the `.gitignore` steps.
  - Renderer code goes in a new `renderer/secrets-view.js` loaded by `index.html`, and `test/helpers/dom.js` loads it in the same order.
- **CLI:**
  - `gutcheck secrets` lists files and statuses: paths only.
  - `gutcheck secrets --backup [--yes]` plans, prints the preview and applies once the user confirms.
  - `gutcheck secrets --verify` runs Verify with vault.
- **MCP:**
  - Findings appear in `gutcheck_findings` and `gutcheck_overview`.
  - `gutcheck_plan` and `gutcheck_apply` refuse `secret-backup` and `vault-verify` even with `--allow-actions`. The error says: "Backing up secrets runs only from the GutCheck app or CLI."
  - `engine.js` enforces this through a `via === 'mcp'` deny list, not just the tool description.

## 5. Adapters: exact commands

These commands are taken from the installed `pass-cli` 2.7.0 (`--help`) and from each tool's official docs as of 2026-11-09:
- [1Password CLI reference](https://www.1password.dev/cli/reference/)
- [Bitwarden CLI](https://bitwarden.com/help/cli/)
- [keepassxc-cli man page](https://github.com/keepassxreboot/keepassxc/blob/develop/docs/man/keepassxc-cli.1.adoc)
- [pass](https://git.zx2c4.com/password-store/about/)
- [gopass insert](https://github.com/gopasspw/gopass/blob/master/docs/commands/insert.md) and [gopass list](https://github.com/gopasspw/gopass/blob/master/docs/commands/list.md)
- [Proton Pass CLI](https://protonpass.github.io/pass-cli/)

**Read once, hash, send the same bytes.** `vault-save` reads the file into memory once, hashes that buffer, compares it with the planned hash and pipes the same buffer to the CLI. Because no adapter is handed a path to re-read, the bytes saved are exactly the bytes hashed. When a tool takes JSON on stdin, GutCheck builds the JSON in Node, so there is no `jq` dependency and the content never touches argv.

| Tool | Status check | Save (content on stdin only) | Item ID | Exists? (prints no content) | Target |
| --- | --- | --- | --- | --- | --- |
| Proton `pass-cli` | `info --output json`: logged in when it parses and has `id` | `item create note --vault-name <V> --from-template -` with stdin `{"title","note","extra_fields":[]}`. `note` holds the file text; binary files are base64 with a `base64:` first line | stdout is just the new item ID (confirmed live) | `item list --vault-name <V> --filter-state active --output json` (no `--show-secrets`; `items[]` carries only `id`, `title`, `item_type`, `state`, times), then look for `id`. Don't use `item view`/`debug` exit codes for this: a missing ID returns `400 Bad Request` with exit 1, the same as a network error | `--vault-name` |
| 1Password `op` | `op whoami --format json`: a non-zero exit means signed out | `op document create - --title <T> --file-name <name> --vault <V> --tags gutcheck --format json`, with the file on stdin. A document keeps binaries as they are | The JSON reply's `uuid` (or `id`) | `op item get <id> --vault <V> --fields label=title --format json` (no `--reveal`) | `--vault` |
| Bitwarden `bw` | `bw status`: JSON `status` is `unlocked`, `locked` or `unauthenticated` | `bw create item` with **no argument** and stdin = base64 of the item JSON (`type: 2`, `secureNote: {type: 0}`, `name`, `notes`, optional `folderId`). The docs' examples pipe `bw encode` into `bw create`. The plan refuses notes over 10,000 characters | The JSON reply's `id` | `bw list items --folderid <id>`, then only `.id` is read from the parsed JSON (`notes` is dropped right after parsing and never logged); run `bw sync` first | `folderId` in JSON (folder resolved by name with `bw list folders`) |
| KeePassXC `keepassxc-cli` | `keepassxc-cli ls --no-password -k <keyfile> <db>` exits 0 | `add --no-password -k <keyfile> <db> <Group/Title>`, then `attachment-import … <db> <Group/Title> <name> /dev/stdin` with the file on stdin | Entry path `Group/Title` (no IDs) | `ls -R -f … <db> <Group>`, then look for the title | DB path plus group |
| pass | `PASSWORD_STORE_DIR` (or `~/.password-store`) has a `.gpg-id` | `pass insert -m -f gutcheck/<name>` with the file on stdin (binaries base64 as for Proton) | Entry name | `<store>/<name>.gpg` exists (pure `fs`; `pass show` would decrypt) | Subfolder |
| gopass | `gopass ls --flat` exits 0 | `gopass insert -f gutcheck/<name>` with the file on stdin (not `--multiline`, which opens `$EDITOR`) | Entry name | `gopass ls --flat`, then look for the line | Subfolder |

**Decisions this forces:**
- **KeePassXC needs a key-file-only database** (`--no-password -k`, optionally with a YubiKey). GutCheck never handles a master password, and the docs don't describe a way to pass one securely. With a password-protected DB, Test connection explains this and the adapter stays off.
- **Proton:** SSH private keys go in as SSH key items (see §5a). Every other file goes in as a note.
- **Changed files:** a new item is created and the record points to it. The old item stays in the vault as history. GutCheck never deletes vault items.

**Spike before writing each adapter** (implementation step 1; the plan stops if one fails):

| Question | How to settle it | If it fails |
| --- | --- | --- |
| ~~Does `pass-cli` print the new ID?~~ | **Settled 2026-11-09 (live):** `item create note` and `ssh-key import` both print only the item ID on stdout, and `vault create` prints the share ID | n/a |
| ~~Does an imported Proton SSH key round-trip?~~ | **Settled 2026-11-09 (live, throwaway vault, deleted afterwards):** see §5a "Round-trip result" | n/a |
| Do the 1Password `SSH Key` category and Bitwarden `type: 5` accept a key on stdin? | Read the source and recorded output; live only if the user has that tool | Document / secure note (table above) |
| Does `bw create item` read stdin with no argument? | Read the CLI source, `apps/cli/src/commands/create.command.ts` | Disable Bitwarden: putting the encoded JSON in argv would expose the secret |
| Does `keepassxc-cli attachment-import` accept `/dev/stdin`? | Read the CLI source (`src/cli/AttachmentImport.cpp`) | Use a 0600 temp file in a 0700 temp dir, deleted in `finally` |
| Exit codes for signed-out `op whoami` / `pass-cli info`, and for a missing item | Read the source, or record real output | Treat any non-zero exit or unparseable output as "not signed in", and show stderr cut to 300 characters |

**Labels in Settings:** only Proton can be tried live on the dev machine. The other adapters are tested with recorded output and marked "untested with a live vault" in Settings until a user confirms one works.

## 5a. SSH private keys

A password manager's SSH key item fits better than a note. The manager knows it's a key, shows its fingerprint, and can serve it through its own SSH agent, so a lost laptop means installing the agent rather than restoring files.

**Which files are SSH keys** (GutCheck reads only the first line):
- `-----BEGIN OPENSSH PRIVATE KEY-----` anywhere.
- `-----BEGIN (RSA|EC|DSA) PRIVATE KEY-----` only when the file is in `~/.ssh` or named `id_*`.
- Everything else, such as TLS keys (`server.key`, `*.pem`, PKCS#8 `BEGIN PRIVATE KEY`), stays a note or document, so a TLS key is never filed as an SSH key.

**Fingerprint without reading the secret:**
- **OpenSSH format:** the public key blob sits unencrypted near the start of the file, even for passphrase-protected keys. `secrets.js` decodes that header in pure Node (`openssh-key-v1\0`, cipher, kdf, kdf options, key count, public key blob) and computes `SHA256:<base64>`, the same value `ssh-keygen -l` prints. It doesn't decrypt anything and runs no program.
- **Other formats:** the fingerprint is taken from the `.pub` file beside the key if there is one, and left empty otherwise.

The record stores `fingerprint` beside `sha256`. Findings and the UI may show the fingerprint, which is public, and the key's type (ed25519, rsa, …).

**Proton (confirmed on 2026-11-09 against `pass-cli` 2.7.0, using a vault that doesn't exist so nothing was created):**
- **Save:** `pass-cli item create ssh-key import --from-private-key /dev/stdin --title <T> --vault-name <V>`, with the buffer on stdin. A valid key piped this way got through parsing and reached the vault lookup. Garbage input failed locally with `Failed to parse SSH private key` before any network call. So the "send the same bytes" rule holds and no temp file is needed.
- **Passphrase-protected keys:** imported without `--password`. `pass-cli` warns `The key will be stored encrypted` and stores the key as it is. GutCheck never asks for or sets passphrases. Proton's agent skips such keys unless the item has a Hidden field named "Passphrase" ([ssh-agent docs](https://protonpass.github.io/pass-cli/commands/ssh-agent/)), so the step's result says: "Backed up encrypted. To use it with Proton's SSH agent, add a Hidden field named Passphrase to the item in Proton Pass."
- **Verify** takes two steps:
  1. Existence comes from `item list` (§5).
  2. For an item that exists, `pass-cli ssh-agent debug --vault-name <V> --item-id <id> --output json` returns `valid_keys[]` with `title`, `algorithm`, `key_size` (RSA) and `fingerprint`, and no key material. Verify compares that fingerprint with the record's. A different one is `mismatch`, treated like `missing`.
  - An encrypted key comes back under `invalid_items[]` with the reason `SSH key is encrypted but no passphrase found in custom fields` and no fingerprint. For those, Verify checks existence only and shows the reason as a hint.
- **Item ID:** stdout of `ssh-key import`.

**Round-trip result** (live, 2026-11-09, `pass-cli` 2.7.0; a throwaway vault, deleted afterwards). Keys tested: an ed25519 key, a passphrase-protected ed25519 key, and a PEM RSA-2048 key, plus a `.env`-style note with no trailing newline.
- `item view --output json` returns `item.content.content.SshKey.private_key` and `.public_key`, and `item.content.note` for notes.
- **Private keys:** all three came back byte-identical (411, 444 and 1679 bytes). Fingerprints match `ssh-keygen -lf`; the encrypted key's matches once it's opened with its passphrase.
- **Public keys:** Proton keeps the key but drops the comment for the encrypted and PEM keys. This doesn't matter, because GutCheck compares fingerprints.
- **Note:** byte-identical (45 bytes, the missing trailing newline kept).
- **`ssh-agent debug`:** listed the plain and PEM keys as usable and the encrypted one as needing a passphrase, as the docs say.

So restoring the `SshKey.private_key` value from `pass-cli item view --output json` (or from the Proton app) gives back the exact file. The README section will say how. The `--field` name for a direct restore wasn't tested.

**Other managers:** use their SSH item type only once a spike confirms that type can be created with the key on stdin. Until then, SSH keys are saved like any other file:

| Tool | SSH item type to try | Fallback |
| --- | --- | --- |
| 1Password | `SSH Key` category, created from a JSON template on stdin (`op item create --vault <V> -` with an `SSHKEY`-type field); it works with 1Password's SSH agent | Document |
| Bitwarden | item `type: 5` (`sshKey: { privateKey, publicKey, keyFingerprint }`) through the same `bw create item` stdin path; it works with Bitwarden desktop's SSH agent | Secure note |
| KeePassXC | the entry plus a `KeeAgent.settings` attachment for its SSH agent integration. That needs settings XML the docs don't describe, so it isn't attempted in v1 | Attachment |
| pass / gopass | none (plain files) | `insert` |

**Not in v1:**
- Starting or setting up Proton's `ssh-agent`.
- `--create-new-identities`.
- Removing keys from `~/.ssh` after a backup. GutCheck never deletes the local file.

## 6. Errors

- **Locked or signed out:** the step fails with the adapter's hint, for example `Run "bw unlock" and export BW_SESSION, then try again.`
- **CLI missing:** the fix becomes "Link a password manager" and points to Settings.
- **Item too large for the tool:** for example, Bitwarden notes over 10,000 characters. The plan refuses up front, before any file reaches the CLI, with the limit and another option (1Password or KeePassXC take attachments).
- **One file failing doesn't undo the others:** each file is its own step, and steps that succeeded are recorded. The run stops at the first failure, as `apply.js` already does, and the summary lists what was saved.
- **Concurrent runs:** writes to the record go through a read-modify-write with the atomic rename, and the last writer wins per path, which is safe because entries are independent.

## 7. Testing

- **`test/secrets.test.js`, using temp repos and a temp HOME:**
  - Ignored `.env` is unbacked. Templates are not flagged.
  - `*.pub` is not flagged. A fixture key is low confidence.
  - A committed `.env` is left to `env-tracked`, not flagged here.
  - A file over 1 MB is not flagged.
  - Statuses come out right: unbacked, changed after an edit, backed, skipped, and a copy matched by hash.
  - `~/.npmrc` without a token is not flagged; `~/.docker/config.json` with no `auths` entries is not flagged.
- **SSH keys (`test/secrets.test.js`):**
  - Fingerprints from OpenSSH keys made by `ssh-keygen` in a temp dir (plain and passphrase-protected) match `ssh-keygen -lf`.
  - A PKCS#8 TLS key is never classed as SSH.
  - A Proton save of an SSH key uses `ssh-key import --from-private-key /dev/stdin`, and a `mismatch` fingerprint from Verify is treated as unbacked.
- **`test/vault.test.js`, per adapter, with a fake `run`:**
  - `args` never contains the file's contents, which appear only in `input`.
  - The vault target lands in the right flag.
  - `parseId` works on recorded sample output.
  - Locked and missing states map to the right hints.
- **`vault-save` tests (in `test/vault.test.js`):**
  - A hash mismatch stops the run.
  - A symlink is refused.
  - A failed CLI writes no record entry.
  - Stderr that echoes the content is cleaned.
  - The record file is 0600.
- **MCP:** `gutcheck_plan` with `secret-backup` is refused even with `allowActions`.
- **`test/accuracy.test.js`:** one case per false alarm found while building.
- **Real check (manual, with the user's OK):** back up one throwaway file to a test vault through `pass-cli`, which is installed on the dev machine, then Verify.

## 8. Files

New:
- `src/secrets.js`
- `src/vault.js`
- `src/vault-adapters.js`
- `src/actions-secrets.js`
- `src/renderer/secrets-view.js`
- `test/secrets.test.js`
- `test/vault.test.js`

Changed:
- `src/actions.js`: import `SECRET_NAME` and register the plans
- `src/apply.js`: the `vault-save` step
- `src/clutter.js`: return the secret candidates
- `src/checks-hygiene.js`: the findings
- `src/service.js`, `src/engine.js`, `src/cli.js`, `src/mcp.js`: wiring, and MCP refuses
- `src/main.js`: IPC
- `src/renderer/index.html` and the settings UI
- `report-fixes.js`: the report step
- `docs/sources.md`, `CHANGELOG.md`, `README.md`
