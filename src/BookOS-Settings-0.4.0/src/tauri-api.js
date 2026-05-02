export async function tauriInvoke(cmd, args={}) {
    if(window.__TAURI__){const inv=window.__TAURI__.core?.invoke||window.__TAURI__.tauri?.invoke;if(inv)return await inv(cmd,args);}
    throw new Error(`No Tauri: ${cmd}`);
}
export function isTauri(){return !!window.__TAURI__}
export function getAssetUrl(path) {
    if(window.__TAURI__?.core?.convertFileSrc) return window.__TAURI__.core.convertFileSrc(path);
    return 'asset://localhost' + (path.startsWith('/') ? path : '/' + path);
}
