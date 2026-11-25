# AUR package

`gutcheck-bin/` packages a tagged release's AppImage (`GutCheck-$pkgver-x86_64.AppImage`
from GitHub Releases). It unpacks the AppImage into `/opt/gutcheck` and links
`/usr/bin/gutcheck`. The app keeps Chromium's sandbox on, and `chrome-sandbox` is installed setuid for
kernels without unprivileged user namespaces. `gutcheck --cli <command>` and `gutcheck --mcp`
run headless as with the AppImage.

## Updating for a release

Once the release workflow has published `v$pkgver`:

1. Set `pkgver` in `gutcheck-bin/PKGBUILD`, and reset `pkgrel=1`.
2. `cd packaging/aur/gutcheck-bin && updpkgsums`. The AppImage's sum must match the
   release's `SHA256SUMS.txt`.
3. `makepkg -f && namcap PKGBUILD *.pkg.tar.zst`, then run
   `pkg/gutcheck-bin/opt/gutcheck/gutcheck --cli --help`.
4. `makepkg --printsrcinfo > .SRCINFO`, and commit both files here.
5. Push to the AUR:

   ```sh
   export SSH_AUTH_SOCK=~/.ssh/proton-pass-ssh-agent.sock
   git clone ssh://aur@aur.archlinux.org/gutcheck-bin.git ~/aur/gutcheck-bin
   cp packaging/aur/gutcheck-bin/{PKGBUILD,.SRCINFO} ~/aur/gutcheck-bin/
   cd ~/aur/gutcheck-bin && git add PKGBUILD .SRCINFO && git commit -m "Update to $pkgver" && git push
   ```

Expected `namcap` output: one error, "ELF files outside of a valid path ('opt/')", which is
normal for a prebuilt Electron app. Also expected are warnings for the setuid `chrome-sandbox`,
unstripped Electron libraries, unused `libdl`/`libpthread` and implicitly satisfied X11 and
udev libraries, plus "x86_64 should be $CARCH" because the release asset name contains it.
