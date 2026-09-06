/**
 * WIDGET EMBEBIBLE — sin dependencias, un solo <script>
 *
 *   <script src="https://…/chatbotrag-widget.js"
 *           data-url="https://mi-sitio.com/api/asistente"   (ruta intermedia del sitio)
 *           data-perfil="VIDA_ONCOLOGICO"                      (opcional)
 *           data-color="#e2660f" data-titulo="Terra"></script>
 *
 * Habla con una RUTA INTERMEDIA del sitio (que autentica contra el servicio), no
 * con el servicio directamente: así la clave del cliente nunca viaja al navegador.
 * La ruta debe exponer POST {url}/mensajes con { conversacionId, perfilId, texto }
 * y devolver la `RespuestaMensaje` del contrato.
 *
 * Accesibilidad: botón ≥ 44 px, `role="dialog"`, cierre con Escape, foco al abrir,
 * respeta `prefers-reduced-motion`. Sin cookies ni almacenamiento persistente: el
 * id de conversación vive en memoria de la página (se pierde al recargar, a
 * propósito: menos retención).
 *
 * Seguridad: el texto del asistente se inserta con `textContent`, nunca con
 * `innerHTML`; no hay autoenlazado de URLs (phishing servido por nosotros, no).
 */
import type { RespuestaMensaje } from './contrato.js';
import { nuevoIdConversacion } from './contrato.js';

interface OpcionesWidget {
  url: string;
  perfilId: string | null;
  color: string;
  titulo: string;
  bienvenida: string;
  posicion: 'derecha' | 'izquierda';
}

const ESTILOS = (o: OpcionesWidget) => `
.cbr-boton{position:fixed;bottom:20px;${o.posicion}:16px;z-index:70;min-width:44px;min-height:44px;padding:10px 16px;border-radius:999px;border:0;background:${o.color};color:#fff;font:600 15px/1 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.22);cursor:pointer}
.cbr-boton:focus-visible{outline:3px solid #000;outline-offset:2px}
.cbr-panel{position:fixed;bottom:76px;${o.posicion}:16px;z-index:90;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - 100px));display:flex;flex-direction:column;background:#fff;color:#222;border:1px solid #ddd;border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,.25);font:15px/1.4 system-ui,sans-serif;overflow:hidden}
.cbr-cab{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:${o.color};color:#fff;font-weight:700}
.cbr-cab button{min-width:44px;min-height:44px;background:transparent;border:0;color:#fff;font-size:20px;cursor:pointer}
.cbr-lista{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.cbr-msg{max-width:85%;padding:10px 12px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}
.cbr-msg.u{align-self:flex-end;background:${o.color};color:#fff}
.cbr-msg.a{align-self:flex-start;background:#f2f2f2}
.cbr-fuentes{font-size:12px;color:#555;align-self:flex-start;margin-top:-4px}
.cbr-form{display:flex;gap:8px;padding:10px;border-top:1px solid #eee}
.cbr-form input{flex:1;min-height:44px;padding:0 12px;border:1px solid #ccc;border-radius:10px;font:inherit}
.cbr-form button{min-width:44px;min-height:44px;border:0;border-radius:10px;background:${o.color};color:#fff;font-weight:600;cursor:pointer}
.cbr-form button[disabled]{opacity:.6;cursor:default}
.cbr-pie{font-size:11px;color:#666;padding:0 12px 10px}
@media (prefers-reduced-motion:no-preference){.cbr-panel{animation:cbr-in .15s ease-out}@keyframes cbr-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}}
@media (prefers-color-scheme:dark){.cbr-panel{background:#1e1e1e;color:#eee;border-color:#333}.cbr-msg.a{background:#2a2a2a}.cbr-form input{background:#141414;color:#eee;border-color:#444}.cbr-fuentes,.cbr-pie{color:#aaa}}
`;

function leerOpciones(script: HTMLScriptElement): OpcionesWidget {
  const d = script.dataset;
  if (!d['url']) throw new Error('chatbotrag-widget: falta data-url');
  return {
    url: d['url'].replace(/\/$/, ''),
    perfilId: d['perfil'] || null,
    color: d['color'] || '#2b5a9e',
    titulo: d['titulo'] || 'Asistente virtual',
    bienvenida: d['bienvenida'] || 'Hola, soy un asistente virtual con inteligencia artificial. ¿En qué puedo ayudarle?',
    posicion: d['posicion'] === 'izquierda' ? 'izquierda' : 'derecha',
  };
}

