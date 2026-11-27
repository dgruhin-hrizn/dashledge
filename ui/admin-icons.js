// Shared 20-point outline icons for Settings. All geometry is app-owned.
const paths={
 info:'M10 2a8 8 0 1 1 0 16a8 8 0 1 1 0-16 M10 9v5 M10 6v.5',
 general:'M2 5h9 M15 5h3 M12 3v4h3V3z M2 15h3 M9 15h9 M5 13v4h4v-4z',
 brand:'M2 6.5h16v9H2z M5 9h3v4H5z M11 9h4 M11 12h4',
 pages:'M2 4h16v12H2z M8 4v12 M8 10h10',
 connections:'M6 2v4 M10 2v4 M4 6h8v2a4 4 0 0 1-4 4v2a3 3 0 0 0 6 0v-2h3',
 studio:'M3 3h6v6H3z M12 3h5v6h-5z M3 12h6v5H3z M12 14.5h6 M15 11.5v6',
 market:'M3 8h14v9H3z M2 4h16l-1 4H3z M8 17v-5h4v5',
 preview:'M2 4h16v11H2z M6 18h8 M10 15v3',
 display:'M2 5h16v9H2z M7 17h6',
 cpu:'M5 5h10v10H5z M8 8h4v4H8z M7 2v3 M12 2v3 M7 15v3 M12 15v3 M2 7h3 M2 12h3 M15 7h3 M15 12h3',
 gpu:'M2 5h15v9H2z M5 14v2 M8 14v2 M11 14v2 M17 8h1 M12 9.5a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 0 1 4.6 0',
 memory:'M2 6h16v8H2z M5 8v4 M8 8v4 M11 8v4 M14 8v4 M4 14v2 M8 14v2 M12 14v2 M16 14v2',
 disk:'M4 4h12l2 8v4H2v-4z M2 12h16 M13 14h2',
 network:'M2 7h13l-3-3 M18 13H5l3 3',
 power:'M10 2 5 11h4l-1 7 7-11h-5z',
 clock:'M17 10a7 7 0 1 1-14 0 7 7 0 1 1 14 0 M10 6v4l3 2',
 spotify:'M16 6c-4-2-8-2-12 0 M15 10c-4-2-7-2-10-1 M14 14c-3-1.5-5-1.5-8-1',
 emby:'M3 10l7-7 7 7-7 7z M9 7v6l4-3z',
 comfy:'M3 3h4v4H3z M13 13h4v4h-4z M13 3h4v4h-4z M7 5h6 M5 7v8h8',
 proxmox:'M3 3l14 14 M3 17l6-6 M12 8l5-5',
 omlx:'M2 13l4-6 4 7 4-9 4 6',
 unraid:'M2 13v-3 M5 13V8 M8 12V5 M11 10V3 M14 12V6 M17 14v-4',
 ember:'M10 2c1 6 8 7 5 12-1 3-3 4-5 4 2-2 2-4 0-6-2 1-3 3-2 5-6-2-5-7-1-11-1 3 0 4 1 4 1-2 3-4 2-8z',
 notes:'M4 3h12v11l-3 3H4z M7 7h6 M7 10h6',
 shelf:'M3 4h6v5H3z M12 4h5v5h-5z M3 12h6v5H3z M12 12h5v5h-5z',
 plus:'M10 4v12 M4 10h12', find:'M13 8a5 5 0 1 1-10 0 5 5 0 0 1 10 0 M12 12l5 5',
 split:'M2 4h16v12H2z M10 4v12', stack:'M2 4h16v12H2z M2 10h16',
 undo:'M7 4 3 8l4 4 M4 8h8c6 0 6 8 0 8',
 check:'M3 10l4 4 10-9', edit:'M4 12 13 3l4 4-9 9-5 1z',
 studioFile:'M4 2h8l4 4v12H4z M12 2v5h4 M7 11h6 M7 14h4',
};
const alias={machine:'display',interfaces:'network',volumes:'disk',world:'clock',focus:'clock',json:'connections'};
export function icon(kind){
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
 svg.setAttribute('viewBox','0 0 20 20');svg.setAttribute('class','admin-icon');
 svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.45');
 svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');
 const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',paths[alias[kind]||kind]||paths.shelf);svg.append(path);return svg;
}
