# 夏沫琉璃 / Summer Liquid Glass

English | [中文](README.zh.md)

A dsh-web-ui v2 skin: a Japanese summer-festival backdrop under an iOS 26
liquid-glass surface. Ice-cyan interaction, rose selection, amber running, and
yellow-green success over a deep-night palette.

## Palette

Deep night `#071321` base, glass base `#111927`, primary text `#F8F3F5`,
secondary `#C0CAD5`, dim `#8997A7`; ice cyan `#67DCE7`, rose `#DD8FAC`, amber
`#F3B75F`, yellow-green `#CBE77D`, coral `#F1717F`.

## Structure

- `skin.json` — v2 manifest (backgroundMedia declares the night-festival art and its readability scrim).
- `skin.css` — token remap (`--dsw-*` + `--aion-*`).
- `patches.css` — glass polish (backdrop blur, inner highlights, composer fade).
- `assets/` — the backdrop art.
- `preview/` — light/dark gallery previews.

## Frozen (2026-09-27)

This skin is **frozen at `1.0.1-frozen`**: it is the shipped default, and
changes to it must be deliberate, never incidental. Two guards gate it and
must stay green:

- `node ~/.dsh/profiles/web/scripts/dsh-token-contrast.mjs` — overlay and
  state-pill contrast ≥ 4.5:1 in both base modes, the toast/tooltip/pool-error
  repaints present, `--dsw-menu-backdrop-filter` still defined (ui-theme owns
  it; the skin deliberately does not redefine it), and the dotfiles mirror
  byte-identical to this directory.
- `node ~/.dsh/profiles/web/scripts/dsh-rebrand.mjs --check` — fork branding
  plus the same contrast verdict (it imports the probe).

A deliberate change means: edit here (or `skin.css`/`patches.css`), keep both
guards green, bump the version, and re-sync the mirror at
`~/dotfiles/dsh-dotfiles/skins/summer-liquid-glass/`.

## License

BSD-3-Clause. The backdrop art is provided by the user for local use; re-check
redistribution rights before publishing.