export function montarWidget(script: HTMLScriptElement, documento: Document = document): void {
  const o = leerOpciones(script);
  const estilo = documento.createElement('style');
  estilo.textContent = ESTILOS(o);
  documento.head.appendChild(estilo);

  const boton = documento.createElement('button');
  boton.className = 'cbr-boton';
  boton.type = 'button';
  boton.setAttribute('aria-haspopup', 'dialog');
  boton.setAttribute('aria-expanded', 'false');
  boton.textContent = `💬 ${o.titulo}`;
  documento.body.appendChild(boton);

  let panel: HTMLDivElement | null = null;
  let conversacionId = nuevoIdConversacion('web');
  let enviando = false;

  const agregar = (lista: HTMLElement, texto: string, clase: 'u' | 'a', fuentes: string[] = []) => {
    const div = documento.createElement('div');
    div.className = `cbr-msg ${clase}`;
    div.textContent = texto; // nunca innerHTML
    lista.appendChild(div);
    if (fuentes.length) {
      const f = documento.createElement('div');
      f.className = 'cbr-fuentes';
      f.textContent = `Fuente: ${fuentes.join(' · ')}`;
      lista.appendChild(f);
    }
    lista.scrollTop = lista.scrollHeight;
  };

  const cerrar = () => {
    panel?.remove();
    panel = null;
    boton.setAttribute('aria-expanded', 'false');
    boton.focus();
  };

  const abrir = () => {
    if (panel) return cerrar();
    panel = documento.createElement('div');
    panel.className = 'cbr-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', o.titulo);

    const cab = documento.createElement('div');
    cab.className = 'cbr-cab';
    const titulo = documento.createElement('span');
    titulo.textContent = o.titulo;
    const cerrarBtn = documento.createElement('button');
    cerrarBtn.type = 'button';
    cerrarBtn.setAttribute('aria-label', 'Cerrar');
    cerrarBtn.textContent = '×';
    cerrarBtn.addEventListener('click', cerrar);
    cab.append(titulo, cerrarBtn);

    const lista = documento.createElement('div');
    lista.className = 'cbr-lista';
    lista.setAttribute('aria-live', 'polite');
    agregar(lista, o.bienvenida, 'a');

    const form = documento.createElement('form');
    form.className = 'cbr-form';
    const entrada = documento.createElement('input');
    entrada.type = 'text';
    entrada.maxLength = 1500;
    entrada.autocomplete = 'off';
    entrada.placeholder = 'Escriba su consulta…';
    entrada.setAttribute('aria-label', 'Mensaje');
    const enviar = documento.createElement('button');
    enviar.type = 'submit';
    enviar.textContent = 'Enviar';
    form.append(entrada, enviar);

    const pie = documento.createElement('div');
    pie.className = 'cbr-pie';
    pie.textContent = 'Asistente con inteligencia artificial. No comparta datos personales por este medio.';

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const texto = entrada.value.trim();
      if (!texto || enviando) return;
      enviando = true;
      enviar.disabled = true;
      agregar(lista, texto, 'u');
      entrada.value = '';
      try {
        const r = await fetch(`${o.url}/mensajes`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ conversacionId, perfilId: o.perfilId, texto }),
        });
        const json = (await r.json()) as RespuestaMensaje | { ok: false; motivo: string };
        if (!r.ok || !json.ok) {
          agregar(lista, r.status === 429 ? 'Demasiados mensajes seguidos. Espere un momento e intente de nuevo.' : 'No pude procesar el mensaje. Intente de nuevo en unos segundos.', 'a');
        } else {
          agregar(lista, json.texto, 'a', [...new Set(json.respaldo.map((x) => `${x.titulo} (${x.version})`))]);
        }
      } catch {
        agregar(lista, 'No hay conexión con el asistente en este momento.', 'a');
      } finally {
        enviando = false;
        enviar.disabled = false;
        entrada.focus();
      }
    });

    panel.append(cab, lista, form, pie);
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') cerrar();
    });
    documento.body.appendChild(panel);
    boton.setAttribute('aria-expanded', 'true');
    entrada.focus();
  };

  boton.addEventListener('click', abrir);
  // Nueva conversación al recargar: no se persiste nada.
  documento.addEventListener('visibilitychange', () => {
    if (documento.visibilityState === 'hidden' && !panel) conversacionId = nuevoIdConversacion('web');
  });
}

// Autoarranque cuando se incluye con <script>.
if (typeof document !== 'undefined' && document.currentScript instanceof HTMLScriptElement) {
  montarWidget(document.currentScript);
}
