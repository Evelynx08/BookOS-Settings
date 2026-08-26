//! Color dinámico al estilo Material You: del fondo de pantalla salen unas
//! cuantas semillas, de cada semilla sale una paleta tonal completa, y de ahí
//! las variables CSS que consumen las apps de BookOS.
//!
//! Por qué OkLCh y no HCT (lo que usa Android): HCT es CAM16 + L*, unas 600
//! líneas de tablas y matrices con dependencias que este binario no tiene.
//! OkLCh es perceptualmente equivalente para lo que hace falta aquí —tono
//! estable al cambiar la luminosidad, croma comparable entre tonos— en 60
//! líneas y sin dependencias. El eje de "tono" (0-100) sí se mantiene en L*
//! como en Material, para que los contrastes salgan donde se esperan.

// ── sRGB ↔ OkLab ─────────────────────────────────────────────────────────

fn srgb_to_linear(c: f64) -> f64 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}
fn linear_to_srgb(c: f64) -> f64 {
    if c <= 0.0031308 { c * 12.92 } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
}

fn linear_to_oklab(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    let m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    let s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    let (l, m, s) = (l.cbrt(), m.cbrt(), s.cbrt());
    (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
     1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
     0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)
}

fn oklab_to_linear(l: f64, a: f64, b: f64) -> (f64, f64, f64) {
    let l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    let m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    let s_ = l - 0.0894841775 * a - 1.2914855480 * b;
    let (l3, m3, s3) = (l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
    ( 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
     -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
     -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3)
}

/// (L, C, H°) desde un sRGB de 8 bits.
pub fn rgb_to_oklch(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let (rl, gl, bl) = (srgb_to_linear(r as f64 / 255.0),
                        srgb_to_linear(g as f64 / 255.0),
                        srgb_to_linear(b as f64 / 255.0));
    let (l, a, bb) = linear_to_oklab(rl, gl, bl);
    let c = (a * a + bb * bb).sqrt();
    let mut h = bb.atan2(a).to_degrees();
    if h < 0.0 { h += 360.0; }
    (l, c, h)
}

fn oklch_to_rgb_raw(l: f64, c: f64, h: f64) -> (f64, f64, f64) {
    let hr = h.to_radians();
    let (rl, gl, bl) = oklab_to_linear(l, c * hr.cos(), c * hr.sin());
    (linear_to_srgb(rl), linear_to_srgb(gl), linear_to_srgb(bl))
}

fn in_gamut(l: f64, c: f64, h: f64) -> bool {
    let (r, g, b) = oklch_to_rgb_raw(l, c, h);
    let lo = -0.0005;
    let hi = 1.0005;
    r >= lo && r <= hi && g >= lo && g <= hi && b >= lo && b <= hi
}

/// Baja el croma hasta que el color entra en sRGB. Recortar los canales a
/// pelo (clamp 0-1) desplaza el tono —un rojo saturado se vuelve naranja—,
/// que es justo lo que arruina una paleta generada.
fn oklch_to_hex(l: f64, c: f64, h: f64) -> String {
    let mut c = c.max(0.0);
    if !in_gamut(l, c, h) {
        let (mut lo, mut hi) = (0.0, c);
        for _ in 0..24 {
            let mid = (lo + hi) / 2.0;
            if in_gamut(l, mid, h) { lo = mid } else { hi = mid }
        }
        c = lo;
    }
    let (r, g, b) = oklch_to_rgb_raw(l, c, h);
    format!("#{:02X}{:02X}{:02X}",
        (r * 255.0).round().clamp(0.0, 255.0) as u8,
        (g * 255.0).round().clamp(0.0, 255.0) as u8,
        (b * 255.0).round().clamp(0.0, 255.0) as u8)
}

/// Tono Material (0 = negro, 100 = blanco) → L de OkLab. Se pasa por L* de
/// CIELAB a propósito: los tonos de Material están calibrados en esa escala,
/// así que reutilizarla deja los contrastes donde deben estar.
fn tone_to_okl(t: f64) -> f64 {
    let t = t.clamp(0.0, 100.0);
    let fy = (t + 16.0) / 116.0;
    let y = if t > 8.0 { fy * fy * fy } else { t / 903.2963 };
    linear_to_oklab(y, y, y).0
}

// ── Paleta tonal ─────────────────────────────────────────────────────────

/// Una rampa de un solo tono: mismo hue y croma, la luminosidad la pide quien
/// la usa. Es la pieza con la que se montan primary / secondary / neutral…
#[derive(Clone, Copy)]
pub struct Tonal { hue: f64, chroma: f64 }

impl Tonal {
    pub fn tone(&self, t: f64) -> String { oklch_to_hex(tone_to_okl(t), self.chroma, self.hue) }
    /// Igual que `tone`, pero devolviendo los canales para poder componer
    /// rgba() con alfa (los divisores y hovers de las apps son translúcidos).
    fn tone_rgb(&self, t: f64) -> (u8, u8, u8) {
        let hex = self.tone(t);
        (u8::from_str_radix(&hex[1..3], 16).unwrap_or(0),
         u8::from_str_radix(&hex[3..5], 16).unwrap_or(0),
         u8::from_str_radix(&hex[5..7], 16).unwrap_or(0))
    }
}

/// Los cuatro estilos que se ofrecen, con el mismo papel que en Android:
/// cambian cuánto croma se conserva y cuánto se giran los tonos secundarios.
#[derive(Clone, Copy, PartialEq)]
pub enum Style { Vibrant, Expressive, Muted, Neutral }

impl Style {
    pub fn from_str(s: &str) -> Style {
        match s {
            "expressive" => Style::Expressive,
            "muted"      => Style::Muted,
            "neutral"    => Style::Neutral,
            _            => Style::Vibrant,
        }
    }
    pub fn id(&self) -> &'static str {
        match self { Style::Vibrant => "vibrant", Style::Expressive => "expressive",
                     Style::Muted => "muted", Style::Neutral => "neutral" }
    }
}

