# Localization — wallpaper-providers-gnome

This directory contains gettext translation files for the extension preferences.

## Structure

```
locale/
├── wallpaper-providers-gnome.pot          # Translation template (source of truth)
├── pt_BR/LC_MESSAGES/
│   └── wallpaper-providers-gnome.po       # Brazilian Portuguese
├── es/LC_MESSAGES/
│   └── wallpaper-providers-gnome.po       # Spanish
└── README.md                    # This file
```

## Compiling Translations

After editing `.po` files, compile them to `.mo` binary format:

```bash
# Compile Brazilian Portuguese
msgfmt locale/pt_BR/LC_MESSAGES/wallpaper-providers-gnome.po \
  -o locale/pt_BR/LC_MESSAGES/wallpaper-providers-gnome.mo

# Compile Spanish
msgfmt locale/es/LC_MESSAGES/wallpaper-providers-gnome.po \
  -o locale/es/LC_MESSAGES/wallpaper-providers-gnome.mo
```

Or compile all at once:

```bash
for po in locale/*/LC_MESSAGES/wallpaper-providers-gnome.po; do
  msgfmt "$po" -o "${po%.po}.mo"
done
```

## Updating the Template

After adding/changing translatable strings (`_("...")`) in the code, regenerate the template:

```bash
xgettext --language=JavaScript \
  --keyword=_ \
  --keyword=N_ \
  --from-code=UTF-8 \
  --output=locale/wallpaper-providers-gnome.pot \
  prefs.js \
  ui/prefs_helpers.js \
  lib/i18n.js
```

Then merge into existing `.po` files:

```bash
msgmerge --update locale/pt_BR/LC_MESSAGES/wallpaper-providers-gnome.po locale/wallpaper-providers-gnome.pot
msgmerge --update locale/es/LC_MESSAGES/wallpaper-providers-gnome.po locale/wallpaper-providers-gnome.pot
```

## Supported Languages

| Code   | Language              | Status     |
|--------|-----------------------|------------|
| `en`   | English               | Default    |
| `pt_BR`| Brazilian Portuguese  | Complete   |
| `es`   | Spanish               | Complete   |

## Adding a New Language

1. Copy `wallpaper-providers-gnome.pot` to `locale/<LANG>/LC_MESSAGES/wallpaper-providers-gnome.po`
2. Fill in the `msgstr` translations
3. Compile with `msgfmt`
4. The extension will auto-detect the system locale

## Testing

To test a specific language, set the `LANGUAGE` environment variable:

```bash
LANGUAGE=pt_BR gnome-extensions prefs wallpaper-providers-gnome@redclaw.com.br
```

Or change the language in the extension's Preferences > Providers > Language.
