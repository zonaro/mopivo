/*
 * Mopivo landing page — client-side i18n.
 *
 * Languages: English (fallback), Brazilian Portuguese, Spanish.
 * Detection order: saved choice (localStorage) -> navigator.language(s) -> English.
 *
 * Every translatable node in index.html carries one of:
 *   data-i18n        -> replaces textContent
 *   data-i18n-html   -> replaces innerHTML (strings with inline markup)
 *   data-i18n-alt    -> replaces the element's alt attribute
 * <title> and the meta description / og tags are updated from the `meta.*` keys.
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'mopivo-lang';
    var FALLBACK = 'en';
    var SUPPORTED = ['en', 'pt-BR', 'es'];

    var TRANSLATIONS = {
        en: {
            'meta.title': 'Mopivo — Amazing wallpapers and video wallpapers for your GNOME',
            'meta.description': 'Mopivo brings wallpapers from 8 sources and plays video wallpapers on your desktop. One command, 30 seconds, free forever.',
            'meta.ogTitle': 'Mopivo — your desktop comes alive',
            'meta.ogDescription': '8 wallpaper sources + video wallpapers. Install with 1 command. Free, open-source, no account.',
            'nav.features': 'Features',
            'nav.providers': 'Sources',
            'nav.install': 'Install',
            'nav.faq': 'FAQ',
            'nav.download': '⬇ Download free',
            'hero.iconAlt': 'Mopivo — landscapes through the four seasons',
            'hero.title': 'Your GNOME<br><span class="grad">comes alive in 30 seconds.</span>',
            'hero.sub': 'Mopivo finds wallpapers from <b style="color:var(--text)">8 sources</b>, applies them in 1 click and even plays <b style="color:var(--text)">video wallpapers</b> — your own files, streaming or web pages. Built for GNOME, free, open-source, no sign-up.',
            'install.label': 'Copy · paste in the terminal · enter',
            'hero.gnomeLine': '● works on GNOME 45 to 50',
            'install.copy': '⧉ Copy',
            'install.wget': 'Prefer <span style="font-family:var(--mono)">wget</span>?',
            'cta.installBtn': '⬇ Install now — 1 command',
            'cta.github': '★ View on GitHub',
            'hero.micro': '<b>✓</b> No sudo &nbsp;·&nbsp; <b>✓</b> stays in your home folder &nbsp;·&nbsp; <b>✓</b> uninstalls cleanly &nbsp;·&nbsp; <b>✓</b> 30 seconds',
            'stat.sources': 'wallpaper sources',
            'stat.video': 'video types (file, streaming, web)',
            'stat.custom': 'make it truly yours',
            'stat.free': 'accounts, trackers or paywall',
            'features.eyebrow': 'Why Mopivo',
            'features.title': 'Made for people who change<br>their wallpaper every day.',
            'features.lead': 'No ad-packed websites, no manual downloads, no guesswork. Search, filter, click — done, applied to your desktop and lock screen.',
            'card.gallery.title': 'Fast, beautiful gallery',
            'card.gallery.desc': 'Instant search, switch sources in one click, thumbnails that load right away and downloads in the best quality — all with smart caching.',
            'card.filters.title': 'Powerful filters',
            'card.filters.desc': 'Categories, purity level, sorting, minimum resolution, aspect ratio, colors and an anti-AI filter — find exactly what you\'re looking for.',
            'card.video.title': 'Real video wallpapers',
            'card.video.desc': 'Each monitor gets its own video, fit modes, volume, mute, Next and Shuffle buttons — plus support for YouTube links.',
            'card.auto.title': 'Automatic rotation',
            'card.auto.desc': 'Timed slideshow from any folder, static video blur, shuffle mode and multi-monitor support.',
            'card.privacy.title': 'Private by nature',
            'card.privacy.desc': 'Zero telemetry. Your keys stay only on your computer. Open-source and auditable, GPL-3.0 license.',
            'card.lang.title': 'In your language',
            'card.lang.desc': 'Interface in English with translations for pt-BR and Spanish. Help center with a step-by-step guide per source.',
            'providers.eyebrow': 'Sources',
            'providers.title': '8 sources. Zero hassle.',
            'providers.lead': 'Three ask for a quick, free sign-up (Pexels, Unsplash, Pixabay); the rest just work — including your folders and wallpapers you generate right in the app.',
            'prov.wallhaven.desc': 'Full filters, optional NSFW with sign-up.',
            'prov.wallhaven.tag': 'optional sign-up',
            'prov.pexels.desc': 'Premium curation for empty searches.',
            'prov.pexels.tag': 'free sign-up',
            'prov.unsplash.desc': 'Top-quality photography.',
            'prov.unsplash.tag': 'free sign-up',
            'prov.safebooru.desc': 'SFW anime, tag-based search.',
            'prov.safebooru.tag': 'direct, no sign-up',
            'prov.pixabay.desc': 'Safe search always on.',
            'prov.pixabay.tag': 'free sign-up',
            'prov.waifu.desc': 'Curated anime, up to 30 fresh ones.',
            'prov.waifu.tag': 'direct, no sign-up',
            'prov.local.desc': 'Your Pictures folder + extras, newest first.',
            'prov.local.tag': 'direct, no sign-up',
            'prov.generator.name': '🎨 Generator',
            'prov.generator.desc': 'Abstract wallpapers generated right in the app.',
            'prov.generator.tag': 'direct, no sign-up',
            'install.eyebrow': 'Installation',
            'install.title': '3 steps. No sudo. No risk.',
            'step.copy.title': 'Copy the command',
            'step.copy.desc': 'The command downloads the official installer from GitHub and checks what your system needs, with tips for each distro.',
            'step.run.title': 'Run it and you\'re set',
            'step.run.desc': 'It puts the app in the right place, sets everything up and creates the icon in your apps menu.',
            'step.open.title': 'Open Mopivo',
            'step.open.desc': 'Look for "Mopivo" in your apps grid and start using it. It also runs straight from the terminal if you prefer.',
            'requirements.label': 'Requirements · Fedora / Ubuntu / Arch',
            'requirements.code': 'GNOME 45 to 50 · Fedora, Ubuntu, Arch and derivatives',
            'requirements.optional': 'Optional: support for streaming links and web pages. The installer uses whatever is available.',
            'faq.eyebrow': 'FAQ',
            'faq.title': 'Straight questions, straight answers.',
            'faq.q1.q': 'Is it safe to run a curl | bash?',
            'faq.q1.a': 'Yes. The scripts are short, open for anyone to read and live in the public repository. They only write to your home folder, never ask for an admin password, and you can inspect the code in your browser first. Uninstalling cleans everything up with the <span style="font-family:var(--mono)">uninstall.sh</span> (see "How do I uninstall?" below).',
            'faq.q3.q': 'Does it work on Wayland?',
            'faq.q3.a': 'Yes. Images work in your session as usual. Video wallpapers use a desktop layer when available and, if needed, fall back to fullscreen per monitor. Auto-pause has a small limitation on Wayland — flagged on the Video page.',
            'faq.q4.q': 'Do I have to pay for an API?',
            'faq.q4.a': 'No. Wallhaven (SFW), Safebooru, Waifu.im, your folders and the built-in generator work with no sign-up. Pexels, Unsplash and Pixabay ask for a free key — the app tells you which one is missing and the Help Center shows you how to create it in 2 minutes.',
            'faq.q5.q': 'How do I uninstall?',
            'faq.q5.a': 'However you prefer — they all do the same cleanup (stops the video, removes the app, shortcut, icon, settings and translations; your current wallpaper stays untouched):<br><br><b>Direct command (recommended):</b> <span style="font-family:var(--mono)">curl -fsSL https://raw.githubusercontent.com/zonaro/mopivo/master/uninstall.sh | bash</span><br><b>In the downloaded code:</b> <span style="font-family:var(--mono)">./uninstall.sh</span> (or <span style="font-family:var(--mono)">./scripts/uninstall.sh</span> / <span style="font-family:var(--mono)">make uninstall</span>)<br><b>Via the installer:</b> <span style="font-family:var(--mono)">./install.sh --uninstall</span> or <span style="font-family:var(--mono)">curl …/install.sh | bash -s -- --uninstall</span>',
            'faq.q6.q': 'Where are the install and uninstall scripts?',
            'faq.q6.a': 'In the repository root: <span style="font-family:var(--mono)">install.sh</span> installs (fetches the remote code if run via curl) and <span style="font-family:var(--mono)">uninstall.sh</span> removes. Both accept <span style="font-family:var(--mono)">--help</span>, <span style="font-family:var(--mono)">--ref &lt;branch|tag&gt;</span> and <span style="font-family:var(--mono)">--yes</span>. The real logic lives in <span style="font-family:var(--mono)">scripts/install.sh</span> and <span style="font-family:var(--mono)">scripts/uninstall.sh</span> — the root ones just call or download when needed. Direct links: <a href="https://raw.githubusercontent.com/zonaro/mopivo/master/install.sh">install.sh</a> · <a href="https://raw.githubusercontent.com/zonaro/mopivo/master/uninstall.sh">uninstall.sh</a>.',
            'final.title': 'Ready to bring your desktop to life? 🚀',
            'final.lead': 'One command. Thirty seconds. Endless wallpapers.',
            'final.copyBtn': 'Copy install command',
            'footer.tagline': '<b style="color:var(--text)">Mopivo</b> · formerly Wallpaper Providers · GPL-3.0-or-later · made with ♥ for GNOME',
            'toast.msg': 'Command copied! Paste it in the terminal and hit Enter ✨'
        },

        'pt-BR': {
            'meta.title': 'Mopivo — Wallpapers incríveis e vídeo-wallpapers para seu GNOME',
            'meta.description': 'Mopivo traz wallpapers de 8 fontes e toca vídeo-wallpapers no seu desktop. Um comando, 30 segundos, grátis para sempre.',
            'meta.ogTitle': 'Mopivo — seu desktop ganha vida',
            'meta.ogDescription': '8 fontes de wallpapers + vídeo-wallpapers. Instala com 1 comando. Grátis, open-source, sem conta.',
            'nav.features': 'Recursos',
            'nav.providers': 'Provedores',
            'nav.install': 'Instalação',
            'nav.faq': 'FAQ',
            'nav.download': '⬇ Baixar grátis',
            'hero.iconAlt': 'Mopivo — paisagens nas quatro estações',
            'hero.title': 'Seu GNOME<br><span class="grad">ganha vida em 30 segundos.</span>',
            'hero.sub': 'Mopivo busca wallpapers em <b style="color:var(--text)">8 fontes</b>, aplica com 1 clique e ainda toca <b style="color:var(--text)">vídeo-wallpapers</b> — arquivos seus, streaming ou páginas web. Feito para GNOME, grátis, open-source, sem cadastro.',
            'install.label': 'Copie · cole no terminal · enter',
            'hero.gnomeLine': '● funciona no GNOME 45 a 50',
            'install.copy': '⧉ Copiar',
            'install.wget': 'Prefere <span style="font-family:var(--mono)">wget</span>?',
            'cta.installBtn': '⬇ Instalar agora — 1 comando',
            'cta.github': '★ Ver no GitHub',
            'hero.micro': '<b>✓</b> Sem sudo &nbsp;·&nbsp; <b>✓</b> fica na sua pasta pessoal &nbsp;·&nbsp; <b>✓</b> remove tudo limpo &nbsp;·&nbsp; <b>✓</b> 30 segundos',
            'stat.sources': 'fontes de wallpaper',
            'stat.video': 'tipos de vídeo (arquivo, streaming, web)',
            'stat.custom': 'personalize do seu jeito',
            'stat.free': 'contas, rastreadores ou paywall',
            'features.eyebrow': 'Por que Mopivo',
            'features.title': 'Feito para quem troca<br>de wallpaper todo dia.',
            'features.lead': 'Nada de site cheio de anúncio, download manual e ajuste no escuro. Pesquise, filtre, clique — pronto, aplicado no desktop e na tela de bloqueio.',
            'card.gallery.title': 'Galeria rápida e bonita',
            'card.gallery.desc': 'Busca instantânea, troca de fonte num clique, miniaturas que carregam na hora e download na melhor qualidade — tudo com cache inteligente.',
            'card.filters.title': 'Filtros poderosos',
            'card.filters.desc': 'Categorias, nível de pureza, ordenação, resolução mínima, proporção, cores e filtro anti-IA — encontre exatamente o que procura.',
            'card.video.title': 'Vídeo-wallpaper de verdade',
            'card.video.desc': 'Cada monitor com seu vídeo, modos de ajuste, volume, mute, botões Próximo e Sorte — e suporte a links do YouTube.',
            'card.auto.title': 'Troca automática',
            'card.auto.desc': 'Slideshow por tempo a partir de qualquer pasta, desfoque estático do vídeo, modo aleatório e suporte a múltiplos monitores.',
            'card.privacy.title': 'Privado por natureza',
            'card.privacy.desc': 'Zero telemetria. Suas chaves ficam só no seu computador. Código aberto e auditável, licença GPL-3.0.',
            'card.lang.title': 'Em português',
            'card.lang.desc': 'Interface em inglês com traduções para pt-BR e espanhol. Central de ajuda com guia passo a passo por fonte.',
            'providers.eyebrow': 'Fontes',
            'providers.title': '8 fontes. Zero complicação.',
            'providers.lead': 'Três pedem cadastro rápido e grátis (Pexels, Unsplash, Pixabay), o resto abre direto — incluindo suas pastas e os wallpapers que você gera no próprio app.',
            'prov.wallhaven.desc': 'Filtros completos, NSFW opcional com cadastro.',
            'prov.wallhaven.tag': 'cadastro opcional',
            'prov.pexels.desc': 'Curadoria premium para buscas vazias.',
            'prov.pexels.tag': 'cadastro grátis',
            'prov.unsplash.desc': 'Fotografia de altíssima qualidade.',
            'prov.unsplash.tag': 'cadastro grátis',
            'prov.safebooru.desc': 'Anime SFW, busca por tags.',
            'prov.safebooru.tag': 'direto, sem cadastro',
            'prov.pixabay.desc': 'Busca segura sempre ativa.',
            'prov.pixabay.tag': 'cadastro grátis',
            'prov.waifu.desc': 'Anime curado, até 30 novidades.',
            'prov.waifu.tag': 'direto, sem cadastro',
            'prov.local.desc': 'Sua pasta Imagens + extras, mais recentes primeiro.',
            'prov.local.tag': 'direto, sem cadastro',
            'prov.generator.name': '🎨 Gerador',
            'prov.generator.desc': 'Wallpapers abstratos gerados no próprio app.',
            'prov.generator.tag': 'direto, sem cadastro',
            'install.eyebrow': 'Instalação',
            'install.title': '3 passos. Sem sudo. Sem risco.',
            'step.copy.title': 'Copie o comando',
            'step.copy.desc': 'O comando baixa o instalador oficial do GitHub e verifica o que seu sistema precisa, com dicas para cada distro.',
            'step.run.title': 'Rode e pronto',
            'step.run.desc': 'Ele coloca o app no lugar certo, configura tudo e cria o ícone no menu de aplicativos.',
            'step.open.title': 'Abra o Mopivo',
            'step.open.desc': 'Procure "Mopivo" na grade de apps e comece a usar. Também roda direto pelo terminal se preferir.',
            'requirements.label': 'Requisitos · Fedora / Ubuntu / Arch',
            'requirements.code': 'GNOME 45 a 50 · Fedora, Ubuntu, Arch e derivados',
            'requirements.optional': 'Opcionais: suporte a links de streaming e a páginas web. O instalador usa o que tiver disponível.',
            'faq.eyebrow': 'FAQ',
            'faq.title': 'Perguntas diretas, respostas diretas.',
            'faq.q1.q': 'É seguro rodar um curl | bash?',
            'faq.q1.a': 'Sim. Os scripts são curtos, abertos para qualquer um ler e estão no repositório público. Eles só escrevem na sua pasta pessoal, nunca pedem senha de administrador, e você pode conferir o código antes no navegador. A desinstalação limpa tudo com o <span style="font-family:var(--mono)">uninstall.sh</span> (veja "Como desinstalo?" abaixo).',
            'faq.q3.q': 'Funciona no Wayland?',
            'faq.q3.a': 'Sim. As imagens funcionam na sua sessão normalmente. O vídeo-wallpaper usa uma camada de desktop quando disponível e, se precisar, vira tela cheia por monitor. A pausa automática tem uma pequena limitação no Wayland — avisada na página de Vídeo.',
            'faq.q4.q': 'Preciso pagar por API?',
            'faq.q4.a': 'Não. Wallhaven (SFW), Safebooru, Waifu.im, suas pastas e o gerador nativo funcionam sem cadastro. Pexels, Unsplash e Pixabay pedem chave grátis — o app avisa qual está faltando e a Central de Ajuda ensina a criar em 2 minutos.',
            'faq.q5.q': 'Como desinstalo?',
            'faq.q5.a': 'Do jeito que preferir — todos fazem a mesma limpeza (para o vídeo, remove app, atalho, ícone, configurações e traduções; seu papel de parede atual fica intacto):<br><br><b>Comando direto (recomendado):</b> <span style="font-family:var(--mono)">curl -fsSL https://raw.githubusercontent.com/zonaro/mopivo/master/uninstall.sh | bash</span><br><b>No código baixado:</b> <span style="font-family:var(--mono)">./uninstall.sh</span> (ou <span style="font-family:var(--mono)">./scripts/uninstall.sh</span> / <span style="font-family:var(--mono)">make uninstall</span>)<br><b>Via instalador:</b> <span style="font-family:var(--mono)">./install.sh --uninstall</span> ou <span style="font-family:var(--mono)">curl …/install.sh | bash -s -- --uninstall</span>',
            'faq.q6.q': 'Onde estão os scripts de instalação e remoção?',
            'faq.q6.a': 'Na raiz do repositório: <span style="font-family:var(--mono)">install.sh</span> instala (busca o código remoto se rodado via curl) e <span style="font-family:var(--mono)">uninstall.sh</span> remove. Ambos aceitam <span style="font-family:var(--mono)">--help</span>, <span style="font-family:var(--mono)">--ref &lt;branch|tag&gt;</span> e <span style="font-family:var(--mono)">--yes</span>. A lógica real fica em <span style="font-family:var(--mono)">scripts/install.sh</span> e <span style="font-family:var(--mono)">scripts/uninstall.sh</span> — os da raiz só chamam ou baixam quando preciso. Links diretos: <a href="https://raw.githubusercontent.com/zonaro/mopivo/master/install.sh">install.sh</a> · <a href="https://raw.githubusercontent.com/zonaro/mopivo/master/uninstall.sh">uninstall.sh</a>.',
            'final.title': 'Bora deixar seu desktop vivo? 🚀',
            'final.lead': 'Um comando. Trinta segundos. Infinitos wallpapers.',
            'final.copyBtn': 'Copiar comando de instalação',
            'footer.tagline': '<b style="color:var(--text)">Mopivo</b> · antes Wallpaper Providers · GPL-3.0-or-later · feito com ♥ para o GNOME',
            'toast.msg': 'Comando copiado! Cole no terminal e dê Enter ✨'
        },

        es: {
            'meta.title': 'Mopivo — Fondos de pantalla increíbles y video-fondos para tu GNOME',
            'meta.description': 'Mopivo trae fondos de 8 fuentes y reproduce video-fondos en tu escritorio. Un comando, 30 segundos, gratis para siempre.',
            'meta.ogTitle': 'Mopivo — tu escritorio cobra vida',
            'meta.ogDescription': '8 fuentes de fondos + video-fondos. Instala con 1 comando. Gratis, open-source, sin cuenta.',
            'nav.features': 'Funciones',
            'nav.providers': 'Fuentes',
            'nav.install': 'Instalación',
            'nav.faq': 'FAQ',
            'nav.download': '⬇ Descargar gratis',
            'hero.iconAlt': 'Mopivo — paisajes en las cuatro estaciones',
            'hero.title': 'Tu GNOME<br><span class="grad">cobra vida en 30 segundos.</span>',
            'hero.sub': 'Mopivo busca fondos en <b style="color:var(--text)">8 fuentes</b>, los aplica con 1 clic y además reproduce <b style="color:var(--text)">video-fondos</b> — tus propios archivos, streaming o páginas web. Hecho para GNOME, gratis, open-source, sin registro.',
            'install.label': 'Copia · pega en la terminal · enter',
            'hero.gnomeLine': '● funciona en GNOME 45 a 50',
            'install.copy': '⧉ Copiar',
            'install.wget': '¿Prefieres <span style="font-family:var(--mono)">wget</span>?',
            'cta.installBtn': '⬇ Instalar ahora — 1 comando',
            'cta.github': '★ Ver en GitHub',
            'hero.micro': '<b>✓</b> Sin sudo &nbsp;·&nbsp; <b>✓</b> queda en tu carpeta personal &nbsp;·&nbsp; <b>✓</b> se desinstala limpio &nbsp;·&nbsp; <b>✓</b> 30 segundos',
            'stat.sources': 'fuentes de fondos',
            'stat.video': 'tipos de video (archivo, streaming, web)',
            'stat.custom': 'personalízalo a tu gusto',
            'stat.free': 'cuentas, rastreadores ni paywall',
            'features.eyebrow': 'Por qué Mopivo',
            'features.title': 'Hecho para quien cambia<br>de fondo todos los días.',
            'features.lead': 'Nada de sitios llenos de anuncios, descargas manuales ni ajustes a ciegas. Busca, filtra, haz clic — listo, aplicado en tu escritorio y pantalla de bloqueo.',
            'card.gallery.title': 'Galería rápida y bonita',
            'card.gallery.desc': 'Búsqueda instantánea, cambio de fuente en un clic, miniaturas que cargan al instante y descargas en la mejor calidad — todo con caché inteligente.',
            'card.filters.title': 'Filtros potentes',
            'card.filters.desc': 'Categorías, nivel de pureza, orden, resolución mínima, proporción, colores y filtro anti-IA — encuentra justo lo que buscas.',
            'card.video.title': 'Video-fondos de verdad',
            'card.video.desc': 'Cada monitor con su propio video, modos de ajuste, volumen, silencio, botones Siguiente y Sorpresa — y soporte para enlaces de YouTube.',
            'card.auto.title': 'Cambio automático',
            'card.auto.desc': 'Pase de diapositivas por tiempo desde cualquier carpeta, desenfoque estático del video, modo aleatorio y soporte para varios monitores.',
            'card.privacy.title': 'Privado por naturaleza',
            'card.privacy.desc': 'Cero telemetría. Tus claves se quedan solo en tu ordenador. Código abierto y auditable, licencia GPL-3.0.',
            'card.lang.title': 'En tu idioma',
            'card.lang.desc': 'Interfaz en inglés con traducciones a portugués y español. Centro de ayuda con guía paso a paso por fuente.',
            'providers.eyebrow': 'Fuentes',
            'providers.title': '8 fuentes. Cero complicaciones.',
            'providers.lead': 'Tres piden un registro rápido y gratis (Pexels, Unsplash, Pixabay); el resto funciona al instante — incluidas tus carpetas y los fondos que generas en la propia app.',
            'prov.wallhaven.desc': 'Filtros completos, NSFW opcional con registro.',
            'prov.wallhaven.tag': 'registro opcional',
            'prov.pexels.desc': 'Curaduría premium para búsquedas vacías.',
            'prov.pexels.tag': 'registro gratis',
            'prov.unsplash.desc': 'Fotografía de altísima calidad.',
            'prov.unsplash.tag': 'registro gratis',
            'prov.safebooru.desc': 'Anime SFW, búsqueda por etiquetas.',
            'prov.safebooru.tag': 'directo, sin registro',
            'prov.pixabay.desc': 'Búsqueda segura siempre activa.',
            'prov.pixabay.tag': 'registro gratis',
            'prov.waifu.desc': 'Anime curado, hasta 30 novedades.',
            'prov.waifu.tag': 'directo, sin registro',
            'prov.local.desc': 'Tu carpeta Imágenes + extras, las más recientes primero.',
            'prov.local.tag': 'directo, sin registro',
            'prov.generator.name': '🎨 Generador',
            'prov.generator.desc': 'Fondos abstractos generados en la propia app.',
            'prov.generator.tag': 'directo, sin registro',
            'install.eyebrow': 'Instalación',
            'install.title': '3 pasos. Sin sudo. Sin riesgo.',
            'step.copy.title': 'Copia el comando',
            'step.copy.desc': 'El comando descarga el instalador oficial de GitHub y verifica lo que tu sistema necesita, con consejos para cada distro.',
            'step.run.title': 'Ejecuta y listo',
            'step.run.desc': 'Coloca la app en su sitio, lo configura todo y crea el icono en el menú de aplicaciones.',
            'step.open.title': 'Abre Mopivo',
            'step.open.desc': 'Busca "Mopivo" en la rejilla de apps y empieza a usarlo. También se ejecuta desde la terminal si lo prefieres.',
            'requirements.label': 'Requisitos · Fedora / Ubuntu / Arch',
            'requirements.code': 'GNOME 45 a 50 · Fedora, Ubuntu, Arch y derivados',
            'requirements.optional': 'Opcional: soporte para enlaces de streaming y páginas web. El instalador usa lo que haya disponible.',
            'faq.eyebrow': 'FAQ',
            'faq.title': 'Preguntas directas, respuestas directas.',
            'faq.q1.q': '¿Es seguro ejecutar un curl | bash?',
            'faq.q1.a': 'Sí. Los scripts son cortos, cualquiera puede leerlos y están en el repositorio público. Solo escriben en tu carpeta personal, nunca piden contraseña de administrador, y puedes revisar el código antes en el navegador. La desinstalación limpia todo con <span style="font-family:var(--mono)">uninstall.sh</span> (ver "¿Cómo lo desinstalo?" más abajo).',
            'faq.q3.q': '¿Funciona en Wayland?',
            'faq.q3.a': 'Sí. Las imágenes funcionan en tu sesión con normalidad. Los video-fondos usan una capa de escritorio cuando está disponible y, si hace falta, pasan a pantalla completa por monitor. La pausa automática tiene una pequeña limitación en Wayland — avisada en la página de Vídeo.',
            'faq.q4.q': '¿Tengo que pagar por una API?',
            'faq.q4.a': 'No. Wallhaven (SFW), Safebooru, Waifu.im, tus carpetas y el generador nativo funcionan sin registro. Pexels, Unsplash y Pixabay piden una clave gratis — la app te dice cuál falta y el Centro de Ayuda te enseña a crearla en 2 minutos.',
            'faq.q5.q': '¿Cómo lo desinstalo?',
            'faq.q5.a': 'Como prefieras — todos hacen la misma limpieza (detiene el video, quita la app, el acceso directo, el icono, la configuración y las traducciones; tu fondo actual queda intacto):<br><br><b>Comando directo (recomendado):</b> <span style="font-family:var(--mono)">curl -fsSL https://raw.githubusercontent.com/zonaro/mopivo/master/uninstall.sh | bash</span><br><b>En el código descargado:</b> <span style="font-family:var(--mono)">./uninstall.sh</span> (o <span style="font-family:var(--mono)">./scripts/uninstall.sh</span> / <span style="font-family:var(--mono)">make uninstall</span>)<br><b>Vía el instalador:</b> <span style="font-family:var(--mono)">./install.sh --uninstall</span> o <span style="font-family:var(--mono)">curl …/install.sh | bash -s -- --uninstall</span>',
            'faq.q6.q': '¿Dónde están los scripts de instalación y desinstalación?',
            'faq.q6.a': 'En la raíz del repositorio: <span style="font-family:var(--mono)">install.sh</span> instala (descarga el código remoto si se ejecuta vía curl) y <span style="font-family:var(--mono)">uninstall.sh</span> elimina. Ambos aceptan <span style="font-family:var(--mono)">--help</span>, <span style="font-family:var(--mono)">--ref &lt;branch|tag&gt;</span> y <span style="font-family:var(--mono)">--yes</span>. La lógica real está en <span style="font-family:var(--mono)">scripts/install.sh</span> y <span style="font-family:var(--mono)">scripts/uninstall.sh</span> — los de la raíz solo llaman o descargan cuando hace falta. Enlaces directos: <a href="https://raw.githubusercontent.com/zonaro/mopivo/master/install.sh">install.sh</a> · <a href="https://raw.githubusercontent.com/zonaro/mopivo/master/uninstall.sh">uninstall.sh</a>.',
            'final.title': '¿Vamos a darle vida a tu escritorio? 🚀',
            'final.lead': 'Un comando. Treinta segundos. Fondos infinitos.',
            'final.copyBtn': 'Copiar comando de instalación',
            'footer.tagline': '<b style="color:var(--text)">Mopivo</b> · antes Wallpaper Providers · GPL-3.0-or-later · hecho con ♥ para GNOME',
            'toast.msg': '¡Comando copiado! Pégalo en la terminal y pulsa Enter ✨'
        }
    };

    function normalizeTag(tag) {
        if (!tag)
            return null;
        var t = String(tag).toLowerCase();
        if (t.indexOf('pt') === 0)
            return 'pt-BR';
        if (t.indexOf('es') === 0)
            return 'es';
        if (t.indexOf('en') === 0)
            return 'en';
        return null;
    }

    function detect() {
        try {
            var saved = window.localStorage.getItem(STORAGE_KEY);
            if (saved && TRANSLATIONS[saved])
                return saved;
        } catch (e) { /* storage unavailable — ignore */ }

        var list = (navigator.languages && navigator.languages.length)
            ? navigator.languages
            : [navigator.language || FALLBACK];
        for (var i = 0; i < list.length; i++) {
            var match = normalizeTag(list[i]);
            if (match)
                return match;
        }
        return FALLBACK;
    }

    function setMeta(attr, value, content) {
        if (!content)
            return;
        var el = document.querySelector('meta[' + attr + '="' + value + '"]');
        if (el)
            el.setAttribute('content', content);
    }

    function apply(lang) {
        var dict = TRANSLATIONS[lang] || TRANSLATIONS[FALLBACK];

        document.documentElement.lang = lang;

        var nodes = document.querySelectorAll('[data-i18n]');
        for (var i = 0; i < nodes.length; i++) {
            var key = nodes[i].getAttribute('data-i18n');
            if (dict[key] != null)
                nodes[i].textContent = dict[key];
        }

        var htmlNodes = document.querySelectorAll('[data-i18n-html]');
        for (var j = 0; j < htmlNodes.length; j++) {
            var hkey = htmlNodes[j].getAttribute('data-i18n-html');
            if (dict[hkey] != null)
                htmlNodes[j].innerHTML = dict[hkey];
        }

        var altNodes = document.querySelectorAll('[data-i18n-alt]');
        for (var k = 0; k < altNodes.length; k++) {
            var akey = altNodes[k].getAttribute('data-i18n-alt');
            if (dict[akey] != null)
                altNodes[k].setAttribute('alt', dict[akey]);
        }

        if (dict['meta.title'])
            document.title = dict['meta.title'];
        setMeta('name', 'description', dict['meta.description']);
        setMeta('property', 'og:title', dict['meta.ogTitle']);
        setMeta('property', 'og:description', dict['meta.ogDescription']);

        var buttons = document.querySelectorAll('.lang-switch [data-lang]');
        for (var m = 0; m < buttons.length; m++) {
            var active = buttons[m].getAttribute('data-lang') === lang;
            buttons[m].classList.toggle('active', active);
            buttons[m].setAttribute('aria-pressed', active ? 'true' : 'false');
        }
    }

    function setLang(lang) {
        if (SUPPORTED.indexOf(lang) === -1)
            lang = FALLBACK;
        try {
            window.localStorage.setItem(STORAGE_KEY, lang);
        } catch (e) { /* storage unavailable — ignore */ }
        apply(lang);
    }

    function init() {
        var triggers = document.querySelectorAll('.lang-switch [data-lang]');
        for (var i = 0; i < triggers.length; i++) {
            triggers[i].addEventListener('click', (function (btn) {
                return function () { setLang(btn.getAttribute('data-lang')); };
            })(triggers[i]));
        }
        apply(detect());
    }

    // Exposed for tests / external use.
    window.MopivoI18N = { translations: TRANSLATIONS, setLang: setLang, detect: detect };

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', init);
    else
        init();
})();
