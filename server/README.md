# BookOS — Infraestructura de actualizaciones (lado servidor)

El cliente (BookOS Settings) **ya implementa** todo el flujo de canales y
actualización de versión. Para que funcione, `bookos.es` debe servir estos dos
artefactos y un repo DNF por canal. Aquí están los archivos de referencia,
alineados con el layout real del NAS (`BookOS-ISO/publish-0.6.sh`).

## Estado actual del servidor (comprobado 2026-06-20)

| Recurso | URL | Estado |
|---------|-----|--------|
| Manifiesto | `bookos.es/api/releases.json` | 200 pero **vacío** (`releases:[]`, `latest:null`) |
| Repo apps | `bookos.es/store-files/bookos.repo` | 200 — **solo** `[bookos]`, faltan los 3 de canal |
| Repo **dev** | `bookos.es/repo/fedora/44/x86_64/dev/` | ✅ 200 — `bookos-meta 0.6-1.fc44` + stack |
| Repo **stable** | `…/stable/` | ❌ 404 |
| Repo **beta** | `…/beta/` | ❌ 404 |

→ El stack está publicado en **dev**. Falta: poblar `releases.json`, subir el
`bookos.repo` de 3 canales, y publicar `stable`/`beta`.

## Cómo funciona el cliente (contrato)

1. **Canal** — `set_update_channel(stable|beta|dev)` escribe `CHANNEL=` en
   `/etc/bookos-update.conf` (o `~/.config/bookos-update.conf` sin sudo).
2. **Comprobar** — `refresh_bookos_release`:
   `GET bookos.es/api/releases.json?channel=<canal>` → `select_release()`
   (acepta `by_channel` objeto **o** array, o `releases[]`) → escribe
   `/etc/bookos-release` (o `~/.config/bookos-release-cache`).
3. **¿Update?** — `update_is_available(version, INSTALLED)` compara la `version`
   del manifiesto contra `INSTALLED=` de `/etc/bookos-release`. Final gana a
   pre-release del mismo core (`0.6 > 0.6-rc.1`). Si ya está en esa versión,
   **no** muestra update (correcto).
4. **Aplicar** — `apply_bookos_release`: snapshot btrfs + 
   ```
   dnf upgrade -y --refresh \
     --enablerepo=bookos-<canal> --disablerepo=bookos-<otros> bookos-meta
   ```
   Cambiar de canal y aplicar **sube o baja** a la versión de ese canal.

## Archivos de este directorio

### `releases.json` → `bookos.es/api/releases.json`
`by_channel` como **objeto** (canónico). Campos que lee el cliente por release:
`version` (obligatorio), `size_human` o `size` (bytes), `changelog_url`,
`notes`, `notes_en` (`\n` para saltos). **`version` debe coincidir con el RPM
`bookos-meta` publicado en ese canal** (hoy dev = 0.6).

### `bookos.repo` → `bookos.es/store-files/bookos.repo`
Añade `[bookos-stable]`, `[bookos-beta]`, `[bookos-dev]` con
`baseurl=https://bookos.es/repo/fedora/$releasever/$basearch/<canal>/` además
del `[bookos]` de apps. Sin estos tres, `--enablerepo=bookos-<canal>` falla.

## Publicar / completar (comandos)

El paquete `bookos-meta` ya existe: `BookOS-ISO/rpm/bookos-meta.spec` (v0.6,
noarch, solo `Requires:`). Para publicar un canal con el script existente:

```bash
cd ~/Descargas/BookOS/BookOS-ISO
./publish-0.6.sh stable 0.6      # crea repo/.../stable/ + createrepo_c
./publish-0.6.sh beta   0.6
# dev ya está publicado
```

Subir manualmente los dos artefactos web al NAS/web root:
```bash
scp server/releases.json  evelynx08@A5-NAS:/tmp/  # → /var/www/.../api/releases.json
scp server/bookos.repo    evelynx08@A5-NAS:/tmp/  # → /var/www/.../store-files/bookos.repo
```

### Subir una versión (ej. 0.7)
1. `Version: 0.7` en `bookos-meta.spec` (y los specs del set), `rpmbuild`.
2. `./publish-0.6.sh stable 0.7` (sube RPMs + `createrepo_c`).
3. `by_channel.stable.version = "0.7"` en `releases.json` → subir.
4. El cliente lo detecta en el próximo refresh.

## Pendiente de seguridad ⚠️
- `gpgcheck=0` = repos **sin firma**. Producción: firmar RPM con GPG,
  publicar la clave, `gpgcheck=1` + `gpgkey=`.
- `releases.json` reserva `signed_with`/`public_keys` (minisign/gpg) — firmar el
  manifiesto y verificarlo en el cliente más adelante.
- `bookos.es/changelog` da **404**: crear las URLs de `changelog_url`.
