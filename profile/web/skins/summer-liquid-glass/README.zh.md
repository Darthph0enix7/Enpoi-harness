# 夏沫琉璃 / Summer Liquid Glass

[English](README.md) | 中文

dsh-web-ui v2 皮肤：日系夏祭背景 + iOS 26 液态玻璃表面。冰青作主要交互、
玫瑰粉作选中、琥珀金作运行中、黄绿作成功，深海军蓝底。

## 调色板

深夜底 `#071321`、玻璃基底 `#111927`、主文字 `#F8F3F5`、次级 `#C0CAD5`、
弱化 `#8997A7`；冰青 `#67DCE7`、玫瑰粉 `#DD8FAC`、琥珀金 `#F3B75F`、
黄绿 `#CBE77D`、珊瑚红 `#F1717F`。

## 目录结构

- `skin.json` — v2 清单（backgroundMedia 声明日系夏祭背景图与可读性遮罩）。
- `skin.css` — token 重映射（`--dsw-*` + `--aion-*`）。
- `patches.css` — 玻璃质感（背景模糊、内缘高光、输入区渐隐）。
- `assets/` — 背景插画。
- `preview/` — 亮/暗画廊预览图。

## 冻结（2026-09-27）

本皮肤已**冻结在 `1.0.1-frozen`**：它是默认皮肤，任何改动都必须是有意为之，
不能是顺手的。两个守卫把关、必须保持绿色：

- `node ~/.dsh/profiles/web/scripts/dsh-token-contrast.mjs` —— 浮层与状态
  胶囊对比度在两种基底下 ≥ 4.5:1，toast/tooltip/pool 错误修补仍在，
  `--dsw-menu-backdrop-filter` 仍有定义（由 ui-theme 拥有，本皮肤有意不
  重复定义），且 dotfiles 镜像与本目录逐字节一致。
- `node ~/.dsh/profiles/web/scripts/dsh-rebrand.mjs --check` —— fork 品牌
  检查 + 同一套对比度结论（内部导入上述探针）。

“有意改动”的流程：在本目录（或 `skin.css`/`patches.css`）修改，保持两个
守卫绿色，提升版本号，并重新同步镜像目录
`~/dotfiles/dsh-dotfiles/skins/summer-liquid-glass/`。

## 许可证

BSD-3-Clause。背景插画由用户提供、仅限本地使用；发布前请重新核查再分发权利。
