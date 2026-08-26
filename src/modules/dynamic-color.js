// Color dinámico: la paleta que Ajustes genera desde el fondo de pantalla.
//
// El backend deja la hoja en ~/.config/bookos/palette.css. Aquí solo se
// inyecta en un <style> que va SIEMPRE al final de <head>: misma
// especificidad que las reglas de style.css y más tarde en la cascada, así
// que gana sin tener que tocar una sola regla original.
//
// Este fichero es el cliente que comparten todas las apps de BookOS (Ajustes,
// Reloj, Notas, Store, Player, Viewer, Shell). Si se cambia aquí, cópiese tal
// cual: no depende de nada del resto de Ajustes salvo `tauriInvoke`.

import{tauriInvoke}from'../tauri-api.js';

const STYLE_ID='bookos-dynamic-palette';
const CACHE_KEY='__bookos_palette_css__';

/// Solo pinta: mete (o reemplaza) la hoja de la paleta en el DOM SIN tocar la
/// caché de localStorage. Es lo que usa la previsualización en vivo de la
/// página de Fondos — elegir una ficha no debe sobrevivir a un cierre en
/// caliente de la ventana si nunca se pulsó "Aplicar".
function paintPaletteCss(css){
    let el=document.getElementById(STYLE_ID);
    if(!css){ el?.remove(); return; }
    if(!el){
        el=document.createElement('style');
        el.id=STYLE_ID;
    }
    el.textContent=css;
    // Reinsertar al final incluso si ya existía: cualquier hoja añadida después
    // (una carga tardía, un tema) quedaría por encima y ganaría el desempate.
    document.head.appendChild(el);
}

/// Igual que `paintPaletteCss`, pero además persiste en la caché de
/// localStorage que `applyCachedPalette()` lee ANTES del primer pintado en
/// cada arranque de la app. Solo debe llamarse con un estado que sea de
/// verdad — aplicado por el usuario o confirmado por el backend — nunca con
/// una previsualización a medio elegir: si la ventana se cierra en mitad de
/// una previsualización sin pasar por aquí, el próximo arranque no hereda
/// ningún color que no se llegó a aplicar.
export function installPaletteCss(css){
    paintPaletteCss(css);
    try{
        if(css)localStorage.setItem(CACHE_KEY,css);
        else localStorage.removeItem(CACHE_KEY);
    }catch{}
}

/// Previsualización en vivo: SOLO pinta, nunca persiste. Úsese en la
/// previsualización de la paleta dinámica (elegir semilla/estilo antes de
/// pulsar "Aplicar"); `installPaletteCss` es para el estado real.
export const previewPaletteCss = paintPaletteCss;

/// Aplica la última paleta conocida SIN esperar al backend. Va antes del
/// primer pintado para que la ventana no abra con los colores de fábrica y
/// cambie medio segundo después.
export function applyCachedPalette(){
    try{
        const css=localStorage.getItem(CACHE_KEY);
        if(css)installPaletteCss(css);
    }catch{}
}

/// Pide el estado real al backend y corrige lo que hubiera en caché.
export async function syncPalette(){
    try{
        const st=JSON.parse(await tauriInvoke('dynamic_color_state'));
        installPaletteCss(st.enabled?(st.css||''):'');
        return st;
    }catch(e){ return null; }
}

/// Convierte el JSON de roles ({light:{...},dark:{...}}) en la misma hoja que
/// escribe el backend. Se usa para que al tocar una ficha de estilo la
/// interfaz cambie en el acto, sin ir al disco a releer el fichero.
export function paletteToCss(p){
    if(!p||!p.light||!p.dark)return '';
    const decl=o=>Object.entries(o).map(([k,v])=>`--${k}:${v}`).join(';');
    const l=decl(p.light), d=decl(p.dark);
    return `:root,:root.light-mode{${l}}\n`+
           `:root.dark-mode{${d}}\n`+
           `@media(prefers-color-scheme:dark){:root:not(.light-mode){${d}}}`;
}

// ── Integración a nivel de sistema (futuro, sin activar) ───────────────────
// Hoy la paleta solo tiñe las apps Tauri de BookOS que importan este módulo.
// Para que tiña también Plasma/widgets/qml habría que escribir los mismos
// roles en un formato que esas piezas puedan leer. Boceto de lo que faltaría,
// sin activar hasta decidir el formato final y probarlo con calma:
//
// 1) Plasma (kdeglobals / colores de Qt/Kirigami):
//    El backend (`dynamic_color_apply` en src-tauri) ya calcula la paleta;
//    solo faltaría, tras generarla, volcar los tonos primary/accent a un
//    esquema de color Plasma (~/.local/share/color-schemes/BookOSDynamic.colors)
//    y aplicarlo con `kwriteconfig6`+`plasma-apply-colorscheme`, igual que ya
//    se hace para AccentColorFromWallpaper en renderFondos().
//
// 2) Widgets Plasma en QML (com.bookos.bookbar, KdeControlStation…):
//    export function paletteToQml(p){
//        if(!p||!p.light||!p.dark)return '';
//        // Un JSON plano que un Kirigami.Theme personalizado o un Plasmoid
//        // pueda leer con FileWatcher, análogo a palette.css pero en
//        // ~/.config/bookos/palette.json.
//        return JSON.stringify({light:p.light,dark:p.dark});
//    }
//
// 3) SDDM / lockscreen (ya reciben `bookos-reapply-theme.sh`):
//    El hook `bookos-theme-reapply.hook` podría, al detectar un cambio en
//    palette.css, regenerar también el `theme.conf` del greeter con los
//    mismos tonos — hoy ese hook solo reacciona a temas Kvantum/Plasma, no
//    a la paleta dinámica.
//
// Nada de esto se activa aquí: es la lista de qué tocaría para que "tintar
// otras apps de BookOS e incluso widgets" (pedido del usuario) deje de ser
// solo esta ventana de Ajustes.