pub struct Scheme {
    pub primary: Tonal,
    pub secondary: Tonal,
    pub tertiary: Tonal,
    pub neutral: Tonal,
    pub neutral_variant: Tonal,
}

/// Construye las cinco rampas a partir de una semilla y un estilo.
pub fn scheme_from_seed(seed_hex: &str, style: Style) -> Scheme {
    let (r, g, b) = hex_to_rgb(seed_hex).unwrap_or((0, 122, 255));
    let (_, seed_c, seed_h) = rgb_to_oklch(r, g, b);

    // Una semilla casi gris no tiene tono utilizable: el atan2 devuelve ruido.
    // Se cae al azul de BookOS antes que generar una paleta con un tono al azar.
    let h = if seed_c < 0.012 { 250.0 } else { seed_h };

    // (primary, secondary, tertiary, neutral, neutralVariant, giro de tertiary,
    //  giro de secondary). El croma de primary se topa con el de la semilla en
    //  los estilos suaves para que un fondo apagado no salga fosforito.
    let (pc, sc, tc, nc, nvc, t_rot, s_rot) = match style {
        Style::Vibrant    => (0.155, 0.075, 0.140, 0.013, 0.030,  60.0,   0.0),
        Style::Expressive => (0.130, 0.100, 0.140, 0.012, 0.028, 120.0,  35.0),
        Style::Muted      => (seed_c.min(0.085).max(0.055), 0.042, 0.055, 0.009, 0.020, 60.0, 0.0),
        Style::Neutral    => (0.030, 0.020, 0.022, 0.005, 0.011,  30.0,   0.0),
    };

    Scheme {
        primary:         Tonal { hue: h,                     chroma: pc },
        secondary:       Tonal { hue: (h + s_rot) % 360.0,   chroma: sc },
        tertiary:        Tonal { hue: (h + t_rot) % 360.0,   chroma: tc },
        neutral:         Tonal { hue: h,                     chroma: nc },
        neutral_variant: Tonal { hue: h,                     chroma: nvc },
    }
}

pub fn hex_to_rgb(hex: &str) -> Option<(u8, u8, u8)> {
    let h = hex.trim_start_matches('#');
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) { return None; }
    Some((u8::from_str_radix(&h[0..2], 16).ok()?,
          u8::from_str_radix(&h[2..4], 16).ok()?,
          u8::from_str_radix(&h[4..6], 16).ok()?))
}

