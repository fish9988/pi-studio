// 为沙箱化 srcDoc HTML 预览注入安全兼容垫片：
// 1. 不开 allow-same-origin 以隔离主应用权限，但部分网页会在顶层读取 localStorage / sessionStorage
//    或调用 history.replaceState/pushState，在 opaque origin（about:srcdoc）下会直接抛 SecurityError 中断后续绘图脚本；
// 2. 垫片仅在触发 SecurityError 时退回内存 Map 与无害化 noop（并在传入 #hash 时同步 location.hash），不触碰父页面。

const HTML_PREVIEW_SHIM = `<script>(function(){try{window.localStorage}catch(_){var mem=function(){var s=Object.create(null);return{getItem:function(k){return Object.prototype.hasOwnProperty.call(s,k)?s[k]:null},setItem:function(k,v){s[String(k)]=String(v)},removeItem:function(k){delete s[String(k)]},clear:function(){s=Object.create(null)},key:function(i){return Object.keys(s)[i]||null},get length(){return Object.keys(s).length}}};try{Object.defineProperty(window,"localStorage",{value:mem(),configurable:true})}catch(_){}try{Object.defineProperty(window,"sessionStorage",{value:mem(),configurable:true})}catch(_){}}try{var h=window.history;if(h){var r=h.replaceState,p=h.pushState;h.replaceState=function(st,t,u){try{return r.call(this,st,t,u)}catch(_){if(typeof u==="string"&&u.charAt(0)==="#"){try{window.location.hash=u}catch(_2){}}}};h.pushState=function(st,t,u){try{return p.call(this,st,t,u)}catch(_){if(typeof u==="string"&&u.charAt(0)==="#"){try{window.location.hash=u}catch(_2){}}}}}}catch(_){}})();</script>`;

export function injectHtmlPreviewShim(html: string): string {
  const headMatch = /<head\b[^>]*>/i.exec(html);
  if (headMatch !== null) {
    const idx = headMatch.index + headMatch[0].length;
    return `${html.slice(0, idx)}${HTML_PREVIEW_SHIM}${html.slice(idx)}`;
  }
  const htmlMatch = /<html\b[^>]*>/i.exec(html);
  if (htmlMatch !== null) {
    const idx = htmlMatch.index + htmlMatch[0].length;
    return `${html.slice(0, idx)}${HTML_PREVIEW_SHIM}${html.slice(idx)}`;
  }
  return `${HTML_PREVIEW_SHIM}${html}`;
}
