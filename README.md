# Mopivo

> Seu GNOME vivo em 30 segundos — wallpapers de 7 fontes + vídeo-wallpapers.

🌐 **Site:** https://zonaro.github.io/mopivo/ · 💻 **Repo:** https://github.com/zonaro/mopivo · 📜 GPL-3.0-or-later

Mopivo (antes *Wallpaper Providers*) é um app standalone GTK4 + libadwaita para
navegar e aplicar wallpapers de múltiplas fontes — e para tocar vídeo-wallpapers
locais, via streaming ou páginas web.

- Application id / GSettings schema id: `br.com.redclaw.Mopivo`
- Settings schema path: `/br/com/redclaw/Mopivo/`
- Gettext domain: `mopivo`
- Renderer D-Bus name: `org.redclaw.MopivoRenderer`

> **Nota sobre o nome:** o projeto e o repositório se chamam **Mopivo**, e todos os
> IDs técnicos (App ID, schema, domínios, pastas em `~/.local`) usam `mopivo`.
> Como o app nunca foi lançado, não há camada de compatibilidade nem migração —
> basta instalar normalmente.

Feito com GJS (ESM). Não roda dentro do GNOME Shell: o vídeo toca num subprocesso
renderer separado, então um crash do GStreamer nunca derruba o Shell.

## Instalação em 1 comando

```bash
curl -fsSL https://raw.githubusercontent.com/zonaro/mopivo/master/install.sh | bash
```

Alternativa com `wget`:

```bash
wget -qO- https://raw.githubusercontent.com/zonaro/mopivo/master/install.sh | bash
```

O `install.sh` da raiz:

- usa o checkout local quando você já clonou (`./install.sh`), delegando para
  `scripts/install.sh` / `scripts/uninstall.sh`;
- quando rodado via `curl | bash` (sem checkout), faz `git clone --depth 1`
  ou baixa o tarball do `master` para um diretório temporário e instala de lá;
- checa dependências (`gjs`, `glib-compile-schemas`, `msgfmt`) com dicas por
  distro, e aceita `--ref <branch|tag>`, `--yes` e `--uninstall`.

Opções:

```bash
./install.sh --help
curl -fsSL https://raw.githubusercontent.com/zonaro/mopivo/master/install.sh | bash -s -- --uninstall
```

## Instalação manual

```bash
./scripts/install.sh
# ou
make install
```

O install script:

1. Desabilita e desinstala a antiga extensão GNOME Shell
   (`wallpaper-providers-gnome@redclaw.com.br`) se presente, e remove seu
   diretório em `~/.local/share/gnome-shell/extensions/`.
2. Copia a árvore de runtime (`main.js`, `app/`, `ui/`, `lib/`, `renderer/`,
   `schemas/`, `locale/`, `data/`) para `~/.local/share/mopivo/` (APP_DIR),
   removendo arquivos obsoletos.
3. Compila o schema em `APP_DIR/schemas/` (o renderer carrega de lá) e instala
   globalmente em `~/.local/share/glib-2.0/schemas/`, recompilando o diretório.
4. Compila as traduções para
   `~/.local/share/locale/<lang>/LC_MESSAGES/mopivo.mo`.
5. Instala o .desktop em
   `~/.local/share/applications/br.com.redclaw.Mopivo.desktop` e o
   ícone (conjunto hicolor PNG 64–512px) em
   `~/.local/share/icons/hicolor/<size>x<size>/apps/br.com.redclaw.Mopivo.png`.

Depois, abra **Mopivo** na grade de apps, ou rode direto:

```bash
gjs -m ~/.local/share/mopivo/main.js
```

Flags:

```
(no options)   open the main window
--prefs        open the preferences window
--smoke-test   headless check (settings + providers), then exit
--version      print the version and exit
--help         show help and exit
```

Para rodar do checkout: `gjs -m main.js`, ou `make smoke` para o smoke test.

## Requisitos