// ── Roles → variables CSS de las apps de BookOS ──────────────────────────
//
// Las apps (Ajustes, Reloj, Notas, Store, Player, Viewer, Shell) comparten el
// mismo vocabulario de variables: --bg --card --tx --tx2 --div --brd --hov
// --act --blue --sbg --toff. Teñirlas es lo que hace que TODA la app siga al
// fondo de pantalla sin tocar una sola regla de sus hojas de estilo.
//
// --green/--red/--orange/--yellow se dejan como están: son semánticos (error,
// éxito, aviso). Material hace lo mismo con su paleta de error.

pub struct Roles { pub pairs: Vec<(&'static str, String)> }

fn rgba(c: (u8, u8, u8), a: f64) -> String {
    format!("rgba({},{},{},{})", c.0, c.1, c.2, a)
}

pub fn roles(s: &Scheme, dark: bool) -> Roles {
    let p = &s.primary;
    let n = &s.neutral;
    let nv = &s.neutral_variant;
    let t = &s.tertiary;

    // El acento sobre el que se componen divisores, hovers y bordes: teñirlos
    // con el primario (en vez de con negro/blanco puro) es lo que da el aspecto
    // "toda la interfaz sabe de qué color es el fondo".
    let (accent, overlay, pairs): (String, (u8, u8, u8), Vec<(&'static str, String)>) = if dark {
        let acc = p.tone(80.0);
        let ov = p.tone_rgb(80.0);
        (acc.clone(), ov, vec![
            ("--bg",     n.tone(6.0)),
            ("--card",   n.tone(12.0)),
            ("--sbg",    rgba(ov, 0.10)),
            ("--tx",     n.tone(96.0)),
            ("--tx2",    nv.tone(68.0)),
            ("--blue",   acc.clone()),
            ("--toff",   n.tone(30.0)),
            ("--div",    rgba(ov, 0.13)),
            ("--brd",    rgba(ov, 0.10)),
            ("--hov",    rgba(ov, 0.09)),
            ("--act",    rgba(ov, 0.16)),
            // Extras para quien los quiera: contenedor del acento y su texto.
            ("--accent-container",    p.tone(30.0)),
            ("--on-accent",           p.tone(20.0)),
            ("--on-accent-container", p.tone(90.0)),
            ("--accent-2",            s.secondary.tone(80.0)),
            ("--accent-3",            t.tone(80.0)),
        ])
    } else {
        let acc = p.tone(42.0);
        let ov = p.tone_rgb(42.0);
        (acc.clone(), ov, vec![
            ("--bg",     n.tone(96.0)),
            ("--card",   n.tone(100.0)),
            ("--sbg",    rgba(ov, 0.08)),
            ("--tx",     n.tone(12.0)),
            ("--tx2",    nv.tone(45.0)),
            ("--blue",   acc.clone()),
            ("--toff",   n.tone(86.0)),
            ("--div",    rgba(ov, 0.14)),
            ("--brd",    rgba(ov, 0.12)),
            ("--hov",    rgba(ov, 0.07)),
            ("--act",    rgba(ov, 0.13)),
            ("--accent-container",    p.tone(90.0)),
            ("--on-accent",           "#FFFFFF".to_string()),
            ("--on-accent-container", p.tone(20.0)),
            ("--accent-2",            s.secondary.tone(42.0)),
            ("--accent-3",            t.tone(42.0)),
        ])
    };
    let _ = (accent, overlay);
    Roles { pairs }
}

/// Hoja que se carga DESPUÉS de la de cada app. Misma especificidad y más
/// tarde en la cascada = gana, sin tener que tocar las reglas originales.
pub fn css(s: &Scheme) -> String {
    let light = roles(s, false);
    let dark = roles(s, true);
    let fmt = |r: &Roles| r.pairs.iter()
        .map(|(k, v)| format!("{}:{}", k, v))
        .collect::<Vec<_>>().join(";");
    let l = fmt(&light);
    let d = fmt(&dark);
    format!(
"/* Generado por BookOS Settings — color dinámico del fondo de pantalla.\n\
   No editar: se reescribe cada vez que se aplica una paleta. */\n\
:root,:root.light-mode{{{l}}}\n\
:root.dark-mode{{{d}}}\n\
@media(prefers-color-scheme:dark){{:root:not(.light-mode){{{d}}}}}\n")
}

/// El mismo contenido en JSON, para el front (previsualización de las fichas)
/// y para que otras piezas del sistema puedan leer la paleta sin parsear CSS.
pub fn json(seed: &str, style: Style, s: &Scheme) -> String {
    let one = |r: &Roles| r.pairs.iter()
        .map(|(k, v)| format!("\"{}\":\"{}\"", k.trim_start_matches("--"), v))
        .collect::<Vec<_>>().join(",");
    let tones = |t: &Tonal| [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 95.0]
        .iter().map(|x| format!("\"{}\"", t.tone(*x))).collect::<Vec<_>>().join(",");
    format!(
        "{{\"seed\":\"{}\",\"style\":\"{}\",\"light\":{{{}}},\"dark\":{{{}}},\
          \"tones\":{{\"primary\":[{}],\"secondary\":[{}],\"tertiary\":[{}],\"neutral\":[{}]}}}}",
        seed, style.id(), one(&roles(s, false)), one(&roles(s, true)),
        tones(&s.primary), tones(&s.secondary), tones(&s.tertiary), tones(&s.neutral))
}

// ── Esquema de color nativo de KDE Plasma (.colors) ──────────────────────
//
// Mismo reparto de tonos que `roles()`, pero en el formato `r,g,b` que usa
// KDE (kdeglobals / plasma-apply-colorscheme) en vez de CSS. Esto es lo que
// hace que KdeControlStation y los SVG del desktoptheme (que ya leen
// Kirigami.Theme / current-color-scheme) sigan la paleta sin tocarles una
// línea: heredan el esquema de color de Plasma como cualquier app Qt/QML.
//
// Los semánticos (negativo/neutro/positivo) se dejan fijos, calcados de los
// esquemas estáticos de BookOS — mismo criterio que en `roles()`. "Visited"
// no es semántico de verdad (es un matiz de enlace visitado), así que ahí
// sí se usa el secundario de la paleta en vez de un valor fijo.
fn rgb_str(c: (u8, u8, u8)) -> String { format!("{},{},{}", c.0, c.1, c.2) }

pub fn kde_colors(s: &Scheme, dark: bool) -> String {
    let p = &s.primary;
    let n = &s.neutral;
    let nv = &s.neutral_variant;

    let (bg, chrome, card, tx, tx2, accent, visited, negative, neutral_c, positive, name) = if dark {
        (n.tone_rgb(6.0), n.tone_rgb(3.0), n.tone_rgb(12.0), n.tone_rgb(96.0), nv.tone_rgb(68.0),
         p.tone_rgb(80.0), s.secondary.tone_rgb(70.0),
         (255u8,69u8,58u8), (255u8,214u8,10u8), (48u8,209u8,88u8), "BookOS Dinámico Oscuro")
    } else {
        (n.tone_rgb(96.0), n.tone_rgb(90.0), n.tone_rgb(100.0), n.tone_rgb(12.0), nv.tone_rgb(45.0),
         p.tone_rgb(42.0), s.secondary.tone_rgb(45.0),
         (255u8,59u8,48u8), (255u8,204u8,0u8), (52u8,199u8,89u8), "BookOS Dinámico Claro")
    };

    let block = |bg_normal: (u8,u8,u8), bg_alt: (u8,u8,u8)| format!(
"BackgroundAlternate={}
BackgroundNormal={}
DecorationFocus={acc}
DecorationHover={acc}
ForegroundActive={acc}
ForegroundInactive={tx2}
ForegroundLink={acc}
ForegroundNegative={neg}
ForegroundNeutral={neu}
ForegroundNormal={tx}
ForegroundPositive={pos}
ForegroundVisited={vis}
", rgb_str(bg_alt), rgb_str(bg_normal),
        acc=rgb_str(accent), tx2=rgb_str(tx2), neg=rgb_str(negative), neu=rgb_str(neutral_c),
        tx=rgb_str(tx), pos=rgb_str(positive), vis=rgb_str(visited));

    format!(
"[ColorEffects:Inactive]
ChangeSelectionColor=true

[ColorScheme]
Name={name}

[Colors:Button]
{button}
[Colors:Complementary]
{complementary}
[Colors:Header]
{header}
[Colors:NormalBackground]
BackgroundNormal={bg}
ForegroundNormal={tx}

[Colors:Selection]
BackgroundAlternate={acc}
BackgroundNormal={acc}
DecorationFocus={acc}
DecorationHover={acc}
ForegroundActive=255,255,255
ForegroundInactive=200,200,200
ForegroundLink=255,255,255
ForegroundNegative={neg}
ForegroundNeutral={neu}
ForegroundNormal=255,255,255
ForegroundPositive={pos}
ForegroundVisited={vis}

[Colors:Tooltip]
{tooltip}
[Colors:View]
{view}
[Colors:Window]
{window}
[General]
ColorScheme={id}
Name={name}
shadeSortColumn=true

[KDE]
contrast=4

[WM]
activeBackground={bg}
activeBlend={bg}
activeForeground={tx}
inactiveBackground={chrome}
inactiveBlend={chrome}
inactiveForeground={tx2}
",
        name=name, id=if dark {"BookOSDynamicDark"} else {"BookOSDynamicLight"},
        bg=rgb_str(bg), chrome=rgb_str(chrome), tx=rgb_str(tx), tx2=rgb_str(tx2),
        acc=rgb_str(accent), neg=rgb_str(negative), neu=rgb_str(neutral_c), pos=rgb_str(positive), vis=rgb_str(visited),
        button=block(card, card),
        complementary=block(chrome, card),
        header=block(chrome, card),
        tooltip=block(chrome, card),
        view=block(bg, card),
        window=block(bg, card),
    )
}

// ── Kvantum (apps Qt que no leen Kirigami.Theme) ─────────────────────────
//
// El .kvconfig de BookOS solo tiene color de verdad en un puñado de valores
// que se repiten tal cual por todo el archivo (10 en total, contados en las
// plantillas). Por eso la sustitución es un find&replace de placeholders
// sobre una copia literal del .kvconfig original, no un generador de
// secciones: no hay que tocar las claves de estilo (SVG, tamaños, flags).
fn hex(c: (u8, u8, u8)) -> String { format!("#{:02X}{:02X}{:02X}", c.0, c.1, c.2) }

pub fn kvantum_substitutions(s: &Scheme, dark: bool) -> Vec<(&'static str, String)> {
    let p = &s.primary;
    let n = &s.neutral;
    if dark {
        vec![
            ("{{BG}}",         hex(n.tone_rgb(6.0))),
            ("{{CHROME}}",     hex(n.tone_rgb(3.0))),
            ("{{CARD}}",       hex(n.tone_rgb(12.0))),
            ("{{CARD2}}",      hex(n.tone_rgb(18.0))),
            ("{{ACCENT_A30}}", format!("{}4D", hex(p.tone_rgb(80.0)))),
            ("{{ACCENT}}",     hex(p.tone_rgb(80.0))),
            ("{{TX}}",         hex(n.tone_rgb(96.0))),
            ("{{TX2}}",        hex(s.neutral_variant.tone_rgb(68.0))),
            ("{{DISABLED}}",   hex(n.tone_rgb(24.0))),
            ("{{VISITED}}",    hex(s.secondary.tone_rgb(70.0))),
        ]
    } else {
        vec![
            ("{{BG}}",         hex(n.tone_rgb(96.0))),
            ("{{CHROME}}",     hex(n.tone_rgb(90.0))),
            ("{{CARD}}",       hex(n.tone_rgb(100.0))),
            ("{{CARD2}}",      hex(n.tone_rgb(85.0))),
            ("{{ACCENT_A30}}", format!("{}4D", hex(p.tone_rgb(42.0)))),
            ("{{ACCENT}}",     hex(p.tone_rgb(42.0))),
            ("{{TX}}",         hex(n.tone_rgb(12.0))),
            ("{{TX2}}",        hex(s.neutral_variant.tone_rgb(45.0))),
            ("{{DISABLED}}",   hex(n.tone_rgb(78.0))),
            ("{{VISITED}}",    hex(s.secondary.tone_rgb(45.0))),
        ]
    }
}

/// Aplica las sustituciones de `kvantum_substitutions` a una plantilla.
pub fn kvantum_config(template: &str, s: &Scheme, dark: bool) -> String {
    let mut out = template.to_string();
    for (ph, val) in kvantum_substitutions(s, dark) {
        out = out.replace(ph, &val);
    }
    out
}

// ── Semillas del fondo de pantalla ───────────────────────────────────────

/// Extrae hasta `want` colores representativos, con tonos separados entre sí.
///
/// El histograma de ImageMagick da los colores dominantes, pero en crudo salen
/// cinco variantes del mismo azul: si un fondo es mayoritariamente de un color,
/// las 16 entradas más pobladas son ese color. Por eso se agrupa por TONO y de
/// cada grupo sale un único representante.
pub fn seeds_from_image(path: &str) -> Result<Vec<String>, String> {
    use std::process::Command;
    let magick = if Command::new("magick").arg("-version").output().is_ok() { "magick" } else { "convert" };
    let out = Command::new(magick)
        .args([path, "-resize", "160x160!", "-colors", "48", "-format", "%c", "histogram:info:"])
        .output()
        .map_err(|e| format!("ImageMagick no disponible: {}", e))?;
    if !out.status.success() { return Err("ImageMagick falló al leer la imagen".into()); }
    let text = String::from_utf8_lossy(&out.stdout);

    struct Bucket { hue: f64, score: f64, chroma: f64, r: f64, g: f64, b: f64, w: f64 }
    let mut buckets: Vec<Bucket> = Vec::new();
    let mut gray_score = 0.0f64;
    let mut gray_hue = 250.0f64;

    for line in text.lines() {
        // Formato: "   1234: ( 41, 62,110) #295A6E srgb(...)"
        let count: f64 = match line.trim().split(':').next().and_then(|c| c.trim().parse().ok()) {
            Some(c) => c, None => continue,
        };
        let hex = match line.split('#').nth(1) { Some(h) => h, None => continue };
        let hex: String = hex.chars().take(6).collect();
        let (r, g, b) = match hex_to_rgb(&hex) { Some(v) => v, None => continue };
        let (l, c, h) = rgb_to_oklch(r, g, b);
        // Ni lo casi negro ni lo casi blanco sirven de semilla: no tienen tono
        // fiable y de ellos no sale ninguna paleta distinguible.
        if !(0.20..=0.92).contains(&l) { continue; }
        // Superficie x croma, igual que el acento del SDDM: un color mayoritario
        // aunque apagado manda sobre un destello saturado de cuatro píxeles.
        let score = count * (0.20 + c * 6.0).min(1.6);
        if c < 0.025 {
            if score > gray_score { gray_score = score; gray_hue = h; }
            continue;
        }
        // Los tonos a menos de 22° se consideran el mismo color y se funden,
        // ponderando por la puntuación para que el representante caiga donde
        // está el peso, no en el primero que llegó.
        match buckets.iter_mut().find(|b| {
            let d = (b.hue - h).abs();
            d.min(360.0 - d) < 22.0
        }) {
            Some(bk) => {
                let w = bk.w + score;
                bk.hue = circ_mean(bk.hue, bk.w, h, score);
                bk.r = (bk.r * bk.w + r as f64 * score) / w;
                bk.g = (bk.g * bk.w + g as f64 * score) / w;
                bk.b = (bk.b * bk.w + b as f64 * score) / w;
                bk.chroma = (bk.chroma * bk.w + c * score) / w;
                bk.score += score;
                bk.w = w;
            }
            None => buckets.push(Bucket { hue: h, score, chroma: c, w: score,
                                          r: r as f64, g: g as f64, b: b as f64 }),
        }
    }

    buckets.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    // Cuatro semillas del fondo: las más "interesantes" (mayor score = más
    // presencia x croma) primero. Si el fondo no da para tantos tonos
    // distintos, se rellena con el gris neutro; si tampoco hay eso, se
    // devuelven menos de 4 en vez de inventar color donde no lo hay.
    let want = 4;
    let mut seeds: Vec<String> = buckets.iter().take(want).map(|b| {
        // El representante se normaliza a un croma y una luminosidad usables:
        // la semilla es solo el TONO, la paleta ya decide el resto.
        let (_, _, h) = rgb_to_oklch(b.r.round() as u8, b.g.round() as u8, b.b.round() as u8);
        oklch_to_hex(tone_to_okl(60.0), b.chroma.clamp(0.05, 0.16), h)
    }).collect();

    // Relleno neutro solo si hacen falta plazas: fondos (blanco y negro, nieve,
    // noche) de los que no sale ningún color honesto igual necesitan una
    // opción, pero un fondo con 4+ tonos reales no debería perder una plaza
    // por un gris que nadie pidió.
    if seeds.len() < want {
        seeds.push(oklch_to_hex(tone_to_okl(60.0), 0.02, gray_hue));
    }

    if seeds.is_empty() { return Err("sin colores utilizables en la imagen".into()); }
    Ok(seeds)
}

/// Media de dos ángulos en el círculo de tono, ponderada. Promediar 350° y 10°
/// a pelo da 180° (el color opuesto), que es el error clásico al agrupar tonos.
fn circ_mean(h1: f64, w1: f64, h2: f64, w2: f64) -> f64 {
    let (a1, a2) = (h1.to_radians(), h2.to_radians());
    let x = a1.cos() * w1 + a2.cos() * w2;
    let y = a1.sin() * w1 + a2.sin() * w2;
    let mut h = y.atan2(x).to_degrees();
    if h < 0.0 { h += 360.0; }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Un color de ida y vuelta por OkLCh no debe moverse: si esto falla, toda
    /// la paleta sale desviada sin que se note de dónde viene.
    #[test]
    fn roundtrip_srgb() {
        for hex in ["#007AFF", "#FF3B30", "#34C759", "#8E8E93", "#000000", "#FFFFFF"] {
            let (r, g, b) = hex_to_rgb(hex).unwrap();
            let (l, c, h) = rgb_to_oklch(r, g, b);
            assert_eq!(oklch_to_hex(l, c, h), hex, "roundtrip de {}", hex);
        }
    }

    /// La rampa tonal tiene que ser monótona en luminosidad y quedar dentro de
    /// sRGB; sin el recorte de croma un rojo saturado se volvería naranja.
    #[test]
    fn tonal_ramp_is_monotonic_and_in_gamut() {
        let s = scheme_from_seed("#B3261E", Style::Vibrant);
        let mut prev = -1.0;
        for t in [0.0, 10.0, 20.0, 40.0, 60.0, 80.0, 95.0, 100.0] {
            let hex = s.primary.tone(t);
            let (r, g, b) = hex_to_rgb(&hex).unwrap();
            let (l, _, _) = rgb_to_oklch(r, g, b);
            assert!(l > prev, "tono {} no sube en luminosidad", t);
            prev = l;
        }
    }

    /// Una semilla gris no tiene tono utilizable: debe caer al azul de BookOS
    /// en vez de generar una paleta con un hue de ruido.
    #[test]
    fn gray_seed_falls_back() {
        let s = scheme_from_seed("#808080", Style::Vibrant);
        assert!((s.primary.hue - 250.0).abs() < 0.001);
    }

    /// Las plantillas Kvantum deben quedar sin placeholders sin sustituir
    /// tras aplicar la paleta, en ambos modos: si un placeholder no tiene
    /// entrada en `kvantum_substitutions`, el .kvconfig sale con literal
    /// "{{...}}" en vez de un color y Kvantum lo ignora en silencio.
    #[test]
    fn kvantum_templates_have_no_leftover_placeholders() {
        let s = scheme_from_seed("#0A84FF", Style::Vibrant);
        for (tmpl, dark) in [
            (include_str!("../extra/kvantum/bookos-dark-blue.kvconfig.tmpl"), true),
            (include_str!("../extra/kvantum/bookos-light-blue.kvconfig.tmpl"), false),
        ] {
            let out = kvantum_config(tmpl, &s, dark);
            assert!(!out.contains("{{"), "quedó un placeholder sin sustituir (dark={})", dark);
        }
    }
}
