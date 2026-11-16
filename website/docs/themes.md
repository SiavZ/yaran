---
title: Managing Themes
description: Switch the built-in themes, preview them live, or write your own from scratch.
group: Guides
order: 40
---

yaran ships with a generous set of built-in themes and lets you write your own.

> [!IMPORTANT]
> Theming is a terminal UI feature. The web UI is dark-only: it ships one tuned dark
> palette, ignores your `theme` setting, and does not follow your system light/dark
> preference. A theme you write changes the terminal UI only.

## Changing the theme

Open the **theme picker** from the terminal UI's command palette and arrow through the
options with a live preview. It discovers every built-in plus anything you have
authored, and labels where each one came from.

![The terminal UI theme picker open over the workspace, listing yaran_dark as the current theme with the bundled themes below it.](/screens/tui-theme-picker.png)

To set it by hand instead, edit the `[ui]` section of `config.toml` and reload the config
(or restart):

```toml
[ui]
theme = "yaran_dark"   # the default
```

With a yaran running, `yaran config set ui.theme "nord"` does the edit and the reload in one
step. `yaran themes ls` lists every theme yaran can load and which one is in use.

Built-in names use underscores:

```toml
theme = "catppuccin_mocha"
theme = "nord"
theme = "dracula"
theme = "tokyo_night"
theme = "gruvbox_dark"
```

There are far more: Catppuccin's four flavors, Tokyo Night's variants, Solarized,
Rose Pine, Everforest, Kanagawa, One Dark, and others. The picker is the list that
never goes stale.

## Nerd Font icons

Running a [Nerd Font](https://www.nerdfonts.com) in your terminal? yaran can trade its
plain icons for proper ones: a folder for the project, a star for standalone rows, the
pull-request and warning marks, the disclosure chevrons, and the serving and terminals
chips in the header. Out of the box yaran draws the plain set every screenshot in these
docs shows, so it looks right in any font:

![The terminal UI sidebar: three active agents, one of them running three tabs, and a collapsed Inactive tail.](/screens/tui-agent-list-two-line.png)

Flip it with the `toggle-nerd-font-icons` command in the terminal UI's command palette.
It takes effect on the spot and is saved for next time. You can also find it as **Nerd
Font icons** in the web UI's Preferences dialog, or set it by hand:

```toml
[ui]
nerd_font_icons = true   # off by default
```

> [!IMPORTANT]
> This needs a Nerd Font (a patched font) set as your terminal's font. Without one the
> icons come out as empty boxes; flip the setting back and the plain set returns. It
> changes the terminal UI only: the web UI draws its own icons either way.

## How a theme name is resolved

When you set `theme = "<name>"`, yaran looks in this order:

1. A user theme at `<config dir>/themes/<name>.toml`. Your own themes win first.
2. The bundled `yaran_dark` theme.
3. An [Opaline](https://github.com/hyperb1iss/opaline) built-in (Catppuccin, Nord,
   Dracula, and friends).

> [!NOTE]
> A name that matches nothing is not fatal. yaran tells you so and falls back to a safe
> default rather than launching into an unreadable color scheme.

## Writing your own theme

Custom themes are TOML files. Put one at:

- **Linux:** `~/.config/yaran/themes/<name>.toml`
- **macOS:** `~/.yaran/themes/<name>.toml`

then point your config at it:

```toml
[ui]
theme = "my_theme"   # matches my_theme.toml in the themes directory
```

The file name, without `.toml`, is the theme's id.

> [!TIP]
> Start from the theme yaran already uses. Grab
> [`assets/themes/yaran_dark.toml`](https://github.com/patrickdappollonio/dux/blob/main/assets/themes/yaran_dark.toml)
> from the repository, drop it in your themes directory under a new name, and recolor
> it. It defines every surface yaran paints, so you will never hit a missing color.

### The shape of a theme file

Theme files use the Opaline format. Three parts matter most:

```toml
[meta]
name = "My Theme"
author = "you"
variant = "dark"        # or "light"
description = "A custom yaran theme"

[palette]
# Name your colors once, reuse them everywhere below.
bg     = "#11111d"
fg     = "#f4f7ff"
accent = "#00d4ff"
pink   = "#ff4fd8"

[tokens]
# yaran.* tokens map a color onto a specific yaran UI surface.
"yaran.app_bg"         = "bg"
"yaran.text_fg"        = "fg"
"yaran.border_focused" = "accent"
"yaran.title_focused"  = "accent"
"yaran.selection_bg"   = "pink"
# ...and so on for every surface you want to control.
```

You have two ways to define colors:

- **Set `yaran.*` tokens explicitly** for control over each surface: borders, headers,
  selection, diff colors, status line, and the rest. This is what the bundled theme
  does.
- **Rely on the fallback.** Any `yaran.*` token you leave out is derived from Opaline's
  standard semantic tokens (`text.*`, `bg.*`, `accent.*`, `border.*`, `code.*`). A
  complete, standard Opaline theme works in yaran as-is, even if it was never written
  with yaran in mind.

Names inside dialogs (branches, paths, agent and project names) are drawn as small chips:
the dialog background (`yaran.overlay_bg`) on the dialog text color (`yaran.text_fg`). There is
nothing extra to set.

> [!TIP]
> The cards inside a pane, like the note in the changes pane when a folder has no
> repository, sit on the pane's own background (`yaran.app_bg`) with just a border. Want them
> to stand out? Set `yaran.pane_card_bg` and they get a fill of their own.

Save the file and open the theme picker: your theme is listed alongside the built-ins,
labeled as user-authored, with the same live preview. Tweak, save, re-pick, repeat.