- GNOME 45–50 (Wayland ou X11)
- `gjs` (suporte a ESM)
- GTK 4 e libadwaita 1.x
- GStreamer com `gtk4paintablesink` (vídeo-wallpaper)
- `xprop` (camada desktop X11/XWayland)
- `glib-compile-schemas` e `msgfmt` (só no install)
- `python3` com `numpy` e `Pillow` (gerador de wallpapers — aba Generator)
- Opcional: [yt-dlp](https://github.com/yt-dlp/yt-dlp) (streaming)
- Opcional: WebKitGTK 6.0 (fonte webpage)

Exemplos por distro:

```bash
# Fedora
sudo dnf install gjs gtk4 libadwaita gstreamer1-plugin-gtk4 glib2-devel gettext xprop
# Ubuntu 24.04+
sudo apt install gjs gir1.2-gtk-4.0 gir1.2-adw-1 libglib2.0-bin gettext x11-utils
# Arch
sudo pacman -S gjs gtk4 libadwaita gst-plugin-gtk4 glib2 gettext xorg-xprop
```

O install usa `rsync` quando disponível, com fallback para `cp`.

## Desinstalar

```bash
curl -fsSL https://raw.githubusercontent.com/zonaro/mopivo/master/uninstall.sh | bash
# ou no checkout
./uninstall.sh
# ou
./scripts/uninstall.sh
# ou
make uninstall
# ou via instalador
curl -fsSL https://raw.githubusercontent.com/zonaro/mopivo/master/install.sh | bash -s -- --uninstall
```

Para o renderer (`pkill -f renderer/renderer.js`) e remove APP_DIR, .desktop,
ícone, schema global (recompilando) e catálogos `.mo`. Seu papel de parede atual
(`org.gnome.desktop.background`) é preservado.

## Configuração

Tudo vive no schema `br.com.redclaw.Mopivo`, editável na janela de
Preferências (5 páginas: Providers, Filters, Downloads, Help Center, Video) ou
via `gsettings`:

```bash
gsettings list-keys br.com.redclaw.Mopivo
gsettings set br.com.redclaw.Mopivo video-mode true
```

Grupos principais:

- **Providers** — `active-provider`, `language`, `api-key`,
  `pexels-api-key`, `unsplash-api-key`, `pixabay-api-key`, `local-folders`,
  `local-recursive`, `wallrus-folders`, `wallrus-recursive`.
- **Filters** — `search-query`, `categories`, `purity`, `sorting`, `order`,
  `top-range`, `atleast`, `resolutions`, `ratios`, `colors`, `ai-art-filter`.
- **Downloads** — `download-folder` (vazio = `~/Pictures/Mopivo`),
  `set-background`, `page-size` (padrão 10).
- **Video source** — `video-mode`, `video-mode-type`, `video-path`,
  `video-folder` (vazio = `~/Videos/Mopivo`), `video-provider`,
  `video-search-query`, `video-streaming-url`, `video-webpage-url`,
  `video-webpage-local-html`.
- **Video playback** — `video-volume`, `video-mute`,
  `video-fade-duration-sec`, `video-audio-primary-monitor-only`,
  `video-fit-mode`, `video-random-start`, `video-monitor-paths`.
- **Auto-pause** — `pause-on-maximize-or-fullscreen`, `pause-on-focus`,
  `pause-on-battery`, `low-battery-threshold`, `pause-on-mpris-playing`.
- **Auto-change** — `change-wallpaper`, `change-wallpaper-directory-path`,
  `change-wallpaper-interval`, `change-wallpaper-mode`.
- **Static wallpaper** — `static-wallpaper-from-video`,
  `static-wallpaper-blur-enabled`, `static-wallpaper-blur-radius`.
- **Advanced** — `show-on-lock-screen`, mais as seis chaves do renderer
  `startup-delay`, `show-panel-menu`, `enable-va`, `enable-nvsl`,
  `prefer-clappersink`, `force-mediafile`.
- **Gerador** — `generator-preset`, `generator-palette`,
  `generator-resolution`, `generator-format`, `generator-export-folder`.

### Placement

Como o wallpaper é aplicado entre os monitores é controlado por
`wallpaper-mode`:

- **same** (padrão) — a mesma imagem repetida em todos os monitores.
- **span** — uma única imagem esticada por todos os monitores
  (`picture-options='spanned'`).
- **per-monitor** — uma imagem por conector, composta num único PNG
  `spanned`.

No modo `per-monitor`, atribua imagens por conector em
`wallpaper-per-monitor` (entradas `"conector=uri"`); monitores sem
atribuição usam `wallpaper-default-uri`:

```bash
gsettings set br.com.redclaw.Mopivo wallpaper-mode 'per-monitor'
gsettings set br.com.redclaw.Mopivo wallpaper-per-monitor '["HDMI-1=file:///home/u/a.jpg","eDP-1=file:///home/u/b.jpg"]'
gsettings set br.com.redclaw.Mopivo wallpaper-default-uri 'file:///home/u/default.jpg'
```

Se a composição falhar, o modo cai para `scaled` (imagem única).

65 chaves no total.

## Modo imagem

Janela principal com busca, dropdown de provedor e galeria com paginação. Clicar
numa miniatura baixa a imagem em resolução máxima para a pasta de download
(`download-folder`, vazio = `~/Pictures/Mopivo`, nomeada
`<provider>-<id>.<ext>`) e — com `set-background`
ligado — aplica como papel de parede. As miniaturas continuam em cache em
`~/.cache/mopivo/<provider>/`. Popover de filtros Wallhaven (categorias,
pureza, ordenação, top range, resolução mínima, resoluções, proporções, cores e
filtro AI-art).

| Provider | API key | Notas |
|---|---|---|
| Wallhaven | Opcional (NSFW exige) | Filtros completos |
| Pexels | Obrigatória — [pexels.com/api](https://www.pexels.com/api/) | Curadoria usada em buscas vazias |
| Unsplash | Obrigatória — [unsplash.com/developers](https://unsplash.com/developers) | `Client-ID`; feed usado em buscas vazias |
| Safebooru | Nenhuma | Board anime SFW; tags com underscore (`blue_hair`) |
| Pixabay | Obrigatória — [pixabay.com/api/docs](https://pixabay.com/api/docs/) | `safesearch` sempre on |
| Waifu.im | Nenhuma | Arquivo anime curado, SFW; tags com hífen; até 30 resultados frescos |
| Local Files | Nenhuma | Sua `~/Pictures` + pastas extras; busca por nome, newest first |

Provedores com chave ficam inutilizáveis até configurá-la; a página Providers
mostra qual está faltando. Cada provedor tem guia passo a passo em
Preferências → Help Center.

## Modo vídeo

Ligue o switch video-mode no header (ou `video-mode`) para trocar a galeria pelo
modo vídeo, que tem duas abas:

- **Browse** (`ui/videoGallery.js`) — galeria online de vídeos das fontes que
  suportam vídeo (Pexels e Pixabay), com busca, paginação e posters. Clicar
  baixa o `.mp4` para a pasta de vídeos (`video-folder`, vazio =
  `~/Videos/Mopivo`, nomeado `<provider>-<id>.mp4`) e já começa a tocar.
- **Playback** (`ui/videoControls.js`) — controles do vídeo-wallpaper local,
  streaming ou webpage. Playback delegado ao renderer via
  `lib/video/launcher.js`.

Na aba **Browse**, o provedor de vídeo é escolhido pela chave `video-provider`
(Pexels ou Pixabay) e o último termo buscado fica salvo em `video-search-query`;
clicar num resultado baixa o vídeo na pasta de vídeos (padrão `~/Videos/Mopivo`)
e reproduz imediatamente. No Pixabay a busca exige um termo — consultas vazias
não retornam nada.

| Fonte | Valor | Settings |
|---|---|---|
| Arquivos locais | `local` | `video-path` (único) ou `video-folder` (next/lucky) |
| Streaming URL | `streaming` | `video-streaming-url`, resolvido com yt-dlp |
| Webpage | `webpage` | `video-webpage-url` ou `video-webpage-local-html` (WebKitGTK) |

Sem `video-folder`, usa `~/Videos/Mopivo`.

Painel (`ui/videoControls.js`): fonte (Local/Streaming/Webpage), Video Path com
**Browse…**, URL de streaming, Play/Pause, **Next** e **Lucky**, mute + volume,
Fit Mode (Fill/Contain/Cover/Scale down). Estado sincronizado via D-Bus.

No X11 e no Wayland via XWayland, o launcher roda o renderer com
`GDK_BACKEND=x11` (`-P <APP_DIR>`, `-F <file>`), marcando as janelas como
`_NET_WM_WINDOW_TYPE_DESKTOP` via `xprop` no tamanho do monitor. Sem camada
desktop X11, cai para `fullscreen_on_monitor`.

**Limite conhecido:** auto-pause no Wayland exige integração com o Shell que um
app standalone não tem — não é aplicado lá (avisado na página Video). Auto-change
e static-wallpaper são do renderer e independem do auto-pause.

## Gerador

A terceira aba do header (ícone de paleta) gera wallpapers abstratos no mesmo
estilo do app Wallrus, sem ler wallpapers prontos e sem GPU: a matemática dos
shaders foi portada para `renderer/generator.py`, um subprocesso Python que usa
`numpy` + `Pillow`. O motor é acessado por `lib/generator/engine.js` via
`Gio.Subprocess`, então um preview roda num processo separado e nunca trava a UI.

- **7 presets**: Bars, Waves, Plasma, Terrain, Circle, Dunes, Spark — cada um com
  seus próprios controles (angle, scale, speed/time, center, variation).
- **Paletas**: `data/palettes/` (categorias `cold` e `dark`); as 4 cores são
  amostradas do PNG com `lib/generator/palettes.js`.
- **Pipeline**: Scene → Blur → Bloom → Chromatic Aberration → Effects (noise,
  dither, grain) e Lighting (bevel/gradient/vignette).
- **Ações**: **Randomize** (sorteia preset, paleta e parâmetros), **Set as
  Wallpaper** e **Export** (Display / HD / QHD / 4K / Phone, em PNG ou JPEG).
- **Prévia**: debounced (~250 ms) para `~/.cache/mopivo/generator/`.

Se `python3`, `numpy` ou `Pillow` não estiverem presentes, a aba mostra uma
mensagem explicando como instalar.

| Setting | Padrão | Descrição |
|---|---|---|
| `generator-preset` | `Bars` | Preset atual |
| `generator-palette` | `` (vazio) | Caminho da paleta atual |
| `generator-resolution` | `0` | 0=Display, 1=HD, 2=QHD, 3=4K, 4=Phone |
| `generator-format` | `png` | `png` ou `jpg` |
| `generator-export-folder` | `` (vazio) | Pasta de export; vazio = `~/Pictures` |

## Troubleshooting

```bash
journalctl -f -o cat /usr/bin/gjs
gsettings list-keys br.com.redclaw.Mopivo
gsettings get br.com.redclaw.Mopivo video-mode
gdbus introspect --session \
  --dest org.redclaw.MopivoRenderer \
  --object-path /org/redclaw/MopivoRenderer
```

- Renderer não inicia: confira `gtk4paintablesink` + `xprop` e fonte de vídeo.
- Streaming falha: confira `yt-dlp` no `PATH`.
- Webpage em branco: confira WebKitGTK 6.0.
- Schema sumiu no checkout: `make compile` ou reinstale.

## Estrutura

```
main.js               Entry point (Adw.Application, flags, smoke test)
prefs.js              Preferences window (Providers/Filters/Downloads/Help Center/Video)
install.sh            One-liner installer (raiz — bootstrap remoto + delega a scripts/)
uninstall.sh          One-liner uninstaller (raiz — bootstrap remoto + delega a scripts/)
docs/                 Landing page (GitHub Pages, source: /docs)
app/
  window.js           Main window: image + video + generator stacks, provider switching
  videoController.js  Renderer lifecycle, D-Bus channel, next/lucky/streaming
  generatorPage.js    Generator tab: presets, palettes, live preview, export
ui/
  gallery.js          Gtk.FlowBox thumbnail gallery + pagination
  videoGallery.js     Online video gallery (Pexels/Pixabay) + pagination
  filters.js          Wallhaven filter popover
  videoControls.js    Video controls pane
  prefs_helpers.js    Adw row builders + Help Center content
lib/
  download.js         Shared fetch-to-file (Soup for http(s), Gio copy for file://)
  i18n.js             Gettext helper
  paths.js            Canonical Pictures/Videos download-folder resolution
  wallpaper.js        Sets the GNOME desktop background
  providers/          One module per source + registry (see lib/providers/README.md)
  video/              Video subsystem (constants, dbus, launcher, ytDlp,
                      videoThumbs, playbackState, staticBlur)
  generator/          Generator engine (presets, palettes, spec builder)
renderer/
  renderer.js         GStreamer/WebKit renderer subprocess (one window per monitor)
  stylesheet.css      Renderer window CSS
  generator.py        Abstract wallpaper generator (numpy + Pillow)
schemas/              GSettings schema
locale/               .pot template + pt_BR / es translations
tests/                Headless unit tests (tests/run.js, gallery, filters,
                      videoController, videoGallery, generator)
data/                 Desktop entry template, app icon (data/icons/) and
                      generator palettes (data/palettes/)
scripts/              install.sh, uninstall.sh, export-icons.sh
```

Novo provider? Checklist em
[lib/providers/README.md](lib/providers/README.md#adding-a-new-provider).

## Desenvolvimento

Inglês por padrão, traduções pt_BR e es via `lib/i18n.js` (`_(str)`).

```bash
make check    # node --check em todo JS + testes headless + schema strict
make smoke    # smoke test headless (main.js --smoke-test)
make i18n     # compila .mo in-tree
make compile  # compila o schema
make clean    # limpa schema compilado e .mo in-tree
```

Ícones: o master é `data/icons/br.com.redclaw.Mopivo.png`; regenere o conjunto
hicolor + os assets da landing page com `scripts/export-icons.sh`.

## Licença

GPL-3.0-or-later. Veja os headers dos fontes.
