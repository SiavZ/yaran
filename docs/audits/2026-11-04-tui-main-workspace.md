# Main TUI redesign and review

Date: 2026-11-04. Implementation by Claude Opus 5.5; independent review and
verification by the parent Codex agent. This follows the earlier
[TUI bug and readability audit](2026-11-04-tui-ui-ux.md).

What this change does: it updates the ordinary terminal workspace that the user
sees while navigating agents and typing. The current grouped, compact sidebar
and enabled human board were the baseline. Personal preferences were preserved.
This report records concrete changes and checks, without assigning an overall
visual-design score.

## Visible changes

- The header reads as a workspace path. Project, branch and agent context lead;
  version and commit move to the right in a quieter tone and give way first on
  small terminals. An overlong context ends with an ellipsis.
- Pane titles have padding. A filled title badge identifies the focused pane.
  The center title starts with the agent's name and then its provider.
- A terminal receiving input has a typing-colored border and an `INPUT` title.
  The footer repeats that state and advertises keys that remain available.
  Scrollback and take-over cards suppress the INPUT claim.
- Compact agent rows show Working, Typing or Needs you when space permits;
  idle rows remain quiet. Project counts align at the right. A gutter bar marks
  the selected row, with a quieter color when the sidebar loses focus.
- The footer identifies its pane, and an empty status row is blank. Fullscreen
  views fit inside the existing footer boundary so the mode and Minimize hint
  remain visible.

The implementation reuses theme colors and shared pane, text, input and hint
components. It adds no dependency or new theme token. Flat and comfortable
sidebar settings remain supported. Shared pane styling also applies to those
views. The prior save-recovery, focus, Unicode and contrast fixes remain.

## Reviewer findings and resolutions

1. **The footer could claim INPUT while a take-over card blocked typing.** A
   live PTY alone did not mean this device could write to it. The footer now
   checks ownership and scrollback as well as input focus. A real-PTY regression
   rendered a covered pane and failed before the fix. The existing scrollback
   caret test now also checks the title and footer state.
2. **Padded Changes headings could clip a total.** At 19 columns the new padding
   turned `Changes (1) +1 -1` into `Changes (1) +1 -`. The title budget now includes
   both padding cells and borders. The regression verifies that totals are
   omitted at 19 columns and remain complete at 21. The same padding budget now
   applies to the human board title. With 12 waiting cards, both the pane title
   and the section heading shorten their label before the count; the 80-column
   view previously clipped the section count to `1`. A regression covers both.
3. **Fullscreen covered the footer.** At 160×45 the bottom border overwrote the
   new INPUT badge and Minimize hint. The parent runtime check caught this in
   both themes, and a regression reproduced it. Agent, terminal and startup-log
   fullscreen views now use the existing bounds that reserve the footer.
   Fullscreen keeps its Minimize hint even while typing is paused.
4. **A narrow header ended in an unmarked partial fact.** The final header now
   uses the shared display-width truncation helper. A regression checks the
   ellipsis while retaining the existing version-priority assertions.
5. **Unselected filenames inherited the host terminal's foreground.** In Ayu
   Light the resulting white paths were nearly invisible on the pale pane.
   File rows and the file-search field now use the theme's text color. The
   rendered-cell regression failed with a reset foreground and passes with the
   theme foreground; selected rows retain their paired selection colors.

The small temporary vector used to choose each pane badge's foreground was
also removed from the render path. The same bounded candidate iterator produces
the same colors without that allocation. Bundled-theme contrast checks remain
in place.

## Verification and evidence

Source review compared the implementation with a saved pre-Opus snapshot,
including connected input, ownership, scroll, fullscreen and redraw code. The
existing core diff matches that snapshot exactly.

- `cargo test -p yaran-tui`: **2,566 passed**, zero failures after review fixes.
- `cargo clippy --all-targets --all-features -- -D warnings`: passed.
- `cargo fmt --all --check` and `git diff --check`: passed.
- The final isolated Linux build and optimized native macOS build passed.
  The source, staged and installed executables passed signature, version and
  byte-integrity checks.
- All 19 documentation captures pass their content and image guards; the
  website PNGs match those captures. The complete set was refreshed after the
  final review fixes. Two earlier renderer startup failures and their guarded
  reruns remain in `review/docs-manifest-before-final.json`.
- The website screenshot contract suite passes all 16 checks.

Real Linux TUI captures cover dark and Ayu Light at 160×45, 120×32 and 80×24.
The fixture has two projects, working/idle/attention agents, provider tabs,
companion and standalone terminals, changed files, file search, and the human
board both empty and populated with 12 waiting tasks.
The parent inspected the rendered images, not only captured text.
The final independent journey produces 36 guarded workspace images. Navigation,
typing, changed files, file search and populated board are captured at all three
sizes in both themes; fullscreen and paused/resumed scrollback are captured at
160×45. The 19 documentation scenes also exercise the palette, help, creation,
project environment editor, theme picker, serving, multiple front ends, startup
logs and worktree screens.

Evidence is under `tools/preview-env/shots/tui-main-redesign-20261104/`:

- `png/before-*` and `png/after-*`: implementation comparison captures.
- `review-final-*`: final-source captures from the parent's independent journey.
- `runner/review-workspace.js`: actual navigation, typing, Files-tab clicks and
  search, fullscreen, scrolling, return-to-live-edge input and populated board.
- `review/`: failing baseline checks, fixed regressions, runtime logs and final
  verification records.
- `docs/manifest.json`: guarded documentation capture results.

The parent explicitly clicks the Files tab. Merely focusing the right column
can leave the human board selected, so that alone was not counted as checking
the changed-file view.

Review result: no blocking findings remain in the main-workspace change.

The reviewed native build was installed atomically at
`~/.local/bin/yaran`, also reached through the existing `dux`
symlink. Its SHA-256 is
`d757f0fee71ea2c052a7d26c9f1a5cd37e0585fa712dfb7747845df12f25b608`.
The preceding executable is preserved at
`~/.local/bin/yaran.backup-20261104T114110963194Z`.
The complete installation record is `review/install.json` in the evidence
directory. This records the build verified before source publication.

## Limits

Testing uses disposable configuration, repositories and fake providers. It does
not cover live provider authentication, every host terminal palette, native IME
or clipboard behavior. The rasterizer uses bundled Yaran Mono because MonoLisa
is unavailable. Very narrow sidebars fall back to glyph state cues; long hint
lists use an ellipsis. Ayu Light's unfocused borders remain faint, while the
focused and input title badges pass the bundled-theme text contrast checks.

The host TUI is never launched, stopped or driven by the verification scripts.
Installing replaces the executable atomically and keeps a backup. The user
applies it to their live session with the `reload-binary` palette command.
