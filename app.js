// ============================================================
// NORTE PADEL — lógica de la app (vanilla JS, sin frameworks)
// ============================================================

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const DIAS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const DIAS_CORTO = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

// ---------- estado ----------
let currentUser = null;   // usuario de Supabase Auth, o null si no hay sesión
let miJugador = null;     // fila de "jugadores" ligada al usuario logueado
let isAdmin = false;
let editandoPerfil = false;
let torneoActualId = null;
let torneoActualData = null; // torneo completo cargado en refrescarDetalleTorneo, para prefill de "Editar torneo"
let yaInscriptoEnTorneoActual = false; // lo setea actualizarAccesoInscripcion — evita volver a mostrar el wizard de inscripción si se llega por un link directo o "Atrás" del navegador estando ya anotado
let categoriaRankingActual = localStorage.getItem("np_categoria_ranking") || null;
let cacheComplejos = [];
let cacheCanchas = [];
let cacheJugadoresAdmin = [];
let cacheCategorias = [];
let cacheEtiquetas = []; // etiquetas_jugador — uso interno del admin, con color
let cacheRankingCategoriaAdmin = {}; // jugador_id -> [{categoria, puntos_ranking, partidos_jugados, partidos_ganados}], para el bloque "categorías de ranking" del admin
let cacheTorneos = [];
let torneoDestacadoId = null; // el torneo en curso o el próximo; a donde lleva la banda "Inscribite ya" de Inicio
let torneoEnCursoId = null; // solo si HOY cae dentro de sus fechas (a diferencia de torneoDestacadoId, no cae al próximo) -- ver cargarEnVivo()
let ultimosPartidos = [];
// true si alguna categoría del torneo abierto ya tiene calendario (cancha+horario
// asignados) o terminó — fuente de verdad para mostrar Calendario/Resultados
// (ver renderTorneoSubnav), en vez de "hay partidos" que también es cierto para
// un fixture recién armado y todavía sin horario.
let hayCalendarioTorneoActual = false;
let ultimasCanchasTorneo = [];
let partidosCategoriaFiltro = ""; // "" = todas las categorías del torneo
let partidosBusquedaFiltro = ""; // texto libre, busca por nombre de jugador o pareja (ver renderPartidosAdmin)
let configApp = {}; // clave/valor de la tabla "config" (whatsapp_numero, instagram_url)

// "Jugar" (reservar cancha) está armado pero pausado hasta cerrar el acuerdo con el club
// y activar el botón en index.html — mientras tanto no se llama a sus funciones para no
// pegarle a tablas/RPCs que todavía no se corrieron en la base de producción.
const FEATURE_JUGAR_HABILITADA = false;

// ---------- utilidades UI ----------
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(toast._h);
  toast._h = setTimeout(() => (t.style.display = "none"), 3500);
}

// ============================================================
// ROUTER — hash liviano sobre el mismo mecanismo .view/.active de siempre.
// Sin librerías ni build step: el hosting es estático sin reglas de rewrite,
// así que el hash (#/torneo/xyz) es la única forma de tener enlaces
// compartibles + F5 sin romper + atrás/adelante del navegador, gratis.
// `cambiarVista` sigue funcionando exactamente igual para quien la llama
// solo con el nombre — el segundo parámetro (ruta) es opcional.
// ============================================================
let syncingDesdeHash = false; // evita el loop cambiarVista → navegarA → hashchange → enrutar → cambiarVista

// Pantallas Público/Jugador de UN torneo (todas viven bajo la misma barra de
// contexto — ver #torneoContextBar en index.html). Es la única tabla que
// mapea ruta -> vista para estas pantallas, así abrirTorneo y el mini-nav
// del torneo nunca se desincronizan entre sí.
// "" (Torneo) es la pantalla que ve la gente apenas entra: hero + inscripción
// (si está abierta) + categoría/etapa + partidos, todo junto — antes eran 3
// pestañas (Inicio/Calendario/Resultados) que mostraban casi lo mismo.
// "info" junta lo que antes eran Categorías + Jugadores + datos de sede.
const PANTALLAS_TORNEO = {
  "": { view: "torneo-resultados", label: "Torneo" },
  fotos: { view: "torneo-fotos", label: "Fotos" },
  info: { view: "torneo-info", label: "Info" }
};
// estas no van en el mini-nav (se llega a ellas desde un botón puntual, no
// como una pestaña más) pero también son "pantallas de torneo" a los
// efectos de mostrar/ocultar la barra de contexto
const PANTALLAS_TORNEO_EXTRA = {
  inscripcion: "torneo-inscripcion",
  "mi-inscripcion": "mi-inscripcion",
  "mi-disponibilidad": "mi-disponibilidad-torneo"
};
const VISTAS_DE_TORNEO = new Set([
  ...Object.values(PANTALLAS_TORNEO).map((p) => p.view),
  ...Object.values(PANTALLAS_TORNEO_EXTRA)
]);

let adminFocoTorneoActivo = false; // true mientras se administra UN torneo puntual (ver cambiarVista)
function cambiarVista(nombre, ruta) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
  const view = document.getElementById("view-" + nombre);
  if (view) view.classList.add("active");
  const tab = document.querySelector(`.tab[data-view="${nombre}"]`);
  if (tab) tab.classList.add("active");
  // la barra de contexto de un torneo (nombre, estado, mini-nav) persiste
  // arriba de cualquiera de sus 8 pantallas, y se oculta en cualquier otra
  document.getElementById("torneoContextBar").style.display = VISTAS_DE_TORNEO.has(nombre) ? "block" : "none";
  // entrar a Admin por la vía normal (tab Config / "Más") siempre muestra todo — el
  // modo enfocado "solo este torneo" (adminFocoTorneoActivo) lo activa
  // btnAdministrarEsteTorneo y lo apaga admBtnVolverConfigGeneral (ver más abajo en
  // este archivo). Se chequea acá y no solo en esos dos handlers porque cambiar el
  // hash a #/admin dispara además un "hashchange" que vuelve a llamar a
  // cambiarVista("admin") por su cuenta (ver despacharRuta) — sin este chequeo,
  // ese segundo llamado deshacía el modo enfocado apenas se activaba.
  if (nombre === "admin" && !adminFocoTorneoActivo) {
    mostrarConfigGeneral(true);
    document.getElementById("admBtnVolverConfigGeneral").style.display = "none";
    mostrarSeccionConfigGeneral(seccionConfigActiva);
  } else if (nombre !== "admin") {
    adminFocoTorneoActivo = false;
  }
  if (!syncingDesdeHash) navegarA(ruta || (nombre === "inicio" ? "/" : "/" + nombre));
}

// Prende/apaga TODA la configuración general del club de una sola vez —
// admConfigGeneralWrap (cfg general, complejos, categorías...) y
// admConfigGeneralWrap2 (noticias, jugadores registrados) son dos wraps
// separados por HTML solo porque "Auspiciantes" (auspiciantesWrap) quedó
// en el medio de los dos para poder mostrarse solo, sin el resto, desde el
// atajo de "Administrar este torneo" — ver btnAuspiciantesTorneo más abajo.
function mostrarConfigGeneral(visible) {
  document.getElementById("admConfigGeneralWrap").style.display = visible ? "block" : "none";
  document.getElementById("admConfigGeneralWrap2").style.display = visible ? "block" : "none";
  document.getElementById("auspiciantesWrap").style.display = visible ? "block" : "none";
  document.getElementById("btnCerrarAuspiciantesTorneo").style.display = "none";
}

function navegarA(ruta) {
  if ((location.hash.slice(1) || "/") === ruta) return;
  location.hash = ruta;
}

function parsearHash() {
  const cruda = (location.hash || "#/").slice(1) || "/";
  const [ruta, query] = cruda.split("?");
  return { segmentos: ruta.split("/").filter(Boolean), params: new URLSearchParams(query || "") };
}

// despacha la ruta actual a la pantalla correspondiente, reutilizando las
// mismas funciones que ya usan los botones/clicks de siempre (abrirTorneo,
// abrirPerfilJugador, cambiarVista) — el router no duplica ninguna lógica.
async function despacharRuta() {
  const { segmentos: seg } = parsearHash();
  const [raiz, a, sub] = seg;
  syncingDesdeHash = true;
  try {
    if (!raiz) { cambiarVista("inicio"); return; }
    if (raiz === "torneos") { cambiarVista("torneos"); return; }
    if (raiz === "ranking") { cambiarVista("ranking"); return; }
    if (raiz === "en-vivo") { cambiarVista("en-vivo"); return; }
    if (raiz === "perfil") { cambiarVista("perfil"); return; }
    if (raiz === "jugar" && FEATURE_JUGAR_HABILITADA) { cambiarVista("jugar"); return; }
    if (raiz === "admin") {
      if (!isAdmin) { cambiarVista("inicio"); return; }
      cambiarVista("admin");
      return;
    }
    if (raiz === "torneo" && a) { await abrirTorneo(a, sub); return; }
    if (raiz === "perfil-jugador" && a) { await abrirPerfilJugador(a); return; }
    cambiarVista("inicio");
  } finally {
    syncingDesdeHash = false;
  }
}
window.addEventListener("hashchange", despacharRuta);
// primer enrutamiento: recién después de que se resuelva la sesión (más abajo,
// en manejarCambioSesion) — así una ruta de /admin en el link no parpadea
// antes de saber si el usuario es admin o no.

document.querySelectorAll(".tab").forEach((btn) => {
  if (!btn.dataset.view) return;
  btn.addEventListener("click", () => cambiarVista(btn.dataset.view));
});
document.getElementById("btnPerfil").addEventListener("click", () => cambiarVista("perfil"));
document.getElementById("btnHeroTorneos").addEventListener("click", () => cambiarVista("torneos"));
document.getElementById("btnHeroTorneos2").addEventListener("click", () => cambiarVista("torneos"));
document.getElementById("btnHeroRanking").addEventListener("click", () => cambiarVista("ranking"));
document.getElementById("marqueeBanda").addEventListener("click", () => {
  if (torneoDestacadoId) abrirTorneo(torneoDestacadoId);
  else cambiarVista("torneos");
});

// agrupa categorías tipo "6ta Damas" / "6ta Caballeros" por género; lo que no matchea
// (categorías genéricas viejas, sin género) cae en "Otras" para no perderlas de vista
function generoDeCategoria(nombre) {
  if (nombre.endsWith(" Damas")) return "Damas";
  if (nombre.endsWith(" Caballeros")) return "Caballeros";
  return "Otras";
}
function agruparPorGenero(categorias) {
  const grupos = { Damas: [], Caballeros: [], Otras: [] };
  categorias.forEach((c) => grupos[generoDeCategoria(typeof c === "string" ? c : c.nombre)].push(c));
  return grupos;
}
const ORDEN_GENEROS = ["Damas", "Caballeros", "Otras"];

// Buscador de jugadores con el <input list> + <datalist> nativos del navegador
// (con 600+ jugadores importados, un <select> con todos adentro es imposible
// de usar — esto da el filtrado-al-tipear gratis, sin agregar ninguna
// librería de autocompletado). El id real de cada jugador no cabe en el
// value del <option> sin verse feo, así que se guarda aparte en un Map
// colgado del propio input; ver idDesdeDatalist para leerlo de vuelta. Si dos
// jugadores comparten exactamente el mismo nombre+categoría se desambiguan
// con "(2)", "(3)"... al final del texto, así nunca se pisan en el mapa.
function llenarDatalist(inputId, datalistId, items, labelFn) {
  const input = document.getElementById(inputId);
  const datalist = document.getElementById(datalistId);
  if (!input || !datalist) return;
  const mapa = new Map();
  const vistos = new Map();
  datalist.innerHTML = "";
  items.forEach((it) => {
    const base = labelFn(it);
    const n = (vistos.get(base) || 0) + 1;
    vistos.set(base, n);
    const label = n > 1 ? `${base} (${n})` : base;
    mapa.set(label, it.id);
    const opt = document.createElement("option");
    opt.value = label;
    datalist.appendChild(opt);
  });
  input._mapaDatalist = mapa;
}
// Devuelve el id del jugador elegido, o "" si lo tipeado no coincide con
// ninguna opción real de la lista (evita inscribir con un id inventado si
// alguien escribe cualquier cosa y no termina de elegir de la lista).
function idDesdeDatalist(inputId) {
  const input = document.getElementById(inputId);
  return input?._mapaDatalist?.get(input.value.trim()) || "";
}
// Escapa texto libre (nombre/apellido de jugador, sponsor, noticia,
// motivo_rechazo...) antes de interpolarlo en un string que después se asigna
// a innerHTML/outerHTML — sin esto, cualquiera que edite su nombre puede
// inyectar HTML/JS que se ejecuta en el navegador de quien vea esa pantalla
// (stored XSS). Sirve tanto para texto dentro de una etiqueta como para el
// valor de un atributo entre comillas dobles.
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Etiqueta compartida para buscar un jugador por nombre en cualquier datalist
// (alta de pareja nueva, reemplazo de un jugador en una pareja existente...).
function labelJugadorBuscable(j) {
  return `${j.apellido}, ${j.nombre} — ${j.categoria || "sin categoría"}`;
}

function llenarSelect(select, items, labelFn, valueFn) {
  if (!select) return;
  const valorPrevio = select.value;
  select.innerHTML = "";
  items.forEach((it) => {
    const opt = document.createElement("option");
    opt.value = valueFn ? valueFn(it) : it.id;
    opt.textContent = labelFn(it);
    select.appendChild(opt);
  });
  if (valorPrevio) select.value = valorPrevio;
}

// ============================================================
// AUTENTICACIÓN Y PERFIL
// ============================================================
function traducirErrorAuth(error) {
  const msg = error?.message || "";
  if (msg.includes("Invalid login credentials")) return "Email o contraseña incorrectos.";
  if (msg.includes("User already registered")) return "Ya existe una cuenta con ese email. Probá iniciar sesión.";
  if (msg.includes("Password should be")) return "La contraseña es muy corta (mínimo 6 caracteres).";
  return msg || "Ocurrió un error.";
}

document.getElementById("btnLogin").addEventListener("click", async () => {
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  if (!email || !password) { document.getElementById("authError").textContent = "Completá email y contraseña"; return; }
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { document.getElementById("authError").textContent = traducirErrorAuth(error); return; }
  toast("¡Bienvenido de nuevo! 🎾");
});

document.getElementById("btnSignup").addEventListener("click", async () => {
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  if (!email || !password) { document.getElementById("authError").textContent = "Completá email y contraseña"; return; }
  const { error } = await sb.auth.signUp({ email, password });
  if (error) { document.getElementById("authError").textContent = traducirErrorAuth(error); return; }
  toast("Cuenta creada. Ahora completá tu perfil de jugador 🎾");
});

document.getElementById("btnLogout").addEventListener("click", async () => {
  await sb.auth.signOut();
  toast("Cerraste sesión");
  cambiarVista("inicio");
});

document.getElementById("btnEditarPerfil").addEventListener("click", () => {
  editandoPerfil = true;
  renderVistaPerfil();
});

// Picker de disponibilidad — colapsado por defecto (🟢 disponibilidad completa,
// nada visible), y solo despliega una lista de restricciones removibles si el
// jugador toca 🔴. Se usa tanto para el perfil general (contenedorId=
// "disponibilidadForm") como para el bloqueo puntual de un torneo
// (contenedorId="torneoDispBloqueadaForm") — mismo componente, dos instancias.
// El estado en memoria de CADA instancia vive en el propio contenedor
// (cont._restricciones) para no pisarse entre sí si las dos están cargadas a
// la vez, y para no tener que tocar el patrón de guardado (borrar todo +
// reinsertar) que ya usan btnGuardarPerfil y btnGuardarDispTorneo — solo
// cambia CÓMO se arma esa lista antes de guardarla (ver leerRestriccionesDeForm).
function renderDisponibilidadForm(contenedorId = "disponibilidadForm") {
  const cont = document.getElementById(contenedorId);
  cont._restricciones = [];
  cont.innerHTML = `
    <div class="pill-row disp-toggle">
      <button type="button" class="pill active" data-disp="completa">🟢 Tengo disponibilidad completa</button>
      <button type="button" class="pill" data-disp="restringida">🔴 Tengo horarios en los que no puedo jugar</button>
    </div>
    <div class="disp-restricciones-wrap" style="display:none">
      <div class="disp-lista-restricciones"></div>
      <div class="disp-nueva-restriccion" style="display:none">
        <label>Día</label>
        <select class="disp-nueva-dia">${DIAS.map((d, i) => `<option value="${i}">${d}</option>`).join("")}</select>
        <div class="row" style="margin-top:6px">
          <div><label>Desde</label><input type="time" class="disp-nueva-desde" /></div>
          <div><label>Hasta</label><input type="time" class="disp-nueva-hasta" /></div>
        </div>
        <div class="row" style="margin-top:8px">
          <button type="button" class="secondary small disp-btn-confirmar-restriccion">Agregar</button>
          <button type="button" class="secondary small disp-btn-cancelar-restriccion">Cancelar</button>
        </div>
      </div>
      <button type="button" class="secondary small disp-btn-agregar-restriccion" style="margin-top:8px">+ Agregar horario</button>
    </div>
  `;

  const wrapRestricciones = cont.querySelector(".disp-restricciones-wrap");
  const listaEl = cont.querySelector(".disp-lista-restricciones");
  const nuevaEl = cont.querySelector(".disp-nueva-restriccion");

  function pintarLista() {
    listaEl.innerHTML = cont._restricciones.length === 0
      ? '<p class="match-meta">Todavía no agregaste ningún horario.</p>'
      : cont._restricciones.map((r, i) => `
        <span class="pill removable" style="display:inline-flex;margin:0 6px 6px 0">
          ${DIAS_CORTO[r.dia_semana]} ${r.hora_desde.slice(0, 5)}–${r.hora_hasta.slice(0, 5)}
          <button type="button" class="disp-btn-quitar" data-i="${i}" aria-label="Quitar este horario">×</button>
        </span>`).join("");
    listaEl.querySelectorAll(".disp-btn-quitar").forEach((btn) => {
      btn.addEventListener("click", () => {
        cont._restricciones.splice(Number(btn.dataset.i), 1);
        pintarLista();
      });
    });
  }
  cont._pintarLista = pintarLista; // para que precargarRestriccionesEnForm pueda repintar tras precargar

  cont.querySelectorAll(".disp-toggle .pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      cont.querySelectorAll(".disp-toggle .pill").forEach((b) => b.classList.toggle("active", b === btn));
      wrapRestricciones.style.display = btn.dataset.disp === "restringida" ? "block" : "none";
    });
  });
  cont.querySelector(".disp-btn-agregar-restriccion").addEventListener("click", () => { nuevaEl.style.display = "block"; });
  cont.querySelector(".disp-btn-cancelar-restriccion").addEventListener("click", () => { nuevaEl.style.display = "none"; });
  cont.querySelector(".disp-btn-confirmar-restriccion").addEventListener("click", () => {
    const dia = Number(cont.querySelector(".disp-nueva-dia").value);
    const desde = cont.querySelector(".disp-nueva-desde").value;
    const hasta = cont.querySelector(".disp-nueva-hasta").value;
    if (!desde || !hasta) { toast("Elegí desde y hasta"); return; }
    if (hasta <= desde) { toast('El horario "hasta" tiene que ser después del "desde"'); return; }
    cont._restricciones.push({ dia_semana: dia, hora_desde: desde, hora_hasta: hasta });
    pintarLista();
    nuevaEl.style.display = "none";
    cont.querySelector(".disp-nueva-desde").value = "";
    cont.querySelector(".disp-nueva-hasta").value = "";
  });

  pintarLista();
}

// Precarga filas ya guardadas (de la DB) en el picker: si hay alguna, arranca
// mostrando el toggle en 🔴 con la lista ya cargada; si no hay ninguna, se
// queda en 🟢 disponibilidad completa (el default).
function precargarRestriccionesEnForm(contenedorId, filas) {
  const cont = document.getElementById(contenedorId);
  if (!cont) return;
  cont._restricciones = (filas || []).map((d) => ({
    dia_semana: d.dia_semana,
    hora_desde: String(d.hora_desde).slice(0, 5),
    hora_hasta: String(d.hora_hasta).slice(0, 5)
  }));
  const hayRestricciones = cont._restricciones.length > 0;
  cont.querySelectorAll(".disp-toggle .pill").forEach((b) => b.classList.toggle("active", (b.dataset.disp === "restringida") === hayRestricciones));
  cont.querySelector(".disp-restricciones-wrap").style.display = hayRestricciones ? "block" : "none";
  if (cont._pintarLista) cont._pintarLista();
}

// Lee el estado actual del picker, en el mismo formato {dia_semana,
// hora_desde, hora_hasta} que ya esperan los handlers de guardado (delete +
// insert) — así btnGuardarPerfil y btnGuardarDispTorneo casi no cambian.
function leerRestriccionesDeForm(contenedorId) {
  const cont = document.getElementById(contenedorId);
  return (cont?._restricciones || []).slice();
}

function mostrarFotoPreview(url) {
  const img = document.getElementById("fotoPreview");
  const placeholder = document.getElementById("fotoPlaceholder");
  if (url) { img.src = url; img.style.display = "block"; placeholder.style.display = "none"; }
  else { img.style.display = "none"; placeholder.style.display = "flex"; }
}
document.getElementById("jFoto").addEventListener("change", (e) => {
  const archivo = e.target.files[0];
  if (archivo) mostrarFotoPreview(URL.createObjectURL(archivo));
});

async function precargarFormularioPerfil(j) {
  document.getElementById("jNombre").value = j.nombre || "";
  document.getElementById("jApellido").value = j.apellido || "";
  document.getElementById("jCategoria").value = j.categoria_pendiente || j.categoria || "6ta";
  document.getElementById("jTelefono").value = j.telefono || "";
  document.getElementById("jLado").value = j.lado_preferido || "indistinto";
  mostrarFotoPreview(j.foto_url);

  const notice = document.getElementById("categoriaPendienteNotice");
  if (j.categoria_pendiente) {
    notice.textContent = `Categoría solicitada: ${j.categoria_pendiente} · pendiente de aprobación del admin`;
    notice.style.display = "block";
  } else {
    notice.style.display = "none";
  }

  renderDisponibilidadForm("disponibilidadForm");
  const { data: disp } = await sb.from("disponibilidad").select("*").eq("jugador_id", j.id).is("torneo_id", null);
  precargarRestriccionesEnForm("disponibilidadForm", disp);
}

function renderVistaPerfil() {
  const authCard = document.getElementById("authCard");
  const completarCard = document.getElementById("completarPerfilCard");
  const miCard = document.getElementById("miPerfilCard");
  document.getElementById("authError").textContent = "";

  if (!currentUser) {
    authCard.style.display = "block";
    completarCard.style.display = "none";
    miCard.style.display = "none";
    return;
  }
  authCard.style.display = "none";

  if (!miJugador || editandoPerfil) {
    completarCard.style.display = "block";
    miCard.style.display = "none";
    if (miJugador) precargarFormularioPerfil(miJugador);
    else { renderDisponibilidadForm(); mostrarFotoPreview(null); document.getElementById("categoriaPendienteNotice").style.display = "none"; }
  } else {
    completarCard.style.display = "none";
    miCard.style.display = "block";
    const pendiente = miJugador.categoria_pendiente ? ` (pendiente: ${miJugador.categoria_pendiente})` : "";
    document.getElementById("miPerfilResumen").textContent =
      `${miJugador.nombre} ${miJugador.apellido} · Categoría ${miJugador.categoria}${pendiente} · ${miJugador.puntos_ranking} pts`;
  }
}
renderDisponibilidadForm();

document.getElementById("btnGuardarPerfil").addEventListener("click", async () => {
  const btn = document.getElementById("btnGuardarPerfil");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  if (!currentUser) { toast("Iniciá sesión primero"); return; }
  const nombre = document.getElementById("jNombre").value.trim();
  const apellido = document.getElementById("jApellido").value.trim();
  if (!nombre || !apellido) { toast("Completá nombre y apellido"); return; }

  const categoriaSeleccionada = document.getElementById("jCategoria").value || "6ta";
  const datos = {
    nombre, apellido,
    auth_user_id: currentUser.id,
    email: currentUser.email,
    telefono: document.getElementById("jTelefono").value.trim() || null,
    lado_preferido: document.getElementById("jLado").value
  };
  // la categoría no se cambia directo: queda pedida y la aprueba el admin (ver trigger en schema.sql)
  datos.categoria_pendiente = (miJugador && categoriaSeleccionada === miJugador.categoria) ? null : categoriaSeleccionada;

  const archivoFoto = document.getElementById("jFoto").files[0];
  if (archivoFoto) {
    const path = `${currentUser.id}-${Date.now()}-${archivoFoto.name}`;
    const { error: upErr } = await sb.storage.from("fotos").upload(path, archivoFoto);
    if (upErr) { toast("Error subiendo la foto: " + upErr.message); return; }
    const { data: pub } = sb.storage.from("fotos").getPublicUrl(path);
    datos.foto_url = pub.publicUrl;
  }

  let jugadorId;
  if (miJugador) {
    const { error } = await sb.from("jugadores").update(datos).eq("id", miJugador.id);
    if (error) { toast("Error: " + error.message); return; }
    jugadorId = miJugador.id;
  } else {
    // ¿esta persona ya tiene un perfil precargado del ranking del circuito
    // (torneo en curso, importado antes de que se registrara)? Si lo hay y es
    // uno solo, lo reclama (así entra con sus puntos) en vez de crear uno nuevo en cero.
    const { data: idReclamado } = await sb.rpc("reclamar_perfil_ranking", { p_nombre: nombre, p_apellido: apellido });
    if (idReclamado) {
      const { error } = await sb.from("jugadores").update(datos).eq("id", idReclamado);
      if (error) { toast("Error: " + error.message); return; }
      jugadorId = idReclamado;
    } else {
      const { data, error } = await sb.from("jugadores").insert(datos).select().single();
      if (error) { toast("Error: " + error.message); return; }
      jugadorId = data.id;
    }
  }

  await sb.from("disponibilidad").delete().eq("jugador_id", jugadorId).is("torneo_id", null);
  const disponibilidades = leerRestriccionesDeForm("disponibilidadForm").map((r) => ({ jugador_id: jugadorId, torneo_id: null, ...r }));
  if (disponibilidades.length > 0) await sb.from("disponibilidad").insert(disponibilidades);

  const { data: perfil } = await sb.from("jugadores").select("*").eq("id", jugadorId).single();
  miJugador = perfil;
  editandoPerfil = false;
  document.getElementById("jFoto").value = "";
  toast(datos.categoria_pendiente ? "¡Perfil guardado! Tu categoría queda pendiente de aprobación 🎾" : "¡Perfil guardado! 🎾");
  pedirPermisoNotificaciones();
  renderVistaPerfil();
  suscribirseANotificacionesRealtime();
  actualizarContadorNotificaciones();
  cargarRanking();
  cargarMejoresPorCategoria();
  if (torneoActualId) renderInscribirme();
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btnGuardarClaveNueva").addEventListener("click", async () => {
  const btn = document.getElementById("btnGuardarClaveNueva");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  const c1 = document.getElementById("nuevaClave1").value;
  const c2 = document.getElementById("nuevaClave2").value;
  const err = document.getElementById("claveNuevaError");
  err.textContent = "";
  if (c1.length < 6) { err.textContent = "La contraseña debe tener al menos 6 caracteres."; return; }
  if (c1 !== c2) { err.textContent = "Las dos contraseñas no coinciden."; return; }

  const { error } = await sb.auth.updateUser({ password: c1 });
  if (error) { err.textContent = error.message; return; }

  await sb.from("jugadores").update({ debe_cambiar_clave: false }).eq("id", miJugador.id);
  miJugador.debe_cambiar_clave = false;
  document.getElementById("nuevaClave1").value = "";
  document.getElementById("nuevaClave2").value = "";
  document.getElementById("cambiarClaveOverlay").style.display = "none";
  toast("¡Contraseña actualizada! 🔒");
  } finally {
    btn.disabled = false;
  }
});

async function manejarCambioSesion(session) {
  currentUser = session?.user || null;
  miJugador = null;
  isAdmin = false;

  if (currentUser) {
    const [{ data: perfil }, { data: adminRow }] = await Promise.all([
      sb.from("jugadores").select("*").eq("auth_user_id", currentUser.id).maybeSingle(),
      sb.from("admins").select("user_id").eq("user_id", currentUser.id).maybeSingle()
    ]);
    miJugador = perfil || null;
    isAdmin = !!adminRow;
  }

  document.getElementById("cambiarClaveOverlay").style.display = miJugador?.debe_cambiar_clave ? "flex" : "none";

  // body.is-admin (más abajo en style.css) es lo único que decide si #btnAdminPanel
  // se muestra — igual en mobile y en desktop (ver comentario junto a #btnAdminPanel
  // en style.css).
  document.body.classList.toggle("is-admin", isAdmin);
  document.getElementById("perfilNombreCorto").textContent = miJugador ? miJugador.nombre : "";
  // foto de perfil real en el header (en vez del ícono genérico) apenas está disponible —
  // si no hay sesión o no cargó foto, avatarHtml ya resuelve el ícono de pelota de siempre
  document.getElementById("perfilAvatarWrap").innerHTML = miJugador
    ? avatarHtml(miJugador.foto_url, 22)
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="12" cy="8" r="3.3"/><path d="M5 20c0-3.6 3.1-6.5 7-6.5s7 2.9 7 6.5"/></svg>';

  renderVistaPerfil();
  suscribirseANotificacionesRealtime();
  actualizarContadorNotificaciones();
  if (isAdmin) { cargarJugadoresAdmin(); if (FEATURE_JUGAR_HABILITADA) cargarReservasPendientesAdmin(); }
  calcularTorneoDestacado();
  cargarHeroPosicion();
  cargarMiProximoPartido();
  cargarMisUltimosPartidos();
  if (torneoActualId) refrescarDetalleTorneo();
  if (FEATURE_JUGAR_HABILITADA) renderJugar();

  // recién acá se sabe con certeza si hay sesión / si es admin, así que el
  // primer enrutamiento (deep-link o refresh) se resuelve una sola vez acá
  if (!primerEnrutamientoHecho) { primerEnrutamientoHecho = true; despacharRuta(); }
}
let primerEnrutamientoHecho = false;
sb.auth.onAuthStateChange((_event, session) => manejarCambioSesion(session));

// ============================================================
// RANKING (segmentado por categoría, vía función pública)
// ============================================================
let generoRankingActual = localStorage.getItem("np_genero_ranking") || null;
async function cargarRanking() {
  // ranking_categoria_publico() (no jugadores_publicos()): devuelve una fila por cada
  // categoría en la que el jugador tiene puntos, así el mismo jugador puede aparecer
  // en el ranking de más de una categoría a la vez.
  const { data } = await sb.rpc("ranking_categoria_publico");
  const todos = data || [];
  const categorias = [...new Set(todos.map((j) => j.categoria).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "es", { numeric: true }));

  const contGenero = document.getElementById("generoRankingPills");
  const cont = document.getElementById("categoriaPills");
  if (categorias.length === 0) {
    contGenero.innerHTML = "";
    cont.innerHTML = "";
    document.querySelector("#tablaRanking tbody").innerHTML = "";
    document.getElementById("rankingVacio").style.display = "block";
    ultimoRankingExport = null;
    return;
  }

  // primer nivel: Damas / Caballeros (solo los géneros que efectivamente tienen categorías)
  const grupos = agruparPorGenero(categorias);
  const generosConDatos = ORDEN_GENEROS.filter((g) => grupos[g].length > 0);
  if (!generoRankingActual || !generosConDatos.includes(generoRankingActual)) {
    generoRankingActual = generosConDatos[0];
  }
  contGenero.innerHTML = generosConDatos.length > 1 ? generosConDatos.map((g) =>
    `<button class="pill ${g === generoRankingActual ? "active" : ""}" data-genero="${g}">${g}</button>`
  ).join("") : "";
  contGenero.querySelectorAll(".pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      generoRankingActual = btn.dataset.genero;
      localStorage.setItem("np_genero_ranking", generoRankingActual);
      categoriaRankingActual = null; // que elija la primera categoría de ese género
      cargarRanking();
    });
  });

  // segundo nivel: categorías del género elegido
  const categoriasDelGenero = grupos[generoRankingActual];
  if (!categoriaRankingActual || !categoriasDelGenero.includes(categoriaRankingActual)) {
    categoriaRankingActual = categoriasDelGenero[0];
  }

  cont.innerHTML = categoriasDelGenero.map((c) =>
    `<button class="pill ${c === categoriaRankingActual ? "active" : ""}" data-categoria="${c}">${c}</button>`
  ).join("");
  cont.querySelectorAll(".pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      categoriaRankingActual = btn.dataset.categoria;
      localStorage.setItem("np_categoria_ranking", categoriaRankingActual);
      cargarRanking();
    });
  });

  const completa = todos.filter((j) => j.categoria === categoriaRankingActual)
    .sort((a, b) => b.puntos_ranking - a.puntos_ranking);
  ultimoRankingExport = { categoria: categoriaRankingActual, lista: completa };

  const tbody = document.querySelector("#tablaRanking tbody");
  tbody.innerHTML = "";
  if (completa.length === 0) {
    document.getElementById("rankingVacio").style.display = "block";
    return;
  }
  document.getElementById("rankingVacio").style.display = "none";
  completa.forEach((j, idx) => {
    const posicion = idx + 1;
    // clasifica al Master de fin de año: primeros 20. La foto grande (con borde
    // dorado) queda solo para los primeros 10 — son dos cortes distintos ahora.
    const clasificaMaster = posicion <= 20;
    const fotoGrande = posicion <= 10;
    const tr = document.createElement("tr");
    if (clasificaMaster) tr.className = "fila-master";
    const posClass = posicion <= 3 ? `pos-${posicion}` : "";
    const avatarClass = fotoGrande ? "avatar-master" : "";
    const badgeMaster = clasificaMaster ? `<span class="badge" style="color:#ffd700;border-color:#ffd700">Master</span>` : "";
    tr.innerHTML = `<td class="${posClass}">${posicion}</td>
      <td><div style="display:flex;align-items:center;gap:8px">${avatarHtml(j.foto_url, fotoGrande ? 72 : 30, avatarClass)}<span>${escapeHtml(j.nombre)} ${escapeHtml(j.apellido)} ${badgeMaster}</span></div></td>
      <td><strong class="ranking-puntos">${j.puntos_ranking}</strong></td>
      <td class="ranking-secundario">${j.partidos_jugados}</td>
      <td class="ranking-secundario">${j.partidos_ganados}</td>`;
    tr.style.cursor = "pointer";
    tr.addEventListener("click", () => abrirPerfilJugador(j.id));
    tbody.appendChild(tr);
  });
}

// ============================================================
// EXPORTAR RANKING COMO IMAGEN (para redes — tamaño Historia de Instagram,
// 1080x1920). Solo admin, botones en la propia pantalla de Ranking. Se arma
// con la lista que cargarRanking() ya calculó (ultimoRankingExport) -- no se
// pide de nuevo a Supabase. Todo con Canvas nativo, sin librerías nuevas.
// ============================================================
let ultimoRankingExport = null; // { categoria, lista } -- lo actualiza cargarRanking()

function descargarCanvas(canvas, nombreArchivo) {
  try {
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = nombreArchivo;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }, "image/png");
    return true;
  } catch (e) {
    return false;
  }
}

// Recorta y dibuja "cover" (llena el rectángulo sin deformar la foto,
// recortando el sobrante) -- mismo criterio que ya usa el círculo del
// campeón con su propia foto, generalizado para pintar el fondo entero.
function dibujarImagenCover(ctx, img, x, y, w, h) {
  const escala = Math.max(w / img.width, h / img.height);
  const anchoRecorte = w / escala, altoRecorte = h / escala;
  const sx = (img.width - anchoRecorte) / 2, sy = (img.height - altoRecorte) / 2;
  ctx.drawImage(img, sx, sy, anchoRecorte, altoRecorte, x, y, w, h);
}

// fotoFondo (opcional): foto real de cancha/pelota ya cargada con
// cargarImagenParaCanvas. Se oscurece con un degradé para que el título y la
// lista se sigan leyendo bien encima. Sin foto, queda el degradé liso de
// siempre (fallback si algún día no está disponible el archivo).
function fondoImagenExport(ctx, w, h, fotoFondo) {
  if (fotoFondo) {
    dibujarImagenCover(ctx, fotoFondo, 0, 0, w, h);
    const oscuro = ctx.createLinearGradient(0, 0, 0, h);
    oscuro.addColorStop(0, "rgba(5,8,10,.88)");
    oscuro.addColorStop(0.22, "rgba(5,8,10,.5)");
    oscuro.addColorStop(0.6, "rgba(5,8,10,.7)");
    oscuro.addColorStop(1, "rgba(5,8,10,.92)");
    ctx.fillStyle = oscuro;
    ctx.fillRect(0, 0, w, h);
  } else {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "#132a20");
    grad.addColorStop(1, "#05080A");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }
  const brillo = ctx.createRadialGradient(w / 2, 0, 0, w / 2, 0, w);
  brillo.addColorStop(0, "rgba(111,224,138,.22)");
  brillo.addColorStop(1, "rgba(111,224,138,0)");
  ctx.fillStyle = brillo;
  ctx.fillRect(0, 0, w, h);
}

function encabezadoImagenExport(ctx, w, categoria, etiqueta) {
  ctx.textAlign = "center";
  ctx.fillStyle = "#6FE08A";
  ctx.font = "700 30px Manrope";
  ctx.fillText(etiqueta, w / 2, 130);
  ctx.fillStyle = "#EAF1EE";
  ctx.font = "900 76px 'Playfair Display'";
  ctx.fillText("NORTE PADEL", w / 2, 220);
  ctx.fillStyle = "#9BB0A7";
  ctx.font = "600 34px Manrope";
  ctx.fillText(categoria, w / 2, 280);
}

function piePaginaImagenExport(ctx, w, h) {
  ctx.textAlign = "center";
  ctx.fillStyle = "#9BB0A7";
  ctx.font = "600 22px Manrope";
  const fecha = new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" });
  ctx.fillText(`Ranking al ${fecha}`, w / 2, h - 50);
}

// crossOrigin="anonymous": si Supabase Storage no responde con headers CORS,
// el navegador dispara onerror (no deja el canvas "manchado") -- por eso alcanza
// con este resolve(null) para el fallback de iniciales, sin try/catch extra.
function cargarImagenParaCanvas(url) {
  return new Promise((resolve) => {
    if (!url) { resolve(null); return; }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function exportarRankingTop20() {
  if (!ultimoRankingExport || ultimoRankingExport.lista.length === 0) { toast("No hay ranking cargado para exportar"); return; }
  await document.fonts.ready;
  const { categoria, lista } = ultimoRankingExport;
  const top = lista.slice(0, 20);
  const W = 1080, H = 1920;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const fondo = await cargarImagenParaCanvas("ranking-bg-top20.jpg");
  fondoImagenExport(ctx, W, H, fondo);
  encabezadoImagenExport(ctx, W, categoria, "🏆 TOP 20 · RANKING");

  const inicioLista = 360;
  const altoFila = (H - inicioLista - 120) / 20;
  const colorPosicion = (pos) => pos === 1 ? "#ffd700" : pos === 2 ? "#c9d3e0" : pos === 3 ? "#ff9d5c" : "#EAF1EE";
  top.forEach((j, idx) => {
    const y = inicioLista + idx * altoFila;
    const posicion = idx + 1;
    if (idx % 2 === 0) {
      ctx.fillStyle = "rgba(255,255,255,.07)";
      ctx.fillRect(60, y, W - 120, altoFila - 6);
    }
    ctx.textAlign = "left";
    ctx.fillStyle = colorPosicion(posicion);
    ctx.font = "800 34px Manrope";
    ctx.fillText(String(posicion).padStart(2, "0"), 90, y + altoFila / 2 + 12);
    ctx.fillStyle = "#EAF1EE";
    ctx.font = "700 34px Manrope";
    ctx.fillText(`${j.nombre} ${j.apellido}`, 175, y + altoFila / 2 + 12);
    ctx.textAlign = "right";
    ctx.fillStyle = "#6FE08A";
    ctx.font = "800 34px Manrope";
    ctx.fillText(String(j.puntos_ranking), W - 90, y + altoFila / 2 + 12);
  });

  piePaginaImagenExport(ctx, W, H);
  descargarCanvas(canvas, `ranking-${categoria.replace(/\s+/g, "-").toLowerCase()}-top20.png`);
}

function dibujarCampeonEnCanvas(ctx, campeon, categoria, foto, fotoFondo, W, H) {
  ctx.clearRect(0, 0, W, H);
  fondoImagenExport(ctx, W, H, fotoFondo);
  encabezadoImagenExport(ctx, W, categoria, "🏆 CAMPEÓN DE LA CATEGORÍA");

  const cx = W / 2, cy = 640, radio = 260;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radio, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (foto) {
    const lado = Math.min(foto.width, foto.height);
    const sx = (foto.width - lado) / 2, sy = (foto.height - lado) / 2;
    ctx.drawImage(foto, sx, sy, lado, lado, cx - radio, cy - radio, radio * 2, radio * 2);
  } else {
    ctx.fillStyle = "#0F7A46";
    ctx.fillRect(cx - radio, cy - radio, radio * 2, radio * 2);
    ctx.fillStyle = "#EAF1EE";
    ctx.textAlign = "center";
    ctx.font = "900 160px Manrope";
    ctx.fillText(`${campeon.nombre[0] || ""}${campeon.apellido[0] || ""}`, cx, cy + 55);
  }
  ctx.restore();
  ctx.lineWidth = 8;
  ctx.strokeStyle = "#6FE08A";
  ctx.beginPath();
  ctx.arc(cx, cy, radio, 0, Math.PI * 2);
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.fillStyle = "#EAF1EE";
  ctx.font = "900 68px 'Playfair Display'";
  ctx.fillText(`${campeon.nombre} ${campeon.apellido}`, cx, cy + radio + 130);
  ctx.fillStyle = "#6FE08A";
  ctx.font = "800 92px Manrope";
  ctx.fillText(String(campeon.puntos_ranking), cx, cy + radio + 250);
  ctx.fillStyle = "#9BB0A7";
  ctx.font = "700 30px Manrope";
  ctx.fillText("PUNTOS", cx, cy + radio + 290);

  piePaginaImagenExport(ctx, W, H);
}

async function exportarRankingCampeon() {
  if (!ultimoRankingExport || ultimoRankingExport.lista.length === 0) { toast("No hay ranking cargado para exportar"); return; }
  await document.fonts.ready;
  const { categoria, lista } = ultimoRankingExport;
  const campeon = lista[0];
  const W = 1080, H = 1920;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const [foto, fondo] = await Promise.all([
    cargarImagenParaCanvas(campeon.foto_url),
    cargarImagenParaCanvas("ranking-bg-campeon.jpg")
  ]);
  dibujarCampeonEnCanvas(ctx, campeon, categoria, foto, fondo, W, H);
  const nombreArchivo = `campeon-${categoria.replace(/\s+/g, "-").toLowerCase()}.png`;
  const ok = descargarCanvas(canvas, nombreArchivo);
  if (!ok && foto) {
    // canvas "manchado" pese al crossOrigin (CORS raro del hosting de la foto):
    // se reintenta directamente sin foto de jugador en vez de dejar al usuario
    // sin nada (el fondo de cancha, al ser un archivo propio del sitio, no
    // tiene este problema).
    dibujarCampeonEnCanvas(ctx, campeon, categoria, null, fondo, W, H);
    descargarCanvas(canvas, nombreArchivo);
    toast("Se exportó sin la foto (no se pudo leer por permisos de imagen)");
  }
}

document.getElementById("btnExportarTop20")?.addEventListener("click", exportarRankingTop20);
document.getElementById("btnExportarCampeon")?.addEventListener("click", exportarRankingCampeon);

// ============================================================
// PERFIL PÚBLICO DE JUGADOR (foto grande, stats, torneos ganados)
// ============================================================
let vistaAntesDePerfilJugador = "ranking";
async function abrirPerfilJugador(jugadorId) {
  const vistaActual = document.querySelector(".view.active");
  if (vistaActual && vistaActual.id !== "view-perfil-jugador") {
    vistaAntesDePerfilJugador = vistaActual.id.replace("view-", "");
  }
  cambiarVista("perfil-jugador", "/perfil-jugador/" + jugadorId);

  const [{ data: jugadores }, { data: torneosGanados }, { data: finalesPerdidas }, { data: estadisticasRows }] = await Promise.all([
    sb.rpc("jugadores_publicos"),
    sb.rpc("torneos_ganados_publico", { p_jugador_id: jugadorId }),
    sb.rpc("finales_perdidas_publico", { p_jugador_id: jugadorId }),
    sb.rpc("estadisticas_jugador", { p_jugador_id: jugadorId })
  ]);
  const j = (jugadores || []).find((x) => x.id === jugadorId);
  if (!j) { toast("No se encontró el jugador"); cambiarVista(vistaAntesDePerfilJugador); return; }
  const est = (estadisticasRows || [])[0] || {};

  document.getElementById("pjFoto").innerHTML = avatarHtml(j.foto_url, 96, "", true);
  document.getElementById("pjNombre").textContent = `${j.nombre} ${j.apellido}`;
  document.getElementById("pjCategoria").textContent = j.categoria;
  document.getElementById("pjPuntos").textContent = j.puntos_ranking;
  document.getElementById("pjJugados").textContent = j.partidos_jugados;
  document.getElementById("pjGanados").textContent = j.partidos_ganados;
  document.getElementById("pjEfectividad").textContent =
    j.partidos_jugados > 0 ? Math.round((j.partidos_ganados / j.partidos_jugados) * 100) + "%" : "—";

  document.getElementById("pjFinales").textContent = est.total_finales || 0;
  document.getElementById("pjTotalTorneos").textContent = est.total_torneos || 0;
  document.getElementById("pj6m").textContent = est.partidos_6m
    ? `${est.ganados_6m || 0}G - ${est.partidos_6m - (est.ganados_6m || 0)}P`
    : "sin partidos";
  document.getElementById("pjPrimerUltimoTorneo").textContent =
    est.primer_torneo ? `Primer torneo: ${est.primer_torneo} · Último: ${est.ultimo_torneo}` : "";

  const cont = document.getElementById("pjTorneosGanados");
  cont.innerHTML = (torneosGanados || []).length > 0
    ? torneosGanados.map((t) => `
      <div class="pj-torneo-item">
        <div><strong>${iconoTrofeo()} ${t.torneo_nombre}</strong><div class="match-meta">con ${escapeHtml(t.companero_nombre)} ${escapeHtml(t.companero_apellido)}${t.categoria ? " · " + t.categoria : ""}</div></div>
        <span class="match-meta">${t.fecha || ""}</span>
      </div>`).join("")
    : '<p class="empty">Todavía no ganó ningún torneo.</p>';

  // medallero: 🥇 por cada torneo ganado, 🥈 por cada final perdida — resumen arriba del
  // todo del perfil, y el detalle de subcampeonatos en su propia tarjeta más abajo
  const cantOro = (torneosGanados || []).length;
  const cantPlata = (finalesPerdidas || []).length;
  const trofeos = document.getElementById("pjTrofeos");
  if (cantOro > 0 || cantPlata > 0) {
    trofeos.style.display = "flex";
    trofeos.innerHTML = [
      cantOro > 0 ? `<span class="pj-medalla pj-medalla-oro">🥇 ${cantOro > 1 ? `${cantOro} veces campeón` : "Campeón"}</span>` : "",
      cantPlata > 0 ? `<span class="pj-medalla pj-medalla-plata">🥈 ${cantPlata > 1 ? `${cantPlata} veces subcampeón` : "Subcampeón"}</span>` : ""
    ].join("");
  } else {
    trofeos.style.display = "none";
    trofeos.innerHTML = "";
  }

  const contSub = document.getElementById("pjSubcampeonatos");
  const cardSub = document.getElementById("pjSubcampeonatosCard");
  cardSub.style.display = cantPlata > 0 ? "block" : "none";
  contSub.innerHTML = (finalesPerdidas || []).map((t) => `
    <div class="pj-torneo-item">
      <div><strong>🥈 ${t.torneo_nombre}</strong><div class="match-meta">con ${escapeHtml(t.companero_nombre)} ${escapeHtml(t.companero_apellido)}${t.categoria ? " · " + t.categoria : ""}</div></div>
      <span class="match-meta">${t.fecha || ""}</span>
    </div>`).join("");
}
document.getElementById("btnVolverPerfilJugador").addEventListener("click", () => cambiarVista(vistaAntesDePerfilJugador));
// "Ver mis estadísticas" en Mi Perfil: reutiliza el perfil público de jugador
// (ya trae puntos/jugados/ganados/torneos reales vía RPC) en vez de duplicar
// esa lógica acá con datos inventados.
document.getElementById("btnVerMiPerfilPublico").addEventListener("click", () => {
  if (miJugador) abrirPerfilJugador(miJugador.id);
});

// ============================================================
// INICIO: próximos torneos con flyer + jugador del mes
// ============================================================
async function cargarInicio() {
  const hoy = new Date().toISOString().slice(0, 10);
  const { data } = await sb.from("torneos").select("*").not("flyer_url", "is", null).order("fecha_inicio", { ascending: true });
  const proximos = (data || []).filter((t) => !t.fecha_fin || t.fecha_fin >= hoy);

  const destacado = document.getElementById("flyerDestacado");
  const grid = document.getElementById("flyerMini");
  const vacio = document.getElementById("inicioSinTorneos");
  destacado.innerHTML = "";
  grid.innerHTML = "";

  if (proximos.length === 0) {
    vacio.style.display = "block";
    moverFlyerDestacadoSegunAncho();
    return;
  }
  vacio.style.display = "none";

  // el primero, más grande y destacado; el resto, en la grilla chica de siempre
  const [primero, ...resto] = proximos;
  destacado.innerHTML = `
    <div class="flyer-destacado" style="background-image:url('${primero.flyer_url}')">
      <div class="flyer-destacado-info">
        <strong>${primero.nombre}</strong>
        <span>${iconoCalendarioChico()} ${primero.fecha_inicio}</span>
      </div>
    </div>`;
  destacado.querySelector(".flyer-destacado").addEventListener("click", () => abrirTorneo(primero.id));

  resto.forEach((t) => {
    const div = document.createElement("div");
    div.innerHTML = `<img src="${t.flyer_url}" alt="${t.nombre}" loading="lazy" style="cursor:pointer" /><div class="match-meta meta-caption">${t.nombre}</div>`;
    div.querySelector("img").addEventListener("click", () => abrirTorneo(t.id));
    grid.appendChild(div);
  });
  moverFlyerDestacadoSegunAncho();
}

// ampliable=true agrega el data-attribute que capta el listener delegado de más abajo
// (ver "FOTO AMPLIADA") para poder tocar la foto y verla en pantalla grande. Además
// suma una lupa chica superpuesta (pointer-events:none, no interfiere con el click
// ni con el foco por teclado, que siguen siendo los de la imagen) para que la acción
// de ampliar sea visible de un vistazo y no dependa solo del cursor al pasar el mouse.
function avatarHtml(fotoUrl, size, extraClass, ampliable) {
  const s = size || 44;
  const clickable = ampliable && fotoUrl;
  const cls = (extraClass ? ` ${extraClass}` : "") + (clickable ? " avatar-clickable" : "");
  const dataAttr = clickable ? ` data-foto-grande="${fotoUrl}" tabindex="0" role="button" aria-label="Ver foto en grande"` : "";
  const img = fotoUrl
    ? `<img class="avatar${cls}" src="${fotoUrl}" alt="" loading="lazy" style="width:${s}px;height:${s}px" onerror="this.style.display='none'"${dataAttr} />`
    : `<div class="avatar avatar-placeholder${cls}" style="width:${s}px;height:${s}px">🎾</div>`;
  if (!clickable) return img;
  const iconoLupa = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><circle cx="10" cy="10" r="6.5"/><path d="M10 7.2v5.6M7.2 10h5.6"/><path d="M15 15l5.5 5.5"/></svg>`;
  return `<span class="avatar-wrap" style="width:${s}px;height:${s}px">${img}<span class="avatar-zoom-icon" aria-hidden="true">${iconoLupa}</span></span>`;
}

// íconos de trazo chicos para metadatos de partido/torneo (cancha, horario, fecha,
// ganador) — mismo estilo de línea que ya usan los íconos de la tabbar, en vez de
// emoji (📍🕒📅🏆). No es una librería nueva, son 4 SVG inline reutilizables.
function iconoPin() { return '<svg class="meta-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M12 21s7-7.5 7-12a7 7 0 1 0-14 0c0 4.5 7 12 7 12Z"/><circle cx="12" cy="9" r="2.3"/></svg>'; }
function iconoReloj() { return '<svg class="meta-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>'; }
function iconoTrofeo() { return '<svg class="meta-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M8 4h8v4a4 4 0 0 1-8 0V4Z"/><path d="M8 5H5a3 3 0 0 0 3 4"/><path d="M16 5h3a3 3 0 0 1-3 4"/><path d="M12 13v3"/><path d="M9 20h6"/><path d="M10 16h4l.5 4h-5l.5-4Z"/></svg>'; }
function iconoCalendarioChico() { return '<svg class="meta-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 9.5h16"/><path d="M8 3v4M16 3v4"/></svg>'; }

// "Mejores de cada categoría": reemplaza al viejo "Jugador/Jugadora del mes"
// (una sola tarjeta que rotaba por género). Reutiliza ranking_categoria_publico()
// -- la misma RPC de Ranking/heroPosición -- y de ahí saca el puntaje más alto
// de cada categoría; no hace falta una RPC nueva. Se muestran de a 2 por
// pantalla (como pidió el club, porque con todas juntas quedaba muy largo),
// en un carrusel horizontal con scroll-snap + puntos (mismo patrón que ya usan
// Campeones y el hero: actualizarPuntosScroll).
let cacheMejoresCategoria = null;
async function cargarMejoresPorCategoria() {
  const { data } = await sb.rpc("ranking_categoria_publico");
  const mejorPorCategoria = new Map();
  (data || []).forEach((j) => {
    const actual = mejorPorCategoria.get(j.categoria);
    if (!actual || j.puntos_ranking > actual.puntos_ranking) mejorPorCategoria.set(j.categoria, j);
  });
  cacheMejoresCategoria = [...mejorPorCategoria.values()]
    .sort((a, b) => a.categoria.localeCompare(b.categoria, "es", { numeric: true }));
  renderMejoresPorCategoria();
}

// Cuántas tarjetas entran por página: no un 2 fijo (en desktop, con el ancho
// completo, quedaban solo 2 tarjetas angostas y mucho hueco vacío a los
// costados) -- se calcula según el ancho real disponible, con ~230px por
// tarjeta como medida cómoda para que la foto de fondo no quede ni muy
// chica ni muy estirada. Nunca menos de 2 (así queda igual que antes en
// mobile) ni más de 6 (para no volver las tarjetas ilegibles de angostas).
function tarjetasPorPagina(anchoDisponible) {
  const ANCHO_TARJETA = 230, GAP = 10;
  const cantidad = Math.floor((anchoDisponible + GAP) / (ANCHO_TARJETA + GAP));
  return Math.max(2, Math.min(6, cantidad || 2));
}

function renderMejoresPorCategoria() {
  const mejores = cacheMejoresCategoria;
  const banda = document.getElementById("mejoresCategoriaCard");
  if (!mejores) return;
  if (mejores.length === 0) { banda.style.display = "none"; return; }
  banda.style.display = "block";

  const tarjetaHtml = (j) => {
    const fondo = j.foto_url ? `style="background-image:url('${j.foto_url}')"` : "";
    return `
      <div class="destacado-card" data-jugador-id="${j.id}" ${fondo}>
        <div class="destacado-tag">🏆 ${escapeHtml(j.categoria)}</div>
        <div class="destacado-stat">
          <strong>${j.puntos_ranking}</strong>
          <span>puntos</span>
        </div>
        <div class="destacado-info">
          <strong>${escapeHtml(j.nombre)} ${escapeHtml(j.apellido)}</strong>
        </div>
      </div>`;
  };
  const track = document.getElementById("mejoresCategoriaTrack");
  const porPagina = tarjetasPorPagina(track.clientWidth);
  // mismo número de columnas en todas las páginas (así las tarjetas no cambian
  // de ancho entre una página llena y la última, que puede venir incompleta);
  // si hay menos categorías que "porPagina", se achica a esa cantidad para no
  // dejar una sola página con columnas vacías forzadas.
  const columnas = Math.min(porPagina, mejores.length);
  const paginas = [];
  for (let i = 0; i < mejores.length; i += porPagina) paginas.push(mejores.slice(i, i + porPagina));
  track.innerHTML = paginas.map((pag) => `<div class="destacados-grid" style="grid-template-columns:repeat(${columnas},1fr)">${pag.map(tarjetaHtml).join("")}</div>`).join("");

  track.querySelectorAll(".destacado-card[data-jugador-id]").forEach((card) => {
    card.addEventListener("click", () => abrirPerfilJugador(card.dataset.jugadorId));
  });
  actualizarPuntosScroll("mejoresCategoriaTrack", "mejoresCategoriaDots");
}

// tira rotativa de "ascendieron este mes" en Inicio; si son pocos igual da vueltas
// despacio, y si son muchos alcanza para no amontonarlos todos en pantalla a la vez
async function cargarAscendidos() {
  const { data } = await sb.rpc("ascendidos_del_mes");
  const card = document.getElementById("ascendidosCard");
  if (!data || data.length === 0) { card.style.display = "none"; return; }
  card.style.display = "block";

  const item = (a) => `
    <div class="ascendido-item" data-jugador-id="${a.jugador_id}">
      ${avatarHtml(a.foto_url, 56)}
      <strong>${escapeHtml(a.nombre)} ${escapeHtml(a.apellido)}</strong>
      <span>→ ${a.categoria_nueva}</span>
    </div>`;
  const set = `<div class="ascendidos-set">${data.map(item).join("")}</div>`;
  // el segundo juego es una copia para el loop infinito del carrusel (ver marquee-scroll);
  // se oculta a lectores de pantalla para no repetir cada nombre dos veces
  const track = document.getElementById("ascendidosContenido");
  track.innerHTML = set + `<div class="ascendidos-set" aria-hidden="true">${data.map(item).join("")}</div>`;
  track.querySelectorAll(".ascendido-item").forEach((el) => {
    el.addEventListener("click", () => abrirPerfilJugador(el.dataset.jugadorId));
  });
}

// "Últimos resultados" / "Próximos partidos" en Inicio, del torneo destacado
// (en curso o el próximo) — no dependen del orden de otras llamadas: calculan
// su propio torneo destacado en vez de leer el global (que lo arma
// manejarCambioSesion() por separado, sin garantía de haber corrido antes).
// Reutiliza la misma tarjeta de Resultados (llavePartidoCardHtml) en vez de
// una tira que gira -- con la banda de arriba ya en movimiento, sumarle más
// quedaba recargado.
async function cargarUltimosProximos() {
  await calcularTorneoDestacado();
  const idTorneo = torneoDestacadoId;
  if (!idTorneo) {
    document.getElementById("inicioResultadosWrap").style.display = "none";
    document.getElementById("inicioProximoDestacadoWrap").style.display = "none";
    return;
  }
  const { data } = await sb.rpc("partidos_publicos", { p_torneo_id: idTorneo });
  const partidos = data || [];
  const ahora = new Date();

  const jugados = partidos.filter((p) => p.estado === "jugado" && p.horario)
    .sort((a, b) => new Date(b.horario) - new Date(a.horario)).slice(0, 3);
  const proximos = partidos.filter((p) => p.horario && p.estado !== "jugado" && new Date(p.horario) >= ahora)
    .sort((a, b) => new Date(a.horario) - new Date(b.horario)).slice(0, 3);

  // "resultados" y "calendario" ya no son pantallas separadas — las dos tarjetas
  // llevan a la misma pantalla única de Torneo ("").
  renderInicioPartidosGrid("inicioResultadosWrap", "inicioResultadosGrid", jugados, () => abrirTorneo(idTorneo, ""));
  // "Próximo partido destacado": un solo carrusel (en todos los anchos) con
  // hasta 3 próximos partidos, en vez de un banner fijo + una lista aparte
  // (quedaban duplicados). Rota solo, como el carrusel del hero.
  renderProximosCarrusel(proximos, idTorneo);
}

// Carrusel de "Próximo partido destacado": una slide .match-pair-destacado por
// partido (fotos grandes en duotono, ver matchVsRowHtml + estilos en
// style.css), con scroll-snap + puntos + autoplay -- mismo mecanismo que el
// carrusel del hero, reutilizado (ver actualizarPuntosCarrusel/reiniciarAutoplayCarrusel).
function renderProximosCarrusel(items, idTorneo) {
  const wrap = document.getElementById("inicioProximoDestacadoWrap");
  const track = document.getElementById("destacadoCarouselTrack");
  if (items.length === 0) { wrap.style.display = "none"; return; }
  wrap.style.display = "block";
  track.innerHTML = items.map((p) => {
    const horario = p.horario
      ? new Date(p.horario).toLocaleString("es-AR", { weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
      : "Horario a definir";
    const local = p.cancha_nombre ? `${p.complejo_nombre ? p.complejo_nombre + " · " : ""}${p.cancha_nombre}` : (p.complejo_nombre || "A definir");
    return `
      <div class="hero-carousel-slide">
        <div class="match-pair-destacado" style="cursor:pointer" data-p="${p.id}">
          ${matchVsRowHtml(p)}
          <p class="match-meta">${p.categoria ? `${p.categoria} · ` : ""}${iconoCalendarioChico()} ${horario} · ${iconoPin()} ${local}</p>
        </div>
      </div>`;
  }).join("");
  track.querySelectorAll(".match-pair-destacado").forEach((el) => { el.onclick = () => abrirTorneo(idTorneo, ""); });
  actualizarPuntosCarrusel("destacadoCarouselTrack", "destacadoCarouselDots", true);
  reiniciarAutoplayCarrusel("destacadoCarouselTrack");
}

function renderInicioPartidosGrid(wrapId, gridId, items, onClick) {
  const wrap = document.getElementById(wrapId);
  if (items.length === 0) { wrap.style.display = "none"; return; }
  wrap.style.display = "block";
  const grid = document.getElementById(gridId);
  grid.innerHTML = items.map(llavePartidoCardHtml).join("");
  // clic en cualquier tarjeta lleva al Calendario/Resultados de ese torneo (no
  // al detalle del partido: acá no está cargado ultimosPartidos, que es de
  // donde abrirDetallePartido() lee)
  grid.querySelectorAll(".llave-partido").forEach((el) => { el.onclick = onClick; });
}

// admite pegar cualquier link común de YouTube (watch?v=, youtu.be/, /live/, /embed/)
// y se queda solo con el ID de 11 caracteres, para no depender de que el club
// pegue justo el formato "correcto" -- si no matchea nada, no hay transmisión.
function extraerIdYoutube(url) {
  const m = String(url || "").match(/(?:v=|youtu\.be\/|\/live\/|\/embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : "";
}

// "En vivo": video (cargado a mano en Config, ver btnGuardarConfig) + partidos del
// torneo que cae dentro de HOY (no el "destacado" de cargarUltimosProximos, que
// también apunta al próximo torneo aunque todavía no haya arrancado). Reutiliza
// partidos_publicos() y la misma tarjeta de siempre (llavePartidoCardHtml).
async function cargarEnVivo() {
  const videoId = extraerIdYoutube(configApp.youtube_en_vivo);
  const wrapVideo = document.getElementById("enVivoVideoWrap");
  const sinVideo = document.getElementById("enVivoSinVideo");
  if (videoId) {
    wrapVideo.innerHTML = `<iframe src="https://www.youtube.com/embed/${videoId}" title="Transmisión en vivo" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
    wrapVideo.style.display = "block";
    sinVideo.style.display = "none";
  } else {
    wrapVideo.innerHTML = "";
    wrapVideo.style.display = "none";
    sinVideo.style.display = "block";
  }

  await calcularTorneoDestacado(); // idempotente -- asegura torneoEnCursoId sin depender del orden de carga en init()
  const wrapPartidos = document.getElementById("enVivoPartidosWrap");
  if (!torneoEnCursoId) { wrapPartidos.style.display = "none"; return; }
  const { data } = await sb.rpc("partidos_publicos", { p_torneo_id: torneoEnCursoId });
  const partidos = data || [];
  const ahora = new Date();
  const jugandoAhora = partidos.filter((p) => p.estado === "en_juego");
  const proximos = partidos.filter((p) => p.horario && p.estado === "programado" && new Date(p.horario) >= ahora)
    .sort((a, b) => new Date(a.horario) - new Date(b.horario)).slice(0, 6);

  if (jugandoAhora.length === 0 && proximos.length === 0) { wrapPartidos.style.display = "none"; return; }
  wrapPartidos.style.display = "block";
  renderInicioPartidosGrid("enVivoJugandoWrap", "enVivoJugandoGrid", jugandoAhora, () => abrirTorneo(torneoEnCursoId, ""));
  renderInicioPartidosGrid("enVivoProximosWrap", "enVivoProximosGrid", proximos, () => abrirTorneo(torneoEnCursoId, ""));
}

async function cargarHeroPosicion() {
  const card = document.getElementById("heroPosicionCard");
  if (!miJugador) { card.style.display = "none"; return; }
  const { data } = await sb.rpc("ranking_categoria_publico");
  const delGrupo = (data || []).filter((j) => j.categoria === miJugador.categoria)
    .sort((a, b) => b.puntos_ranking - a.puntos_ranking);
  const pos = delGrupo.findIndex((j) => j.id === miJugador.id);
  if (pos === -1) { card.style.display = "none"; return; }
  document.getElementById("heroPosicionValor").textContent = `#${pos + 1}`;
  document.getElementById("heroPosicionSub").textContent = miJugador.categoria;
  card.style.display = "flex";
}

async function cargarCampeones() {
  const { data } = await sb.rpc("campeones_publico");
  const card = document.getElementById("campeonesCard");
  if (!data || data.length === 0) { card.style.display = "none"; return; }
  card.style.display = "block";
  document.getElementById("campeonesContenido").innerHTML = data.map((c) => `
    <div class="campeon-card">
      <div class="campeon-avatares">${avatarHtml(c.jugador1_foto, 48)}${avatarHtml(c.jugador2_foto, 48)}</div>
      <div class="campeon-nombres">
        <span class="campeon-nombre-link" data-jugador-id="${c.jugador1_id}">${escapeHtml(c.jugador1_nombre)} ${escapeHtml(c.jugador1_apellido)}</span> /
        <span class="campeon-nombre-link" data-jugador-id="${c.jugador2_id}">${escapeHtml(c.jugador2_nombre)} ${escapeHtml(c.jugador2_apellido)}</span>
      </div>
      <div class="campeon-torneo">${iconoTrofeo()} ${escapeHtml(c.torneo_nombre)}${c.categoria ? " · " + escapeHtml(c.categoria) : ""}</div>
    </div>
  `).join("");

  document.querySelectorAll("#campeonesContenido .campeon-nombre-link").forEach((el) => {
    el.addEventListener("click", () => abrirPerfilJugador(el.dataset.jugadorId));
  });
  actualizarPuntosScroll("campeonesContenido", "campeonesDots");
}

// "Tu próximo partido": igual que "Tus últimos partidos" (mismo criterio de
// solo-con-sesión-iniciada y misma tarjeta reutilizada), pero el que sigue sin
// jugarse -- así el jugador ve de entrada cuándo y contra quién juega, sin
// tener que ir a buscarlo a Torneos.
async function cargarMiProximoPartido() {
  const wrap = document.getElementById("inicioMiProximoWrap");
  if (!miJugador) { wrap.style.display = "none"; return; }
  const { data } = await sb.rpc("mi_proximo_partido_publico", { p_jugador_id: miJugador.id });
  if (!data || data.length === 0) { wrap.style.display = "none"; return; }
  wrap.style.display = "block";
  document.getElementById("inicioMiProximoGrid").innerHTML = data.map((p) => `
    <div>
      <div class="match-meta meta-caption">${escapeHtml(p.torneo_nombre)}${p.categoria ? " · " + escapeHtml(p.categoria) : ""}</div>
      ${llavePartidoCardHtml(p)}
    </div>
  `).join("");
  document.querySelectorAll("#inicioMiProximoGrid [data-abrir-partido]").forEach((el) => {
    el.addEventListener("click", () => abrirDetallePartido(el.dataset.abrirPartido));
  });
}

// "Tus últimos partidos": solo con sesión iniciada (miJugador). Reutiliza la
// misma tarjeta que ya usan Resultados/Llave (llavePartidoCardHtml) — acá
// arriba de cada una hace falta indicar de qué torneo/categoría es, porque a
// diferencia de esas vistas estos partidos pueden ser de torneos distintos.
async function cargarMisUltimosPartidos() {
  const wrap = document.getElementById("inicioMisPartidosWrap");
  if (!miJugador) { wrap.style.display = "none"; return; }
  const { data } = await sb.rpc("mis_ultimos_partidos_publico", { p_jugador_id: miJugador.id });
  if (!data || data.length === 0) { wrap.style.display = "none"; return; }
  wrap.style.display = "block";
  document.getElementById("inicioMisPartidosGrid").innerHTML = data.map((p) => `
    <div>
      <div class="match-meta meta-caption">${escapeHtml(p.torneo_nombre)}${p.categoria ? " · " + escapeHtml(p.categoria) : ""}</div>
      ${llavePartidoCardHtml(p)}
    </div>
  `).join("");
  document.querySelectorAll("#inicioMisPartidosGrid [data-abrir-partido]").forEach((el) => {
    el.addEventListener("click", () => abrirDetallePartido(el.dataset.abrirPartido));
  });
}

// ============================================================
// EN VIVO: torneo actual (o el próximo) + mi partido asignado
// ============================================================
// fila de partido tipo "orden de juego": pareja · V · pareja, sobre fondo de color
// (se reutiliza acá, en el detalle de un partido y en la lista de partidos de
// Administración). En pádel siempre se juega de a 2: cada lado muestra a sus dos
// jugadores por separado, cada uno con su propio avatar (foto si la cargó, si no
// el ícono de pelota de siempre) — nunca un ícono único representando a la pareja.
// ganador (opcional): 1 o 2 si ya se sabe quién ganó — resalta a esa pareja
// en vez de mostrar los dos lados igual, para que un partido jugado se vea
// distinto (más "resultado") que uno todavía por jugar
function matchVsRowHtml(p, ganador) {
  const cls1 = ganador === 1 ? "ganador" : ganador === 2 ? "perdedor" : "";
  const cls2 = ganador === 2 ? "ganador" : ganador === 1 ? "perdedor" : "";
  const jugadorHtml = (nombre, apellido, foto) => `
    <div class="match-pair-player">
      <span class="match-pair-foto">${avatarHtml(foto, 34)}</span>
      <span class="match-pair-nombre">${escapeHtml([nombre, apellido].filter(Boolean).join(" ") || "?")}</span>
    </div>`;
  return `<div class="match-pair ${ganador ? "jugado" : ""}">
    <div class="match-pair-lado ${cls1}">
      ${jugadorHtml(p.j1a_nombre, p.j1a_apellido, p.j1a_foto)}
      ${jugadorHtml(p.j1b_nombre, p.j1b_apellido, p.j1b_foto)}
    </div>
    <span class="match-pair-vs">VS</span>
    <div class="match-pair-lado der ${cls2}">
      ${jugadorHtml(p.j2a_nombre, p.j2a_apellido, p.j2a_foto)}
      ${jugadorHtml(p.j2b_nombre, p.j2b_apellido, p.j2b_foto)}
    </div>
  </div>`;
}

// Antes alimentaba la vista separada "En vivo" (sacada de la app: Torneos ya cumple esa
// función). Se mantiene solo para calcular torneoDestacadoId, que es a dónde lleva la
// banda "Inscribite ya" de Inicio.
async function calcularTorneoDestacado() {
  const hoy = new Date().toISOString().slice(0, 10);
  const { data: torneos } = await sb.from("torneos").select("*, complejos(nombre, direccion)").order("fecha_inicio");
  const enCurso = (torneos || []).find((t) => t.fecha_inicio <= hoy && (t.fecha_fin || t.fecha_inicio) >= hoy);
  const proximo = (torneos || []).filter((t) => t.fecha_inicio > hoy).sort((a, b) => a.fecha_inicio.localeCompare(b.fecha_inicio))[0];
  torneoDestacadoId = (enCurso || proximo)?.id || null;
  torneoEnCursoId = enCurso?.id || null;
}

document.getElementById("btnDestacarJugador").addEventListener("click", async () => {
  const btn = document.getElementById("btnDestacarJugador");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  const jugadorId = document.getElementById("jdmSelect").value;
  if (!jugadorId) { toast("Elegí un jugador"); return; }
  const motivo = document.getElementById("jdmMotivo").value.trim() || null;
  const { error } = await sb.from("jugador_del_mes").insert({ jugador_id: jugadorId, motivo });
  if (error) { toast("Error: " + error.message); return; }
  toast("Jugador del mes actualizado");
  document.getElementById("jdmMotivo").value = "";
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// COMPLEJOS Y CANCHAS (admin)
// ============================================================
async function cargarComplejos() {
  const { data: complejos } = await sb.from("complejos").select("*").order("nombre");
  const { data: canchas } = await sb.from("canchas").select("*").order("nombre");
  cacheComplejos = complejos || [];
  cacheCanchas = canchas || [];

  const cont = document.getElementById("listaComplejos");
  cont.innerHTML = "";
  cacheComplejos.forEach((c) => {
    const canchasDelComplejo = cacheCanchas.filter((k) => k.complejo_id === c.id);
    const div = document.createElement("div");
    div.className = "match-card";
    div.innerHTML = `
      <div class="match-teams">${c.nombre}</div>
      <div class="match-meta">${c.direccion || ""}</div>
      <div style="margin-top:8px">${canchasDelComplejo.map((k) => `
        <div class="row" style="align-items:center;margin-bottom:4px">
          <span class="badge">${k.nombre}</span>
          <input type="number" min="0" step="100" placeholder="$/hora (opcional)" class="inputCostoHora" data-cancha="${k.id}" value="${k.costo_hora ?? ""}" style="max-width:150px" />
        </div>
      `).join("") || '<span class="match-meta">Sin canchas cargadas</span>'}</div>
      <div class="row" style="margin-top:10px">
        <input placeholder="Nombre de cancha (ej: Cancha 3)" class="inputCancha" data-complejo="${c.id}" />
        <button class="secondary small btnAgregarCancha" data-complejo="${c.id}">Agregar cancha</button>
      </div>
    `;
    cont.appendChild(div);
  });

  document.querySelectorAll(".btnAgregarCancha").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
      const complejoId = btn.dataset.complejo;
      const input = document.querySelector(`.inputCancha[data-complejo="${complejoId}"]`);
      const nombre = input.value.trim();
      if (!nombre) { toast("Poné un nombre para la cancha"); return; }
      const { error } = await sb.from("canchas").insert({ complejo_id: complejoId, nombre });
      if (error) { toast("Error: " + error.message); return; }
      input.value = "";
      cargarComplejos();
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll(".inputCostoHora").forEach((input) => {
    input.addEventListener("change", async () => {
      const costo_hora = input.value === "" ? null : Number(input.value);
      const { error } = await sb.from("canchas").update({ costo_hora }).eq("id", input.dataset.cancha);
      if (error) { toast("Error: " + error.message); return; }
      const cancha = cacheCanchas.find((k) => k.id === input.dataset.cancha);
      if (cancha) cancha.costo_hora = costo_hora;
      toast("Precio actualizado");
    });
  });

  llenarSelect(document.getElementById("tComplejo"), cacheComplejos, (c) => c.nombre);
  llenarSelect(document.getElementById("teComplejo"), cacheComplejos, (c) => c.nombre);
  llenarSelect(document.getElementById("reservaComplejo"), cacheComplejos, (c) => c.nombre);
  actualizarCanchasReserva();
}

document.getElementById("btnCrearComplejo").addEventListener("click", async () => {
  const btn = document.getElementById("btnCrearComplejo");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  const nombre = document.getElementById("cNombre").value.trim();
  if (!nombre) { toast("Poné un nombre de complejo"); return; }
  const direccion = document.getElementById("cDireccion").value.trim() || null;
  const cantidad = Math.max(0, Number(document.getElementById("cCantidadCanchas").value) || 0);

  const { data, error } = await sb.from("complejos").insert({ nombre, direccion }).select().single();
  if (error) { toast("Error: " + error.message); return; }

  if (cantidad > 0) {
    const canchas = Array.from({ length: cantidad }, (_, i) => ({ complejo_id: data.id, nombre: `Cancha ${i + 1}` }));
    await sb.from("canchas").insert(canchas);
  }

  document.getElementById("cNombre").value = "";
  document.getElementById("cDireccion").value = "";
  toast("Complejo creado" + (cantidad > 0 ? ` con ${cantidad} cancha(s)` : ""));
  cargarComplejos();
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// CATEGORIAS (editable por el admin: perfil de jugador + torneos)
// ============================================================
async function cargarCategorias() {
  const { data } = await sb.from("categorias").select("*").order("orden");
  cacheCategorias = data || [];
  const grupos = agruparPorGenero(cacheCategorias);
  const generosConDatos = ORDEN_GENEROS.filter((g) => grupos[g].length > 0);

  const selectJugador = document.getElementById("jCategoria");
  if (selectJugador) {
    const valorPrevio = selectJugador.value;
    selectJugador.innerHTML = generosConDatos.map((g) =>
      `<optgroup label="${g}">${grupos[g].map((c) => `<option value="${c.nombre}">${c.nombre}</option>`).join("")}</optgroup>`
    ).join("");
    if (valorPrevio) selectJugador.value = valorPrevio;
  }

  const categoriasCheckboxHtml = (chkClass) => generosConDatos.map((g) => `
    <div class="categorias-genero-grupo">
      <h4>${g}</h4>
      <div class="check-grid">
        ${grupos[g].map((c) => `<label><input type="checkbox" class="${chkClass}" value="${c.nombre}" /> ${c.nombre}</label>`).join("")}
      </div>
    </div>
  `).join("");

  const formTorneo = document.getElementById("tCategoriasForm");
  if (formTorneo) {
    formTorneo.innerHTML = categoriasCheckboxHtml("chkTorneoCategoria");
  }
  const formTorneoEdit = document.getElementById("teCategoriasForm");
  if (formTorneoEdit) {
    formTorneoEdit.innerHTML = categoriasCheckboxHtml("chkTorneoCategoriaEdit");
  }

  const listaAdmin = document.getElementById("listaCategoriasAdmin");
  if (listaAdmin) {
    listaAdmin.innerHTML = generosConDatos.map((g) => `
      <div class="categorias-genero-grupo">
        <h4>${g}</h4>
        ${grupos[g].map((c) =>
          `<span class="pill removable">${c.nombre}
            <button type="button" class="btnEditarCategoria" data-id="${c.id}" data-nombre="${c.nombre}" aria-label="Editar ${c.nombre}">✏️</button>
            <button type="button" class="btnBorrarCategoria" data-id="${c.id}" aria-label="Borrar ${c.nombre}">×</button>
          </span>`
        ).join("")}
      </div>
    `).join("");
    listaAdmin.querySelectorAll(".btnBorrarCategoria").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        try {
        const { error } = await sb.from("categorias").delete().eq("id", btn.dataset.id);
        if (error) { toast("Error: " + error.message); return; }
        cargarCategorias();
        } finally {
          btn.disabled = false;
        }
      });
    });
    listaAdmin.querySelectorAll(".btnEditarCategoria").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        try {
        const nombreViejo = btn.dataset.nombre;
        const nuevoNombre = (prompt("Nuevo nombre para la categoría:", nombreViejo) || "").trim();
        if (!nuevoNombre || nuevoNombre === nombreViejo) return;
        const { error } = await sb.from("categorias").update({ nombre: nuevoNombre }).eq("id", btn.dataset.id);
        if (error) { toast("Error: " + error.message); return; }
        // mantener consistentes las referencias en texto libre que usan el nombre viejo
        await Promise.all([
          sb.from("jugadores").update({ categoria: nuevoNombre }).eq("categoria", nombreViejo),
          sb.from("jugadores").update({ categoria_pendiente: nuevoNombre }).eq("categoria_pendiente", nombreViejo),
          sb.from("torneo_categorias").update({ categoria: nuevoNombre }).eq("categoria", nombreViejo)
        ]);
        toast("Categoría renombrada");
        cargarCategorias();
        cargarRanking();
        if (isAdmin) cargarJugadoresAdmin();
        } finally {
          btn.disabled = false;
        }
      });
    });
  }
}

document.getElementById("btnAgregarCategoria").addEventListener("click", async () => {
  const btn = document.getElementById("btnAgregarCategoria");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  const input = document.getElementById("catNueva");
  const nombre = input.value.trim();
  if (!nombre) { toast("Poné un nombre de categoría"); return; }
  const { error } = await sb.from("categorias").insert({ nombre, orden: cacheCategorias.length + 1 });
  if (error) { toast("Error: " + error.message); return; }
  input.value = "";
  toast("Categoría agregada");
  cargarCategorias();
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btnTodasCategorias").addEventListener("click", () => {
  document.querySelectorAll(".chkTorneoCategoria").forEach((chk) => (chk.checked = true));
});
document.getElementById("btnTodasCategoriasEdit")?.addEventListener("click", () => {
  document.querySelectorAll(".chkTorneoCategoriaEdit").forEach((chk) => (chk.checked = true));
});

// ============================================================
// ETIQUETAS DE JUGADOR (uso interno del admin, con color — mismo patrón que
// categorías, pero NO públicas: sirven para acomodar horarios/partidos)
// ============================================================
async function cargarEtiquetas() {
  if (!isAdmin) return;
  const { data } = await sb.from("etiquetas_jugador").select("*").order("orden");
  cacheEtiquetas = data || [];

  const selectJugador = document.getElementById("jaEtiquetaFiltro"); // reservado, no usado por ahora
  const listaAdmin = document.getElementById("listaEtiquetasAdmin");
  if (!listaAdmin) return;
  listaAdmin.innerHTML = cacheEtiquetas.map((et) => `
    <span class="pill removable" style="border-color:${et.color}">
      <span class="etiqueta-dot" style="background:${et.color}"></span> ${et.nombre}
      <button type="button" class="btnBorrarEtiqueta" data-id="${et.id}" aria-label="Borrar etiqueta ${et.nombre}">×</button>
    </span>
  `).join("") || '<p class="empty">Todavía no cargaste etiquetas.</p>';

  listaAdmin.querySelectorAll(".btnBorrarEtiqueta").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
      const { error } = await sb.from("etiquetas_jugador").delete().eq("id", btn.dataset.id);
      if (error) { toast("Error: " + error.message); return; }
      toast("Etiqueta borrada");
      cargarEtiquetas();
      cargarJugadoresAdmin();
      } finally {
        btn.disabled = false;
      }
    });
  });
}

document.getElementById("btnAgregarEtiqueta")?.addEventListener("click", async () => {
  const btn = document.getElementById("btnAgregarEtiqueta");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  const input = document.getElementById("etqNueva");
  const nombre = input.value.trim();
  const color = document.getElementById("etqColorNueva").value;
  if (!nombre) { toast("Poné un nombre de etiqueta"); return; }
  const { error } = await sb.from("etiquetas_jugador").insert({ nombre, color, orden: cacheEtiquetas.length + 1 });
  if (error) { toast("Error: " + error.message); return; }
  input.value = "";
  toast("Etiqueta agregada");
  cargarEtiquetas();
  } finally {
    btn.disabled = false;
  }
});

// pill/punto de color para mostrar la etiqueta de un jugador donde le sirva al admin
// para acomodar horarios (lista de jugadores, inscriptos y parejas de un torneo).
// jugadorId se busca contra cacheJugadoresAdmin (ya trae etiqueta_id en su "select *").
function etiquetaDotHtml(jugadorId) {
  const j = cacheJugadoresAdmin.find((x) => x.id === jugadorId);
  const et = j && cacheEtiquetas.find((e) => e.id === j.etiqueta_id);
  return et ? `<span class="etiqueta-dot" style="background:${et.color}" title="${et.nombre}" aria-label="Etiqueta: ${et.nombre}"></span>` : "";
}

// ============================================================
// PAREJAS ANOTADAS EN UN TORNEO — un solo componente para las dos pantallas
// que las muestran: "Jugadores/Parejas" (pública, solo lectura) y
// "Inscripciones y parejas" de Administración (con acciones). `editable`
// es el único interruptor entre ambas — nunca se muestran acciones de
// gestión en la pantalla pública.
// ============================================================
// Renglón propio (no un badge/pill apretado — con día completo y "de X a Y"
// en vez de un guión) con los horarios en que ESE jugador avisó que no puede
// jugar en este torneo. Junta lo general de su perfil con lo puntual de este
// torneo, mismo cálculo que ya usa el armado automático (ver
// jugadoresDisponibilidad). Vacío si tiene disponibilidad completa, que es
// el caso más común. Se probó primero como badge en una sola línea y quedaba
// ilegible apenas había más de un horario cargado.
function dispResumenHtml(nombreCompleto, filas) {
  if (!filas || !filas.length) return "";
  const detalle = filas
    .map((d) => `${DIAS[d.dia_semana]} de ${String(d.hora_desde).slice(0, 5)} a ${String(d.hora_hasta).slice(0, 5)}`)
    .join("<br>");
  return `<p class="match-meta disp-resumen">🕒 <strong>${escapeHtml((nombreCompleto || "").split(" ")[0])} no puede jugar:</strong><br>${detalle}</p>`;
}

// Carga el picker de horarios bloqueados de UN jugador puntual para ESTE
// torneo, dentro del panel que abre el botón 🕒 de su fila — así el admin
// puede cargarlo por él si todavía no lo hizo (pedido del club: no depender
// de que cada jugador se acuerde de entrar a "Mi disponibilidad").
async function cargarDispAdminForm(contId, jugadorId) {
  if (!document.getElementById(contId)) return;
  renderDisponibilidadForm(contId);
  const { data } = await sb.from("disponibilidad").select("*").eq("jugador_id", jugadorId).eq("torneo_id", torneoGestionId);
  precargarRestriccionesEnForm(contId, data);
}
// Guarda lo que se cargó en cualquiera de esos paneles (mismo patrón
// delete+insert que btnGuardarDispTorneo) — un solo listener delegado sirve
// tanto para los paneles de parejas como para los de "sin pareja".
function wireGuardarDispAdmin(cont) {
  cont.querySelectorAll(".btnGuardarDispAdmin").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const jugadorId = btn.dataset.jugador;
        const contId = btn.dataset.cont;
        await sb.from("disponibilidad").delete().eq("jugador_id", jugadorId).eq("torneo_id", torneoGestionId);
        const filas = leerRestriccionesDeForm(contId).map((r) => ({ jugador_id: jugadorId, torneo_id: torneoGestionId, ...r }));
        if (filas.length > 0) await sb.from("disponibilidad").insert(filas);
        toast("Horarios guardados");
        refrescarTrasAccionGestion();
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function parejaRowHtml(p, editable, dispPorJugador) {
  const catBadge = p.categoria ? `<span class="badge">${p.categoria}</span>` : "";
  const estadoBadge = p.estado === "confirmada" ? `<span class="badge solid">Confirmada</span>`
    : p.estado === "rechazada" ? `<span class="badge danger" title="${escapeHtml(p.motivo_rechazo || "")}">Rechazada</span>`
    : `<span class="badge orange">Pendiente de confirmar</span>`;
  const etiquetas = editable ? etiquetaDotHtml(p.jugador1_id) + etiquetaDotHtml(p.jugador2_id) : "";
  const pendiente = editable && p.estado !== "confirmada" && p.estado !== "rechazada";
  const nombrePareja = `${escapeHtml(p.jugador1_nombre)} / ${escapeHtml(p.jugador2_nombre)}`;
  const dispResumenJ1 = editable ? dispResumenHtml(p.jugador1_nombre, dispPorJugador?.[p.jugador1_id]) : "";
  const dispResumenJ2 = editable ? dispResumenHtml(p.jugador2_nombre, dispPorJugador?.[p.jugador2_id]) : "";
  // Pago (ver inscripciones.pago): independiente de "estado", que solo habla
  // de la categoría/confirmación. Un admin puede tocar cada 💰 para marcar/
  // desmarcar el pago de ESE jugador, o el atajo de "los 2" cuando falta alguno.
  // El pago es información solo para el admin (no tiene sentido exponer
  // públicamente quién pagó y quién no) -- pagoHtml queda vacío si !editable.
  const ambosPagaron = p.jugador1_pago && p.jugador2_pago;
  const pagoHtml = editable
    ? `<div class="pareja-pago-row">
        <span class="match-meta meta-caption">Pago:</span>
        <button type="button" class="secondary small btnTogglePago" data-jugador="${p.jugador1_id}" data-pago="${p.jugador1_pago ? "1" : "0"}">${p.jugador1_pago ? "✅" : "⬜"} ${escapeHtml((p.jugador1_nombre || "").split(" ")[0])}</button>
        <button type="button" class="secondary small btnTogglePago" data-jugador="${p.jugador2_id}" data-pago="${p.jugador2_pago ? "1" : "0"}">${p.jugador2_pago ? "✅" : "⬜"} ${escapeHtml((p.jugador2_nombre || "").split(" ")[0])}</button>
        ${!ambosPagaron ? `<button type="button" class="secondary small btnMarcarPagoAmbos" data-j1="${p.jugador1_id}" data-j2="${p.jugador2_id}">✅ Marcar pago de los 2</button>` : ""}
      </div>`
    : "";
  return `<div class="pareja-row-wrap">
    <div class="pareja-row">
      <span>${etiquetas}🎾 ${nombrePareja} ${catBadge} ${estadoBadge}</span>
      <span style="display:flex;gap:6px;align-items:center;flex-shrink:0">
        ${pendiente ? `<button type="button" class="secondary small btnConfirmarPareja" data-j1="${p.jugador1_id}" data-j2="${p.jugador2_id}">Confirmar</button>` : ""}
        ${pendiente ? `<button type="button" class="secondary small btnRechazarPareja" data-j1="${p.jugador1_id}" data-j2="${p.jugador2_id}">Rechazar</button>` : ""}
        ${editable ? `<button type="button" class="secondary small btnToggleDispPareja" data-p="${p.id}" title="Cargar horarios en que no pueden jugar" aria-label="Cargar horarios en que no pueden jugar">🕒</button>` : ""}
        ${editable ? `<button type="button" class="secondary small btnTogglePareja" data-p="${p.id}" title="Reemplazar un jugador de esta pareja" aria-label="Reemplazar un jugador de esta pareja">✏️</button>` : ""}
        ${editable ? `<button type="button" class="danger btnBorrarPareja" data-id="${p.id}" data-nombre="${escapeHtml(nombrePareja)}" data-j1="${p.jugador1_id}" data-j2="${p.jugador2_id}" aria-label="Sacar del torneo a la pareja ${nombrePareja}">×</button>` : ""}
      </span>
    </div>
    ${editable ? pagoHtml : ""}
    ${editable ? dispResumenJ1 : ""}
    ${editable ? dispResumenJ2 : ""}
    ${editable ? `
    <div class="match-admin-panel" data-disp-pareja="${p.id}" style="display:none">
      <p class="match-meta" style="margin-bottom:6px">Horarios en que NO pueden jugar este torneo — cargalo vos si el jugador todavía no lo hizo.</p>
      <p class="match-meta meta-caption" style="margin-bottom:4px">${escapeHtml(p.jugador1_nombre)}</p>
      <div id="admDispForm-${p.id}-${p.jugador1_id}"></div>
      <button type="button" class="secondary small btnGuardarDispAdmin" data-jugador="${p.jugador1_id}" data-cont="admDispForm-${p.id}-${p.jugador1_id}" style="margin-top:6px;margin-bottom:14px">Guardar</button>
      <p class="match-meta meta-caption" style="margin-bottom:4px">${escapeHtml(p.jugador2_nombre)}</p>
      <div id="admDispForm-${p.id}-${p.jugador2_id}"></div>
      <button type="button" class="secondary small btnGuardarDispAdmin" data-jugador="${p.jugador2_id}" data-cont="admDispForm-${p.id}-${p.jugador2_id}" style="margin-top:6px">Guardar</button>
    </div>` : ""}
    ${editable ? `
    <div class="match-admin-panel" data-editar-pareja="${p.id}" style="display:none">
      <p class="match-meta" style="margin-bottom:6px">Reemplazá al jugador que anotaste sin saber quién iba a jugar de verdad — se corrige en esta pareja y en TODOS los partidos que ya jugó o le falten (zona, octavos, cuartos...), no hace falta tocar cada partido. Si ya hay resultados cargados con el jugador viejo, los puntos de ranking que ya sumó quedan a su nombre hasta que se migren con un script aparte.</p>
      <div class="match-actions">
        <input type="text" class="inputCambiarJugador" id="dtCambiarJugador_${p.id}_1" list="dtListaCambiarJugador_${p.id}_1" placeholder="Buscar reemplazo de ${escapeHtml(p.jugador1_nombre)}..." autocomplete="off" style="flex:1" />
        <datalist id="dtListaCambiarJugador_${p.id}_1"></datalist>
        <button type="button" class="secondary small btnCambiarJugadorPareja" data-p="${p.id}" data-slot="1" data-otro="${p.jugador2_id}">Cambiar</button>
      </div>
      <div class="match-actions" style="margin-top:6px">
        <input type="text" class="inputCambiarJugador" id="dtCambiarJugador_${p.id}_2" list="dtListaCambiarJugador_${p.id}_2" placeholder="Buscar reemplazo de ${escapeHtml(p.jugador2_nombre)}..." autocomplete="off" style="flex:1" />
        <datalist id="dtListaCambiarJugador_${p.id}_2"></datalist>
        <button type="button" class="secondary small btnCambiarJugadorPareja" data-p="${p.id}" data-slot="2" data-otro="${p.jugador1_id}">Cambiar</button>
      </div>
    </div>` : ""}
  </div>`;
}
function sinParejaChipHtml(i, editable, dispPorJugador) {
  const sufijoEstado = i.estado && i.estado !== "confirmada" ? ` · ${i.estado === "pendiente" ? "pendiente" : i.estado}` : "";
  const nombreCompleto = `${escapeHtml(i.nombre)} ${escapeHtml(i.apellido)}`;
  // Igual que en parejaRowHtml: el pago es información solo para el admin.
  const pagoHtml = editable
    ? `<button type="button" class="btnTogglePago" data-jugador="${i.jugador_id}" data-pago="${i.pago ? "1" : "0"}" style="background:none;border:none;cursor:pointer;font-size:13px;padding:0 4px 0 0" title="${i.pago ? "Pagó" : "No pagó"} — tocar para cambiar" aria-label="${nombreCompleto}: ${i.pago ? "pagó" : "no pagó"}, tocar para cambiar">${i.pago ? "✅" : "⬜"}</button>`
    : "";
  const dispResumen = editable ? dispResumenHtml(i.nombre, dispPorJugador?.[i.jugador_id]) : "";
  const idFormSuelto = `admDispForm-suelto-${i.jugador_id}`;
  const botonDisp = editable ? `<button type="button" class="secondary small btnToggleDispSuelto" data-jugador="${i.jugador_id}" title="Cargar horarios en que no puede jugar" aria-label="Cargar horarios en que no puede jugar ${nombreCompleto}">🕒</button>` : "";
  const panelDisp = editable ? `
    <div class="match-admin-panel" data-disp-suelto="${i.jugador_id}" style="display:none;flex-basis:100%">
      <div id="${idFormSuelto}"></div>
      <button type="button" class="secondary small btnGuardarDispAdmin" data-jugador="${i.jugador_id}" data-cont="${idFormSuelto}" style="margin-top:6px">Guardar</button>
    </div>` : "";
  return `<span class="pill removable" style="display:inline-flex;flex-wrap:wrap;margin:0 6px 6px 0">${editable ? etiquetaDotHtml(i.jugador_id) : ""}${pagoHtml}${nombreCompleto}${i.categoria_torneo ? ` · ${i.categoria_torneo}` : ""}${sufijoEstado}${botonDisp}${editable ? `<button type="button" class="btnBorrarInscripto" data-id="${i.jugador_id}" data-nombre="${nombreCompleto}" aria-label="Sacar a ${nombreCompleto} del torneo">×</button>` : ""}${panelDisp}</span>${dispResumen}`;
}
// Cablea los toggles de pago (💰 por jugador + "marcar pago de los 2") de un
// contenedor -- se usa igual en la lista de parejas y en la de "sin pareja",
// así que queda en una sola función en vez de repetir el mismo listener dos veces.
function wireTogglesPago(cont) {
  cont.querySelectorAll(".btnTogglePago").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const nuevoPago = btn.dataset.pago !== "1";
        const { error } = await sb.from("inscripciones").update({ pago: nuevoPago }).eq("torneo_id", torneoGestionId).eq("jugador_id", btn.dataset.jugador);
        if (error) { toast("Error: " + error.message); return; }
        refrescarTrasAccionGestion();
      } finally {
        btn.disabled = false;
      }
    });
  });
  cont.querySelectorAll(".btnMarcarPagoAmbos").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const { error } = await sb.from("inscripciones").update({ pago: true }).eq("torneo_id", torneoGestionId).in("jugador_id", [btn.dataset.j1, btn.dataset.j2]);
        if (error) { toast("Error: " + error.message); return; }
        toast("Pago marcado para los dos");
        refrescarTrasAccionGestion();
      } finally {
        btn.disabled = false;
      }
    });
  });
}
function renderParejasEn(contParejasId, contSinParejaId, insc, parejas, editable, dispPorJugador = {}) {
  // al público no se le muestran parejas rechazadas ni inscripciones
  // canceladas/rechazadas — son historial para el admin, no algo vigente
  const inscBase = editable ? (insc || []) : (insc || []).filter((i) => i.estado !== "cancelada" && i.estado !== "rechazada");
  const parejasBase = editable ? (parejas || []) : (parejas || []).filter((p) => p.estado !== "rechazada");
  const enPareja = new Set(parejasBase.flatMap((p) => [p.jugador1_id, p.jugador2_id]));
  const sinPareja = inscBase.filter((i) => !enPareja.has(i.jugador_id));

  const contParejas = document.getElementById(contParejasId);
  // Panel del admin: las que todavía no tienen el pago de los DOS
  // confirmado van primero -- son las que hay que perseguir, no algo que
  // haya que encontrar scrolleando (pedido del club tras pagos tardíos).
  // Reusa jugador1_pago/jugador2_pago, que ya existían en el HTML de cada
  // fila (parejaRowHtml) pero venían siempre en blanco por un bug de la
  // función de Supabase (ver fix_pago_en_parejas_publicas.sql).
  const parejasOrdenadas = editable
    ? [...parejasBase].sort((a, b) => (a.jugador1_pago && a.jugador2_pago ? 1 : 0) - (b.jugador1_pago && b.jugador2_pago ? 1 : 0))
    : parejasBase;
  const pagas = editable ? parejasBase.filter((p) => p.jugador1_pago && p.jugador2_pago).length : 0;
  const resumenPagoHtml = editable && parejasBase.length
    ? `<p class="match-meta" style="margin-bottom:8px">💳 ${pagas} de ${parejasBase.length} parejas con el pago confirmado${pagas < parejasBase.length ? " — las que faltan no entran al fixture hasta confirmarlas" : ""}.</p>`
    : "";
  contParejas.innerHTML = resumenPagoHtml + (parejasOrdenadas.map((p) => parejaRowHtml(p, editable, dispPorJugador)).join("") || '<p class="empty">Todavía no hay parejas anotadas.</p>');
  if (editable) {
    contParejas.querySelectorAll(".btnBorrarPareja").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          await borrarPareja(btn.dataset.id, btn.dataset.nombre, btn.dataset.j1, btn.dataset.j2);
        } finally {
          btn.disabled = false;
        }
      });
    });
    contParejas.querySelectorAll(".btnConfirmarPareja").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          await confirmarPareja(btn.dataset.j1, btn.dataset.j2);
        } finally {
          btn.disabled = false;
        }
      });
    });
    contParejas.querySelectorAll(".btnRechazarPareja").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          await rechazarPareja(btn.dataset.j1, btn.dataset.j2);
        } finally {
          btn.disabled = false;
        }
      });
    });

    // ✏️ reemplazar un jugador de la pareja: se corrige en la pareja misma
    // (parejas.jugador1_id/jugador2_id), así que se propaga sola a todos los
    // partidos que la referencian, sin tocarlos uno por uno.
    parejasBase.forEach((p) => {
      llenarDatalist(`dtCambiarJugador_${p.id}_1`, `dtListaCambiarJugador_${p.id}_1`, cacheJugadoresAdmin.filter((j) => j.id !== p.jugador2_id), labelJugadorBuscable);
      llenarDatalist(`dtCambiarJugador_${p.id}_2`, `dtListaCambiarJugador_${p.id}_2`, cacheJugadoresAdmin.filter((j) => j.id !== p.jugador1_id), labelJugadorBuscable);
    });
    contParejas.querySelectorAll(".btnTogglePareja").forEach((btn) => {
      btn.addEventListener("click", () => {
        const panel = contParejas.querySelector(`[data-editar-pareja="${btn.dataset.p}"]`);
        if (panel) panel.style.display = panel.style.display === "none" ? "block" : "none";
      });
    });
    contParejas.querySelectorAll(".btnToggleDispPareja").forEach((btn) => {
      btn.addEventListener("click", () => {
        const panel = contParejas.querySelector(`[data-disp-pareja="${btn.dataset.p}"]`);
        if (!panel) return;
        const abrir = panel.style.display === "none";
        panel.style.display = abrir ? "block" : "none";
        if (abrir && !panel.dataset.cargado) {
          panel.dataset.cargado = "1";
          const pareja = parejasBase.find((x) => x.id === btn.dataset.p);
          if (pareja) {
            cargarDispAdminForm(`admDispForm-${pareja.id}-${pareja.jugador1_id}`, pareja.jugador1_id);
            cargarDispAdminForm(`admDispForm-${pareja.id}-${pareja.jugador2_id}`, pareja.jugador2_id);
          }
        }
      });
    });
    wireGuardarDispAdmin(contParejas);
    contParejas.querySelectorAll(".btnCambiarJugadorPareja").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        try {
        const parejaId = btn.dataset.p;
        const slot = btn.dataset.slot;
        const inputId = `dtCambiarJugador_${parejaId}_${slot}`;
        const input = document.getElementById(inputId);
        const nuevoId = idDesdeDatalist(inputId);
        if (input.value.trim() && !nuevoId) { toast("Elegí un jugador de la lista que aparece al escribir (no quedó seleccionado ninguno)"); return; }
        if (!nuevoId) { toast("Buscá y elegí el jugador que reemplaza"); return; }
        if (nuevoId === btn.dataset.otro) { toast("Ya está en esta pareja — elegí otro jugador"); return; }
        const pareja = parejasBase.find((x) => x.id === parejaId);
        const campo = slot === "1" ? "jugador1_id" : "jugador2_id";
        const { error } = await sb.from("parejas").update({ [campo]: nuevoId }).eq("id", parejaId);
        if (error) { toast("Error: " + error.message); return; }
        // así el jugador nuevo queda inscripto en este torneo (si ya lo estaba, no cambia nada)
        if (pareja?.categoria) {
          await sb.from("inscripciones").upsert(
            { torneo_id: torneoGestionId, jugador_id: nuevoId, categoria: pareja.categoria, estado: "confirmada" },
            { onConflict: "torneo_id,jugador_id", ignoreDuplicates: true }
          );
        }
        toast("Jugador reemplazado en la pareja");
        avisarActualizacionEnVivo();
        refrescarTrasAccionGestion();
        } finally {
          btn.disabled = false;
        }
      });
    });
    wireTogglesPago(contParejas);
  }

  const contSinPareja = document.getElementById(contSinParejaId);
  contSinPareja.innerHTML = sinPareja.length === 0 ? "" : `
    <p class="match-meta" style="margin:12px 0 6px">Todavía sin pareja:</p>
    ${sinPareja.map((i) => sinParejaChipHtml(i, editable, dispPorJugador)).join("")}`;
  if (editable) {
    contSinPareja.querySelectorAll(".btnBorrarInscripto").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          await borrarInscripcion(btn.dataset.id, btn.dataset.nombre);
        } finally {
          btn.disabled = false;
        }
      });
    });
    contSinPareja.querySelectorAll(".btnToggleDispSuelto").forEach((btn) => {
      btn.addEventListener("click", () => {
        const panel = contSinPareja.querySelector(`[data-disp-suelto="${btn.dataset.jugador}"]`);
        if (!panel) return;
        const abrir = panel.style.display === "none";
        panel.style.display = abrir ? "block" : "none";
        if (abrir && !panel.dataset.cargado) {
          panel.dataset.cargado = "1";
          cargarDispAdminForm(`admDispForm-suelto-${btn.dataset.jugador}`, btn.dataset.jugador);
        }
      });
    });
    wireGuardarDispAdmin(contSinPareja);
    wireTogglesPago(contSinPareja);
  }
}

// ============================================================
// PUNTOS POR RONDA (ranking por eliminación directa) — POR TORNEO
// ============================================================
// Antes era un valor global (una sola tabla puntos_ronda para todos los
// torneos). Ahora cada torneo tiene su propio puntaje (torneos.puntos_ronda,
// jsonb) y puede marcarse como "no puntuable" (torneos.es_puntuable) para
// torneos amistosos/exhibición que no deben sumar ni restar nada del
// ranking general. Por eso esto vive solo acá, en el dashboard de UN
// torneo (sección Configuración) — ya no en la Configuración general.
const RONDAS_INPUT = {
  "Campeón": "prCampeon", "Sub": "prSub", "Semifinal": "prSemifinal",
  "Cuartos": "prCuartos", "Octavos": "prOctavos", "Dieciseisavos": "prDieciseisavos"
};

// Habilita/deshabilita los 6 inputs de puntaje según el checkbox de
// "puntuable" — un torneo no puntuable no necesita valores cargados.
function aplicarEstadoPuntuableTorneo(esPuntuable) {
  document.getElementById("avisoTorneoNoPuntuable").style.display = esPuntuable ? "none" : "block";
  document.getElementById("avisoTorneoPuntuable").style.display = esPuntuable ? "block" : "none";
  Object.values(RONDAS_INPUT).forEach((inputId) => { document.getElementById(inputId).disabled = !esPuntuable; });
}

// Se llama desde cargarGestionTorneo con el torneo ya cargado (t.puntos_ronda
// y t.es_puntuable ya vienen en el select("*") de ese torneo).
function cargarPuntosTorneo(t) {
  const esPuntuable = t.es_puntuable !== false;
  document.getElementById("chkTorneoPuntuable").checked = esPuntuable;
  const pr = t.puntos_ronda || {};
  Object.entries(RONDAS_INPUT).forEach(([ronda, inputId]) => {
    document.getElementById(inputId).value = pr[ronda] ?? "";
  });
  aplicarEstadoPuntuableTorneo(esPuntuable);
}

document.getElementById("chkTorneoPuntuable").addEventListener("change", (e) => aplicarEstadoPuntuableTorneo(e.target.checked));

document.getElementById("btnGuardarPuntosTorneo").addEventListener("click", async () => {
  const btn = document.getElementById("btnGuardarPuntosTorneo");
  if (btn.disabled || !torneoGestionId) return;
  btn.disabled = true;
  try {
    const esPuntuable = document.getElementById("chkTorneoPuntuable").checked;
    const puntosRonda = {};
    Object.entries(RONDAS_INPUT).forEach(([ronda, inputId]) => {
      puntosRonda[ronda] = Number(document.getElementById(inputId).value) || 0;
    });
    const { error } = await sb.from("torneos").update({ es_puntuable: esPuntuable, puntos_ronda: puntosRonda }).eq("id", torneoGestionId);
    if (error) { toast("Error: " + error.message); return; }
    if (torneoGestionData) { torneoGestionData.es_puntuable = esPuntuable; torneoGestionData.puntos_ronda = puntosRonda; }
    toast("Puntaje guardado");
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// CONFIGURACIÓN GENERAL (whatsapp del club, instagram)
// ============================================================
async function cargarConfig() {
  const { data } = await sb.from("config").select("*");
  configApp = {};
  (data || []).forEach((r) => { configApp[r.clave] = r.valor; });
  const inputWsp = document.getElementById("cfgWhatsapp");
  const inputIg = document.getElementById("cfgInstagram");
  const inputYt = document.getElementById("cfgYoutubeEnVivo");
  if (inputWsp) inputWsp.value = configApp.whatsapp_numero || "";
  if (inputIg) inputIg.value = configApp.instagram_url || "";
  if (inputYt) inputYt.value = configApp.youtube_en_vivo || "";
}

document.getElementById("btnGuardarConfig").addEventListener("click", async () => {
  const btn = document.getElementById("btnGuardarConfig");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  const whatsapp = document.getElementById("cfgWhatsapp").value.trim().replace(/\D/g, "");
  const instagram = document.getElementById("cfgInstagram").value.trim();
  const youtubeEnVivo = document.getElementById("cfgYoutubeEnVivo").value.trim();
  const { error } = await sb.from("config").upsert([
    { clave: "whatsapp_numero", valor: whatsapp || null },
    { clave: "instagram_url", valor: instagram || null },
    { clave: "youtube_en_vivo", valor: youtubeEnVivo || null }
  ], { onConflict: "clave" });
  if (error) { toast("Error: " + error.message); return; }
  toast("Configuración guardada");
  await cargarConfig();
  cargarNoticias();
  cargarEnVivo();
  if (torneoActualId) refrescarDetalleTorneo();
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// JUGADORES (listado admin, para inscribir manualmente y jugador del mes)
// ============================================================
async function cargarJugadoresAdmin() {
  if (!isAdmin) return;
  if (cacheCategorias.length === 0) await cargarCategorias();
  if (cacheEtiquetas.length === 0) await cargarEtiquetas();
  const [{ data }, { data: rankingRows }] = await Promise.all([
    sb.from("jugadores").select("*").eq("activo", true).order("apellido"),
    sb.from("ranking_categoria").select("*")
  ]);
  cacheJugadoresAdmin = data || [];
  cacheRankingCategoriaAdmin = {};
  (rankingRows || []).forEach((r) => {
    (cacheRankingCategoriaAdmin[r.jugador_id] ||= []).push(r);
  });
  renderListaJugadoresAdmin();
  llenarDatalist("dtSelectJugador1", "dtListaJugadores1", cacheJugadoresAdmin, labelJugadorBuscable);
  llenarDatalist("dtSelectJugador2", "dtListaJugadores2", cacheJugadoresAdmin, labelJugadorBuscable);
  llenarSelect(document.getElementById("jdmSelect"), cacheJugadoresAdmin, (j) => `${j.nombre} ${j.apellido} (${j.categoria})`);
  renderSolicitudesCategoria(cacheJugadoresAdmin);
}

document.getElementById("btnMostrarBuscarJugador")?.addEventListener("click", () => {
  const wrap = document.getElementById("buscarJugadorWrap");
  wrap.style.display = "block";
  document.getElementById("buscarJugadorAdmin").focus();
});

// Ascenso de categoría: se lleva la mitad de los puntos de la categoría vieja,
// sumados a lo que ya tuviera cargado en la nueva (si ya había jugado ahí antes),
// y la categoría vieja se borra del ranking. La usan tanto el botón "Ascender" de
// cada ficha como "Aprobar" en Solicitudes de categoría (pedido por el jugador).
async function ejecutarAscenso(jugadorId, puntosCategoriaVieja, categoriaVieja, categoriaNueva) {
  const { data: filaExistente } = await sb.from("ranking_categoria").select("puntos_ranking")
    .eq("jugador_id", jugadorId).eq("categoria", categoriaNueva).maybeSingle();
  const puntosNuevos = (Number(puntosCategoriaVieja) || 0) / 2 + Number(filaExistente?.puntos_ranking || 0);
  const { error } = await sb.from("jugadores")
    .update({ categoria: categoriaNueva, categoria_pendiente: null, puntos_ranking: puntosNuevos })
    .eq("id", jugadorId);
  if (error) return { error };
  await sb.from("ranking_categoria").upsert(
    { jugador_id: jugadorId, categoria: categoriaNueva, puntos_ranking: puntosNuevos, updated_at: new Date().toISOString() },
    { onConflict: "jugador_id,categoria" }
  );
  await sb.from("ranking_categoria").delete().eq("jugador_id", jugadorId).eq("categoria", categoriaVieja);
  await sb.from("historial_categoria").insert({ jugador_id: jugadorId, categoria_anterior: categoriaVieja, categoria_nueva: categoriaNueva });
  return { puntosNuevos };
}

// tarjetas editables (nombre, apellido, categoría, puntos) para corregir errores de registro
// Solo aparecen jugadores después de buscar (para no listar a todo el club de una), tal cual "Crear torneo"
function renderListaJugadoresAdmin() {
  const cont = document.getElementById("listaJugadoresAdmin");
  if (!cont) return;
  const q = (document.getElementById("buscarJugadorAdmin")?.value || "").trim().toLowerCase();
  cont.innerHTML = "";
  if (q.length < 2) { cont.innerHTML = '<p class="empty">Escribí al menos 2 letras para buscar.</p>'; return; }
  const lista = cacheJugadoresAdmin.filter((j) => `${j.nombre} ${j.apellido}`.toLowerCase().includes(q));
  if (lista.length === 0) { cont.innerHTML = '<p class="empty">No se encontraron jugadores.</p>'; return; }
  lista.forEach((j) => {
    const div = document.createElement("div");
    div.className = "match-card";
    const nombresCategoria = cacheCategorias.map((c) => c.nombre);
    if (!nombresCategoria.includes(j.categoria)) nombresCategoria.push(j.categoria); // por si la categoría ya no existe
    const opcionesCategoria = nombresCategoria.map((n) => `<option value="${n}" ${n === j.categoria ? "selected" : ""}>${n}</option>`).join("");
    const opcionesEtiqueta = `<option value="">Sin etiqueta</option>` +
      cacheEtiquetas.map((et) => `<option value="${et.id}" ${et.id === j.etiqueta_id ? "selected" : ""}>${et.nombre}</option>`).join("");
    div.innerHTML = `
      <div class="row" style="align-items:center;gap:8px">
        <span class="jaAvatarPreview">${avatarHtml(j.foto_url, 56)}</span>
        <input type="file" class="jaFoto" accept="image/*" style="flex:1" />
      </div>
      <div class="row" style="margin-top:8px">
        <input type="text" class="jaNombre" value="${escapeHtml(j.nombre)}" placeholder="Nombre" />
        <input type="text" class="jaApellido" value="${escapeHtml(j.apellido)}" placeholder="Apellido" />
      </div>
      <div class="row" style="margin-top:8px">
        <select class="jaCategoria">${opcionesCategoria}</select>
        <input type="number" class="jaPuntos" value="${j.puntos_ranking}" placeholder="Puntos" style="max-width:100px" />
      </div>
      <div class="row" style="margin-top:8px">
        <label for="jaEtiqueta-${j.id}" class="match-meta" style="margin:0">Etiqueta:</label>
        <select id="jaEtiqueta-${j.id}" class="jaEtiqueta">${opcionesEtiqueta}</select>
      </div>
      <div class="match-meta">${j.email || ""} ${j.telefono || ""}</div>
      <div class="ja-ranking-extra" style="margin-top:8px">
        <div class="match-meta">Categorías de ranking (puede estar en más de una a la vez):</div>
        <div class="jaRankingLista"></div>
        <div class="row" style="margin-top:6px;gap:8px">
          <select class="jaNuevaCategoria"></select>
          <button type="button" class="secondary small btnAgregarCategoriaRanking">+ Agregar categoría</button>
        </div>
      </div>`;
    const renderRankingExtra = () => {
      const filas = cacheRankingCategoriaAdmin[j.id] || [];
      div.querySelector(".jaRankingLista").innerHTML = filas.length === 0
        ? '<p class="empty" style="margin:4px 0">Sin filas todavía (se crea una para su categoría principal al cargar el ranking).</p>'
        : filas.map((rc) => `
          <div class="row jaRankingFila" data-categoria="${rc.categoria}" style="margin-top:4px;gap:8px;align-items:center">
            <span style="flex:1">${rc.categoria}</span>
            <input type="number" class="jaRankingPuntos" value="${rc.puntos_ranking}" style="max-width:100px" />
            <button type="button" class="secondary small danger btnQuitarCategoriaRanking">Quitar</button>
          </div>`).join("");
      const nombresLibres = cacheCategorias.map((c) => c.nombre).filter((n) => !filas.some((rc) => rc.categoria === n));
      const selNueva = div.querySelector(".jaNuevaCategoria");
      selNueva.innerHTML = nombresLibres.map((n) => `<option value="${n}">${n}</option>`).join("");
      div.querySelectorAll(".jaRankingFila").forEach((fila) => {
        const categoria = fila.dataset.categoria;
        fila.querySelector(".jaRankingPuntos").addEventListener("change", async (e) => {
          const puntos_ranking = Number(e.target.value);
          if (!Number.isFinite(puntos_ranking) || puntos_ranking < 0) { toast("Los puntos tienen que ser un número positivo"); return; }
          const { error } = await sb.from("ranking_categoria").update({ puntos_ranking }).eq("jugador_id", j.id).eq("categoria", categoria);
          if (error) { toast("Error: " + error.message); return; }
          toast("Puntos actualizados");
          await cargarJugadoresAdmin();
          cargarRanking();
        });
        const btnQuitarCatRanking = fila.querySelector(".btnQuitarCategoriaRanking");
        btnQuitarCatRanking.addEventListener("click", async () => {
          if (btnQuitarCatRanking.disabled) return;
          if (!confirm(`¿Sacar a ${j.nombre} ${j.apellido} del ranking de ${categoria}?`)) return;
          btnQuitarCatRanking.disabled = true;
          try {
          const { error } = await sb.from("ranking_categoria").delete().eq("jugador_id", j.id).eq("categoria", categoria);
          if (error) { toast("Error: " + error.message); return; }
          toast("Categoría quitada del ranking");
          await cargarJugadoresAdmin();
          cargarRanking();
          } finally {
            btnQuitarCatRanking.disabled = false;
          }
        });
      });
      const btnAgregarCatRanking = div.querySelector(".btnAgregarCategoriaRanking");
      btnAgregarCatRanking.addEventListener("click", async () => {
        if (btnAgregarCatRanking.disabled) return;
        btnAgregarCatRanking.disabled = true;
        try {
        const categoria = selNueva.value;
        if (!categoria) { toast("No quedan categorías para agregar"); return; }
        const { error } = await sb.from("ranking_categoria").insert({ jugador_id: j.id, categoria, puntos_ranking: 0 });
        if (error) { toast("Error: " + error.message); return; }
        toast(`${j.nombre} ${j.apellido} ahora también rankea en ${categoria}`);
        await cargarJugadoresAdmin();
        cargarRanking();
        } finally {
          btnAgregarCatRanking.disabled = false;
        }
      });
    };
    renderRankingExtra();
    div.insertAdjacentHTML("beforeend", `
      <div class="row" style="margin-top:8px;gap:8px">
        <button type="button" class="secondary small btnGuardarJugador">Guardar</button>
        <button type="button" class="secondary small btnAscenderJugador">⬆ Ascender</button>
        <button type="button" class="secondary small btnBlanquearClave">🔑 Blanquear clave</button>
        <button type="button" class="secondary small danger btnEliminarJugador">Eliminar perfil</button>
      </div>
    `);
    div.querySelector(".jaFoto").addEventListener("change", (e) => {
      const archivo = e.target.files[0];
      if (archivo) div.querySelector(".jaAvatarPreview").innerHTML = avatarHtml(URL.createObjectURL(archivo), 56);
    });
    div.querySelector(".btnGuardarJugador").addEventListener("click", async function () {
      if (this.disabled) return;
      this.disabled = true;
      try {
      const nombre = div.querySelector(".jaNombre").value.trim();
      const apellido = div.querySelector(".jaApellido").value.trim();
      const categoria = div.querySelector(".jaCategoria").value;
      const puntos_ranking = Number(div.querySelector(".jaPuntos").value);
      const etiqueta_id = div.querySelector(".jaEtiqueta").value || null;
      if (!nombre || !apellido) { toast("Nombre y apellido no pueden quedar vacíos"); return; }
      if (!Number.isFinite(puntos_ranking) || puntos_ranking < 0) { toast("Los puntos tienen que ser un número positivo"); return; }
      const datos = { nombre, apellido, categoria, puntos_ranking, etiqueta_id };
      const archivoFoto = div.querySelector(".jaFoto").files[0];
      if (archivoFoto) {
        const path = `admin-${j.id}-${Date.now()}-${archivoFoto.name}`;
        const { error: upErr } = await sb.storage.from("fotos").upload(path, archivoFoto);
        if (upErr) { toast("Error subiendo la foto: " + upErr.message); return; }
        const { data: pub } = sb.storage.from("fotos").getPublicUrl(path);
        datos.foto_url = pub.publicUrl;
      }
      const { error } = await sb.from("jugadores").update(datos).eq("id", j.id);
      if (error) { toast("Error: " + error.message); return; }
      toast("Jugador actualizado");
      cargarJugadoresAdmin();
      cargarRanking();
      } finally {
        this.disabled = false;
      }
    });
    // Ascender: usa la categoría elegida en el selector de arriba como destino.
    // Solo actúa si esa categoría es realmente más alta (según "orden" en categorías);
    // para bajar de categoría o corregirla sin dividir puntos, sigue estando "Guardar".
    div.querySelector(".btnAscenderJugador").addEventListener("click", async function () {
      if (this.disabled) return;
      const categoriaNueva = div.querySelector(".jaCategoria").value;
      if (categoriaNueva === j.categoria) { toast("Elegí arriba, en el selector de categoría, a cuál asciende"); return; }
      if (cacheCategorias.length === 0) await cargarCategorias();
      const ordenPorNombre = Object.fromEntries(cacheCategorias.map((c) => [c.nombre, c.orden]));
      if ((ordenPorNombre[categoriaNueva] ?? 0) <= (ordenPorNombre[j.categoria] ?? 0)) {
        toast(`${categoriaNueva} no es una categoría más alta que ${j.categoria} — para eso usá Guardar`);
        return;
      }
      if (!confirm(`¿Ascender a ${j.nombre} ${j.apellido} de ${j.categoria} a ${categoriaNueva}? Se lleva la mitad de sus puntos (${j.puntos_ranking} → ${Number(j.puntos_ranking) / 2}) y se lo saca del ranking de ${j.categoria}.`)) return;
      this.disabled = true;
      try {
        const { error, puntosNuevos } = await ejecutarAscenso(j.id, j.puntos_ranking, j.categoria, categoriaNueva);
        if (error) { toast("Error: " + error.message); return; }
        toast(`Ascendió a ${categoriaNueva} con ${puntosNuevos} puntos`);
        cargarJugadoresAdmin();
        cargarRanking();
      } finally {
        this.disabled = false;
      }
    });
    // Blanquear la clave de un jugador (ej: la olvidó, o quedó con la provisoria
    // de una importación vieja). No se puede hacer desde el cliente con la clave
    // "anon" de siempre -- hace falta la Edge Function admin-reset-password
    // (server-side, con la service_role key que Supabase le inyecta sola, nunca
    // pegada acá) que valida que quien llama es admin y recién ahí resetea.
    div.querySelector(".btnBlanquearClave").addEventListener("click", async () => {
      if (!j.email) { toast("Este jugador no tiene usuario/email cargado"); return; }
      const nuevaClave = prompt(`Nueva clave para ${j.nombre} ${j.apellido} (usuario: ${j.email}):`, "padel2026");
      if (!nuevaClave) return;
      if (nuevaClave.length < 6) { toast("La clave debe tener al menos 6 caracteres"); return; }
      const { data, error } = await sb.functions.invoke("admin-reset-password", { body: { email: j.email, nuevaClave } });
      if (error || data?.error) { toast("Error: " + (data?.error || error.message)); return; }
      toast(`Clave de ${j.nombre} ${j.apellido} blanqueada — se la pide cambiar al entrar`);
    });
    div.querySelector(".btnEliminarJugador").addEventListener("click", async function () {
      if (this.disabled) return;
      this.disabled = true;
      try {
      // "partidos_jugados" solo cuenta partidos con resultado cargado — un jugador
      // placeholder recién armado (0 partidos_jugados) puede igual estar anotado en
      // un partido de zona TODAVÍA NO jugado. Borrar el jugador borra en cascada su
      // pareja, y borrar la pareja borra esos partidos del cuadro (bug real que ya
      // pasó). Por eso acá se revisa cualquier partido asociado, jugado o no, y si
      // hay alguno se bloquea el borrado del todo — para reemplazar a alguien por el
      // jugador real sin perder el partido, está el ✏️ en "Inscripciones y parejas".
      const { data: parejasDelJugador } = await sb.from("parejas").select("id").or(`jugador1_id.eq.${j.id},jugador2_id.eq.${j.id}`);
      const idsParejas = (parejasDelJugador || []).map((p) => p.id);
      let partidosAfectados = 0;
      if (idsParejas.length) {
        const { count } = await sb.from("partidos").select("id", { count: "exact", head: true })
          .or(idsParejas.map((id) => `pareja1_id.eq.${id},pareja2_id.eq.${id}`).join(","));
        partidosAfectados = count || 0;
      }
      if (partidosAfectados > 0) {
        toast(`${j.nombre} ${j.apellido} tiene ${partidosAfectados} partido(s) armado(s) en el cuadro (jugados o no) — borrarlo se los lleva puestos. Si es un placeholder que hay que reemplazar por el jugador real, usá el ✏️ en "Inscripciones y parejas" en vez de borrar.`);
        return;
      }
      const tieneHistorial = j.partidos_jugados > 0;
      const aviso = tieneHistorial
        ? `${j.nombre} ${j.apellido} ya jugó ${j.partidos_jugados} partido(s). Eliminarlo borra también esos partidos y sus parejas del historial, y no se puede deshacer. ¿Eliminar de todas formas?`
        : `¿Eliminar el perfil de ${j.nombre} ${j.apellido}? No se puede deshacer.`;
      if (!confirm(aviso)) return;
      const { error } = await sb.from("jugadores").delete().eq("id", j.id);
      if (error) { toast("Error: " + error.message); return; }
      toast("Perfil eliminado");
      cargarJugadoresAdmin();
      cargarRanking();
      } finally {
        this.disabled = false;
      }
    });
    cont.appendChild(div);
  });
}
document.getElementById("buscarJugadorAdmin")?.addEventListener("input", renderListaJugadoresAdmin);

// ============================================================
// SOLICITUDES DE CATEGORÍA (pedidas por el jugador, las aprueba el admin)
// ============================================================
function renderSolicitudesCategoria(jugadores) {
  const cont = document.getElementById("listaSolicitudesCategoria");
  if (!cont) return;
  const solicitudes = jugadores.filter((j) => j.categoria_pendiente);
  cont.innerHTML = "";
  if (solicitudes.length === 0) { cont.innerHTML = '<p class="empty">No hay solicitudes pendientes.</p>'; return; }
  solicitudes.forEach((j) => {
    const div = document.createElement("div");
    div.className = "match-card";
    div.innerHTML = `<div class="match-teams">${escapeHtml(j.nombre)} ${escapeHtml(j.apellido)} <span class="badge">${j.categoria} → ${j.categoria_pendiente}</span></div>
      <div class="match-meta" style="display:flex;gap:8px;margin-top:8px">
        <button class="secondary small btnAprobarCategoria">Aprobar</button>
        <button class="secondary small danger btnRechazarCategoria">Rechazar</button>
      </div>`;
    div.querySelector(".btnAprobarCategoria").addEventListener("click", async function () {
      if (this.disabled) return;
      this.disabled = true;
      try {
      if (cacheCategorias.length === 0) await cargarCategorias();
      const categoriaVieja = j.categoria;
      const categoriaNueva = j.categoria_pendiente;
      const ordenPorNombre = Object.fromEntries(cacheCategorias.map((c) => [c.nombre, c.orden]));
      const esAscenso = (ordenPorNombre[categoriaNueva] ?? 0) > (ordenPorNombre[categoriaVieja] ?? 0);

      if (esAscenso) {
        const { error, puntosNuevos } = await ejecutarAscenso(j.id, j.puntos_ranking, categoriaVieja, categoriaNueva);
        if (error) { toast("Error: " + error.message); return; }
        toast(`Ascendió a ${categoriaNueva} con ${puntosNuevos} puntos`);
      } else {
        // Descenso o cambio lateral: se mantienen los puntos tal cual.
        const { error } = await sb.from("jugadores").update({ categoria: categoriaNueva, categoria_pendiente: null }).eq("id", j.id);
        if (error) { toast("Error: " + error.message); return; }
        await sb.from("ranking_categoria").upsert(
          { jugador_id: j.id, categoria: categoriaNueva, puntos_ranking: j.puntos_ranking, updated_at: new Date().toISOString() },
          { onConflict: "jugador_id,categoria" }
        );
        // queda registrado para poder mostrar "ascendieron este mes" en Inicio
        await sb.from("historial_categoria").insert({ jugador_id: j.id, categoria_anterior: categoriaVieja, categoria_nueva: categoriaNueva });
        toast("Categoría aprobada");
      }
      cargarJugadoresAdmin();
      cargarRanking();
      } finally {
        this.disabled = false;
      }
    });
    div.querySelector(".btnRechazarCategoria").addEventListener("click", async function () {
      if (this.disabled) return;
      this.disabled = true;
      try {
      const { error } = await sb.from("jugadores").update({ categoria_pendiente: null }).eq("id", j.id);
      if (error) { toast("Error: " + error.message); return; }
      toast("Solicitud rechazada");
      cargarJugadoresAdmin();
      } finally {
        this.disabled = false;
      }
    });
    cont.appendChild(div);
  });
}

// ============================================================
// TORNEOS
// ============================================================
function estaEnVivo(t) {
  const hoy = new Date().toISOString().slice(0, 10);
  return t.fecha_inicio <= hoy && (t.fecha_fin || t.fecha_inicio) >= hoy;
}

function badgeEstadoTorneo(t) {
  if (estaEnVivo(t)) return `<span class="badge live"><span class="live-dot"></span>EN VIVO</span>`;
  if (t.estado === "inscripcion") return `<span class="badge solid">Inscripción abierta</span>`;
  if (t.estado === "inscripcion_cerrada") return `<span class="badge orange">Inscripción cerrada</span>`;
  if (t.estado === "en_curso") return `<span class="badge solid">En curso</span>`;
  if (t.estado === "cancelado") return `<span class="badge orange">Cancelado</span>`;
  return `<span class="badge">${t.estado === "finalizado" ? "Finalizado" : t.estado}</span>`;
}

function linkMapsComplejo(complejo) {
  if (!complejo) return "";
  const query = complejo.direccion ? `${complejo.nombre}, ${complejo.direccion}` : complejo.nombre;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

async function cargarTorneos() {
  const { data } = await sb.from("torneos").select("*, complejos(nombre, direccion), torneo_categorias(categoria)").order("fecha_inicio", { ascending: false });
  cacheTorneos = data || [];
  const cont = document.getElementById("listaTorneos");
  cont.innerHTML = "";

  const spTorneo = document.getElementById("spTorneo");
  if (spTorneo) {
    const valorPrevio = spTorneo.value;
    spTorneo.innerHTML = '<option value="">General (todos los torneos)</option>' +
      cacheTorneos.map((t) => `<option value="${t.id}">${t.nombre}</option>`).join("");
    if (valorPrevio) spTorneo.value = valorPrevio;
  }

  // selector de "torneo en gestión" en Administración — cualquier torneo,
  // sin importar su estado (un admin puede necesitar volver a uno finalizado)
  const selGestion = document.getElementById("admSelectTorneoGestion");
  if (selGestion) {
    const valorPrevio = selGestion.value;
    selGestion.innerHTML = '<option value="">Elegí un torneo</option>' +
      cacheTorneos.map((t) => `<option value="${t.id}">${t.nombre}</option>`).join("");
    if (valorPrevio) selGestion.value = valorPrevio;
  }

  if (!data || data.length === 0) {
    cont.innerHTML = `<p class="empty">Todavía no hay torneos creados.</p>`;
    return;
  }
  data.forEach((t) => {
    const div = document.createElement("div");
    // con flyer propio, la tarjeta se agranda para que se vea como un póster de
    // verdad (no solo de fondo detrás del texto, como con la imagen genérica)
    div.className = "match-card torneo-card-poster" + (t.flyer_url ? " torneo-card-flyer" : "");
    div.style.cursor = "pointer";
    if (t.flyer_url) {
      // velo parejo en TODA la tarjeta (no solo una franja abajo): el afiche del club
      // sigue viéndose y reconociéndose, pero su propia tipografía/color pasan a
      // "textura de fondo" en vez de competir con el nombre/sede que pone la app encima
      // -- ver mockup-tarjeta-torneo (opción B, la elegida) para el porqué.
      div.style.backgroundImage = `linear-gradient(0deg, rgba(5,7,10,.86), rgba(5,7,10,.86)), url('${t.flyer_url}')`;
    }
    const catList = (t.torneo_categorias || []).map((c) => c.categoria);
    const categorias = catList.length === 0 ? "todas las categorías"
      : catList.length > 3 ? `${catList.slice(0, 3).join(", ")} +${catList.length - 3} más`
      : catList.join(", ");
    const maps = linkMapsComplejo(t.complejos);
    div.innerHTML = `
      <div class="torneo-card-header">
        <span class="torneo-nombre">${t.nombre}</span>
        ${badgeEstadoTorneo(t)}
      </div>
      <div class="torneo-lugar">
        ${iconoPin()} <span>${t.complejos?.nombre || "sin complejo"}</span>
        ${maps ? `<a href="${maps}" target="_blank" rel="noopener" class="torneo-maps-link">Ver ubicación ↗</a>` : ""}
      </div>
      <div class="match-meta meta-caption">${categorias} · desde ${t.fecha_inicio}</div>
    `;
    div.addEventListener("click", () => abrirTorneo(t.id));
    const linkMaps = div.querySelector(".torneo-maps-link");
    if (linkMaps) linkMaps.addEventListener("click", (e) => e.stopPropagation());
    cont.appendChild(div);
  });
}

// ---------- Horarios por día del torneo (ej: viernes de noche, sábado y domingo
// desde la mañana) ----------
// El horario "por defecto" (tHoraDesde/tHoraHasta) sigue existiendo y es lo que se
// usa para armar el calendario en cualquier día del torneo que no tenga acá su
// propio horario cargado. Se guarda en torneos.horarios_por_dia (jsonb, formato
// {diaSemana: {desde, hasta}}) — ver ventanaDelTorneo, más abajo. El formulario se
// vuelve a dibujar cada vez que cambian los días tildados, conservando lo ya
// tipeado en los que siguen tildados.
function renderHorariosPorDiaForm(contId, chkClass, valoresPrevios) {
  const cont = document.getElementById(contId);
  if (!cont) return;
  const previos = { ...(valoresPrevios || {}) };
  cont.querySelectorAll("[data-dia]").forEach((fila) => {
    previos[fila.dataset.dia] = {
      desde: fila.querySelector(".hpdDesde").value,
      hasta: fila.querySelector(".hpdHasta").value
    };
  });
  const dias = Array.from(document.querySelectorAll(`.${chkClass}:checked`)).map((c) => Number(c.value));
  cont.innerHTML = dias.map((d) => {
    const v = previos[d] || {};
    return `<div class="row" data-dia="${d}" style="margin-top:6px;align-items:flex-end">
      <div><label>${DIAS_CORTO[d]}, desde</label><input type="time" class="hpdDesde" value="${v.desde || ""}" /></div>
      <div><label>${DIAS_CORTO[d]}, hasta</label><input type="time" class="hpdHasta" value="${v.hasta || ""}" /></div>
    </div>`;
  }).join("");
}
function leerHorariosPorDiaForm(contId) {
  const cont = document.getElementById(contId);
  const resultado = {};
  (cont ? cont.querySelectorAll("[data-dia]") : []).forEach((fila) => {
    const desde = fila.querySelector(".hpdDesde").value;
    const hasta = fila.querySelector(".hpdHasta").value;
    if (desde && hasta) resultado[fila.dataset.dia] = { desde, hasta };
  });
  return Object.keys(resultado).length ? resultado : null;
}
document.getElementById("tDiasForm").addEventListener("change", (e) => {
  if (e.target.classList.contains("chkDiaTorneo")) renderHorariosPorDiaForm("tHorariosPorDiaForm", "chkDiaTorneo");
});
document.getElementById("teDiasForm").addEventListener("change", (e) => {
  if (e.target.classList.contains("chkDiaTorneoEdit")) renderHorariosPorDiaForm("teHorariosPorDiaForm", "chkDiaTorneoEdit");
});
document.getElementById("canchaDiasNuevaForm").addEventListener("change", (e) => {
  if (e.target.classList.contains("chkDiaCanchaNueva")) renderHorariosPorDiaForm("canchaHorariosPorDiaNuevaForm", "chkDiaCanchaNueva");
});
// una cancha por fila, cada una con su propio checkbox de días y su propio
// mini-form de horarios (chkDiaCte-<id>/cteHorarios-<id>, ver canchaTorneoRowHtml)
// -- delegado en el contenedor porque las filas se re-arman enteras en cada
// refrescarTrasAccionGestion(), así no hace falta re-cablear un listener por fila.
document.getElementById("admCanchas").addEventListener("change", (e) => {
  if (e.target.classList.contains("chkDiaCte")) {
    const tcId = e.target.dataset.tc;
    renderHorariosPorDiaForm(`cteHorarios-${tcId}`, `chkDiaCte-${tcId}`);
  }
});
// Una cancha del torneo, con su resumen de días/horario y un editor
// plegable (✏️) para cambiarle los días y, opcionalmente, un horario propio
// distinto al general del torneo (ver torneo_canchas.horarios_por_dia).
function canchaTorneoRowHtml(c) {
  const complejo = cacheComplejos.find((x) => x.id === c.canchas?.complejo_id);
  const nombreCompleto = `${complejo ? escapeHtml(complejo.nombre) + " · " : ""}${escapeHtml(c.canchas?.nombre || "?")}`;
  const resumenDias = c.dias_semana && c.dias_semana.length ? c.dias_semana.map((d) => DIAS_CORTO[d]).join(",") : "todos los días";
  const tieneHorarioPropio = c.horarios_por_dia && Object.keys(c.horarios_por_dia).length;
  return `<div class="cancha-torneo-fila">
    <span class="badge orange">${nombreCompleto} (${resumenDias}${tieneHorarioPropio ? " · horario propio" : ""})
      <a href="#" class="btnEditarCanchaTorneo" data-tc="${c.id}" title="Editar días y horario">✏️</a>
      <a href="#" class="btnQuitarCanchaTorneo" data-tc="${c.id}" title="Quitar">✕</a>
    </span>
    <div class="cancha-torneo-editor" id="cteEditor-${c.id}" style="display:none">
      <label style="margin-top:6px">¿Qué días juega esta cancha?</label>
      <div class="check-grid">
        ${[4, 5, 6, 0, 1, 2, 3].map((d) => `<label><input type="checkbox" class="chkDiaCte chkDiaCte-${c.id}" value="${d}" ${c.dias_semana && c.dias_semana.includes(d) ? "checked" : ""} /> ${DIAS_CORTO[d]}</label>`).join("")}
      </div>
      <label>¿Abre en un horario propio, distinto al general del torneo, alguno de esos días? Dejalo vacío para usar el horario del torneo.</label>
      <div id="cteHorarios-${c.id}"></div>
      <button type="button" class="secondary small btnGuardarCanchaTorneo" data-tc="${c.id}">Guardar</button>
    </div>
  </div>`;
}

// el form de crear torneo queda escondido por defecto (puede haber muchos torneos
// en la lista) y solo se muestra cuando el admin lo pide
document.getElementById("btnMostrarCrearTorneo").addEventListener("click", () => {
  const card = document.getElementById("crearTorneoCard");
  card.style.display = "block";
  document.querySelectorAll(".chkDiaTorneo:checked").forEach((c) => (c.checked = false));
  document.getElementById("tHorariosPorDiaForm").innerHTML = "";
  card.scrollIntoView({ behavior: "smooth", block: "start" });
});
document.getElementById("btnCancelarCrearTorneo").addEventListener("click", () => {
  document.getElementById("crearTorneoCard").style.display = "none";
});

// "Parejas por grupo" / "Cuántas avanzan por grupo" solo se usan cuando el
// formato es "grupos" (armarGruposDeParejas) — en "eliminación directa" y
// "cuadro de zonas" esos dos campos no significan nada, así que se ocultan
// en vez de dejarlos siempre a la vista confundiendo al admin.
function toggleGrupoConfigRow(selectId, rowId) {
  const select = document.getElementById(selectId);
  const row = document.getElementById(rowId);
  if (select && row) row.style.display = select.value === "grupos" ? "flex" : "none";
}
// "Crear torneo" ya no tiene selector propio -- el formato del club
// ("cuadro_zonas") queda fijo en el input oculto tFaseGruposFormato, así que
// tGrupoConfigRow ("Parejas por grupo"/"Cuántas avanzan") ni existe más ahí.
// "Editar torneo" sigue con las 3 opciones (no se toca): un torneo ya creado
// puede seguir usando "grupos"/"eliminación" y cambiarle el formato a mitad
// de camino podría romper el cuadro ya armado.
document.getElementById("teFaseGruposFormato").addEventListener("change", () => toggleGrupoConfigRow("teFaseGruposFormato", "teGrupoConfigRow"));

document.getElementById("btnCrearTorneo").addEventListener("click", async () => {
  const btn = document.getElementById("btnCrearTorneo");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  if (!isAdmin) { toast("Solo un administrador puede crear torneos"); return; }
  const nombre = document.getElementById("tNombre").value.trim();
  const complejoId = document.getElementById("tComplejo").value;
  const fechaInicio = document.getElementById("tFechaInicio").value;
  if (!nombre || !fechaInicio) { toast("Completá al menos nombre y fecha de inicio"); return; }

  let flyerUrl = null;
  const archivo = document.getElementById("tFlyerArchivo").files[0];
  if (archivo) {
    const path = `${Date.now()}-${archivo.name}`;
    const { error: upErr } = await sb.storage.from("flyers").upload(path, archivo);
    if (upErr) { toast("Error subiendo el flyer: " + upErr.message); return; }
    const { data: pub } = sb.storage.from("flyers").getPublicUrl(path);
    flyerUrl = pub.publicUrl;
  }

  const categoriasElegidas = Array.from(document.querySelectorAll(".chkTorneoCategoria:checked")).map((c) => c.value);
  if (categoriasElegidas.length === 0) { toast("Elegí al menos una categoría"); return; }

  const costoTxt = document.getElementById("tCosto").value.trim();
  const diasElegidos = Array.from(document.querySelectorAll(".chkDiaTorneo:checked")).map((c) => Number(c.value));
  const torneo = {
    nombre,
    complejo_id: complejoId || null,
    fecha_inicio: fechaInicio,
    fecha_fin: document.getElementById("tFechaFin").value || fechaInicio,
    flyer_url: flyerUrl,
    costo: costoTxt ? Number(costoTxt) : null,
    duracion_minutos: Number(document.getElementById("tDuracion").value) || 90,
    dias_semana: diasElegidos.length ? diasElegidos : null,
    hora_desde: document.getElementById("tHoraDesde").value || null,
    hora_hasta: document.getElementById("tHoraHasta").value || null,
    horarios_por_dia: leerHorariosPorDiaForm("tHorariosPorDiaForm"),
    // único formato del club (ver el cartel fijo en el form) -- tamano_grupo
    // y avanzan_por_grupo ni se mandan: solo aplican a "grupos" y ya tienen
    // default en la base (3 y 2) para los torneos viejos que sí lo usan.
    fase_grupos_formato: document.getElementById("tFaseGruposFormato").value
  };
  const { data, error } = await sb.from("torneos").insert(torneo).select().single();
  if (error) { toast("Error: " + error.message); return; }

  await sb.from("torneo_categorias").insert(categoriasElegidas.map((categoria) => ({ torneo_id: data.id, categoria })));

  if (complejoId) {
    const canchasDelComplejo = cacheCanchas.filter((c) => c.complejo_id === complejoId);
    if (canchasDelComplejo.length > 0) {
      await sb.from("torneo_canchas").insert(canchasDelComplejo.map((c) => ({ torneo_id: data.id, cancha_id: c.id })));
    }
  }

  toast("Torneo creado");
  document.getElementById("tNombre").value = "";
  document.getElementById("tFlyerArchivo").value = "";
  document.getElementById("tCosto").value = "";
  document.querySelectorAll(".chkTorneoCategoria:checked").forEach((c) => (c.checked = false));
  document.getElementById("crearTorneoCard").style.display = "none";
  cargarTorneos();
  cargarInicio();
  abrirTorneo(data.id);
  } finally {
    btn.disabled = false;
  }
});

// Abre un torneo y muestra una de sus 8 pantallas Público/Jugador (por
// defecto, Inicio). Reutiliza SIEMPRE la misma carga de datos
// (refrescarDetalleTorneo) sea cual sea la pantalla pedida — es más simple
// y más seguro que hacer 8 loaders parciales distintos, y el costo es
// insignificante (las 8 pantallas ya están en el DOM, solo una queda visible).
//
// Cada pestaña del subnav (Inicio/Categorías/Jugadores/Calendario/Resultados)
// cambia el hash, y eso dispara despacharRuta -> abrirTorneo de nuevo (ver
// cambiarVista/despacharRuta) — cada click real vuelve a pedir todos los
// datos del torneo por Supabase. Si el jugador toca dos pestañas rápido
// (por ejemplo Categorías y enseguida Jugadores), la primera consulta puede
// tardar más y resolver DESPUÉS de la segunda, pisando la pantalla nueva con
// la vieja ("a veces vuelve a Categorías"). Un token por llamada evita que
// una respuesta vieja gane: si ya arrancó una navegación más nueva mientras
// esta esperaba, esta no toca la pantalla al terminar.
let tokenNavegacionTorneo = 0;
async function abrirTorneo(id, pantalla) {
  const miToken = ++tokenNavegacionTorneo;
  torneoActualId = id;
  await refrescarDetalleTorneo();
  if (miToken !== tokenNavegacionTorneo) return; // ya hay una navegación más nueva en curso
  // sin pantalla explícita (entrar desde la lista de torneos, o un link directo
  // a /torneo/:id) siempre se aterriza en "" — la pantalla única de Torneo, que ya
  // se encarga de mostrarse vacía/con la inscripción abierta si todavía no hay
  // partidos armados (ver renderPartidosLlave).
  mostrarPantallaTorneo(pantalla);
}
document.getElementById("btnVolverTorneos").addEventListener("click", () => cambiarVista("torneos"));

function mostrarPantallaTorneo(pantalla) {
  // si ya está anotado, un link directo o "Atrás" del navegador a /inscripcion
  // nunca debe volver a mostrar el wizard — se redirige a "Mi inscripción"
  if (pantalla === "inscripcion" && yaInscriptoEnTorneoActual) pantalla = "mi-inscripcion";
  const clave = pantalla || "";
  const info = PANTALLAS_TORNEO[clave];
  // clave desconocida (ej. un link viejo a /calendario o /resultados, de
  // antes de unificarlas) cae en la pantalla única de Torneo, no en blanco.
  const view = info ? info.view : (PANTALLAS_TORNEO_EXTRA[clave] || "torneo-resultados");
  cambiarVista(view, `/torneo/${torneoActualId}${clave ? "/" + clave : ""}`);
  renderTorneoSubnav(clave);
  if (clave === "inscripcion") prepararFormularioInscripcion();
  if (clave === "mi-inscripcion") cargarMiInscripcion();
  if (clave === "mi-disponibilidad") cargarYMostrarDispTorneo();
}

// mini-nav del torneo (Torneo/Info) — un solo lugar que arma los pills, así
// nunca queda desalineado con PANTALLAS_TORNEO ni con la pantalla realmente
// activa. Las dos pestañas están siempre visibles: "Torneo" ya se encarga de
// mostrarse vacía o con la inscripción abierta si todavía no hay partidos
// armados (ver renderPartidosLlave).
function renderTorneoSubnav(claveActiva) {
  const cont = document.getElementById("torneoSubnav");
  cont.innerHTML = Object.entries(PANTALLAS_TORNEO)
    .map(([key, info]) =>
      `<button type="button" class="pill ${key === claveActiva ? "active" : ""}" data-pantalla="${key}">${info.label}</button>`
    ).join("");
  cont.querySelectorAll(".pill").forEach((btn) => {
    btn.addEventListener("click", () => mostrarPantallaTorneo(btn.dataset.pantalla));
  });
}

// ---------- buscador de pareja al inscribirse ----------
let parejaSeleccionada = null;
let jugadoresParaBuscar = [];
let categoriasTorneoActual = []; // categorías que compiten en el torneo abierto actualmente

// habilita "Inscribirme" solo cuando ya se eligió pareja Y categoría — nunca antes
function actualizarBotonInscribirme() {
  const btn = document.getElementById("btnInscribirme");
  if (!btn || btn.style.display === "none") return;
  const categoria = document.getElementById("anotarmeCategoria").value;
  if (!parejaSeleccionada) { btn.disabled = true; btn.textContent = "Elegí tu pareja para continuar"; return; }
  if (!categoria) { btn.disabled = true; btn.textContent = "Elegí la categoría para continuar"; return; }
  btn.disabled = false;
  btn.textContent = "Inscribirme";
}
document.getElementById("anotarmeCategoria").addEventListener("change", actualizarBotonInscribirme);

document.getElementById("buscarPareja").addEventListener("input", (e) => {
  parejaSeleccionada = null;
  document.getElementById("parejaSeleccionadaTxt").textContent = "";
  actualizarBotonInscribirme();
  const q = e.target.value.trim().toLowerCase();
  const sugerencias = document.getElementById("sugerenciasPareja");
  if (!q) { sugerencias.innerHTML = ""; return; }

  const candidatos = jugadoresParaBuscar.filter((j) =>
    j.id !== miJugador?.id && `${j.nombre} ${j.apellido}`.toLowerCase().includes(q)
  ).slice(0, 6);

  sugerencias.innerHTML = candidatos.length > 0
    ? candidatos.map((j) => `<button type="button" class="suggest-item" data-id="${j.id}">${escapeHtml(j.nombre)} ${escapeHtml(j.apellido)} <span class="badge" style="margin-left:6px">${j.categoria}</span></button>`).join("")
    : '<div class="suggest-item" style="color:var(--muted);cursor:default">Sin resultados</div>';

  sugerencias.querySelectorAll(".suggest-item[data-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      parejaSeleccionada = candidatos.find((c) => c.id === btn.dataset.id);
      document.getElementById("buscarPareja").value = `${parejaSeleccionada.nombre} ${parejaSeleccionada.apellido}`;
      document.getElementById("parejaSeleccionadaTxt").textContent = `✓ Vas a jugar con ${parejaSeleccionada.nombre} ${parejaSeleccionada.apellido}`;
      sugerencias.innerHTML = "";
      actualizarBotonInscribirme();
    });
  });
});

// Botón "Anotarme" de Inicio del torneo: decide a dónde lleva (login,
// completar perfil, el wizard de inscripción, o "ya estás anotado") sin
// mostrar ningún formulario ahí mismo — Inicio nunca tiene formularios
// embebidos, solo accesos. La inscripción en sí vive en su propia pantalla
// (view-torneo-inscripcion, ver prepararFormularioInscripcion).
async function actualizarAccesoInscripcion() {
  const estado = document.getElementById("inscripcionEstado");
  const btn = document.getElementById("btnIrAInscribirme");
  yaInscriptoEnTorneoActual = false;
  if (!currentUser) {
    estado.textContent = "Iniciá sesión para poder inscribirte.";
    btn.textContent = "Iniciar sesión";
    btn.style.display = "block";
    btn.onclick = () => cambiarVista("perfil");
    return;
  }
  if (!miJugador) {
    estado.textContent = "Completá tu perfil de jugador antes de inscribirte.";
    btn.textContent = "Completar perfil";
    btn.style.display = "block";
    btn.onclick = () => cambiarVista("perfil");
    return;
  }
  // cancelada/rechazada no cuentan como "ya inscripto" — la fila sigue existiendo
  // como historial (ver schema.sql), pero para la UI es como si no se hubiera
  // anotado: puede volver a hacerlo (inscribirse_con_pareja la reactiva).
  const { data } = await sb.from("inscripciones").select("id, estado, motivo_rechazo").eq("torneo_id", torneoActualId).eq("jugador_id", miJugador.id).maybeSingle();
  const inscActiva = data && data.estado !== "cancelada" && data.estado !== "rechazada";
  yaInscriptoEnTorneoActual = !!inscActiva;
  if (inscActiva) {
    estado.textContent = "✅ Ya estás inscripto en este torneo.";
    btn.textContent = "Ver mi inscripción";
    btn.style.display = "block";
    btn.onclick = () => mostrarPantallaTorneo("mi-inscripcion");
  } else if (data && data.estado === "rechazada") {
    estado.textContent = `❌ Tu inscripción fue rechazada${data.motivo_rechazo ? ": " + data.motivo_rechazo : ""}. Podés volver a anotarte.`;
    btn.textContent = "Anotarme de nuevo";
    btn.style.display = "block";
    btn.onclick = () => mostrarPantallaTorneo("inscripcion");
  } else if (torneoActualData && torneoActualData.estado !== "inscripcion") {
    estado.textContent = "🔒 La inscripción para este torneo está cerrada.";
    btn.style.display = "none";
  } else {
    estado.textContent = "";
    btn.textContent = "Anotarme";
    btn.style.display = "block";
    btn.onclick = () => mostrarPantallaTorneo("inscripcion");
  }
}

// Prepara el Paso 1/2 del wizard de inscripción (categoría con la cantidad de
// parejas ya anotadas + buscador de pareja) cada vez que se entra a esa
// pantalla — no arma nada de esto en Inicio.
async function prepararFormularioInscripcion() {
  const { data: jp } = await sb.rpc("jugadores_publicos");
  jugadoresParaBuscar = jp || [];

  const { data: parejasDb } = await sb.rpc("parejas_publicas", { p_torneo_id: torneoActualId });
  const conteoPorCategoria = {};
  (parejasDb || []).forEach((p) => { if (p.categoria) conteoPorCategoria[p.categoria] = (conteoPorCategoria[p.categoria] || 0) + 1; });

  const selCat = document.getElementById("anotarmeCategoria");
  if (categoriasTorneoActual.length === 0) {
    // sin esto, el select quedaba vacío y "Inscribirme" nunca se habilitaba, sin
    // ninguna pista de por qué — este torneo directamente no tiene categorías
    // cargadas (se configuran al crearlo o editarlo, en Administración).
    selCat.innerHTML = `<option value="">Sin categorías configuradas todavía</option>`;
    toast("Este torneo todavía no tiene categorías configuradas — avisale al club.");
  } else {
    selCat.innerHTML = `<option value="">Elegí la categoría</option>` +
      categoriasTorneoActual.map((c) => {
        const n = conteoPorCategoria[c] || 0;
        return `<option value="${c}">${c}${n ? ` (${n} pareja${n === 1 ? "" : "s"} anotada${n === 1 ? "" : "s"})` : ""}</option>`;
      }).join("");
  }

  document.getElementById("confirmarInscripcionWrap").style.display = "none";
  document.getElementById("inscDispWrap").style.display = "none";
  document.getElementById("buscarParejaWrap").style.display = "block";
  parejaSeleccionada = null;
  document.getElementById("buscarPareja").value = "";
  document.getElementById("parejaSeleccionadaTxt").textContent = "";
  document.getElementById("anotarmeCategoria").value = "";
  const btn = document.getElementById("btnInscribirme");
  btn.style.display = "block";
  btn.onclick = () => mostrarPasoDisponibilidad();
  actualizarBotonInscribirme();
}

// "Mi inscripción": pareja/categoría/estado + accesos (nunca vuelve a mostrar
// el formulario de inscripción una vez ya anotado).
async function cargarMiInscripcion() {
  const contEstado = document.getElementById("miInscEstado");
  const contResumen = document.getElementById("miInscResumen");
  if (!miJugador || !torneoActualId) return;
  const [{ data: insc }, { data: parejas }] = await Promise.all([
    sb.from("inscripciones").select("*").eq("torneo_id", torneoActualId).eq("jugador_id", miJugador.id).maybeSingle(),
    sb.rpc("parejas_publicas", { p_torneo_id: torneoActualId })
  ]);
  if (!insc || insc.estado === "cancelada" || insc.estado === "rechazada") {
    contEstado.innerHTML = insc?.estado === "rechazada" ? '<span class="badge danger">Rechazada</span>' : "";
    contResumen.textContent = insc?.estado === "rechazada"
      ? `Tu inscripción fue rechazada${insc.motivo_rechazo ? ": " + insc.motivo_rechazo : ""}.`
      : "Todavía no estás inscripto en este torneo.";
    return;
  }
  contEstado.innerHTML = insc.estado === "confirmada"
    ? '<span class="badge solid">🟢 Confirmada</span>'
    : '<span class="badge orange">Pendiente de confirmar</span>';
  // un jugador puede tener más de una pareja en este torneo si juega más de
  // una categoría (cada pareja guarda su propia categoría) -- se muestran
  // todas, no solo la primera que aparezca
  const misParejas = (parejas || []).filter((p) => p.jugador1_id === miJugador.id || p.jugador2_id === miJugador.id);
  if (misParejas.length === 0) {
    contResumen.textContent = `Categoría ${insc.categoria} · todavía sin pareja confirmada.`;
  } else {
    contResumen.textContent = misParejas
      .map((p) => {
        const companero = p.jugador1_id === miJugador.id ? p.jugador2_nombre : p.jugador1_nombre;
        return `Jugás con ${companero}, categoría ${p.categoria || insc.categoria}.`;
      })
      .join(" ");
  }
}
document.getElementById("miInscBtnDisponibilidad").addEventListener("click", () => mostrarPantallaTorneo("mi-disponibilidad"));
document.getElementById("miInscBtnMisPartidos").addEventListener("click", () => mostrarPantallaTorneo(""));
document.getElementById("miInscBtnCancelar").addEventListener("click", async () => {
  const btn = document.getElementById("miInscBtnCancelar");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  if (!miJugador || !torneoActualId) return;
  // si ya tiene pareja confirmada, no se puede cancelar solo/a desde acá (dejaría a
  // la/el compañera/o colgada/o, y borrar la pareja es una acción reservada al
  // admin por RLS) — se le pide que lo resuelva con el club
  const { data: parejas } = await sb.rpc("parejas_publicas", { p_torneo_id: torneoActualId });
  const tienePareja = (parejas || []).some((p) => p.jugador1_id === miJugador.id || p.jugador2_id === miJugador.id);
  if (tienePareja) {
    toast("Ya tenés una pareja anotada en este torneo — pedile al club que cancele la inscripción por vos.");
    return;
  }
  if (!confirm("¿Seguro que querés cancelar tu inscripción a este torneo?")) return;
  // no se borra la fila: queda como historial (estado 'cancelada'), permitido por
  // RLS solo hacia ese valor (ver inscripciones_jugador_cancela en schema.sql).
  // Si más adelante se vuelve a anotar, inscribirse_con_pareja la reactiva.
  const { error } = await sb.from("inscripciones").update({ estado: "cancelada" }).eq("torneo_id", torneoActualId).eq("jugador_id", miJugador.id);
  if (error) { toast("Error: " + error.message); return; }
  toast("Cancelaste tu inscripción.");
  avisarActualizacionEnVivo();
  refrescarDetalleTorneo();
  mostrarPantallaTorneo("");
  } finally {
    btn.disabled = false;
  }
});

// Muestra y precarga el picker de horarios bloqueados puntuales para ESTE
// torneo (además de los generales del perfil, que ya se combinan solos al
// armar los partidos — ver jugadoresDisponibilidad).
async function cargarYMostrarDispTorneo() {
  if (!miJugador || !torneoActualId) return;
  renderDisponibilidadForm("torneoDispBloqueadaForm");
  const { data: disp } = await sb.from("disponibilidad").select("*")
    .eq("jugador_id", miJugador.id).eq("torneo_id", torneoActualId);
  precargarRestriccionesEnForm("torneoDispBloqueadaForm", disp);
}

document.getElementById("btnGuardarDispTorneo").addEventListener("click", async () => {
  const btn = document.getElementById("btnGuardarDispTorneo");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  if (!miJugador || !torneoActualId) return;
  await sb.from("disponibilidad").delete().eq("jugador_id", miJugador.id).eq("torneo_id", torneoActualId);
  const disponibilidades = leerRestriccionesDeForm("torneoDispBloqueadaForm").map((r) => ({ jugador_id: miJugador.id, torneo_id: torneoActualId, ...r }));
  if (disponibilidades.length > 0) await sb.from("disponibilidad").insert(disponibilidades);
  toast("¡Guardado! 🎾");
  } finally {
    btn.disabled = false;
  }
});

// Paso intermedio (antes de confirmar) para que cargar los horarios en que
// NO se puede jugar quede DENTRO del camino obligatorio de inscripción, no
// como algo opcional que solo se ve después en "Mi inscripción" — pedido del
// club porque sin este dato es mucho más difícil armar bien el fixture.
// Reusa el mismo componente y la misma tabla que "Mi disponibilidad"
// (torneo_id + jugador_id), así que si ya lo había cargado antes lo ve
// precargado acá.
async function mostrarPasoDisponibilidad() {
  if (!miJugador) return;
  document.getElementById("buscarParejaWrap").style.display = "none";
  document.getElementById("btnInscribirme").style.display = "none";
  document.getElementById("inscDispWrap").style.display = "block";
  renderDisponibilidadForm("inscDispForm");
  const { data: disp } = await sb.from("disponibilidad").select("*")
    .eq("jugador_id", miJugador.id).eq("torneo_id", torneoActualId);
  precargarRestriccionesEnForm("inscDispForm", disp);
}

document.getElementById("btnContinuarDesdeDisp").addEventListener("click", async () => {
  const btn = document.getElementById("btnContinuarDesdeDisp");
  if (btn.disabled || !miJugador) return;
  btn.disabled = true;
  try {
    await sb.from("disponibilidad").delete().eq("jugador_id", miJugador.id).eq("torneo_id", torneoActualId);
    const disponibilidades = leerRestriccionesDeForm("inscDispForm").map((r) => ({ jugador_id: miJugador.id, torneo_id: torneoActualId, ...r }));
    if (disponibilidades.length > 0) await sb.from("disponibilidad").insert(disponibilidades);
    document.getElementById("inscDispWrap").style.display = "none";
    mostrarConfirmarInscripcion();
  } finally {
    btn.disabled = false;
  }
});

// paso 2: confirmación antes de anotar de verdad (acá se va a sumar el pago más adelante)
function mostrarConfirmarInscripcion() {
  const categoria = document.getElementById("anotarmeCategoria").value;
  if (!parejaSeleccionada) { toast("Elegí primero con quién vas a jugar"); return; }
  if (!categoria) { toast("Elegí en qué categoría van a jugar"); return; }
  const t = cacheTorneos.find((x) => x.id === torneoActualId);
  const costoTxt = t?.costo ? ` · Costo: $${t.costo}` : "";
  document.getElementById("confirmarInscripcionResumen").textContent =
    `¿Anotamos a vos y a ${parejaSeleccionada.nombre} ${parejaSeleccionada.apellido} en "${t?.nombre || "este torneo"}", categoría ${categoria}?${costoTxt} Un admin va a confirmar la inscripción cuando verifique el pago.`;
  const contWsp = document.getElementById("confirmarInscripcionWhatsapp");
  if (t?.costo && Number(t.costo) > 0 && configApp.whatsapp_numero) {
    contWsp.innerHTML = botonWhatsappPagoHtml("btnPagarWhatsappConfirmar", "margin-top:8px");
    wirearBotonWhatsappPago("btnPagarWhatsappConfirmar", t);
  } else {
    contWsp.innerHTML = "";
  }
  document.getElementById("buscarParejaWrap").style.display = "none";
  document.getElementById("btnInscribirme").style.display = "none";
  document.getElementById("confirmarInscripcionWrap").style.display = "block";
}

document.getElementById("btnCambiarPareja").addEventListener("click", () => {
  document.getElementById("confirmarInscripcionWrap").style.display = "none";
  document.getElementById("buscarParejaWrap").style.display = "block";
  document.getElementById("btnInscribirme").style.display = "block";
});

document.getElementById("btnConfirmarInscripcion").addEventListener("click", async () => {
  const categoria = document.getElementById("anotarmeCategoria").value;
  if (!parejaSeleccionada) { toast("Elegí primero con quién vas a jugar"); return; }
  if (!categoria) { toast("Elegí en qué categoría van a jugar"); return; }
  const boton = document.getElementById("btnConfirmarInscripcion");
  boton.disabled = true;
  const { error } = await sb.rpc("inscribirse_con_pareja", {
    p_torneo_id: torneoActualId,
    p_pareja_jugador_id: parejaSeleccionada.id,
    p_categoria: categoria
  });
  boton.disabled = false;
  if (error) { toast("Error: " + error.message); return; }
  toast("¡Listo, se anotaron los dos! Falta que el admin confirme la inscripción 🎾");
  parejaSeleccionada = null;
  document.getElementById("buscarPareja").value = "";
  document.getElementById("parejaSeleccionadaTxt").textContent = "";
  document.getElementById("anotarmeCategoria").value = "";
  avisarActualizacionEnVivo();
  await refrescarDetalleTorneo();
  mostrarPantallaTorneo("mi-inscripcion");
});

// ============================================================
// JUGAR (reservar cancha para entrenar / jugar con amigos, día a día,
// fuera del circuito de torneos — pendiente hasta que un admin la confirma,
// no suma puntos al ranking)
// ============================================================
let invitadosSeleccionados = []; // jugadores invitados a la reserva que se está armando (máx. 3)

function actualizarCanchasReserva() {
  const complejoId = document.getElementById("reservaComplejo").value;
  const canchasDelComplejo = cacheCanchas.filter((c) => c.complejo_id === complejoId);
  llenarSelect(document.getElementById("reservaCancha"), canchasDelComplejo, (c) => c.nombre);
  actualizarCostoEstimado();
}
document.getElementById("reservaComplejo").addEventListener("change", actualizarCanchasReserva);

function actualizarCostoEstimado() {
  const cancha = cacheCanchas.find((c) => c.id === document.getElementById("reservaCancha").value);
  const minutos = Number(document.getElementById("reservaDuracion").value) || 90;
  const txt = document.getElementById("reservaCostoTxt");
  txt.textContent = cancha?.costo_hora
    ? `Costo estimado: $${Math.round((cancha.costo_hora * minutos) / 60)} (a confirmar por el club)`
    : "Esta cancha no tiene costo configurado.";
}
document.getElementById("reservaCancha").addEventListener("change", actualizarCostoEstimado);
document.getElementById("reservaDuracion").addEventListener("input", actualizarCostoEstimado);

function renderInvitadosSeleccionados() {
  document.getElementById("reservaInvitadosSeleccionados").innerHTML = invitadosSeleccionados.map((j) => `
    <span class="badge">${escapeHtml(j.nombre)} ${escapeHtml(j.apellido)} <button type="button" class="btnQuitarInvitado" data-id="${j.id}" aria-label="Quitar a ${escapeHtml(j.nombre)} ${escapeHtml(j.apellido)} de invitados" style="border:none;background:none;color:inherit;cursor:pointer;margin-left:4px">×</button></span>
  `).join("");
  document.querySelectorAll(".btnQuitarInvitado").forEach((btn) => {
    btn.addEventListener("click", () => {
      invitadosSeleccionados = invitadosSeleccionados.filter((j) => j.id !== btn.dataset.id);
      renderInvitadosSeleccionados();
    });
  });
}

document.getElementById("reservaBuscarAmigo").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  const sugerencias = document.getElementById("reservaSugerencias");
  if (!q) { sugerencias.innerHTML = ""; return; }
  if (invitadosSeleccionados.length >= 3) { sugerencias.innerHTML = '<div class="suggest-item" style="color:var(--muted);cursor:default">Ya invitaste a 3 amigos (el máximo para la cancha)</div>'; return; }

  const candidatos = jugadoresParaBuscar.filter((j) =>
    j.id !== miJugador?.id && !invitadosSeleccionados.some((s) => s.id === j.id) && `${j.nombre} ${j.apellido}`.toLowerCase().includes(q)
  ).slice(0, 6);

  sugerencias.innerHTML = candidatos.length > 0
    ? candidatos.map((j) => `<button type="button" class="suggest-item" data-id="${j.id}">${escapeHtml(j.nombre)} ${escapeHtml(j.apellido)}</button>`).join("")
    : '<div class="suggest-item" style="color:var(--muted);cursor:default">Sin resultados</div>';

  sugerencias.querySelectorAll(".suggest-item[data-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      invitadosSeleccionados.push(candidatos.find((c) => c.id === btn.dataset.id));
      document.getElementById("reservaBuscarAmigo").value = "";
      sugerencias.innerHTML = "";
      renderInvitadosSeleccionados();
    });
  });
});

document.getElementById("btnPedirReserva").addEventListener("click", async () => {
  const cancha_id = document.getElementById("reservaCancha").value;
  const horarioValor = document.getElementById("reservaHorario").value;
  if (!cancha_id) { toast("Elegí una cancha"); return; }
  if (!horarioValor) { toast("Elegí fecha y hora"); return; }
  const boton = document.getElementById("btnPedirReserva");
  boton.disabled = true;
  const { error } = await sb.rpc("reservar_cancha", {
    p_cancha_id: cancha_id,
    p_horario: new Date(horarioValor).toISOString(),
    p_duracion_minutos: Number(document.getElementById("reservaDuracion").value) || 90,
    p_invitados_ids: invitadosSeleccionados.map((j) => j.id)
  });
  boton.disabled = false;
  if (error) { toast("Error: " + error.message); return; }
  toast("¡Listo! Falta que el club confirme tu reserva 🎾");
  document.getElementById("reservaHorario").value = "";
  invitadosSeleccionados = [];
  renderInvitadosSeleccionados();
  cargarMisReservas();
});

async function cargarMisReservas() {
  const cont = document.getElementById("listaMisReservas");
  if (!miJugador) { cont.innerHTML = ""; return; }
  const { data } = await sb.rpc("mis_reservas");
  const reservas = data || [];
  cont.innerHTML = reservas.length > 0 ? "" : '<p class="empty">Todavía no tenés reservas.</p>';
  reservas.forEach((r) => {
    const horario = new Date(r.horario).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
    const costoTxt = r.costo ? ` · $${r.costo}` : "";
    const estadoBadge = { pendiente: "orange", confirmada: "", rechazada: "danger", cancelada: "danger" }[r.estado] || "";
    const div = document.createElement("div");
    div.className = "match-card";
    div.innerHTML = `
      <div class="match-teams">${r.cancha_nombre}${r.complejo_nombre ? " · " + r.complejo_nombre : ""}</div>
      <div class="match-meta">${horario} · ${r.duracion_minutos} min${costoTxt} <span class="badge ${estadoBadge}">${r.estado}</span></div>
      ${r.invitados ? `<div class="match-meta">Con: ${escapeHtml(r.invitados)}</div>` : ""}
      ${r.soy_organizador && (r.estado === "pendiente" || r.estado === "confirmada") ? '<button class="secondary small danger btnCancelarReserva" style="margin-top:8px">Cancelar reserva</button>' : ""}
    `;
    if (r.soy_organizador) {
      const btnCancelar = div.querySelector(".btnCancelarReserva");
      if (btnCancelar) btnCancelar.addEventListener("click", async () => {
        if (btnCancelar.disabled) return;
        btnCancelar.disabled = true;
        try {
        const { error } = await sb.from("reservas").update({ estado: "cancelada" }).eq("id", r.id);
        if (error) { toast("Error: " + error.message); return; }
        toast("Reserva cancelada");
        cargarMisReservas();
        } finally {
          btnCancelar.disabled = false;
        }
      });
    }
    cont.appendChild(div);
  });
}

async function renderJugar() {
  const aviso = document.getElementById("reservaLoginAviso");
  const form = document.getElementById("reservaFormWrap");
  if (!currentUser || !miJugador) {
    aviso.style.display = "block";
    form.style.display = "none";
    document.getElementById("listaMisReservas").innerHTML = "";
    return;
  }
  aviso.style.display = "none";
  form.style.display = "block";
  if (jugadoresParaBuscar.length === 0) {
    const { data: jp } = await sb.rpc("jugadores_publicos");
    jugadoresParaBuscar = jp || [];
  }
  cargarMisReservas();
}
document.getElementById("btnReservaIrAPerfil").addEventListener("click", () => cambiarVista("perfil"));
document.querySelector('.tab[data-view="jugar"]').addEventListener("click", renderJugar);

async function cargarReservasPendientesAdmin() {
  if (!isAdmin) return;
  const cont = document.getElementById("listaReservasPendientes");
  const { data } = await sb.rpc("reservas_admin");
  const pendientes = (data || []).filter((r) => r.estado === "pendiente");
  cont.innerHTML = pendientes.length > 0 ? "" : '<p class="empty">No hay reservas pendientes.</p>';
  pendientes.forEach((r) => {
    const horario = new Date(r.horario).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
    const costoTxt = r.costo ? ` · $${r.costo}` : "";
    const div = document.createElement("div");
    div.className = "match-card";
    div.innerHTML = `
      <div class="match-teams">${r.cancha_nombre}${r.complejo_nombre ? " · " + r.complejo_nombre : ""}</div>
      <div class="match-meta">${horario} · ${r.duracion_minutos} min${costoTxt}</div>
      <div class="match-meta">Organiza: ${escapeHtml(r.organizador_nombre)}${r.organizador_telefono ? " · " + escapeHtml(r.organizador_telefono) : ""}${r.invitados ? " · Con: " + escapeHtml(r.invitados) : ""}</div>
      <div class="match-meta" style="display:flex;gap:8px;margin-top:8px">
        <button class="secondary small btnConfirmarReserva">Confirmar</button>
        <button class="secondary small danger btnRechazarReserva">Rechazar</button>
      </div>
    `;
    div.querySelector(".btnConfirmarReserva").addEventListener("click", async function () {
      if (this.disabled) return;
      this.disabled = true;
      try {
      const { error } = await sb.from("reservas").update({ estado: "confirmada" }).eq("id", r.id);
      if (error) { toast("Error: " + error.message); return; }
      toast("Reserva confirmada");
      cargarReservasPendientesAdmin();
      } finally {
        this.disabled = false;
      }
    });
    div.querySelector(".btnRechazarReserva").addEventListener("click", async function () {
      if (this.disabled) return;
      this.disabled = true;
      try {
      const { error } = await sb.from("reservas").update({ estado: "rechazada" }).eq("id", r.id);
      if (error) { toast("Error: " + error.message); return; }
      toast("Reserva rechazada");
      cargarReservasPendientesAdmin();
      } finally {
        this.disabled = false;
      }
    });
    cont.appendChild(div);
  });
}

// ---------- WhatsApp para coordinar el pago de una inscripción ----------
// ícono nativo (SVG inline, sin depender de ninguna librería ni imagen externa)
const ICONO_WHATSAPP_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="vertical-align:-3px;margin-right:5px"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.77.46 3.45 1.35 4.95L2 22l5.25-1.38c1.45.79 3.08 1.21 4.79 1.21h.01c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2zm5.83 14.02c-.24.68-1.4 1.32-1.94 1.4-.5.08-1.09.11-1.76-.11-.4-.13-.92-.3-1.59-.58-2.79-1.2-4.62-4.01-4.76-4.2-.14-.19-1.14-1.51-1.14-2.88 0-1.37.72-2.04.97-2.32.25-.28.55-.35.73-.35.18 0 .37 0 .53.01.17.01.4-.06.62.48.24.58.81 2.01.88 2.16.07.15.11.32.02.51-.09.19-.14.31-.28.48-.14.17-.29.37-.42.5-.14.14-.28.29-.12.57.16.28.72 1.19 1.55 1.93 1.06.95 1.96 1.24 2.24 1.38.28.14.44.12.6-.07.16-.19.68-.79.87-1.06.18-.27.36-.23.61-.14.24.09 1.55.73 1.82.86.27.14.45.2.51.32.07.12.07.68-.17 1.36z"/></svg>`;

function botonWhatsappPagoHtml(id, estiloExtra = "") {
  return `<button type="button" class="secondary small" id="${id}" style="${estiloExtra}">${ICONO_WHATSAPP_SVG}Coordinar pago por WhatsApp</button>`;
}

// engancha el click de un botón ya insertado en el DOM (por id) para abrir WhatsApp
// con un mensaje precargado — mismo mensaje sin importar desde qué botón se abrió
function wirearBotonWhatsappPago(id, t) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener("click", () => {
    const quien = miJugador ? `Soy ${miJugador.nombre} ${miJugador.apellido} y ` : "";
    const mensaje = `Hola! ${quien}quiero coordinar el pago de mi inscripción a "${t.nombre}" ($${t.costo}).`;
    window.open(`https://wa.me/${configApp.whatsapp_numero}?text=${encodeURIComponent(mensaje)}`, "_blank", "noopener,noreferrer");
  });
}

// Carga TODO lo público de un torneo (header, canchas, parejas, categorías,
// próximos partidos, calendario, resultados) y lo distribuye entre las 8
// pantallas — todas están siempre en el DOM (solo una queda visible a la
// vez vía .view/.active), así que refrescar acá adentro es tan simple como
// era antes con una sola pantalla. Ninguna acción de administración vive
// más acá: eso es refrescarGestionTorneo/cargarGestionTorneo, en Administración.
async function refrescarDetalleTorneo() {
  if (!torneoActualId) return;
  const { data: t, error } = await sb.from("torneos").select("*, complejos(nombre), torneo_categorias(categoria, estado_fase)").eq("id", torneoActualId).single();
  if (!t) {
    // antes esto fallaba en silencio (pantalla vacía, sin categorías ni jugadores,
    // sin poder anotarse) — casi siempre porque a la base le falta correr la
    // migración de schema.sql más reciente. Mejor avisarlo que dejar todo en blanco.
    if (error) toast("No se pudo cargar el torneo: " + error.message);
    return;
  }
  torneoActualData = t;
  hayCalendarioTorneoActual = (t.torneo_categorias || []).some((c) => c.estado_fase === "calendario_confirmado" || c.estado_fase === "finalizada");

  document.getElementById("dtNombre").textContent = t.nombre;
  document.getElementById("dtEstado").innerHTML = badgeEstadoTorneo(t);
  // hero con foto real de cancha en la pantalla de Inicio del torneo (sección 9
  // del rediseño): mismo dato, solo se muestra también acá en grande.
  document.getElementById("dtNombreHero").textContent = t.nombre;
  document.getElementById("dtEstadoHero").innerHTML = badgeEstadoTorneo(t);
  categoriasTorneoActual = (t.torneo_categorias || []).map((c) => c.categoria);
  const categorias = categoriasTorneoActual.join(", ") || "todas las categorías";
  document.getElementById("dtInfo").textContent = `${t.complejos?.nombre || "sin complejo"} · ${categorias} · ${t.fecha_inicio} a ${t.fecha_fin}`;

  // una vez que se cerró la inscripción (etapa "inscripcion_cerrada" en
  // adelante: en_curso, finalizado) coordinar el pago o anotarse ya no tiene
  // sentido — se deja de mostrar costo, el botón de WhatsApp y la card de
  // "Anotarme" para no confundir a alguien que entra a ver el calendario/las
  // llaves con contenido que ya no aplica.
  const inscripcionYaCerrada = t.estado !== "inscripcion";
  const contCosto = document.getElementById("dtCosto");
  if (t.costo && Number(t.costo) > 0 && !inscripcionYaCerrada) {
    contCosto.style.display = "block";
    contCosto.innerHTML = `<span class="badge solid">💰 Costo: $${t.costo}</span>` +
      (configApp.whatsapp_numero ? botonWhatsappPagoHtml("btnPagarWhatsapp", "margin-left:8px") : "");
    wirearBotonWhatsappPago("btnPagarWhatsapp", t);
  } else {
    contCosto.style.display = "none";
    contCosto.innerHTML = "";
  }
  document.getElementById("dtInscripcionCard").style.display = inscripcionYaCerrada ? "none" : "block";

  await actualizarAccesoInscripcion();
  await cargarSponsorsTorneo();
  await cargarFotosTorneo();

  const { data: tc } = await sb.from("torneo_canchas").select("*, canchas(id, nombre, complejo_id, complejos(nombre))").eq("torneo_id", torneoActualId);
  ultimasCanchasTorneo = tc || [];
  document.getElementById("dtCanchas").innerHTML = (tc || []).map((c) =>
    `<span class="badge orange" style="margin-right:6px">${c.canchas?.nombre || "?"}</span>`
  ).join("") || '<p class="empty">Sin canchas asignadas todavía.</p>';

  const [{ data: insc }, { data: parejas }, { data: partidos }] = await Promise.all([
    sb.rpc("inscriptos_publicos", { p_torneo_id: torneoActualId }),
    sb.rpc("parejas_publicas", { p_torneo_id: torneoActualId }),
    sb.rpc("partidos_publicos", { p_torneo_id: torneoActualId })
  ]);
  // partidos_publicos() devuelve TODOS los partidos del torneo (la misma RPC
  // la usa también Administración, que sí necesita ver los partidos de una
  // categoría todavía en borrador para poder revisarlos) — el filtro de "solo
  // lo publicado" se hace acá, del lado público, con torneo_categorias que ya
  // se trajo arriba: así una categoría en calendario_borrador no le aparece a
  // los jugadores mezclada con otra categoría del mismo torneo que sí esté
  // publicada.
  const categoriasPublicadas = new Set((t.torneo_categorias || [])
    .filter((c) => c.estado_fase === "calendario_confirmado" || c.estado_fase === "finalizada")
    .map((c) => c.categoria));
  ultimosPartidos = (partidos || []).filter((p) => categoriasPublicadas.has(p.categoria));
  // OJO: a propósito NO hay acá un fallback que mire "¿algún partido ya tiene
  // horario?" para forzar hayCalendarioTorneoActual -- desde que existe el
  // calendario "de prueba" (calendario_borrador), un partido puede tener
  // horario asignado SIN que el admin lo haya publicado todavía, y ese
  // fallback se lo mostraría igual al público. Por eso todos los caminos que
  // asignan horario (generarCalendarioParaCategoria, arrastrar en la
  // planilla, "Cambiar horario") mantienen torneo_categorias.estado_fase al
  // día -- esa columna es la única fuente de verdad de "¿ya se puede
  // mostrar?".

  // Torneo (pestaña unificada de torneoSubnav) solo muestra la llave una vez que
  // alguna categoría tiene calendario confirmado — mientras se está anotando
  // gente, o mientras solo existe el fixture (cruces sin horario todavía), esa
  // pantalla no tiene partidos que mostrar todavía (ver también renderTorneoSubnav).

  renderParejasEn("dtParejas", "dtSinPareja", insc || [], parejas || [], false);
  cargarCategoriasTorneo(parejas || []);
  renderStatsInicioTorneo(parejas || [], tc || [], ultimosPartidos);

  await cargarBloqueosCancha();
  renderResultadosPublico();
}

// Después de una acción de gestión (Administración), refresca tanto el panel
// admin del torneo en gestión como su vista pública si el usuario la tiene
// abierta al mismo tiempo — nunca quedan desincronizados entre sí.
async function refrescarTrasAccionGestion() {
  if (torneoGestionId) await cargarGestionTorneo(torneoGestionId);
  if (torneoActualId && torneoActualId === torneoGestionId) await refrescarDetalleTorneo();
}

// ---------- Categorías (pública) ----------
function cargarCategoriasTorneo(parejas) {
  const cont = document.getElementById("dtCategorias");
  if (!cont) return;
  const conteo = {};
  (parejas || []).forEach((p) => { if (p.categoria) conteo[p.categoria] = (conteo[p.categoria] || 0) + 1; });
  cont.innerHTML = categoriasTorneoActual.length === 0
    ? '<p class="empty">Este torneo todavía no tiene categorías cargadas.</p>'
    : categoriasTorneoActual.map((c) => {
      const n = conteo[c] || 0;
      return `<div class="pareja-row"><span>${c}</span><span class="badge">${n} pareja${n === 1 ? "" : "s"}</span></div>`;
    }).join("");
}

// insignias tipo "anillo de progreso" (mismo componente .pj-stats que usa el
// perfil de jugador) — reutilizado acá para Inicio del torneo y para el
// Dashboard de Administración, sin agregar ningún estilo nuevo.
function statsRingHtml(pares) {
  return pares.map(([valor, label]) => `<div><strong>${valor}</strong><span>${label}</span></div>`).join("");
}
function renderStatsInicioTorneo(parejas, canchasTorneo, partidos) {
  const cont = document.getElementById("dtInicioStats");
  if (!cont) return;
  cont.innerHTML = statsRingHtml([
    [(parejas || []).length, "Parejas"],
    [categoriasTorneoActual.length, "Categorías"],
    [(canchasTorneo || []).length, "Canchas"],
    [(partidos || []).length, "Partidos"]
  ]);
}

// ---------- Bloqueos de cancha (admin) ----------
// Concepto DISTINTO de la disponibilidad de un jugador: acá la cancha entera
// queda inutilizable para TODOS en ese horario (lluvia, mantenimiento, otro
// evento) — no es una preferencia personal de un jugador puntual, sino que
// bloquea la cancha para cualquiera. Es global por cancha (no por torneo): una
// cancha bloqueada lo está para cualquier torneo que la use en ese horario. El
// armado automático (matching.js) y la planilla drag-and-drop lo respetan vía
// bloqueosPorCanchaMapa().
let cacheBloqueosCancha = [];

// cancha_id -> [{desde:Date, hasta:Date, motivo}], el formato que esperan
// calcularSlots, asignarHorarios y hayConflictoCancha.
function bloqueosPorCanchaMapa() {
  const mapa = {};
  cacheBloqueosCancha.forEach((b) => {
    if (!mapa[b.cancha_id]) mapa[b.cancha_id] = [];
    mapa[b.cancha_id].push({ desde: new Date(b.desde), hasta: new Date(b.hasta), motivo: b.motivo });
  });
  return mapa;
}

async function cargarBloqueosCancha() {
  const { data } = await sb.from("canchas_bloqueos").select("*, canchas(nombre)").order("desde");
  cacheBloqueosCancha = data || [];
  renderBloqueosAdmin();
}

function renderBloqueosAdmin() {
  const cont = document.getElementById("admBloqueosLista");
  if (!cont) return;
  const ahora = new Date();
  cont.innerHTML = cacheBloqueosCancha.length === 0
    ? '<p class="empty">No hay bloqueos cargados — todas las canchas están disponibles.</p>'
    : cacheBloqueosCancha.map((b) => {
      const vigente = new Date(b.hasta) > ahora;
      const desde = new Date(b.desde).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
      const hasta = new Date(b.hasta).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
      return `<div class="pareja-row">
        <span>${vigente ? "🔴" : "⚪"} ${b.canchas?.nombre || "?"} — ${desde} a ${hasta}${b.motivo ? ` (${escapeHtml(b.motivo)})` : ""}</span>
        <button class="secondary small btnQuitarBloqueo" data-id="${b.id}">Quitar</button>
      </div>`;
    }).join("");

  llenarSelect(document.getElementById("admBloqueoCancha"), cacheCanchas, (c) => {
    const complejo = cacheComplejos.find((x) => x.id === c.complejo_id);
    return `${c.nombre} (${complejo ? complejo.nombre : "?"})`;
  });

  cont.querySelectorAll(".btnQuitarBloqueo").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
      const { error } = await sb.from("canchas_bloqueos").delete().eq("id", btn.dataset.id);
      if (error) { toast("Error: " + error.message); return; }
      toast("Bloqueo eliminado");
      avisarActualizacionEnVivo();
      refrescarTrasAccionGestion();
      } finally {
        btn.disabled = false;
      }
    });
  });
}

document.getElementById("admBtnBloquearCancha").addEventListener("click", async () => {
  const btn = document.getElementById("admBtnBloquearCancha");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  const canchaId = document.getElementById("admBloqueoCancha").value;
  const desde = document.getElementById("admBloqueoDesde").value;
  const hasta = document.getElementById("admBloqueoHasta").value;
  const motivo = document.getElementById("admBloqueoMotivo").value.trim() || null;
  if (!canchaId) { toast("Elegí una cancha"); return; }
  if (!desde || !hasta) { toast("Completá desde y hasta"); return; }
  if (new Date(hasta) <= new Date(desde)) { toast('"Hasta" tiene que ser posterior a "Desde"'); return; }

  const { error } = await sb.from("canchas_bloqueos").insert({
    cancha_id: canchaId,
    desde: new Date(desde).toISOString(),
    hasta: new Date(hasta).toISOString(),
    motivo
  });
  if (error) { toast("Error: " + error.message); return; }
  toast("Cancha bloqueada ✅");
  document.getElementById("admBloqueoDesde").value = "";
  document.getElementById("admBloqueoHasta").value = "";
  document.getElementById("admBloqueoMotivo").value = "";
  avisarActualizacionEnVivo();
  refrescarTrasAccionGestion();
  } finally {
    btn.disabled = false;
  }
});

// ---------- Administración: torneo en gestión ----------
let torneoGestionId = null;
let torneoGestionData = null;

document.getElementById("admSelectTorneoGestion").addEventListener("change", async (e) => {
  const id = e.target.value;
  if (!id) {
    torneoGestionId = null;
    torneoGestionData = null;
    document.getElementById("admGestionTorneoWrap").style.display = "none";
    return;
  }
  await cargarGestionTorneo(id);
});

// Carga todo lo que necesita Administración de UN torneo puntual: header +
// dashboard, el formulario de edición, inscripciones/parejas CON acciones,
// canchas CON alta, bloqueos, y partidos/planilla CON acciones — todo lo que
// antes vivía mezclado en la vista pública bajo el toggle "Organizar", ahora
// vive solo acá.
// Las 4 cards largas de "Administrar este torneo" (Inscripciones/Canchas/
// Bloqueos/Partidos) vivían todas seguidas en una sola pantalla — para llegar
// a "Cargar resultado" (dentro de Partidos) había que scrollear más allá de
// las otras tres. Mismo patrón que renderTorneoSubnav: un pill-nav que
// muestra una sección por vez, así "Partidos" queda a un toque en vez de un
// scroll largo. seccionGestionActiva se mantiene entre refrescos de la
// pantalla (no vuelve a "Inscripciones" cada vez que se recarga algo).
let seccionGestionActiva = "resumen";
// Canchas/Bloqueos/Puntaje vivían agrupadas bajo una sola sección
// "Configuración" (admSeccionConfiguracion) -- ahora cada una es su propia
// entrada, para que la sidebar deje ver una sola cosa por vez y nunca las
// tres juntas (admSeccionConfiguracion sigue en el HTML como envoltorio sin
// estilo propio, ya no se referencia acá).
const SECCIONES_GESTION = {
  resumen: { id: "admSeccionResumen", label: "Resumen" },
  inscripciones: { id: "admSeccionInscripciones", label: "Inscripciones y pagos" },
  canchas: { id: "admSeccionCanchas", label: "Canchas del torneo" },
  bloqueos: { id: "admSeccionBloqueos", label: "Bloqueos de cancha" },
  puntaje: { id: "admSeccionPuntaje", label: "Puntaje para el ranking" },
  fotos: { id: "admSeccionFotos", label: "Fotos" },
  partidos: { id: "admSeccionPartidos", label: "Partidos" }
};
function renderAdminGestionSubnav() {
  const cont = document.getElementById("admGestionSubnav");
  cont.innerHTML = Object.entries(SECCIONES_GESTION)
    .map(([key, info]) => `<button type="button" class="pill ${key === seccionGestionActiva ? "active" : ""}" data-seccion="${key}">${info.label}</button>`)
    .join("");
  cont.querySelectorAll(".pill").forEach((btn) => btn.addEventListener("click", () => mostrarSeccionGestion(btn.dataset.seccion)));
  mostrarSeccionGestion(seccionGestionActiva);
}
function mostrarSeccionGestion(clave) {
  seccionGestionActiva = clave;
  Object.entries(SECCIONES_GESTION).forEach(([key, info]) => {
    document.getElementById(info.id).style.display = key === clave ? "block" : "none";
  });
  document.getElementById("admGestionSubnav").querySelectorAll(".pill").forEach((btn) => btn.classList.toggle("active", btn.dataset.seccion === clave));
  sincronizarAdmSidebar();
}

// "Configuración general" tenía el mismo problema que "Torneo en gestión"
// tenía antes de armar SECCIONES_GESTION: 9 cards mostrándose todas juntas
// apenas se entraba. Mismo mecanismo acá (mapa clave->id + una función que
// muestra solo esa una): nunca más de una a la vez.
let seccionConfigActiva = "club";
let enPantallaTorneoSelector = false; // "Torneo en gestión" del menú lateral, sin elegir torneo todavía (ver mostrarSeccionTorneoSelector)
const SECCIONES_CONFIG_GENERAL = {
  club: { id: "admCfgClub", label: "Configuración del club" },
  complejos: { id: "admCfgComplejos", label: "Canchas y predios" },
  categorias: { id: "admCfgCategorias", label: "Categorías" },
  etiquetas: { id: "admCfgEtiquetas", label: "Etiquetas de jugadores" },
  solicitudes: { id: "admCfgSolicitudes", label: "Solicitudes de categoría" },
  jugadorDelMes: { id: "admCfgJugadorDelMes", label: "Jugador del mes" },
  auspiciantes: { id: "auspiciantesWrap", label: "Auspiciantes" },
  noticias: { id: "admCfgNoticias", label: "Noticias" },
  jugadores: { id: "admCfgJugadores", label: "Jugadores registrados" }
};
function mostrarSeccionConfigGeneral(clave) {
  seccionConfigActiva = clave;
  enPantallaTorneoSelector = false;
  // "Torneo en gestión" (el selector suelto) queda en su propia pantalla, separada
  // de Configuración general -- ver mostrarSeccionTorneoSelector.
  document.getElementById("admSelectorTorneoCard").style.display = "none";
  // en mobile no hay sidebar (ver #admSidebar en style.css) ni ningún otro
  // nav para volver a elegir sección -- ahí "Configuración general" sigue
  // mostrando las 9 cards juntas, como siempre. Achicar a una sola solo
  // tiene sentido en escritorio, donde la sidebar es la forma de cambiar.
  const esDesktop = window.matchMedia("(min-width: 960px)").matches;
  Object.entries(SECCIONES_CONFIG_GENERAL).forEach(([key, info]) => {
    document.getElementById(info.id).style.display = (!esDesktop || key === clave) ? "block" : "none";
  });
  sincronizarAdmSidebar();
}

// "Torneo en gestión" sin elegir todavía: pantalla propia, separada de
// Configuración general (antes el selector quedaba arriba de TODAS las
// secciones de config general a la vez, lo cual confundía -- ver charla que
// llevó a este cambio).
function mostrarSeccionTorneoSelector() {
  enPantallaTorneoSelector = true;
  mostrarConfigGeneral(false);
  document.getElementById("admGestionTorneoWrap").style.display = "none";
  document.getElementById("admSelectorTorneoCard").style.display = "block";
  sincronizarAdmSidebar();
}

// ---------- Sidebar de Administración (#admSidebar, solo escritorio) ----------
// Capa fina de navegación: cada click dispara la MISMA acción/botón de
// siempre (mostrarSeccionGestion, mostrarSeccionConfigGeneral,
// admBtnVolverConfigGeneral, cargarGestionTorneo) y después se sincroniza
// para reflejar qué quedó activo — la sidebar no es dueña de ningún estado
// nuevo, solo lo muestra. En mobile #admSidebar ni se ve (ver style.css),
// así que esto no cambia nada ahí.
document.querySelectorAll("#admSidebar > .adm-side-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.admNav === "config-general") {
      document.getElementById("admBtnVolverConfigGeneral").click();
    } else if (torneoGestionId) {
      cargarGestionTorneo(torneoGestionId);
    } else {
      mostrarSeccionTorneoSelector();
    }
  });
});

function sincronizarAdmSidebar() {
  const sidebar = document.getElementById("admSidebar");
  if (!sidebar) return;
  const enGestion = document.getElementById("admGestionTorneoWrap").style.display !== "none";
  // "activo" en el ítem de menú "Torneo en gestión" tanto si ya hay un torneo cargado
  // como si se está viendo el selector suelto (enPantallaTorneoSelector) -- las dos son
  // parte de la misma sección, separada de Configuración general.
  const enSeccionTorneo = enGestion || enPantallaTorneoSelector;
  sidebar.querySelectorAll(":scope > .adm-side-item").forEach((btn) => {
    btn.classList.toggle("active", enSeccionTorneo ? btn.dataset.admNav === "torneo" : btn.dataset.admNav === "config-general");
  });

  renderSubnavLateral("admSidebarSubnav", SECCIONES_GESTION, seccionGestionActiva, enGestion, mostrarSeccionGestion, "seccion-gestion", "seccionGestion");
  renderSubnavLateral("admSidebarSubnavConfig", SECCIONES_CONFIG_GENERAL, seccionConfigActiva, !enSeccionTorneo, mostrarSeccionConfigGeneral, "seccion-config", "seccionConfig");
}

// Pinta uno de los dos sub-menús de la sidebar (el de "Torneo en gestión" o
// el de "Configuración general") -- misma lógica para los dos, solo cambia
// qué mapa/función usan, para no repetir el mismo bloque dos veces.
// attrKebab/attrCamel: mismo dato en las dos formas que pide el DOM
// (atributo "data-seccion-gestion" en el HTML <-> propiedad .dataset.seccionGestion en JS).
function renderSubnavLateral(contId, mapa, claveActiva, visible, onClick, attrKebab, attrCamel) {
  const subnav = document.getElementById(contId);
  if (!visible) { subnav.style.display = "none"; subnav.innerHTML = ""; return; }
  subnav.style.display = "block";
  subnav.innerHTML = Object.entries(mapa)
    .map(([key, info]) => `<button type="button" class="adm-side-item" data-${attrKebab}="${key}">${info.label}</button>`)
    .join("");
  subnav.querySelectorAll(`[data-${attrKebab}]`).forEach((btn) => {
    const clave = btn.dataset[attrCamel];
    btn.classList.toggle("active", clave === claveActiva);
    btn.addEventListener("click", () => onClick(clave));
  });
}

async function cargarGestionTorneo(id) {
  torneoGestionId = id;
  const { data: t, error } = await sb.from("torneos").select("*, complejos(nombre), torneo_categorias(categoria, estado_fase)").eq("id", id).single();
  if (!t) {
    // ídem refrescarDetalleTorneo: antes esto dejaba "Administrar este torneo" sin
    // mostrar nada y sin ningún aviso — ahora al menos se informa el motivo.
    if (error) toast("No se pudo cargar el torneo: " + error.message);
    return;
  }
  torneoGestionData = t;
  document.getElementById("admSelectTorneoGestion").value = id;
  document.getElementById("admGestionTorneoWrap").style.display = "block";
  // Pantalla enfocada SOLO en este torneo (dashboard aparte): se oculta el
  // selector suelto y toda la configuración general del club (WhatsApp/
  // Instagram, complejos, categorías, auspiciantes generales, etc. — eso
  // vive aparte, en Administración general) sea cual sea la entrada por la
  // que se llegó acá (el selector de esta misma pantalla, o "Administrar
  // este torneo" desde el propio torneo).
  adminFocoTorneoActivo = true;
  enPantallaTorneoSelector = false;
  document.getElementById("admSelectorTorneoCard").style.display = "none";
  mostrarConfigGeneral(false);
  document.getElementById("admBtnVolverConfigGeneral").style.display = "inline-block";
  document.getElementById("admGestionNombre").textContent = t.nombre;
  document.getElementById("admGestionEstado").innerHTML = badgeEstadoTorneo(t);
  cargarPuntosTorneo(t);
  renderAdminGestionSubnav();
  sincronizarAdmSidebar();

  const btnToggleInsc = document.getElementById("btnToggleInscripcion");
  if (t.estado === "inscripcion" || t.estado === "inscripcion_cerrada") {
    btnToggleInsc.style.display = "inline-block";
    btnToggleInsc.textContent = t.estado === "inscripcion" ? "🔒 Cerrar inscripción" : "🔓 Reabrir inscripción";
    btnToggleInsc.onclick = async () => {
      if (btnToggleInsc.disabled) return;
      btnToggleInsc.disabled = true;
      try {
        const nuevoEstado = t.estado === "inscripcion" ? "inscripcion_cerrada" : "inscripcion";
        const { error } = await sb.from("torneos").update({ estado: nuevoEstado }).eq("id", torneoGestionId);
        if (error) { toast("Error: " + error.message); return; }
        toast(nuevoEstado === "inscripcion_cerrada" ? "Inscripción cerrada" : "Inscripción reabierta");
        refrescarTrasAccionGestion();
      } finally {
        btnToggleInsc.disabled = false;
      }
    };
  } else {
    btnToggleInsc.style.display = "none";
  }

  const categoriasGestion = (t.torneo_categorias || []).map((c) => c.categoria);
  document.getElementById("dtSelectCategoriaInscribir").innerHTML = `<option value="">Elegí la categoría</option>` +
    categoriasGestion.map((c) => `<option value="${c}">${c}</option>`).join("");
  const selCatPartidos = document.getElementById("partidosCategoriaFiltro");
  if (!categoriasGestion.includes(partidosCategoriaFiltro)) partidosCategoriaFiltro = "";
  selCatPartidos.innerHTML = `<option value="">Todas</option>` +
    categoriasGestion.map((c) => `<option value="${c}" ${c === partidosCategoriaFiltro ? "selected" : ""}>${c}</option>`).join("");
  renderEstadoCategorias(t.torneo_categorias || []);

  const { data: tc } = await sb.from("torneo_canchas").select("*, canchas(id, nombre, complejo_id)").eq("torneo_id", id);
  document.getElementById("admCanchas").innerHTML = (tc || []).map(canchaTorneoRowHtml).join("")
    || '<p class="empty">Sin canchas asignadas todavía.</p>';
  (tc || []).forEach((c) => renderHorariosPorDiaForm(`cteHorarios-${c.id}`, `chkDiaCte-${c.id}`, c.horarios_por_dia || {}));
  document.querySelectorAll(".btnEditarCanchaTorneo").forEach((a) => a.addEventListener("click", (ev) => {
    ev.preventDefault();
    const editor = document.getElementById(`cteEditor-${a.dataset.tc}`);
    if (editor) editor.style.display = editor.style.display === "none" ? "block" : "none";
  }));
  document.querySelectorAll(".btnGuardarCanchaTorneo").forEach((btn) => btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const tcId = btn.dataset.tc;
      const diasElegidos = Array.from(document.querySelectorAll(`.chkDiaCte-${tcId}:checked`)).map((c) => Number(c.value));
      const { error } = await sb.from("torneo_canchas").update({
        dias_semana: diasElegidos.length ? diasElegidos : null,
        horarios_por_dia: leerHorariosPorDiaForm(`cteHorarios-${tcId}`)
      }).eq("id", tcId);
      if (error) { toast("Error: " + error.message); return; }
      toast("Días y horario de la cancha actualizados");
      refrescarTrasAccionGestion();
    } finally {
      btn.disabled = false;
    }
  }));
  document.querySelectorAll(".btnQuitarCanchaTorneo").forEach((a) => a.addEventListener("click", async (ev) => {
    ev.preventDefault();
    if (a.dataset.busy) return;
    a.dataset.busy = "1";
    try {
      await sb.from("torneo_canchas").delete().eq("id", a.dataset.tc);
      toast("Cancha quitada del torneo");
      refrescarTrasAccionGestion();
    } finally {
      delete a.dataset.busy;
    }
  }));
  llenarSelect(document.getElementById("dtSelectCancha"), cacheCanchas, (c) => {
    const complejo = cacheComplejos.find((x) => x.id === c.complejo_id);
    return `${c.nombre} (${complejo ? complejo.nombre : "?"})`;
  });

  const [{ data: insc }, { data: parejas }, { data: partidos }] = await Promise.all([
    sb.rpc("inscriptos_publicos", { p_torneo_id: id }),
    sb.rpc("parejas_publicas", { p_torneo_id: id }),
    sb.rpc("partidos_publicos", { p_torneo_id: id })
  ]);
  // así el admin ve de un vistazo, junto a cada jugador, si avisó horarios en
  // los que no puede jugar — mismo cálculo que usa el armado automático.
  const dispPorJugador = await jugadoresDisponibilidad((insc || []).map((i) => i.jugador_id), id);
  renderParejasEn("admParejas", "admSinPareja", insc || [], parejas || [], true, dispPorJugador);

  const conHorario = (partidos || []).filter((p) => p.horario).length;
  const pctCalendario = (partidos || []).length ? Math.round((conHorario / partidos.length) * 100) : 0;
  document.getElementById("admDashboardStats").innerHTML = statsRingHtml([
    [(parejas || []).length, "Parejas"],
    [categoriasGestion.length, "Categorías"],
    [(partidos || []).length, "Partidos"],
    [(tc || []).length, "Canchas"],
    [`${pctCalendario}%`, "Calendario armado"]
  ]);
  renderDiagnosticoTorneo(insc || [], parejas || [], partidos || []);

  await cargarBloqueosCancha();
  await cargarFotosTorneoAdmin();
  renderPartidosAdmin(partidos || [], tc || [], parejas || []);
}

// Chequeo rápido de salud del torneo, pedido por el club para poder confirmar
// "¿quedó bien armado?" sin tener que revisar categoría por categoría a mano.
// Cada fila es una situación real que puede pasar sin que rompa nada (una
// pareja sin partido, alguien anotado sin pareja, un partido sin horario) pero
// que el club quiere poder ver de un vistazo antes de avisarle a la gente.
function renderDiagnosticoTorneo(insc, parejas, partidos) {
  const cont = document.getElementById("admDiagnostico");
  if (!cont) return;
  const parejasActivas = parejas.filter((p) => p.estado !== "rechazada");
  const enPartido = new Set(partidos.flatMap((p) => [p.pareja1_id, p.pareja2_id]));
  const parejasSinPartido = parejasActivas.filter((p) => !enPartido.has(p.id));
  const enPareja = new Set(parejasActivas.flatMap((p) => [p.jugador1_id, p.jugador2_id]));
  const inscSinPareja = insc.filter((i) => i.estado !== "cancelada" && i.estado !== "rechazada" && !enPareja.has(i.jugador_id));
  const parejasPendientes = parejasActivas.filter((p) => p.estado === "pendiente");
  const partidosSinHorario = partidos.filter((p) => !p.horario && p.estado !== "jugado");

  const filas = [];
  if (parejasSinPartido.length) filas.push(`⚠️ ${parejasSinPartido.length} pareja${parejasSinPartido.length === 1 ? "" : "s"} sin ningún partido asignado: ${parejasSinPartido.map((p) => `${escapeHtml(p.jugador1_nombre)} / ${escapeHtml(p.jugador2_nombre)} (${p.categoria || "sin categoría"})`).join(", ")} — generá el fixture de esa categoría.`);
  if (inscSinPareja.length) filas.push(`⚠️ ${inscSinPareja.length} anotado${inscSinPareja.length === 1 ? "" : "s"} sin pareja todavía: ${inscSinPareja.map((i) => `${escapeHtml(i.nombre)} ${escapeHtml(i.apellido)}`).join(", ")} — no puede jugar hasta que tenga con quién.`);
  if (parejasPendientes.length) filas.push(`⚠️ ${parejasPendientes.length} pareja${parejasPendientes.length === 1 ? "" : "s"} pendiente${parejasPendientes.length === 1 ? "" : "s"} de confirmar (todavía no revisaste el pago): ${parejasPendientes.map((p) => `${escapeHtml(p.jugador1_nombre)} / ${escapeHtml(p.jugador2_nombre)}`).join(", ")}.`);
  if (partidosSinHorario.length) filas.push(`⚠️ ${partidosSinHorario.length} partido${partidosSinHorario.length === 1 ? "" : "s"} todavía sin cancha/horario — usá "Generar calendario" o asignalo a mano.`);

  cont.innerHTML = filas.length === 0
    ? '<p class="match-meta">✅ Todo en orden: todas las parejas tienen partido, nadie quedó sin pareja y no hay partidos sueltos sin horario.</p>'
    : filas.map((f) => `<p class="match-meta" style="margin-bottom:6px">${f}</p>`).join("");
}

// Borra un torneo completo (inscripciones, parejas, partidos, canchas
// asignadas, bloqueos y auspiciantes de ese torneo se van con él por el "on
// delete cascade" ya definido en el schema — no hay que borrar nada aparte a
// mano). Pide escribir el nombre exacto del torneo como segunda confirmación
// porque es irreversible y se lleva puestos resultados ya jugados.
document.getElementById("btnBorrarTorneo").addEventListener("click", async () => {
  const btn = document.getElementById("btnBorrarTorneo");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  if (!torneoGestionId || !torneoGestionData) return;
  const nombre = torneoGestionData.nombre;
  const escrito = prompt(`Esto borra "${nombre}" para siempre: inscripciones, parejas, partidos y resultados ya jugados. No se puede deshacer.\n\nEscribí el nombre del torneo para confirmar:`);
  if (escrito === null) return;
  if (escrito.trim() !== nombre.trim()) { toast("No coincide el nombre — no se borró nada."); return; }

  const { data, error } = await sb.from("torneos").delete().eq("id", torneoGestionId).select();
  if (error) { toast("Error al borrar: " + error.message); return; }
  if (!data || data.length === 0) {
    toast(`No se pudo borrar "${nombre}" — no tenés permisos de administrador o ya estaba borrado.`);
    return;
  }

  toast(`"${nombre}" borrado`);
  adminFocoTorneoActivo = false;
  torneoGestionId = null;
  torneoGestionData = null;
  document.getElementById("admSelectTorneoGestion").value = "";
  document.getElementById("admBtnVolverConfigGeneral").style.display = "none";
  mostrarSeccionTorneoSelector(); // vuelve al selector suelto, no a Configuración general -- venía de gestionar ESTE torneo
  await cargarTorneos();
  avisarActualizacionEnVivo();
  } finally {
    btn.disabled = false;
  }
});

// ---------- editar torneo (nombre, sede, categorías, fechas, costo, flyer) ----------
document.getElementById("admBtnMostrarEditarTorneo").addEventListener("click", async () => {
  if (!torneoGestionData) return;
  const t = torneoGestionData;
  if (cacheCategorias.length === 0) await cargarCategorias();
  document.getElementById("teNombre").value = t.nombre;
  document.getElementById("teComplejo").value = t.complejo_id || "";
  document.getElementById("teDuracion").value = t.duracion_minutos || 90;
  document.getElementById("teFechaInicio").value = t.fecha_inicio;
  document.getElementById("teFechaFin").value = t.fecha_fin || t.fecha_inicio;
  document.getElementById("teCosto").value = t.costo || "";
  const diasActuales = new Set(t.dias_semana || []);
  document.querySelectorAll(".chkDiaTorneoEdit").forEach((chk) => (chk.checked = diasActuales.has(Number(chk.value))));
  document.getElementById("teHoraDesde").value = t.hora_desde ? t.hora_desde.slice(0, 5) : "";
  document.getElementById("teHoraHasta").value = t.hora_hasta ? t.hora_hasta.slice(0, 5) : "";
  renderHorariosPorDiaForm("teHorariosPorDiaForm", "chkDiaTorneoEdit", t.horarios_por_dia || {});
  document.getElementById("teFaseGruposFormato").value = t.fase_grupos_formato || "grupos";
  document.getElementById("teTamanoGrupo").value = t.tamano_grupo || 3;
  document.getElementById("teAvanzanPorGrupo").value = t.avanzan_por_grupo || 2;
  toggleGrupoConfigRow("teFaseGruposFormato", "teGrupoConfigRow");
  document.getElementById("teFlyerArchivo").value = "";
  const categoriasActuales = new Set((t.torneo_categorias || []).map((c) => c.categoria));
  document.querySelectorAll(".chkTorneoCategoriaEdit").forEach((chk) => (chk.checked = categoriasActuales.has(chk.value)));

  // una vez que alguna categoría ya tiene calendario armado (aunque sea "de
  // prueba", todavía sin publicar), tocar fecha/horario/formato/categorías
  // puede desincronizar los partidos ya programados con lo que el torneo dice
  // — se bloquean esos campos (nombre/sede/costo siguen libres).
  const hayCalendarioArmado = (t.torneo_categorias || []).some((c) => c.estado_fase === "calendario_borrador" || c.estado_fase === "calendario_confirmado" || c.estado_fase === "finalizada");
  document.getElementById("teAvisoBloqueo").style.display = hayCalendarioArmado ? "block" : "none";
  ["teFechaInicio", "teFechaFin", "teDuracion", "teHoraDesde", "teHoraHasta", "teFaseGruposFormato", "teTamanoGrupo", "teAvanzanPorGrupo"]
    .forEach((id) => { document.getElementById(id).disabled = hayCalendarioArmado; });
  document.querySelectorAll(".chkDiaTorneoEdit, .chkTorneoCategoriaEdit").forEach((chk) => { chk.disabled = hayCalendarioArmado; });
  document.querySelectorAll("#teHorariosPorDiaForm input").forEach((inp) => { inp.disabled = hayCalendarioArmado; });

  const card = document.getElementById("editarTorneoCard");
  card.style.display = "block";
  card.scrollIntoView({ behavior: "smooth", block: "start" });
});
document.getElementById("btnCancelarEditarTorneo").addEventListener("click", () => {
  document.getElementById("editarTorneoCard").style.display = "none";
});
document.getElementById("btnGuardarTorneo").addEventListener("click", async () => {
  const btn = document.getElementById("btnGuardarTorneo");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  if (!isAdmin || !torneoGestionId) return;
  const nombre = document.getElementById("teNombre").value.trim();
  const complejoId = document.getElementById("teComplejo").value;
  const fechaInicio = document.getElementById("teFechaInicio").value;
  if (!nombre || !fechaInicio) { toast("Completá al menos nombre y fecha de inicio"); return; }

  const categoriasElegidas = Array.from(document.querySelectorAll(".chkTorneoCategoriaEdit:checked")).map((c) => c.value);
  if (categoriasElegidas.length === 0) { toast("Elegí al menos una categoría"); return; }

  let flyerUrl = torneoGestionData?.flyer_url || null;
  const archivo = document.getElementById("teFlyerArchivo").files[0];
  if (archivo) {
    const path = `${Date.now()}-${archivo.name}`;
    const { error: upErr } = await sb.storage.from("flyers").upload(path, archivo);
    if (upErr) { toast("Error subiendo el flyer: " + upErr.message); return; }
    const { data: pub } = sb.storage.from("flyers").getPublicUrl(path);
    flyerUrl = pub.publicUrl;
  }

  const costoTxt = document.getElementById("teCosto").value.trim();
  const diasElegidosEdit = Array.from(document.querySelectorAll(".chkDiaTorneoEdit:checked")).map((c) => Number(c.value));
  const cambios = {
    nombre,
    complejo_id: complejoId || null,
    fecha_inicio: fechaInicio,
    fecha_fin: document.getElementById("teFechaFin").value || fechaInicio,
    flyer_url: flyerUrl,
    costo: costoTxt ? Number(costoTxt) : null,
    duracion_minutos: Number(document.getElementById("teDuracion").value) || 90,
    dias_semana: diasElegidosEdit.length ? diasElegidosEdit : null,
    hora_desde: document.getElementById("teHoraDesde").value || null,
    hora_hasta: document.getElementById("teHoraHasta").value || null,
    horarios_por_dia: leerHorariosPorDiaForm("teHorariosPorDiaForm"),
    fase_grupos_formato: document.getElementById("teFaseGruposFormato").value,
    tamano_grupo: Number(document.getElementById("teTamanoGrupo").value) || 3,
    avanzan_por_grupo: Number(document.getElementById("teAvanzanPorGrupo").value) || 2
  };
  const { error } = await sb.from("torneos").update(cambios).eq("id", torneoGestionId);
  if (error) { toast("Error: " + error.message); return; }

  // reemplaza las categorías del torneo por las que quedaron tildadas
  await sb.from("torneo_categorias").delete().eq("torneo_id", torneoGestionId);
  await sb.from("torneo_categorias").insert(categoriasElegidas.map((categoria) => ({ torneo_id: torneoGestionId, categoria })));

  toast("Torneo actualizado");
  document.getElementById("editarTorneoCard").style.display = "none";
  cargarTorneos();
  cargarInicio();
  refrescarTrasAccionGestion();
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btnAgregarCanchaTorneo").addEventListener("click", async () => {
  const btn = document.getElementById("btnAgregarCanchaTorneo");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  const canchaId = document.getElementById("dtSelectCancha").value;
  if (!canchaId || !torneoGestionId) return;
  const diasElegidos = Array.from(document.querySelectorAll(".chkDiaCanchaNueva:checked")).map((c) => Number(c.value));
  const { error } = await sb.from("torneo_canchas").insert({
    torneo_id: torneoGestionId,
    cancha_id: canchaId,
    dias_semana: diasElegidos.length ? diasElegidos : null,
    horarios_por_dia: leerHorariosPorDiaForm("canchaHorariosPorDiaNuevaForm")
  });
  if (error) { toast("Esa cancha ya está asignada u ocurrió un error"); return; }
  toast("Cancha agregada al torneo");
  document.querySelectorAll(".chkDiaCanchaNueva").forEach((c) => (c.checked = false));
  renderHorariosPorDiaForm("canchaHorariosPorDiaNuevaForm", "chkDiaCanchaNueva");
  refrescarTrasAccionGestion();
  } finally {
    btn.disabled = false;
  }
});

// Inscribe una pareja completa a mano (ej: dos amigos que se lo pidieron directo al club).
// Siempre entran los dos juntos, nunca un jugador suelto — así nunca queda nadie sin pareja.
document.getElementById("btnInscribir").addEventListener("click", async () => {
  const btn = document.getElementById("btnInscribir");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  const in1 = document.getElementById("dtSelectJugador1");
  const in2 = document.getElementById("dtSelectJugador2");
  const jugador1Id = idDesdeDatalist("dtSelectJugador1");
  const jugador2Id = idDesdeDatalist("dtSelectJugador2");
  const categoria = document.getElementById("dtSelectCategoriaInscribir").value;
  if (!torneoGestionId) return;
  // valida que lo tipeado sea de verdad un jugador de la lista (y no texto
  // suelto que quedó a medio escribir sin elegir ninguna opción)
  if ((in1.value.trim() && !jugador1Id) || (in2.value.trim() && !jugador2Id)) {
    toast("Elegí un jugador de la lista que aparece al escribir (no quedó seleccionado ninguno)");
    return;
  }
  if (!jugador1Id || !jugador2Id) { toast("Buscá y elegí los dos jugadores"); return; }
  if (jugador1Id === jugador2Id) { toast("Elegí dos jugadores distintos"); return; }
  if (!categoria) { toast("Elegí en qué categoría los inscribís"); return; }
  // lo inscribe el admin a mano, así que queda confirmado directo (no hace falta el paso
  // de "pendiente" que sí aplica cuando se anotan ellos mismos desde la app)
  const { error: e1 } = await sb.from("inscripciones").insert({ torneo_id: torneoGestionId, jugador_id: jugador1Id, categoria, estado: "confirmada" });
  const { error: e2 } = await sb.from("inscripciones").insert({ torneo_id: torneoGestionId, jugador_id: jugador2Id, categoria, estado: "confirmada" });
  if (e1 || e2) { toast("Alguno de los dos ya está inscripto u ocurrió un error"); return; }
  const { error: e3 } = await sb.from("parejas").insert({ torneo_id: torneoGestionId, jugador1_id: jugador1Id, jugador2_id: jugador2Id, categoria });
  if (e3) { toast("Se inscribieron pero no se pudo armar la pareja: " + e3.message); refrescarTrasAccionGestion(); return; }
  toast("Pareja inscripta");
  in1.value = "";
  in2.value = "";
  avisarActualizacionEnVivo();
  refrescarTrasAccionGestion();
  } finally {
    btn.disabled = false;
  }
});

// ---------- sacar a alguien del torneo (ej: no pagó) — solo admin ----------
// se usa solo con gente sin pareja todavía (a quien ya tiene pareja primero hay
// que separarlo con borrarPareja, así nunca se borra a alguien "de arrastre")
async function borrarInscripcion(jugadorId, nombreJugador) {
  const { error } = await sb.from("inscripciones").delete().eq("torneo_id", torneoGestionId).eq("jugador_id", jugadorId);
  if (error) { toast("Error: " + error.message); return; }
  toast(`Se sacó a ${nombreJugador} del torneo`);
  avisarActualizacionEnVivo();
  refrescarTrasAccionGestion();
}

// ---------- admin confirma que la pareja pagó y que la categoría es correcta ----------
// (recién ahí la inscripción de los dos pasa de "pendiente" a "confirmada")
async function confirmarPareja(jugador1Id, jugador2Id) {
  const { error: e1 } = await sb.from("inscripciones").update({ estado: "confirmada" }).eq("torneo_id", torneoGestionId).eq("jugador_id", jugador1Id);
  const { error: e2 } = await sb.from("inscripciones").update({ estado: "confirmada" }).eq("torneo_id", torneoGestionId).eq("jugador_id", jugador2Id);
  if (e1 || e2) { toast("Error: " + (e1 || e2).message); return; }
  toast("Inscripción confirmada");
  avisarActualizacionEnVivo();
  refrescarTrasAccionGestion();
}

// Borra la pareja completa del torneo: los dos jugadores quedan totalmente
// desinscriptos (no "sin pareja" sueltos) — para volver a anotarse tienen que
// hacerlo de nuevo, siempre de a dos.
async function borrarPareja(parejaId, nombrePareja, jugador1Id, jugador2Id) {
  const { data: partidosPareja } = await sb.from("partidos").select("id, estado")
    .eq("torneo_id", torneoGestionId)
    .or(`pareja1_id.eq.${parejaId},pareja2_id.eq.${parejaId}`);
  if ((partidosPareja || []).some((p) => p.estado === "jugado")) {
    toast(`${nombrePareja} ya jugó partidos en este torneo — sacale el resultado a mano primero`);
    return;
  }
  // borrar la pareja borra también en cascada sus partidos programados sin
  // jugar (fixture y/o calendario) — es destructivo y no se puede deshacer,
  // así que se avisa antes en vez de hacerlo silencioso.
  const programados = (partidosPareja || []).length;
  if (programados > 0 && !confirm(`${nombrePareja} tiene ${programados} partido(s) programado(s) sin jugar. Al sacarla del torneo esos partidos también se borran. ¿Confirmás?`)) return;
  const { error } = await sb.from("parejas").delete().eq("id", parejaId); // borra también sus partidos pendientes (en cascada)
  if (error) { toast("Error: " + error.message); return; }
  await sb.from("inscripciones").delete().eq("torneo_id", torneoGestionId).eq("jugador_id", jugador1Id);
  await sb.from("inscripciones").delete().eq("torneo_id", torneoGestionId).eq("jugador_id", jugador2Id);
  toast(`Se sacó del torneo a la pareja ${nombrePareja}`);
  avisarActualizacionEnVivo();
  refrescarTrasAccionGestion();
}

// ---------- admin rechaza una inscripción pendiente (con motivo) ----------
// A diferencia de "Confirmar", rechazar no borra nada: la fila queda con
// estado 'rechazada' + motivo, para que el jugador entienda qué pasó (y para
// no perder el historial, mismo criterio que "cancelada" — ver schema.sql).
async function rechazarPareja(jugador1Id, jugador2Id) {
  const motivo = prompt("¿Por qué se rechaza esta inscripción? (se le va a mostrar al jugador)");
  if (motivo === null) return; // canceló el prompt
  const { error: e1 } = await sb.from("inscripciones").update({ estado: "rechazada", motivo_rechazo: motivo || null }).eq("torneo_id", torneoGestionId).eq("jugador_id", jugador1Id);
  const { error: e2 } = await sb.from("inscripciones").update({ estado: "rechazada", motivo_rechazo: motivo || null }).eq("torneo_id", torneoGestionId).eq("jugador_id", jugador2Id);
  if (e1 || e2) { toast("Error: " + (e1 || e2).message); return; }
  toast("Inscripción rechazada");
  avisarActualizacionEnVivo();
  refrescarTrasAccionGestion();
}

// ---------- armar partidos automático ----------
// Orden de fases que el torneo va recorriendo: cada tanda de partidos
// generada (fase de grupos o "Generar siguiente fase") queda etiquetada
// con la fase que le toca — el admin ya no elige la ronda a mano al
// cargar el resultado, así el cuadro respeta el orden real del torneo.
// Nombre de ronda según la cantidad de parejas que entran a jugarla — así un
// torneo con 4 parejas clasificadas pasa directo a "Semifinal" en vez de forzar
// "Dieciseisavos" como si siempre hubiera 32. Si la cantidad no es una potencia
// de 2 conocida (grupos irregulares), usa un nombre genérico en vez de inventar.
const NOMBRES_FASE_POR_CANTIDAD = { 32: "Dieciseisavos", 16: "Octavos", 8: "Cuartos", 4: "Semifinal", 2: "Final" };
function nombreFasePorCantidadEquipos(n) {
  return NOMBRES_FASE_POR_CANTIDAD[n] || `Ronda de ${n}`;
}

// Días del torneo a considerar para el armado automático: si el admin marcó
// días de la semana puntuales (ej: jueves/viernes/sábado) en Crear/Editar
// torneo, sólo se usan esos días dentro del rango de fechas; si no marcó
// ninguno, se usa el rango completo como antes.
function fechasDelTorneo(torneo) {
  const fechas = [];
  const inicio = new Date(torneo.fecha_inicio + "T00:00:00");
  const fin = new Date((torneo.fecha_fin || torneo.fecha_inicio) + "T00:00:00");
  const dias = torneo.dias_semana && torneo.dias_semana.length ? new Set(torneo.dias_semana) : null;
  for (let d = new Date(inicio); d <= fin; d.setDate(d.getDate() + 1)) {
    if (!dias || dias.has(d.getDay())) fechas.push(new Date(d));
  }
  return fechas;
}

// Ventana horaria del torneo para armar el calendario. Si el torneo tiene horarios
// distintos por día (ej: viernes de noche, sábado y domingo desde la mañana —
// horarios_por_dia, cargado en Crear/Editar torneo), devuelve un mapa {diaSemana:
// {desde,hasta}} en minutos; asignarHorarios (matching.js) usa el de cada fecha según
// su día de semana, y cae al horario por defecto en los días que no tengan uno propio.
// Si no hay horarios por día cargados, se mantiene el comportamiento de siempre: una
// sola ventana para todo el torneo.
function ventanaDelTorneo(torneo) {
  const porDefecto = torneo.hora_desde && torneo.hora_hasta
    ? { desde: horaAMinutos(torneo.hora_desde), hasta: horaAMinutos(torneo.hora_hasta) }
    : null;
  const porDia = torneo.horarios_por_dia;
  if (!porDia || Object.keys(porDia).length === 0) return porDefecto;

  const mapa = {};
  (torneo.dias_semana && torneo.dias_semana.length ? torneo.dias_semana : [0, 1, 2, 3, 4, 5, 6]).forEach((dia) => {
    const v = porDia[dia] || porDia[String(dia)];
    mapa[dia] = v ? { desde: horaAMinutos(v.desde), hasta: horaAMinutos(v.hasta) } : porDefecto;
  });
  return mapa;
}

// Igual que ventanaDelTorneo, pero para UNA cancha puntual del torneo (ver
// torneo_canchas.dias_semana/horarios_por_dia): un predio puede jugar solo
// algunos días y/o tener un horario propio distinto al general (ej: abre
// más tarde que el resto). Devuelve una función (día de semana -> ventana):
//  - { cerrado: true } si esa cancha directamente no juega ese día (dias_semana
//    no lo incluye) — a diferencia de "sin restricción", esto SÍ es información
//    nueva que hay que mostrar en la grilla.
//  - { desde, hasta } en minutos si hay una ventana (propia de la cancha, o si
//    no tiene, la del torneo para ese día).
//  - null si no hay ninguna restricción cargada (torneo sin horario tampoco) —
//    se mantiene el comportamiento de siempre: sin límite, todo disponible.
function ventanaDeCancha(tc, torneo) {
  const diasHabilitados = tc.dias_semana && tc.dias_semana.length ? new Set(tc.dias_semana) : null;
  const ventanaTorneo = ventanaDelTorneo(torneo);
  const propiaPorDia = tc.horarios_por_dia;
  return (dia) => {
    if (diasHabilitados && !diasHabilitados.has(dia)) return { cerrado: true };
    if (propiaPorDia && Object.keys(propiaPorDia).length) {
      const v = propiaPorDia[dia] || propiaPorDia[String(dia)];
      if (v) return { desde: horaAMinutos(v.desde), hasta: horaAMinutos(v.hasta) };
    }
    if (!ventanaTorneo) return null;
    return (typeof ventanaTorneo.desde === "number" ? ventanaTorneo : ventanaTorneo[dia]) || null;
  };
}

// Trae los horarios BLOQUEADOS de cada jugador para un torneo: los generales
// de su perfil (torneo_id null, aplican siempre) más los puntuales que haya
// cargado para ESTE torneo puntualmente — combinados, ya que ambos restan
// disponibilidad por igual a la hora de buscar un horario común.
async function jugadoresDisponibilidad(jugadorIds, torneoId) {
  if (!jugadorIds || jugadorIds.length === 0) return {};
  const { data: dispRows } = await sb
    .from("disponibilidad")
    .select("*")
    .in("jugador_id", jugadorIds)
    .or(`torneo_id.is.null,torneo_id.eq.${torneoId}`);
  const disponibilidadPorJugador = {};
  (dispRows || []).forEach((d) => {
    if (!disponibilidadPorJugador[d.jugador_id]) disponibilidadPorJugador[d.jugador_id] = [];
    disponibilidadPorJugador[d.jugador_id].push(d);
  });
  return disponibilidadPorJugador;
}

// Divide las parejas de una categoría en grupos chicos según el tamaño
// configurado en el torneo. Si el último grupo queda con una sola pareja
// suelta (sin nadie contra quién jugar), se la suma al grupo anterior en
// vez de dejarla afuera.
function armarGruposDeParejas(parejasCategoria, tamanoGrupo) {
  const gruposArr = [];
  for (let i = 0; i < parejasCategoria.length; i += tamanoGrupo) gruposArr.push(parejasCategoria.slice(i, i + tamanoGrupo));
  if (gruposArr.length > 1 && gruposArr[gruposArr.length - 1].length === 1) {
    gruposArr[gruposArr.length - 2].push(...gruposArr.pop());
  }
  return gruposArr;
}

// Un badge por categoría con su fase actual, para que el admin sepa de un
// vistazo qué falta: si el calendario ya está armado "de prueba" pero
// todavía no se publicó, se lo remarca en naranja para que no se olvide de
// apretar "Publicar calendario".
const ETIQUETA_ESTADO_FASE = {
  sin_fixture: "sin fixture",
  fixture_generado: "fixture armado, falta calendario",
  calendario_borrador: "calendario de prueba — sin publicar",
  calendario_confirmado: "calendario publicado ✅",
  finalizada: "finalizada 🏆"
};
function renderEstadoCategorias(torneoCategorias) {
  const cont = document.getElementById("admEstadoCategorias");
  if (!cont) return;
  cont.innerHTML = torneoCategorias.map((c) => {
    const clase = c.estado_fase === "calendario_borrador" ? "badge orange" : "badge";
    const etiqueta = ETIQUETA_ESTADO_FASE[c.estado_fase] || c.estado_fase;
    return `<span class="${clase}" style="margin:0 6px 6px 0">${c.categoria}: ${etiqueta}</span>`;
  }).join("");
}

// Arma (e inserta) el FIXTURE de UNA categoría: quién juega contra quién,
// SIN asignarle todavía cancha ni horario — eso es un paso aparte
// (generarCalendarioParaCategoria), para no perder cruces que no encuentren
// hueco en el mismo acto en que se decide quién juega contra quién. `entrada`
// es {parejas: [...]} para modo eliminación directa, o {grupos: [[...], ...]}
// para fase de grupos.
async function generarFixtureParaGrupo(entrada, categoria, ronda, torneo) {
  const cruces = armarCruces({ parejas: entrada.parejas, grupos: entrada.grupos });
  if (cruces.length === 0) return { generados: 0 };
  const filas = cruces.map((c) => ({
    torneo_id: torneo.id, ronda, categoria, grupo: c.grupo,
    pareja1_id: c.pareja1.id, pareja2_id: c.pareja2.id, estado: "programado"
  }));
  const { error } = await sb.from("partidos").insert(filas);
  if (error) { toast(`Error armando ${categoria}: ` + error.message); return { generados: 0 }; }
  await sb.from("torneo_categorias").update({ estado_fase: "fixture_generado" }).eq("torneo_id", torneo.id).eq("categoria", categoria);
  return { generados: filas.length };
}

// Suma, por pareja, el puntos_ranking de sus dos jugadores EN ESA CATEGORÍA
// (ranking_categoria) — es el criterio de seedeo que pidió el club ("la
// pareja que más puntos suman"). Una pareja sin ningún resultado cargado
// todavía en esa categoría queda en 0 (ni cabeza de serie ni favorecida).
async function puntosRankingPorPareja(parejas, categoria) {
  const jugadorIds = [...new Set(parejas.flatMap((p) => [p.jugador1_id, p.jugador2_id]))];
  const { data: rk } = await sb.from("ranking_categoria").select("jugador_id, puntos_ranking").eq("categoria", categoria).in("jugador_id", jugadorIds);
  const puntosPorJugador = Object.fromEntries((rk || []).map((r) => [r.jugador_id, Number(r.puntos_ranking) || 0]));
  return parejas.map((p) => ({ ...p, puntos: (puntosPorJugador[p.jugador1_id] || 0) + (puntosPorJugador[p.jugador2_id] || 0) }));
}

// Arma (e inserta) el fixture de UNA categoría en el formato "cuadro de
// zonas" propio del club (torneo.fase_grupos_formato === 'cuadro_zonas'):
// arma las zonas por ranking (armarZonasPorRanking) y crea el partido de
// cada zona. Una zona que quedó con una sola pareja (total impar) nace ya
// "jugada" (bye) para que el resto del cuadro no tenga que tratar ese caso
// aparte — ver resolverRondaCuadro, que ya sabe seguir de largo cuando el
// perdedor de una zona no existe.
async function generarFixtureCuadroZonas(categoria, parejasCategoria, torneo) {
  const n = Math.ceil(parejasCategoria.length / 2);
  if (!PLANTILLAS_CUADRO[n]) {
    toast(`${categoria}: el cuadro del club solo cubre entre 5 y 28 parejas (esta categoría tiene ${parejasCategoria.length}) — para esta cantidad usá "Grupos" o "Eliminación directa".`);
    return { generados: 0 };
  }
  const parejasConPuntos = await puntosRankingPorPareja(parejasCategoria, categoria);
  const zonas = armarZonasPorRanking(parejasConPuntos);
  const filas = zonas.map((zona, i) => {
    const slot = "Z" + (i + 1);
    if (zona.length === 1) {
      return { torneo_id: torneo.id, ronda: "Zona", categoria, slot_cuadro: slot, pareja1_id: zona[0].id, pareja2_id: null, estado: "jugado", ganador_pareja_id: zona[0].id };
    }
    return { torneo_id: torneo.id, ronda: "Zona", categoria, slot_cuadro: slot, pareja1_id: zona[0].id, pareja2_id: zona[1].id, estado: "programado" };
  });
  const { error } = await sb.from("partidos").insert(filas);
  if (error) { toast(`Error armando ${categoria}: ` + error.message); return { generados: 0 }; }
  await sb.from("torneo_categorias").update({ estado_fase: "fixture_generado" }).eq("torneo_id", torneo.id).eq("categoria", categoria);
  return { generados: filas.length };
}

// Nombre de ronda "legible" (y el que usa puntos_ronda para la bonificación
// de ranking) para cada clave de PLANTILLAS_CUADRO.
const RONDA_DISPLAY_CUADRO = { DIECISEISAVOS: "Dieciseisavos", OCTAVOS: "Octavos", CUARTOS: "Cuartos", SEMIFINAL: "Semifinal", FINAL: "Final" };

// Arma, si ya se puede, la SIGUIENTE ronda del cuadro de zonas de esta
// categoría (la primera de la plantilla que todavía no se armó). Si algún
// resultado de la ronda anterior sigue sin cargarse, no hace nada y avisa
// cuál falta. Se puede llamar de nuevo tantas veces como haga falta: cada
// vez arma una ronda más, hasta la final. Devuelve null si esta categoría no
// usa este formato (no tiene ningún partido con slot_cuadro todavía).
async function generarSiguienteRondaCuadro(categoria, torneoId) {
  const { data: partidos } = await sb.from("partidos").select("slot_cuadro, pareja1_id, pareja2_id, ganador_pareja_id, estado")
    .eq("torneo_id", torneoId).eq("categoria", categoria).not("slot_cuadro", "is", null);
  if (!partidos || partidos.length === 0) return null;

  const nZonas = partidos.filter((p) => p.slot_cuadro[0] === "Z").length;
  const plantilla = PLANTILLAS_CUADRO[nZonas];
  if (!plantilla) return null;

  const mapaSlots = {};
  partidos.forEach((p) => {
    if (p.estado !== "jugado" || !p.ganador_pareja_id) return;
    const perdedor = p.pareja2_id ? (p.ganador_pareja_id === p.pareja1_id ? p.pareja2_id : p.pareja1_id) : null;
    mapaSlots[p.slot_cuadro] = { ganador: p.ganador_pareja_id, perdedor };
  });

  const slotsYaArmados = new Set(partidos.map((p) => p.slot_cuadro));
  for (const nombreRonda of Object.keys(plantilla)) {
    const prefijo = nombreRonda[0]; // D, O, C, S o F
    if (plantilla[nombreRonda].some((_, i) => slotsYaArmados.has(prefijo + (i + 1)))) continue; // ya armada

    const resueltos = resolverRondaCuadro(plantilla[nombreRonda], prefijo, mapaSlots);
    if (!resueltos) return { esperando: RONDA_DISPLAY_CUADRO[nombreRonda] };
    if (resueltos.length === 0) return { generados: 0 };

    const filas = resueltos.map((r) => ({
      torneo_id: torneoId, categoria, ronda: RONDA_DISPLAY_CUADRO[nombreRonda], slot_cuadro: r.slot,
      pareja1_id: r.pareja1_id, pareja2_id: r.pareja2_id,
      estado: r.walkover ? "jugado" : "programado",
      ganador_pareja_id: r.walkover ? r.pareja1_id : null
    }));
    const { error } = await sb.from("partidos").insert(filas);
    if (error) { toast(`Error armando ${categoria}: ` + error.message); return { generados: 0 }; }
    await sb.from("torneo_categorias").update({ estado_fase: nombreRonda === "FINAL" ? "finalizada" : "fixture_generado" }).eq("torneo_id", torneoId).eq("categoria", categoria);
    return { generados: filas.length, ronda: RONDA_DISPLAY_CUADRO[nombreRonda] };
  }
  return { generados: 0, terminado: true };
}

// Busca cancha y horario para los partidos de una categoría que YA tienen
// fixture pero todavía no calendario (horario en null) y actualiza esas
// mismas filas (no inserta partidos nuevos). Encadena `ocupacionAcumulada`
// para no proponerle la misma cancha/horario a otra categoría del torneo.
// Los cruces que sigan sin hueco quedan como partidos reales con horario en
// null (reasignables a mano después), nunca se pierden.
async function generarCalendarioParaCategoria(torneoId, categoria, torneo, canchas, ocupacionAcumulada) {
  // los "bye" del cuadro de zonas (pareja impar) ya nacen "jugados" con
  // pareja2_id null y nunca necesitan horario — se descartan acá para no
  // mandarlos a asignarHorarios, y sobre todo para que ese null nunca llegue
  // a la lista de ids de abajo (ver el filter(Boolean) — un null ahí rompía
  // el .in() contra Supabase real y hacía que NINGUNA pareja se resolviera,
  // dejando la categoría entera sin calendario sin avisar del motivo).
  const { data: partidosDb } = await sb.from("partidos").select("*").eq("torneo_id", torneoId).eq("categoria", categoria).is("horario", null);
  const sinHorarioDb = (partidosDb || []).filter((p) => p.pareja1_id && p.pareja2_id);
  if (sinHorarioDb.length === 0) return { generados: 0, sinHorario: 0 };

  const parejaIds = [...new Set(sinHorarioDb.flatMap((p) => [p.pareja1_id, p.pareja2_id]).filter(Boolean))];
  const { data: parejasDb } = await sb.from("parejas").select("*").in("id", parejaIds);
  const parejaPorId = Object.fromEntries((parejasDb || []).map((p) => [p.id, p]));
  const cruces = sinHorarioDb
    .map((p) => ({ id: p.id, pareja1: parejaPorId[p.pareja1_id], pareja2: parejaPorId[p.pareja2_id], grupo: p.grupo }))
    .filter((c) => c.pareja1 && c.pareja2);
  if (cruces.length === 0) return { generados: 0, sinHorario: 0 };

  const jugadorIds = [...new Set(cruces.flatMap((c) => [c.pareja1.jugador1_id, c.pareja1.jugador2_id, c.pareja2.jugador1_id, c.pareja2.jugador2_id]))];
  const disponibilidadPorJugador = await jugadoresDisponibilidad(jugadorIds, torneo.id);

  const { partidosGenerados, sinHorario } = asignarHorarios({
    cruces,
    disponibilidadPorJugador,
    fechasDisponibles: fechasDelTorneo(torneo),
    canchas,
    duracionMinutos: torneo.duracion_minutos || 90,
    ventana: ventanaDelTorneo(torneo),
    partidosYaProgramados: ocupacionAcumulada,
    bloqueosPorCancha: bloqueosPorCanchaMapa() // respeta los bloqueos de cancha cargados en Administración
  });

  const idPorParejas = new Map(cruces.map((c) => [`${c.pareja1.id}-${c.pareja2.id}`, c.id]));
  for (const p of partidosGenerados) {
    const partidoId = idPorParejas.get(`${p.pareja1_id}-${p.pareja2_id}`);
    if (!partidoId) continue;
    await sb.from("partidos").update({ cancha_id: p.cancha_id, horario: p.horario }).eq("id", partidoId);
  }
  if (partidosGenerados.length > 0) {
    ocupacionAcumulada.push(...partidosGenerados);
    // "de prueba" primero: si esta categoría ya estaba publicada (una ronda
    // posterior a una que el público ya venía viendo), no la escondemos de
    // nuevo -- pero si es la primera vez que tiene calendario, queda en
    // borrador hasta que el admin la revise y apriete "Publicar calendario".
    const { data: catActual } = await sb.from("torneo_categorias").select("estado_fase").eq("torneo_id", torneoId).eq("categoria", categoria).maybeSingle();
    const yaPublicada = catActual && (catActual.estado_fase === "calendario_confirmado" || catActual.estado_fase === "finalizada");
    await sb.from("torneo_categorias").update({ estado_fase: yaPublicada ? "calendario_confirmado" : "calendario_borrador" }).eq("torneo_id", torneoId).eq("categoria", categoria);
  }
  return { generados: partidosGenerados.length, sinHorario: sinHorario.length };
}

// Calcula la tabla de posiciones de un grupo (todos los partidos ya jugados
// de un mismo número de grupo): partidos ganados primero, y como
// desempate, diferencia de sets y después diferencia de games.
function calcularTablaGrupo(partidosGrupo) {
  const stats = {};
  const asegurar = (id) => stats[id] || (stats[id] = { id, ganados: 0, setsFavor: 0, setsContra: 0, gamesFavor: 0, gamesContra: 0 });
  partidosGrupo.forEach((p) => {
    const e1 = asegurar(p.pareja1_id), e2 = asegurar(p.pareja2_id);
    if (p.ganador_pareja_id === p.pareja1_id) e1.ganados++;
    else if (p.ganador_pareja_id === p.pareja2_id) e2.ganados++;
    (p.sets || []).forEach((s) => {
      if (s.p1 > s.p2) { e1.setsFavor++; e2.setsContra++; } else if (s.p2 > s.p1) { e2.setsFavor++; e1.setsContra++; }
      e1.gamesFavor += s.p1; e1.gamesContra += s.p2;
      e2.gamesFavor += s.p2; e2.gamesContra += s.p1;
    });
  });
  return Object.values(stats).sort((a, b) =>
    b.ganados - a.ganados ||
    (b.setsFavor - b.setsContra) - (a.setsFavor - a.setsContra) ||
    (b.gamesFavor - b.gamesContra) - (a.gamesFavor - a.gamesContra)
  );
}

// Escribe torneo.estado='en_curso' la primera vez que alguna categoría llega
// a tener calendario, y 'finalizado' cuando TODAS las categorías del torneo
// llegan a 'finalizada'. Reemplaza a calcularTorneoDestacado() (que decide por
// fecha) como fuente de verdad de "¿está en curso?" para cualquier lugar que
// necesite saberlo de verdad en vez de estimarlo.
async function actualizarEstadoTorneoPorFases(torneoId) {
  const { data: cats } = await sb.from("torneo_categorias").select("estado_fase").eq("torneo_id", torneoId);
  if (!cats || cats.length === 0) return;
  const { data: t } = await sb.from("torneos").select("estado").eq("id", torneoId).single();
  if (!t || t.estado === "cancelado" || t.estado === "finalizado") return;
  if (cats.every((c) => c.estado_fase === "finalizada")) {
    await sb.from("torneos").update({ estado: "finalizado" }).eq("id", torneoId);
  } else if (
    (t.estado === "inscripcion" || t.estado === "inscripcion_cerrada") &&
    cats.some((c) => c.estado_fase === "calendario_confirmado" || c.estado_fase === "finalizada")
  ) {
    await sb.from("torneos").update({ estado: "en_curso" }).eq("id", torneoId);
  }
}

// Agrupa un array de {..., categoria} por su campo categoria (las sin
// categoría asignada todavía quedan juntas bajo "Sin categoría", para no
// perderlas de vista en vez de mezclarlas con otro grupo).
function agruparPorCategoria(lista) {
  const grupos = {};
  lista.forEach((x) => {
    const cat = x.categoria || "Sin categoría";
    if (!grupos[cat]) grupos[cat] = [];
    grupos[cat].push(x);
  });
  return grupos;
}

document.getElementById("btnArmarPartidos").addEventListener("click", async () => {
  const btn = document.getElementById("btnArmarPartidos");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  // parejas_publicas ya trae la categoría de cada pareja (la del torneo puntual
  // en el que se anotó) — un torneo puede tener varias categorías corriendo en
  // paralelo (ej: Damas y Caballeros, varias divisiones) y cada una arma su
  // propia fase de grupos por separado, nunca cruzadas entre sí. Este botón
  // solo arma QUIÉN juega contra quién — el horario y la cancha se asignan
  // aparte con "Generar calendario", una vez armado el fixture.
  if (!torneoGestionId) { toast("Elegí primero un torneo en gestión"); return; }
  const { data: parejasDb } = await sb.rpc("parejas_publicas", { p_torneo_id: torneoGestionId });
  if (!parejasDb || parejasDb.length < 2) { toast("Armá primero al menos 2 parejas"); return; }

  // evita duplicar partidos si se apreta el botón más de una vez: solo arma
  // fase de grupos para las parejas que todavía no tienen ningún partido
  const { data: partidosExistentes } = await sb.from("partidos").select("pareja1_id, pareja2_id").eq("torneo_id", torneoGestionId);
  const yaJuegan = new Set((partidosExistentes || []).flatMap((p) => [p.pareja1_id, p.pareja2_id]));
  const parejasSinPartido = parejasDb.filter((p) => !yaJuegan.has(p.id));
  if (parejasSinPartido.length < 2) { toast("Todas las parejas ya tienen un partido de fase de grupos asignado"); return; }

  // Solo entran al cuadro las parejas con el pago de LOS DOS jugadores
  // confirmado (✅ en "Inscripciones y parejas") -- pedido del club después
  // de que en el último torneo entrara gente que terminó pagando tarde. Las
  // que faltan quedan afuera del fixture (avisadas, no perdidas): en cuanto
  // se les confirme el pago, el próximo click de este botón las suma solas,
  // sin tocar nada de lo ya armado.
  const parejasPendientesPago = parejasSinPartido.filter((p) => !(p.jugador1_pago && p.jugador2_pago));
  const parejasListas = parejasSinPartido.filter((p) => p.jugador1_pago && p.jugador2_pago);
  if (parejasListas.length < 2) {
    toast(parejasPendientesPago.length
      ? `Ninguna pareja tiene el pago de los dos confirmado todavía (${parejasPendientesPago.length} pendiente${parejasPendientesPago.length === 1 ? "" : "s"}) — confirmalo en "Inscripciones y parejas" antes de armar el fixture.`
      : "Armá primero al menos 2 parejas");
    return;
  }

  const { data: torneo } = await sb.from("torneos").select("*").eq("id", torneoGestionId).single();
  const grupos = agruparPorCategoria(parejasListas);
  const formatoGrupos = torneo.fase_grupos_formato === "grupos";
  let totalGenerados = 0;
  for (const categoria of Object.keys(grupos)) {
    const parejasCategoria = grupos[categoria];
    if (parejasCategoria.length < 2) continue; // una sola pareja suelta en esa categoría: no hay con quién cruzarla todavía
    if (torneo.fase_grupos_formato === "cuadro_zonas") {
      const { generados } = await generarFixtureCuadroZonas(categoria, parejasCategoria, torneo);
      totalGenerados += generados;
      continue;
    }
    const entrada = formatoGrupos
      ? { grupos: armarGruposDeParejas(parejasCategoria, torneo.tamano_grupo || 3) }
      : { parejas: parejasCategoria };
    const { generados } = await generarFixtureParaGrupo(entrada, categoria, "Fase de grupos", torneo);
    totalGenerados += generados;
  }

  toast(`Se armó el fixture: ${totalGenerados} partidos (todavía sin cancha ni horario)${parejasPendientesPago.length ? ` — quedaron ${parejasPendientesPago.length} pareja(s) afuera por pago pendiente` : ""}. Ahora usá "Generar calendario".`);
  avisarActualizacionEnVivo();
  refrescarTrasAccionGestion();
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btnGenerarCalendario").addEventListener("click", async () => {
  const btn = document.getElementById("btnGenerarCalendario");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  // Toma los partidos que ya tienen fixture (pareja1/pareja2 definidos) pero
  // todavía no cancha/horario, y les busca un hueco — separado de "Armar
  // fixture" para que armar quién juega contra quién nunca pierda cruces por
  // no encontrarles horario en el mismo acto.
  if (!torneoGestionId) { toast("Elegí primero un torneo en gestión"); return; }
  const { data: torneo } = await sb.from("torneos").select("*").eq("id", torneoGestionId).single();
  const { data: tc } = await sb.from("torneo_canchas").select("dias_semana, horarios_por_dia, canchas(*)").eq("torneo_id", torneoGestionId);
  const canchas = (tc || []).filter((c) => c.canchas).map((c) => ({ ...c.canchas, dias_semana: c.dias_semana, horarios_por_dia: c.horarios_por_dia }));
  if (canchas.length === 0) { toast("Asigná al menos una cancha a este torneo"); return; }
  if (canchas.length === 1) toast("Ojo: este torneo tiene una sola cancha cargada — todos los partidos van a ir ahí. Agregá más canchas abajo si querés repartirlos.");

  const { data: partidosExistentes } = await sb.from("partidos").select("categoria, cancha_id, horario, pareja1_id, pareja2_id").eq("torneo_id", torneoGestionId);
  // las categorías más altas (mayor "orden" en la tabla categorias, ej: 1ra
  // por encima de 8va) se procesan primero para que tengan prioridad de
  // horario y cancha, tal como pidió el club — el resto simplemente se reparte
  // con lo que va quedando libre.
  if (cacheCategorias.length === 0) await cargarCategorias();
  const ordenCategoria = Object.fromEntries(cacheCategorias.map((c) => [c.nombre, c.orden]));
  const categoriasSinHorario = [...new Set((partidosExistentes || []).filter((p) => !p.horario).map((p) => p.categoria))]
    .sort((a, b) => (ordenCategoria[b] || 0) - (ordenCategoria[a] || 0));
  if (categoriasSinHorario.length === 0) { toast("No hay ningún fixture pendiente de calendario — generá el fixture primero"); return; }

  // resuelve pareja_id -> [jugador1_id, jugador2_id] de TODO el torneo (no solo
  // la categoría que se está por procesar) para poder marcar ocupados a los
  // jugadores de los partidos que ya tienen horario — sin esto, una pareja podía
  // terminar con dos partidos a la misma hora (bug reportado: un jugador ya
  // ocupado por un partido de otra categoría, u otra ronda ya calendarizada,
  // podía volver a proponerse libre).
  const yaProgramados = (partidosExistentes || []).filter((p) => p.horario);
  const parejaIdsOcupadas = [...new Set(yaProgramados.flatMap((p) => [p.pareja1_id, p.pareja2_id]).filter(Boolean))];
  const { data: parejasOcupadasDb } = parejaIdsOcupadas.length
    ? await sb.from("parejas").select("id, jugador1_id, jugador2_id").in("id", parejaIdsOcupadas)
    : { data: [] };
  const parejaOcupadaPorId = Object.fromEntries((parejasOcupadasDb || []).map((p) => [p.id, p]));
  const ocupacionAcumulada = yaProgramados.map((p) => {
    const j1 = parejaOcupadaPorId[p.pareja1_id], j2 = parejaOcupadaPorId[p.pareja2_id];
    const jugadores_ids = [j1?.jugador1_id, j1?.jugador2_id, j2?.jugador1_id, j2?.jugador2_id].filter(Boolean);
    return { cancha_id: p.cancha_id, horario: p.horario, jugadores_ids };
  });
  let totalGenerados = 0, totalSinHorario = 0;
  for (const categoria of categoriasSinHorario) {
    const { generados, sinHorario } = await generarCalendarioParaCategoria(torneoGestionId, categoria, torneo, canchas, ocupacionAcumulada);
    totalGenerados += generados;
    totalSinHorario += sinHorario;
  }

  await actualizarEstadoTorneoPorFases(torneoGestionId);
  toast(`Calendario de prueba armado: ${totalGenerados} partidos con horario` +
    (totalSinHorario ? `, ${totalSinHorario} quedaron sin horario común` : "") +
    `. Todavía no lo ven los jugadores — revisalo y apretá "Publicar calendario".`);
  avisarActualizacionEnVivo();
  refrescarTrasAccionGestion();
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btnPublicarCalendario").addEventListener("click", async () => {
  const btn = document.getElementById("btnPublicarCalendario");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  // Pasa de "de prueba" a público SOLO las categorías que están en borrador
  // -- no toca las que ya estaban publicadas ni las que todavía no tienen
  // calendario armado. Es la acción de "aprobar y publicar" que pidió el
  // club: separada a propósito de "Generar calendario" para poder revisar
  // (y reacomodar a mano en la planilla) antes de que se vuelva visible.
  if (!torneoGestionId) { toast("Elegí primero un torneo en gestión"); return; }
  const { data: cats } = await sb.from("torneo_categorias").select("categoria, estado_fase").eq("torneo_id", torneoGestionId);
  const enBorrador = (cats || []).filter((c) => c.estado_fase === "calendario_borrador");
  if (enBorrador.length === 0) { toast("No hay ningún calendario de prueba pendiente de publicar"); return; }

  const { error } = await sb.from("torneo_categorias").update({ estado_fase: "calendario_confirmado" })
    .eq("torneo_id", torneoGestionId).eq("estado_fase", "calendario_borrador");
  if (error) { toast("Error: " + error.message); return; }

  await actualizarEstadoTorneoPorFases(torneoGestionId);
  toast(`Calendario publicado ✅ (${enBorrador.map((c) => c.categoria).join(", ")}) — ya lo pueden ver los jugadores`);
  avisarActualizacionEnVivo();
  refrescarTrasAccionGestion();
  } finally {
    btn.disabled = false;
  }
});

// Por cada categoría del torneo, toma los ganadores de SU fase más avanzada
// ya jugada por completo y arma SU siguiente fase, nombrándola según cuántas
// parejas clasificaron (4 parejas -> Semifinal directo, sin pasar por
// Dieciseisavos/Octavos/Cuartos como si siempre hubiera un cuadro de 32), en
// vez de dejar que el admin elija la ronda de cada partido a mano. Categorías
// que van más atrasadas que otras (por ejemplo, todavía en fase de grupos
// mientras otra ya llegó a Cuartos) simplemente esperan su turno.
document.getElementById("btnGenerarSiguienteFase").addEventListener("click", async () => {
  const btn = document.getElementById("btnGenerarSiguienteFase");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  if (!torneoGestionId) { toast("Elegí primero un torneo en gestión"); return; }
  const { data: partidos } = await sb.rpc("partidos_publicos", { p_torneo_id: torneoGestionId });
  if (!partidos || partidos.length === 0) { toast("Todavía no armaste ningún partido"); return; }

  const { data: torneo } = await sb.from("torneos").select("*").eq("id", torneoGestionId).single();
  const grupos = agruparPorCategoria(partidos);
  const mensajes = [];
  let totalGenerados = 0;

  for (const categoria of Object.keys(grupos)) {
    if (torneo.fase_grupos_formato === "cuadro_zonas") {
      const { avisos } = await propagarCuadro(categoria, torneoGestionId);
      mensajes.push(...avisos);
      const resultado = await generarSiguienteRondaCuadro(categoria, torneoGestionId);
      if (!resultado) continue;
      if (resultado.esperando) mensajes.push(`${categoria}: faltan resultados para poder armar "${resultado.esperando}"`);
      else if (resultado.terminado) mensajes.push(`${categoria}: ya tiene a su campeón, no hay más fases para armar`);
      else if (resultado.generados > 0) { totalGenerados += resultado.generados; mensajes.push(`${categoria}: se armó "${resultado.ronda}" (${resultado.generados}) — generá el calendario para asignarle horario`); }
      continue;
    }
    const partidosCategoria = grupos[categoria];
    // la fase actual de esta categoría es la que se armó más recientemente
    // (no un orden fijo de nombres: la cantidad de rondas depende de cuántas
    // parejas hay, así que 4 parejas pasan directo a semifinal)
    const porRonda = {};
    partidosCategoria.forEach((p) => { const r = p.ronda || "Fase de grupos"; (porRonda[r] = porRonda[r] || []).push(p); });
    const faseActual = Object.keys(porRonda).sort((a, b) =>
      Math.max(...porRonda[b].map((p) => new Date(p.created_at).getTime())) -
      Math.max(...porRonda[a].map((p) => new Date(p.created_at).getTime()))
    )[0];
    const partidosFaseActual = porRonda[faseActual];
    const sinJugar = partidosFaseActual.filter((p) => p.estado !== "jugado");
    if (sinJugar.length > 0) { mensajes.push(`${categoria}: faltan ${sinJugar.length} resultado(s) de "${faseActual}"`); continue; }

    // si esta fase se armó en formato "grupos" (todos contra todos, nadie
    // eliminado), no hay un solo ganador por partido que valga: avanzan las
    // mejores `avanzan_por_grupo` parejas de cada grupo según la tabla de
    // posiciones. Si se armó en formato "eliminación", avanza directo el
    // ganador de cada partido, como antes.
    const esFaseDeGrupos = partidosFaseActual.some((p) => p.grupo != null);
    let ganadoresIds;
    if (esFaseDeGrupos) {
      const porGrupo = {};
      partidosFaseActual.forEach((p) => { (porGrupo[p.grupo] = porGrupo[p.grupo] || []).push(p); });
      const avanzan = torneo.avanzan_por_grupo || 2;
      ganadoresIds = Object.values(porGrupo).flatMap((partidosG) => calcularTablaGrupo(partidosG).slice(0, avanzan).map((s) => s.id));
    } else {
      ganadoresIds = [...new Set(partidosFaseActual.map((p) => p.ganador_pareja_id).filter(Boolean))];
    }
    if (ganadoresIds.length < 2) {
      if (ganadoresIds.length === 1) {
        mensajes.push(`${categoria}: ya tiene a su campeón, no hay más fases para armar`);
        await sb.from("torneo_categorias").update({ estado_fase: "finalizada" }).eq("torneo_id", torneoGestionId).eq("categoria", categoria);
      }
      continue;
    }
    if (ganadoresIds.length % 2 !== 0) { mensajes.push(`${categoria}: quedaron ${ganadoresIds.length} clasificados (número impar) — resolvé eso a mano`); continue; }

    const { data: parejasGanadoras } = await sb.from("parejas").select("*").in("id", ganadoresIds);
    const siguienteFase = nombreFasePorCantidadEquipos(ganadoresIds.length);
    const { generados } = await generarFixtureParaGrupo({ parejas: parejasGanadoras }, categoria, siguienteFase, torneo);
    if (generados > 0) { totalGenerados += generados; mensajes.push(`${categoria}: se armó el fixture de "${siguienteFase}" (${generados}) — generá el calendario para asignarle horario`); }
  }

  await actualizarEstadoTorneoPorFases(torneoGestionId);
  toast(mensajes.length ? mensajes.join(" · ") : "Ninguna categoría está lista para avanzar todavía");
  if (totalGenerados > 0) avisarActualizacionEnVivo();
  refrescarTrasAccionGestion();
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// SLOT (fecha + hora + cancha) — valor DERIVADO, no se guarda en ninguna
// tabla nueva: se calcula a partir de los partidos ya cargados, los
// bloqueos de cancha vigentes, y —si sintetizarVacios viene true (la
// planilla editable de Administración)— también los huecos libres de la
// ventana horaria del torneo, para poder asignarles un partido sin horario.
// ============================================================
function calcularSlots(partidos, canchas, torneo, sintetizarVacios) {
  // cada cancha puede tener su propia ventana horaria (ver ventanaDeCancha) --
  // se resuelve una sola vez por cancha, no por fila, para no recalcularla en
  // cada horario de la grilla.
  const ventanaPorCancha = new Map(canchas.map((c) => [c.id, ventanaDeCancha(c._tc || {}, torneo)]));
  const conHorario = partidos.filter((p) => p.horario);
  const filaPorMinuto = new Map(); // timestamp -> horario ISO de esa fila
  conHorario.forEach((p) => filaPorMinuto.set(new Date(p.horario).getTime(), p.horario));
  if (sintetizarVacios && torneo) {
    const duracion = torneo.duracion_minutos || 90;
    fechasDelTorneo(torneo).forEach((fecha) => {
      const dia = fecha.getDay();
      canchas.forEach((c) => {
        const ventana = ventanaPorCancha.get(c.id)(dia);
        if (ventana && ventana.cerrado) return; // esta cancha no juega este día -- no sintetiza huecos para ella
        const win = ventana || FRANJA_DEFAULT_DIA;
        for (let m = win.desde; m + duracion <= win.hasta; m += duracion) {
          const d = new Date(fecha);
          d.setHours(0, m, 0, 0);
          if (!filaPorMinuto.has(d.getTime())) filaPorMinuto.set(d.getTime(), d.toISOString());
        }
      });
    });
  }
  const duracionMin = (torneo && torneo.duracion_minutos) || 90;
  const bloqueos = bloqueosPorCanchaMapa();
  const horarios = [...filaPorMinuto.entries()].sort((a, b) => a[0] - b[0]).map(([, iso]) => iso);
  const filas = horarios.map((horarioISO) => {
    const desde = new Date(horarioISO);
    const hasta = new Date(desde.getTime() + duracionMin * 60000);
    const dia = desde.getDay();
    const minutosDelDia = desde.getHours() * 60 + desde.getMinutes();
    const celdas = canchas.map((c) => {
      const partido = conHorario.find((p) => p.horario === horarioISO && p.cancha_id === c.id);
      if (partido) return { cancha: c, estado: "ocupado", partido };
      const bloqueo = (bloqueos[c.id] || []).find((b) => desde < b.hasta && hasta > b.desde);
      if (bloqueo) return { cancha: c, estado: "bloqueado", bloqueo };
      // "cerrado": fuera de la ventana propia de ESTA cancha (o directamente no
      // juega este día) -- distinto de "disponible", que sigue siendo zona de
      // drop válida para arrastrar un partido.
      const ventana = ventanaPorCancha.get(c.id)(dia);
      if (ventana && (ventana.cerrado || minutosDelDia < ventana.desde || minutosDelDia >= ventana.hasta)) {
        return { cancha: c, estado: "cerrado" };
      }
      return { cancha: c, estado: "disponible" };
    });
    return { horarioISO, celdas };
  });
  return { horarios, filas, sinHorario: partidos.filter((p) => !p.horario) };
}

// re-renderiza el/los calendario(s) actualmente montados si el viewport
// cruza el breakpoint mobile/desktop — así la grilla y la agenda son
// responsive de verdad, no solo en la carga inicial de la pantalla.
const _calendariosResponsive = new Map(); // containerId -> función de re-render
function registrarRerenderResponsive(containerId, cb) { _calendariosResponsive.set(containerId, cb); }
window.matchMedia("(max-width:767px)").addEventListener("change", () => {
  _calendariosResponsive.forEach((cb) => cb());
});

// Orden natural de canchas: primero por predio, y dentro de cada predio por
// el número que tenga el nombre — así "Cancha 2" va antes que "Cancha 10"
// (un orden alfabético puro los pondría al revés) y todo lo que liste
// canchas (planilla, dropdown de "Cambiar cancha") va siempre de menor a
// mayor en vez del orden en que hayan quedado guardadas en la base.
function compararCanchas(a, b) {
  const complejoA = cacheComplejos.find((x) => x.id === a?.complejo_id)?.nombre || "";
  const complejoB = cacheComplejos.find((x) => x.id === b?.complejo_id)?.nombre || "";
  if (complejoA !== complejoB) return complejoA.localeCompare(complejoB);
  const numA = parseInt((a?.nombre || "").match(/\d+/)?.[0], 10);
  const numB = parseInt((b?.nombre || "").match(/\d+/)?.[0], 10);
  if (!Number.isNaN(numA) && !Number.isNaN(numB) && numA !== numB) return numA - numB;
  return (a?.nombre || "").localeCompare(b?.nombre || "");
}

// Color determinístico por categoría (mismo texto de categoría = siempre el
// mismo color, sin mantener ninguna paleta a mano) — sirve para distinguir
// de un vistazo, en la planilla compacta, a qué categoría pertenece cada
// partido con solo mirar el color del cuadradito.
function colorCategoria(categoria) {
  const str = categoria || "";
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) % 360;
  return `hsl(${hash}, 55%, 36%)`;
}
// "3ra Caballeros" -> "3RA CAB", "8va Damas" -> "8VA DAM" — para que el
// cuadradito compacto de la planilla entre en una sola línea corta.
function abreviarCategoria(categoria) {
  if (!categoria) return "";
  return categoria.trim().split(/\s+/)
    .map((p) => (p.length <= 4 ? p.toUpperCase() : p.slice(0, 3).toUpperCase()))
    .join(" ");
}

// Planilla de Administración (editable=true siempre, ver más abajo la vista
// pública): grilla en PC que se reacomoda al ancho disponible (nunca se corta
// con scroll horizontal, tenga 2 canchas o 8) y agenda vertical
// fecha->hora->cancha en mobile. Agrega los huecos libres del torneo y cada
// partido se puede arrastrar a otra celda (drag-and-drop nativo, solo
// desktop — en mobile cada partido ya tiene sus propios inputs de
// cancha/horario en la vista Lista, ver renderPartidosLista). El público/
// jugador ya no ve esta grilla — ve la llave de Torneo (renderPartidosLlave).
let planillaDiaFiltro = null; // día elegido en las pestañas de la Planilla (Administración) — se mantiene entre re-renders (drag&drop, cambio de categoría)
function renderPartidosCalendario(containerId, partidos, canchasTorneo, editable) {
  const cont = document.getElementById(containerId);
  // _tc: referencia a la fila de torneo_canchas (dias_semana/horarios_por_dia)
  // de esta cancha puntual -- la usa calcularSlots vía ventanaDeCancha().
  const canchas = canchasTorneo.map((c) => c.canchas && { ...c.canchas, _tc: c }).filter(Boolean).sort(compararCanchas);
  if (canchas.length === 0) {
    cont.innerHTML = '<p class="empty">Todavía no hay canchas asignadas a este torneo.</p>';
    return;
  }
  const torneoDeReferencia = editable ? torneoGestionData : torneoActualData;
  const { horarios, filas, sinHorario } = calcularSlots(partidos, canchas, torneoDeReferencia, editable);
  if (horarios.length === 0) {
    cont.innerHTML = editable
      ? '<p class="empty">Todavía no hay partidos ni horarios definidos para este torneo.</p>'
      : '<p class="empty">Todavía no hay partidos con cancha y horario asignados.</p>';
    return;
  }

  // Planilla (editable): un día por vez, con pestañas arriba (mismo patrón
  // .pill/.pill-row que ya se usa en otros filtros de la app) -- pedido
  // explícito para que la grilla no quede larguísima mostrando todos los
  // días del torneo apilados. El público/Calendario sigue mostrando todos
  // los días juntos (ahí no hace falta arrastrar nada, es solo consulta).
  let dias = [];
  if (editable) {
    const vistos = new Set();
    filas.forEach((fila) => {
      const key = new Date(fila.horarioISO).toDateString();
      if (!vistos.has(key)) { vistos.add(key); dias.push(key); }
    });
    if (!dias.includes(planillaDiaFiltro)) {
      const hoy = new Date().toDateString();
      planillaDiaFiltro = dias.includes(hoy) ? hoy : (dias[0] || null);
    }
  }
  const filasVisibles = (editable && planillaDiaFiltro) ? filas.filter((f) => new Date(f.horarioISO).toDateString() === planillaDiaFiltro) : filas;

  // La Planilla (editable) es para reorganizar horarios/canchas rápido, no
  // para cargar resultados -- eso quedó solo en la vista Lista/tarjeta
  // pública (cargaResultadoPanelHtml/wireCargaResultado siguen ahí sin
  // cambios). Acá cada partido es un cuadradito compacto coloreado por
  // categoría (mismo estilo que la planilla en papel del club), con el
  // detalle completo en el title (tooltip nativo) en vez de una tarjeta
  // grande -- así entran muchos partidos por pantalla y se sigue viendo de
  // un vistazo qué zona/categoría es cada uno.
  const tarjetaDetalladaHtml = (p, extraClase = "") => `
    <div class="calendario-partido ${p.estado === "jugado" ? "jugado" : ""} ${extraClase}" data-abrir-partido="${p.id}" tabindex="0" role="button" aria-label="Ver detalle: ${escapeHtml(p.pareja1_nombre)} vs ${escapeHtml(p.pareja2_nombre)}">
      <div class="calendario-equipo">${escapeHtml(p.pareja1_nombre)}</div>
      <div class="calendario-vs">V</div>
      <div class="calendario-equipo">${escapeHtml(p.pareja2_nombre)}</div>
      ${p.ronda && p.ronda !== "Fase de grupos" ? `<span class="badge orange" style="margin-top:4px">${p.ronda}</span>` : (p.grupo ? `<span class="badge orange" style="margin-top:4px">Grupo ${p.grupo}</span>` : "")}
      ${p.categoria ? `<span class="badge" style="margin-top:4px">${p.categoria}</span>` : ""}
    </div>`;
  const tarjetaCompactaHtml = (p, extraClase = "") => {
    const horarioTxt = p.horario ? new Date(p.horario).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) : "";
    const detalle = escapeHtml(`${p.pareja1_nombre} vs ${p.pareja2_nombre}${horarioTxt ? " · " + horarioTxt : ""}${p.estado === "jugado" ? " · Jugado" : ""}`);
    const etiqueta = `${p.slot_cuadro || (p.grupo ? "G" + p.grupo : "")} ${abreviarCategoria(p.categoria)}`.trim();
    return `<div class="calendario-partido calendario-compacta ${p.estado === "jugado" ? "jugado" : ""} ${extraClase}"
        style="background:${colorCategoria(p.categoria)}" title="${detalle}" draggable="true" data-partido="${p.id}">
      ${etiqueta}
    </div>`;
  };
  const tarjetaHtml = (p, extraClase = "") => editable ? tarjetaCompactaHtml(p, extraClase) : tarjetaDetalladaHtml(p, extraClase);
  const bloqueadaHtml = (celda) => `<div class="calendario-bloqueada" title="${escapeHtml(celda.bloqueo.motivo || "Cancha bloqueada")}">🚫 Bloqueada${celda.bloqueo.motivo ? `<br>${escapeHtml(celda.bloqueo.motivo)}` : ""}</div>`;
  const vaciaHtml = (fila, celda) => `<div class="calendario-vacia" ${editable ? `data-horario="${fila.horarioISO}" data-cancha="${celda.cancha.id}"` : ""}></div>`;
  const cerradaHtml = () => `<div class="calendario-cerrada" title="Esta cancha no juega en este horario">🔒 Cerrada</div>`;

  let html = "";
  if (editable && sinHorario.length > 0) {
    html += `<p class="match-meta" style="margin-bottom:6px">Arrastrá un partido sin horario a un hueco libre (en el celular, asignalo desde su tarjeta en la vista Lista):</p>
      <div class="planilla-bandeja" id="planillaBandeja">${sinHorario.map((p) => tarjetaHtml(p, "pendiente")).join("")}</div>`;
  }
  if (editable && dias.length > 1) {
    html += `<div class="pill-row" id="planillaDiasPills">${dias.map((key) => {
      const label = new Date(key).toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });
      return `<button type="button" class="pill ${key === planillaDiaFiltro ? "active" : ""}" data-dia="${key}">${label}</button>`;
    }).join("")}</div>`;
  }

  const esMobile = window.matchMedia("(max-width:767px)").matches;
  if (esMobile) {
    // agenda vertical: fecha -> hora -> cancha — nunca scroll horizontal como solución
    let fechaAnterior = null;
    filasVisibles.forEach((fila) => {
      const d = new Date(fila.horarioISO);
      const fechaTxt = d.toLocaleDateString("es-AR", { weekday: "long", day: "2-digit", month: "2-digit" });
      if (fechaTxt !== fechaAnterior) { html += `<div class="calendario-agenda-fecha">${fechaTxt}</div>`; fechaAnterior = fechaTxt; }
      html += `<div class="calendario-agenda-hora">${iconoReloj()} ${d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}</div>`;
      fila.celdas.forEach((celda) => {
        if ((celda.estado === "disponible" || celda.estado === "cerrado") && !editable) return; // en la agenda pública no hace falta mostrar huecos vacíos ni cerrados
        html += `<div class="calendario-agenda-item"><p class="match-meta meta-caption" style="margin-bottom:2px">${celda.cancha.nombre}</p>`;
        if (celda.estado === "ocupado") html += tarjetaHtml(celda.partido);
        else if (celda.estado === "bloqueado") html += bloqueadaHtml(celda);
        else if (celda.estado === "cerrado") html += cerradaHtml();
        else html += vaciaHtml(fila, celda);
        html += `</div>`;
      });
    });
  } else {
    // grilla de escritorio: auto-fit/minmax se reacomoda al ancho disponible, nunca se corta
    html += `<div class="calendario-grid-scroll"><div class="calendario-grid ${editable ? "compacta" : ""}" style="--calendario-cols:${canchas.length}">`;
    // con varios predios que repiten nombre de cancha ("Cancha 1" en cada
    // uno) el nombre solo no alcanza para distinguirlas -- se antepone el
    // predio, mismo formato "Predio · Cancha" que ya se usa en el selector
    // de "Cambiar cancha" de la vista Lista.
    html += `<div></div>` + canchas.map((c) => {
      const complejo = cacheComplejos.find((x) => x.id === c.complejo_id);
      return `<div class="calendario-grid-cabecera">${complejo ? `<span class="calendario-grid-predio">${complejo.nombre}</span>` : ""}${c.nombre}</div>`;
    }).join("");
    filasVisibles.forEach((fila) => {
      const fecha = new Date(fila.horarioISO).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
      html += `<div class="calendario-hora">${fecha}</div>`;
      fila.celdas.forEach((celda) => {
        if (celda.estado === "ocupado") html += tarjetaHtml(celda.partido);
        else if (celda.estado === "bloqueado") html += bloqueadaHtml(celda);
        else if (celda.estado === "cerrado") html += cerradaHtml();
        else html += vaciaHtml(fila, celda);
      });
    });
    html += `</div></div>`;
  }

  if (!editable && sinHorario.length > 0) {
    html += `<p class="match-meta" style="margin-top:10px">Sin horario asignado (${sinHorario.length}): ` +
      sinHorario.map((p) => `${escapeHtml(p.pareja1_nombre)} vs ${escapeHtml(p.pareja2_nombre)}`).join(" · ") + "</p>";
  }
  cont.innerHTML = html;

  if (editable) {
    wirePlanillaDragAndDrop(containerId);
    cont.querySelectorAll("#planillaDiasPills .pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        planillaDiaFiltro = btn.dataset.dia;
        renderPartidosCalendario(containerId, partidos, canchasTorneo, editable);
      });
    });
  }
  cont.querySelectorAll("[data-abrir-partido]").forEach((el) => {
    el.addEventListener("click", () => abrirDetallePartido(el.dataset.abrirPartido));
  });
  registrarRerenderResponsive(containerId, () => renderPartidosCalendario(containerId, partidos, canchasTorneo, editable));
}

// Drag & drop nativo del navegador (sin librerías, solo desktop): tomar un partido y
// soltarlo en otra celda le cambia cancha y horario juntos en un solo update —
// reutiliza el mismo chequeo de choques (hayConflictoCancha) que ya usan los botones
// de la vista Lista, ahora también respetando los bloqueos de cancha. Soltarlo en la
// bandeja de arriba lo vuelve a dejar "sin horario".
function wirePlanillaDragAndDrop(containerId) {
  const cont = document.getElementById(containerId);
  let arrastrando = null;

  cont.querySelectorAll(".calendario-partido[draggable]").forEach((el) => {
    el.addEventListener("dragstart", () => { arrastrando = el.dataset.partido; el.classList.add("arrastrando"); });
    el.addEventListener("dragend", () => { el.classList.remove("arrastrando"); arrastrando = null; });
  });

  const zonas = [...cont.querySelectorAll(".calendario-vacia")];
  const bandeja = document.getElementById("planillaBandeja");
  if (bandeja) zonas.push(bandeja);

  zonas.forEach((zona) => {
    zona.addEventListener("dragover", (e) => e.preventDefault());
    zona.addEventListener("drop", async (e) => {
      e.preventDefault();
      if (zona.dataset.busy) return;
      const partidoId = arrastrando;
      if (!partidoId) return;
      zona.dataset.busy = "1";
      try {
      const nuevoHorario = zona.dataset.horario || null; // sin dataset.horario = soltado en la bandeja
      const nuevaCancha = zona.dataset.cancha || null;
      const duracion = torneoGestionData?.duracion_minutos || 90;
      const bloqueosDeCancha = nuevaCancha ? (bloqueosPorCanchaMapa()[nuevaCancha] || []) : [];

      if (nuevoHorario && nuevaCancha && hayConflictoCancha(ultimosPartidosGestion, partidoId, nuevaCancha, nuevoHorario, duracion, bloqueosDeCancha)) {
        toast("Ese horario ya está ocupado (cancha bloqueada, o alguna de las parejas ya tiene otro partido a esa hora)");
        return;
      }
      const partido = ultimosPartidosGestion.find((x) => x.id === partidoId);
      const { error } = await sb.from("partidos").update({ cancha_id: nuevaCancha, horario: nuevoHorario }).eq("id", partidoId);
      if (error) { toast("Error: " + error.message); return; }
      // mismo motivo que en btnCambiarHorario: si este partido no tenía horario
      // y ahora se le asignó arrastrándolo, esta categoría ya tiene calendario.
      // Si esa categoría YA estaba publicada, el cambio queda visible al toque
      // (el admin está corrigiendo algo en vivo); si todavía no se publicó
      // nunca, entra como borrador igual que "Generar calendario" -- sigue
      // haciendo falta "Publicar calendario" para que lo vean los jugadores.
      if (nuevoHorario && !partido?.horario && partido?.categoria) {
        const { data: catActual } = await sb.from("torneo_categorias").select("estado_fase").eq("torneo_id", torneoGestionId).eq("categoria", partido.categoria).maybeSingle();
        const yaPublicada = catActual && (catActual.estado_fase === "calendario_confirmado" || catActual.estado_fase === "finalizada");
        await sb.from("torneo_categorias").update({ estado_fase: yaPublicada ? "calendario_confirmado" : "calendario_borrador" }).eq("torneo_id", torneoGestionId).eq("categoria", partido.categoria);
        if (yaPublicada) await actualizarEstadoTorneoPorFases(torneoGestionId);
      }
      toast(nuevoHorario ? "Partido reubicado ✅" : "Partido movido a \"sin horario\"");
      avisarActualizacionEnVivo();
      refrescarTrasAccionGestion();
      } finally {
        delete zona.dataset.busy;
      }
    });
  });
}

// ---------- Carga de resultado (sets) — compartida entre Administración
// (renderPartidosLista) y la tarjeta pública cuando el que mira es admin
// (llavePartidoCardHtml/renderPartidosLlave), para que cargar un resultado
// sea siempre el mismo formulario y el mismo guardado, en un solo lugar. ----
function cargaResultadoPanelHtml(p, oculto) {
  // cruce del cuadro de zonas todavía sin las dos parejas definidas (p.ej.
  // "Ganador Z5" esperando su resultado) — no hay a quién asignarle el
  // ganador todavía, así que no se muestra el formulario de carga.
  if (!p.pareja1_id || !p.pareja2_id) {
    return `
    <div class="match-admin-panel" data-carga-resultado="${p.id}" draggable="false" ${oculto ? 'style="display:none"' : ""}>
      <p class="match-admin-label">Cargar resultado — ${p.ronda || "Fase de grupos"}</p>
      <p class="empty">Todavía falta definir alguna de las dos parejas de este cruce.</p>
    </div>`;
  }
  // si ya tiene resultado cargado, precarga los valores existentes para
  // poder corregirlos en vez de tener que volver a escribir todo de cero
  const sets = p.sets || [];
  const hayTercero = sets.length === 3;
  const val = (lado, set) => { const s = sets[set - 1]; if (!s) return ""; return lado === 1 ? s.p1 : s.p2; };
  const esCorreccion = p.estado === "jugado";
  return `
    <div class="match-admin-panel" data-carga-resultado="${p.id}" draggable="false" ${oculto ? 'style="display:none"' : ""}>
      <p class="match-admin-label">${esCorreccion ? "Corregir resultado" : "Cargar resultado"} — ${p.ronda || "Fase de grupos"}</p>
      <div class="sets-entry" data-p="${p.id}">
        <div class="sets-entry-heads"><span></span><span>Set 1</span><span>Set 2</span><span class="setHead3" style="${hayTercero ? "" : "display:none"}">Set 3</span></div>
        <div class="sets-entry-row">
          <span class="sets-entry-label" title="${escapeHtml(p.pareja1_nombre)}">${escapeHtml(p.pareja1_nombre)}</span>
          <input type="number" min="0" max="7" class="setCell" data-p="${p.id}" data-lado="1" data-set="1" value="${val(1, 1)}" />
          <input type="number" min="0" max="7" class="setCell" data-p="${p.id}" data-lado="1" data-set="2" value="${val(1, 2)}" />
          <input type="number" min="0" max="7" class="setCell setCell3" data-p="${p.id}" data-lado="1" data-set="3" value="${val(1, 3)}" style="${hayTercero ? "" : "display:none"}" />
        </div>
        <div class="sets-entry-row">
          <span class="sets-entry-label" title="${escapeHtml(p.pareja2_nombre)}">${escapeHtml(p.pareja2_nombre)}</span>
          <input type="number" min="0" max="7" class="setCell" data-p="${p.id}" data-lado="2" data-set="1" value="${val(2, 1)}" />
          <input type="number" min="0" max="7" class="setCell" data-p="${p.id}" data-lado="2" data-set="2" value="${val(2, 2)}" />
          <input type="number" min="0" max="7" class="setCell setCell3" data-p="${p.id}" data-lado="2" data-set="3" value="${val(2, 3)}" style="${hayTercero ? "" : "display:none"}" />
        </div>
      </div>
      <div class="match-actions">
        <button class="secondary small btnCargarResultado" data-p="${p.id}" data-p1="${p.pareja1_id}" data-p2="${p.pareja2_id}" data-ronda="${p.ronda || "Fase de grupos"}">${esCorreccion ? "Guardar corrección" : "Cargar resultado"}</button>
      </div>
    </div>`;
}
// engancha el comportamiento del formulario de arriba dentro de `cont`
// (Set 3 que aparece solo si hace falta, guardado a Supabase, y — cuando
// existe — el ícono ✏️ que muestra/oculta el panel sin abrir el detalle del
// partido). Se llama tanto desde Administración como desde la tarjeta
// pública: si `cont` no tiene ninguno de estos elementos, no hace nada.
function wireCargaResultado(cont) {
  function actualizarVisibilidadSet3(partidoId) {
    const celda = (lado, set) => cont.querySelector(`.setCell[data-p="${partidoId}"][data-lado="${lado}"][data-set="${set}"]`);
    const val = (lado, set) => { const v = celda(lado, set).value.trim(); return v === "" ? null : Number(v); };
    const s1p1 = val(1, 1), s1p2 = val(2, 1), s2p1 = val(1, 2), s2p2 = val(2, 2);
    const set1Ganador = (s1p1 !== null && s1p2 !== null && s1p1 !== s1p2) ? (s1p1 > s1p2 ? 1 : 2) : null;
    const set2Ganador = (s2p1 !== null && s2p2 !== null && s2p1 !== s2p2) ? (s2p1 > s2p2 ? 1 : 2) : null;
    const haceFaltaTercero = set1Ganador !== null && set2Ganador !== null && set1Ganador !== set2Ganador;
    const entry = cont.querySelector(`.sets-entry[data-p="${partidoId}"]`);
    entry.querySelector(".setHead3").style.display = haceFaltaTercero ? "" : "none";
    entry.querySelectorAll(".setCell3").forEach((c) => {
      c.style.display = haceFaltaTercero ? "" : "none";
      if (!haceFaltaTercero) c.value = "";
    });
  }
  cont.querySelectorAll(".setCell").forEach((input) => {
    input.addEventListener("input", () => actualizarVisibilidadSet3(input.dataset.p));
  });

  cont.querySelectorAll(".btnCargarResultado").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
      const partidoId = btn.dataset.p;
      const celda = (lado, set) => cont.querySelector(`.setCell[data-p="${partidoId}"][data-lado="${lado}"][data-set="${set}"]`);
      const sets = [];
      for (let set = 1; set <= 3; set++) {
        const v1 = celda(1, set).value.trim(), v2 = celda(2, set).value.trim();
        if (v1 === "" && v2 === "") continue; // set no jugado (p.ej. el tercero cuando no hizo falta)
        if (v1 === "" || v2 === "") { toast(`Completá los dos games del Set ${set}`); return; }
        const p1 = Number(v1), p2 = Number(v2);
        if (p1 === p2) { toast(`El Set ${set} no puede terminar empatado`); return; }
        sets.push({ p1, p2 });
      }
      if (sets.length < 2) { toast("Cargá al menos 2 sets"); return; }
      const setsGanadosP1 = sets.filter((s) => s.p1 > s.p2).length;
      const setsGanadosP2 = sets.filter((s) => s.p2 > s.p1).length;
      if (setsGanadosP1 === setsGanadosP2) {
        toast("El resultado tiene que tener un ganador — completá el Set 3 para desempatar"); return;
      }
      const ganadorParejaId = setsGanadosP1 > setsGanadosP2 ? btn.dataset.p1 : btn.dataset.p2;

      const { data: partidoActualizado, error } = await sb.from("partidos").update({
        sets, estado: "jugado", ganador_pareja_id: ganadorParejaId
      }).eq("id", partidoId).select("categoria, torneo_id, slot_cuadro").single();
      if (error) { toast("Error: " + error.message); return; }
      toast("Resultado cargado, ranking actualizado ✅");
      if (partidoActualizado?.slot_cuadro) {
        // si esto alimenta una fase ya armada del cuadro de zonas, que el
        // rival de esa fase se actualice solo en vez de quedar trabado con
        // el resultado viejo (ver propagarCuadro). OJO: propagarCuadro puede
        // marcar la categoría "finalizada" ella sola (p.ej. si la Final se
        // arma por walkover) sin que este botón haya sido el de la Final --
        // por eso actualizarEstadoTorneoPorFases() se llama SIEMPRE más abajo,
        // no solo dentro del if de "Final" (antes el torneo podía quedar
        // trabado en "en curso" con todos los campeones ya definidos).
        const { avisos } = await propagarCuadro(partidoActualizado.categoria, partidoActualizado.torneo_id);
        avisos.forEach((a) => toast(a));
      }
      avisarActualizacionEnVivo();
      refrescarTrasAccionGestion();
      cargarRanking();
      if (btn.dataset.ronda === "Final") {
        // el campeón de esta categoría se define acá mismo -- no debería hacer
        // falta volver a apretar "Generar siguiente fase" para que el torneo
        // deje de figurar "en curso" (ver actualizarEstadoTorneoPorFases)
        await sb.from("torneo_categorias").update({ estado_fase: "finalizada" }).eq("torneo_id", partidoActualizado.torneo_id).eq("categoria", partidoActualizado.categoria);
        cargarCampeones();
      }
      await actualizarEstadoTorneoPorFases(partidoActualizado.torneo_id);
      } finally {
        btn.disabled = false;
      }
    });
  });

  // clicks adentro del panel de carga no deben burbujear — en la tarjeta
  // pública, ese panel vive dentro de una card que abre el detalle del
  // partido al tocarla en cualquier otro lado.
  cont.querySelectorAll(".match-admin-panel").forEach((panel) => {
    panel.addEventListener("click", (e) => e.stopPropagation());
  });
  // ✏️ solo existe en la tarjeta pública (admin) — muestra/oculta el panel.
  cont.querySelectorAll(".btnTogglePartidoAdmin").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const panel = cont.querySelector(`[data-carga-resultado="${btn.dataset.p}"]`);
      if (panel) panel.style.display = panel.style.display === "none" ? "block" : "none";
    });
  });
}

// tarjeta compacta de un partido para la vista Llave: nombre de cada pareja en una
// sola línea (ya viene armado desde partidos_publicos como "Nombre Apellido / Nombre
// Apellido") + puntaje por set alineado a la derecha, fecha/hora y cancha — el
// ganador se resalta en el verde de marca. Si el que mira es admin y el partido
// todavía no tiene resultado, el ícono ✏️ despliega el mismo formulario de carga
// que antes solo existía en Administración (ver cargaResultadoPanelHtml).
function llavePartidoCardHtml(p) {
  const ganador = p.ganador_pareja_id === p.pareja1_id ? 1 : p.ganador_pareja_id === p.pareja2_id ? 2 : null;
  const sets = p.sets || [];
  const setsHtml = (lado) => sets.length
    ? sets.map((s) => `<span class="llave-set">${lado === 1 ? s.p1 : s.p2}</span>`).join("")
    : '<span class="llave-set">—</span>';
  const horario = p.horario
    ? new Date(p.horario).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "horario a definir";
  const local = p.cancha_nombre ? `${p.complejo_nombre ? p.complejo_nombre + " · " : ""}${p.cancha_nombre}` : (p.complejo_nombre || "a definir");
  const puedeCargarResultado = isAdmin && p.estado !== "jugado";
  // mismo badge/punto pulsante que ya usa badgeEstadoTorneo para el torneo en curso
  // (.badge.live/.live-dot, ver style.css) -- así un partido "en_juego" se distingue
  // solo con clases que ya existían, sin css nuevo para el badge en sí. Se ve en todos
  // lados donde se usa esta tarjeta (Llave, En vivo, Inicio) porque es la misma función.
  const enVivoAhora = p.estado === "en_juego";
  return `
    <div class="llave-partido ${enVivoAhora ? "en-vivo-ahora" : ""}" data-abrir-partido="${p.id}" data-slot="${p.slot_cuadro || ""}" style="cursor:pointer" tabindex="0" role="button" aria-label="Ver detalle: ${escapeHtml(p.pareja1_nombre)} vs ${escapeHtml(p.pareja2_nombre)}">
      <div class="llave-fecha">
        <span>${enVivoAhora ? '<span class="badge live"><span class="live-dot"></span>EN VIVO</span> ' : ""}${iconoReloj()} ${horario}</span>
        <span style="display:flex;align-items:center;gap:6px">
          ${p.slot_cuadro ? `<span>${p.slot_cuadro}</span>` : ""}
          ${puedeCargarResultado ? `<button type="button" class="btnTogglePartidoAdmin" data-p="${p.id}" title="Cargar resultado" aria-label="Cargar resultado">✏️</button>` : ""}
        </span>
      </div>
      <div class="llave-fila ${ganador === 1 ? "ganador" : ""}">
        <span class="llave-pareja">${escapeHtml(p.pareja1_nombre)}</span>
        <span class="llave-sets">${setsHtml(1)}</span>
      </div>
      <div class="llave-fila ${ganador === 2 ? "ganador" : ""}">
        <span class="llave-pareja">${escapeHtml(p.pareja2_nombre)}</span>
        <span class="llave-sets">${setsHtml(2)}</span>
      </div>
      <div class="match-meta llave-meta">${iconoPin()} Local: ${local}</div>
      ${puedeCargarResultado ? cargaResultadoPanelHtml(p, true) : ""}
    </div>`;
}

// vista "llave": columnas de Zona (fase de grupos, una por número de grupo) seguidas
// de las columnas de eliminación directa (una por ronda de bracket), lado a lado como
// en un cuadro de torneo — reutiliza el mismo formato de tarjeta en ambos bloques.
function renderPartidosLlave(containerId, partidos) {
  const cont = document.getElementById(containerId);

  // Esta vista siempre recibe los partidos de UNA sola categoría — Resultados
  // obliga a elegir género y categoría antes de mostrar nada (ver
  // renderResultadosPublico), así el nombre de la categoría no hace falta
  // repetirlo acá (ya se ve en el selector de arriba). Se agrupa en FASES,
  // una al lado de la otra en la misma fila (Zona | Octavos | Cuartos |
  // Semis | Final): el nombre de la fase va una sola vez arriba del grupo,
  // y cada partido de esa fase es su propia columna angosta al lado de las
  // demás (antes las de eliminación quedaban todas amontonadas en una sola
  // columna cuando había más de un partido en la misma ronda).
  const grupales = partidos.filter((p) => p.grupo != null);
  // cuadro de zonas del club (fase_grupos_formato "cuadro_zonas"): cada zona
  // es un solo partido con slot_cuadro "Z1"/"Z2"/... y ronda "Zona" (no usa
  // `grupo`, que es del formato "Grupos" de todos-contra-todos)
  const zonasCuadro = partidos.filter((p) => p.ronda === "Zona" && p.slot_cuadro);
  const gruposOrdenados = [...new Set(grupales.map((p) => p.grupo))].sort((a, b) => a - b);
  const numsZonaCuadro = [...new Set(zonasCuadro.map((p) => Number(p.slot_cuadro.slice(1))))].sort((a, b) => a - b);
  const columnasZona = [
    ...gruposOrdenados.map((g) => ({ titulo: `Zona ${g}`, partidos: grupales.filter((p) => p.grupo === g) })),
    ...numsZonaCuadro.map((n) => ({ titulo: `Zona ${n}`, partidos: zonasCuadro.filter((p) => Number(p.slot_cuadro.slice(1)) === n) }))
  ];

  const fases = [];
  if (columnasZona.length) fases.push({ titulo: "Zona", zona: true, columnas: columnasZona });

  // las fases de eliminación se arman con los nombres de ronda que realmente existen,
  // en el orden en que se generaron (no una lista fija) — así sirve tanto para el cuadro
  // clásico de 16/8/4/2 como para un torneo chico que arranca directo en semifinal, o con
  // nombres genéricos ("Ronda de 6") si el cuadro es irregular. Cada fase es UNA sola
  // columna con todos sus partidos apilados en vertical (igual que una Zona con varios
  // partidos) — lo horizontal es solo el avance de fase (Zona -> Cuartos -> Semis -> Final).
  const eliminacion = partidos.filter((p) => p.ronda && p.ronda !== "Fase de grupos" && p.grupo == null && !(p.ronda === "Zona" && p.slot_cuadro));
  // Orden de fases: primero el orden estándar del cuadro (Dieciseisavos -> Final),
  // sin depender de created_at -- una carga masiva por SQL inserta todo en la misma
  // transacción y ahí todas las filas quedan con el mismo created_at, así que ese
  // criterio dejaba el orden librado al azar. Para nombres no estándar (torneos
  // chicos con rondas genéricas tipo "Ronda de 6") se sigue usando el created_at
  // más viejo de esa ronda como respaldo.
  const ORDEN_FASES_ELIMINACION = ["Dieciseisavos", "Octavos", "Cuartos", "Semifinal", "Final"];
  const primerCreatedAtPorRonda = {};
  eliminacion.forEach((p) => {
    const t = new Date(p.created_at).getTime();
    if (!(p.ronda in primerCreatedAtPorRonda) || t < primerCreatedAtPorRonda[p.ronda]) primerCreatedAtPorRonda[p.ronda] = t;
  });
  const nombresOrdenados = [...new Set(eliminacion.map((p) => p.ronda))].sort((a, b) => {
    const ia = ORDEN_FASES_ELIMINACION.indexOf(a);
    const ib = ORDEN_FASES_ELIMINACION.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return primerCreatedAtPorRonda[a] - primerCreatedAtPorRonda[b];
  });
  nombresOrdenados.forEach((r) => {
    // sin título de columna: ya lo dice el título de la fase (h3) arriba, una
    // sola vez -- repetirlo en el h4 de la columna quedaba redundante ahora
    // que es una sola columna por fase.
    fases.push({
      titulo: r, zona: false,
      columnas: [{ titulo: "", partidos: eliminacion.filter((p) => p.ronda === r) }]
    });
  });

  if (fases.length === 0) {
    cont.innerHTML = '<p class="empty">Todavía no hay partidos armados.</p>';
    return;
  }

  // Sin pestañas "Zonas/Cuartos/Semis/Final": todas las fases quedan una al
  // lado de la otra en el mismo scroll horizontal (con snap en mobile, ver
  // .llave-scroll/.llave-columna) -- se recorren deslizando a la derecha en
  // vez de tener que elegir una pestaña arriba.
  // O1, O2, O3... en ese orden de arriba a abajo (antes quedaban en el orden que
  // devolviera la consulta) -- así la columna se lee igual que en la plantilla del
  // cuadro, y las líneas conectoras (dibujarConectoresLlave) quedan prolijas.
  const ordenarPorSlot = (lista) => [...lista].sort((a, b) =>
    (Number(a.slot_cuadro?.slice(1)) || 0) - (Number(b.slot_cuadro?.slice(1)) || 0));
  const columnaHtml = (col) => `
      <div class="llave-columna">
        ${col.titulo ? `<h4>${col.titulo}</h4>` : ""}
        ${ordenarPorSlot(col.partidos).map((p) => llavePartidoCardHtml(p)).join("")}
      </div>`;
  // Zona: sus columnas (una por zona) van apiladas en VERTICAL, una debajo de
  // la otra -- no una al lado de la otra como las fases (pedido explícito: los
  // partidos de una categoría van en vertical, lo horizontal es el avance de
  // fase Zona -> Cuartos -> Semis -> Final).
  const faseHtml = (fase) => `
      <div class="llave-fase ${fase.zona ? "llave-fase-zona" : ""}">
        <h3 class="llave-fase-titulo">${fase.titulo}</h3>
        <div class="llave-fase-columnas" ${fase.zona ? 'style="flex-direction:column"' : ""}>${fase.columnas.map(columnaHtml).join("")}</div>
      </div>`;

  cont.innerHTML = `<div class="llave-scroll"><div class="llave">${fases.map(faseHtml).join("")}</div></div>`;

  cont.querySelectorAll("[data-abrir-partido]").forEach((el) => {
    el.addEventListener("click", () => abrirDetallePartido(el.dataset.abrirPartido));
  });
  wireCargaResultado(cont);
  // se guarda para poder volver a trazar las líneas si cambia el ancho de
  // pantalla (dibujarConectoresLlave usa posiciones ya renderizadas, así que
  // un resize las deja desalineadas si no se recalculan con los mismos datos)
  cont._partidosLlave = partidos;
  dibujarConectoresLlave(cont, partidos);
}

// Líneas conectoras estilo "cuadro de torneo" (cada partido, unido con el/los
// partidos de los que sale su pareja) -- se apoya en la misma plantilla que ya
// arma los cruces del cuadro propio del club (PLANTILLAS_CUADRO/
// proyeccionCuadroCompleto, en matching.js), así no hay que duplicar esa lógica:
// para cada cruce de la plantilla ("C1" sale de "GZ1" y "PZ3") busca las dos
// tarjetas reales por su data-slot y traza una línea en ángulo entre ellas. Las
// líneas arrancan recién en la primera ronda de eliminación (Octavos o
// Dieciseisavos, según corresponda al tamaño del cuadro): un ref que apunta a
// una Zona ("GZ1", "PZ3", ...) no se conecta, así que Zonas nunca queda unida
// por una línea, aunque algún cruce de una ronda posterior (p.ej. Octavos con
// 9+ zonas) siga saliendo directo de una Zona por un bye. Si el torneo no usa
// el cuadro propio del club (formato "grupos" clásico, sin slot_cuadro) o el
// tamaño no tiene plantilla, no dibuja nada -- se ve como antes, columnas
// sueltas sin líneas.
function dibujarConectoresLlave(cont, partidos) {
  const llave = cont.querySelector(".llave");
  cont.querySelector(".llave-conectores")?.remove();
  const nZonas = partidos.filter((p) => p.slot_cuadro && p.slot_cuadro[0] === "Z").length;
  if (!llave || !nZonas || !PLANTILLAS_CUADRO[nZonas]) return;

  const base = llave.getBoundingClientRect();
  const rectRelativo = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top - base.top, bottom: r.bottom - base.top, left: r.left - base.left, right: r.right - base.left };
  };

  const trazos = [];
  proyeccionCuadroCompleto(nZonas).forEach(({ slot, refA, refB }) => {
    const destino = cont.querySelector(`.llave-partido[data-slot="${slot}"]`);
    if (!destino) return;
    [refA, refB].forEach((ref) => {
      if (ref[1] === "Z") return; // no conectar con Zonas, solo entre rondas de eliminación
      const origen = cont.querySelector(`.llave-partido[data-slot="${ref.slice(1)}"]`);
      if (!origen) return;
      const rO = rectRelativo(origen), rD = rectRelativo(destino);
      const x1 = rO.right, y1 = (rO.top + rO.bottom) / 2;
      const x2 = rD.left, y2 = (rD.top + rD.bottom) / 2;
      const xMedio = (x1 + x2) / 2;
      trazos.push(`M${x1},${y1} H${xMedio} V${y2} H${x2}`);
    });
  });
  if (!trazos.length) return;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "llave-conectores");
  svg.setAttribute("width", llave.scrollWidth);
  svg.setAttribute("height", llave.scrollHeight);
  svg.innerHTML = trazos.map((d) => `<path d="${d}" class="llave-conector-linea" />`).join("");
  llave.prepend(svg);
}
// las líneas se calculan en base a posiciones ya renderizadas (getBoundingClientRect):
// si cambia el ancho de pantalla hay que recalcularlas, con los mismos datos que
// ya se usaron para el último render de cada contenedor (ver cont._partidosLlave).
window.addEventListener("resize", () => requestAnimationFrame(() => {
  ["pubResultadosLlave", "admPartidosLlave"].forEach((id) => {
    const cont = document.getElementById(id);
    if (cont?._partidosLlave) dibujarConectoresLlave(cont, cont._partidosLlave);
  });
}));

// ---------- Torneo (pantalla única: Categoría → Etapa → partidos) ----------
// Calendario y Resultados eran dos pantallas separadas que mostraban casi lo
// mismo (renderPartidosLlave ya incluye partidos jugados y pendientes por
// igual) — se unificaron en una sola, ver renderResultadosPublico más abajo.

// Entra a Administración ya con ESTE torneo en gestión (reemplaza el selector
// suelto #admSelectTorneoGestion como único punto de entrada: ahora también se
// llega desde dentro del propio torneo, que es donde tiene sentido "administrar
// esto" — ver Fase 4 de la reorganización club/torneo).
document.getElementById("btnAdministrarEsteTorneo").addEventListener("click", async () => {
  if (!torneoActualId) return;
  // Se marca ANTES de cambiarVista: cambiar el hash a #/admin dispara además un
  // "hashchange" que vuelve a llamar a cambiarVista("admin") por su cuenta (ver
  // despacharRuta) — sin este chequeo puesto ya, ese segundo llamado deshacía el
  // modo enfocado apenas se activaba (ver el chequeo correspondiente en cambiarVista).
  adminFocoTorneoActivo = true;
  cambiarVista("admin", "/admin");
  await cargarGestionTorneo(torneoActualId); // ya deja la pantalla enfocada solo en este torneo (ver más arriba)
  document.getElementById("admGestionTorneoWrap").scrollIntoView({ behavior: "smooth", block: "start" });
});
document.getElementById("admBtnVolverConfigGeneral").addEventListener("click", () => {
  adminFocoTorneoActivo = false;
  torneoGestionId = null;
  torneoGestionData = null;
  document.getElementById("admGestionTorneoWrap").style.display = "none";
  document.getElementById("admSelectTorneoGestion").value = "";
  document.getElementById("admBtnVolverConfigGeneral").style.display = "none";
  mostrarSeccionConfigGeneral(seccionConfigActiva); // esconde admSelectorTorneoCard por su cuenta
});

// Atajo pedido por el club: desde "Administrar este torneo" poder cargar/ver
// auspiciantes de ESE torneo sin tener que ir a la Configuración general
// (que ahí queda oculta a propósito). Muestra solo la card de Auspiciantes
// —no el resto de la config general— con el torneo ya preseleccionado.
document.getElementById("btnAuspiciantesTorneo").addEventListener("click", () => {
  document.getElementById("auspiciantesWrap").style.display = "block";
  document.getElementById("btnCerrarAuspiciantesTorneo").style.display = "inline-block";
  const spTorneo = document.getElementById("spTorneo");
  if (torneoGestionId) spTorneo.value = torneoGestionId;
  document.getElementById("auspiciantesWrap").scrollIntoView({ behavior: "smooth", block: "start" });
});
document.getElementById("btnCerrarAuspiciantesTorneo").addEventListener("click", () => {
  document.getElementById("auspiciantesWrap").style.display = "none";
  document.getElementById("btnCerrarAuspiciantesTorneo").style.display = "none";
  document.getElementById("admGestionTorneoWrap").scrollIntoView({ behavior: "smooth", block: "start" });
});

// "Todas" mezcladas era justo lo que quedaba confuso (zonas de categorías
// distintas mezcladas en la misma fila, sin poder distinguir Damas de
// Caballeros) -- ahora es obligatorio elegir género (pestañas, mismo patrón
// que ya usa el Ranking) y después categoría, nunca las dos juntas.
let resFiltroGeneroActual = null;
function renderResultadosPublico() {
  const contGenero = document.getElementById("resFiltroGeneroPills");
  const sel = document.getElementById("resFiltroCategoria");
  const grupos = agruparPorGenero(categoriasTorneoActual);
  const generosConDatos = ORDEN_GENEROS.filter((g) => grupos[g].length > 0);
  if (!resFiltroGeneroActual || !generosConDatos.includes(resFiltroGeneroActual)) {
    resFiltroGeneroActual = generosConDatos[0];
  }
  contGenero.innerHTML = generosConDatos.length > 1 ? generosConDatos.map((g) =>
    `<button class="pill ${g === resFiltroGeneroActual ? "active" : ""}" data-genero="${g}">${g}</button>`
  ).join("") : "";
  contGenero.querySelectorAll(".pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      resFiltroGeneroActual = btn.dataset.genero;
      sel.value = ""; // que elija la primera categoría de ese género
      renderResultadosPublico();
    });
  });

  const categoriasDelGenero = grupos[resFiltroGeneroActual] || [];
  if (!categoriasDelGenero.includes(sel.value)) sel.value = categoriasDelGenero[0] || "";
  sel.innerHTML = categoriasDelGenero.map((c) => `<option value="${c}" ${c === sel.value ? "selected" : ""}>${c}</option>`).join("");

  const visibles = sel.value ? ultimosPartidos.filter((p) => p.categoria === sel.value) : [];
  renderPartidosLlave("pubResultadosLlave", visibles);
}
document.getElementById("resFiltroCategoria").addEventListener("change", renderResultadosPublico);

// ---------- Detalle de un partido puntual (Calendario/Resultados) ----------
function abrirDetallePartido(partidoId) {
  const p = ultimosPartidos.find((x) => x.id === partidoId) || ultimosPartidosGestion.find((x) => x.id === partidoId);
  if (!p) return;
  const ganador = p.ganador_pareja_id === p.pareja1_id ? 1 : p.ganador_pareja_id === p.pareja2_id ? 2 : null;
  const horario = p.horario ? new Date(p.horario).toLocaleString("es-AR", { dateStyle: "full", timeStyle: "short" }) : "A definir";
  document.getElementById("partidoDetalleContenido").innerHTML = `
    ${matchVsRowHtml(p, ganador)}
    <p class="match-meta" style="margin-top:8px">${iconoPin()} ${p.cancha_nombre || "sin cancha"} · ${iconoReloj()} ${horario}</p>
    <p class="match-meta">${p.categoria ? `Categoría ${p.categoria} · ` : ""}${p.ronda || (p.grupo ? `Grupo ${p.grupo}` : "Fase de grupos")} · <span class="badge">${p.estado}</span></p>
    ${p.estado === "jugado" ? setsGridHtml(p.sets, ganador) + gamesGanadosBarHtml(p.sets, ganador) : ""}
  `;
  document.getElementById("partidoDetalleOverlay").style.display = "flex";
}
document.getElementById("btnCerrarPartidoDetalle").addEventListener("click", () => { document.getElementById("partidoDetalleOverlay").style.display = "none"; });
document.getElementById("partidoDetalleOverlay").addEventListener("click", (e) => {
  if (e.target.id === "partidoDetalleOverlay") document.getElementById("partidoDetalleOverlay").style.display = "none";
});

// ---------- Administración: Partidos (Lista con acciones, o Planilla arrastrable solo PC) ----------
let ultimosPartidosGestion = [];
let ultimasCanchasTorneoGestion = [];
let ultimasParejasGestion = [];
let vistaPartidosAdmin = "lista"; // lista | planilla

function renderPartidosAdmin(partidos, canchasTorneo, parejasTorneo) {
  ultimosPartidosGestion = partidos;
  ultimasCanchasTorneoGestion = canchasTorneo;
  if (parejasTorneo) ultimasParejasGestion = parejasTorneo;
  if (vistaPartidosAdmin === "planilla" && window.matchMedia("(max-width:767px)").matches) {
    // decisión: el drag-and-drop nativo no funciona por touch y no se agrega
    // ninguna librería para simularlo — en mobile se usa la Lista, donde cada
    // partido sin horario ya tiene sus propios inputs de cancha/horario
    toast('La planilla (arrastrar y soltar) solo está disponible en PC — mostrando "Lista"');
    vistaPartidosAdmin = "lista";
    document.querySelectorAll("#partidosVistaPills .pill").forEach((b) => b.classList.toggle("active", b.dataset.vista === "lista"));
  }
  const q = partidosBusquedaFiltro.trim().toLowerCase();
  let visibles = partidosCategoriaFiltro ? partidos.filter((p) => p.categoria === partidosCategoriaFiltro) : partidos;
  if (q) visibles = visibles.filter((p) => `${p.pareja1_nombre || ""} ${p.pareja2_nombre || ""}`.toLowerCase().includes(q));

  const contLista = document.getElementById("admPartidosLista");
  const contLlave = document.getElementById("admPartidosLlave");
  const contTabla = document.getElementById("admPartidosTabla");
  contLista.style.display = "none";
  contLlave.style.display = "none";
  contTabla.style.display = "none";
  if (vistaPartidosAdmin === "llave") {
    contLlave.style.display = "block";
    // la llave (y la tabla, más abajo) agrupan por fase/zona -- mezclar
    // categorías distintas en un mismo cuadro no tiene sentido, así que acá sí
    // hace falta elegir una.
    contLlave.innerHTML = partidosCategoriaFiltro
      ? ""
      : '<p class="empty">Elegí una categoría arriba para ver su llave.</p>';
    if (partidosCategoriaFiltro) renderPartidosLlave("admPartidosLlave", visibles);
  } else if (vistaPartidosAdmin === "tabla") {
    contTabla.style.display = "block";
    contTabla.innerHTML = partidosCategoriaFiltro
      ? ""
      : '<p class="empty">Elegí una categoría arriba para ver su tabla.</p>';
    if (partidosCategoriaFiltro) renderPartidosTabla("admPartidosTabla", visibles, canchasTorneo, ultimasParejasGestion);
  } else {
    contLista.style.display = "block";
    if (vistaPartidosAdmin === "planilla") renderPartidosCalendario("admPartidosLista", visibles, canchasTorneo, true);
    else renderPartidosLista("admPartidosLista", visibles, canchasTorneo, true, ultimasParejasGestion);
  }
}
document.querySelectorAll("#partidosVistaPills .pill").forEach((btn) => {
  btn.addEventListener("click", () => {
    vistaPartidosAdmin = btn.dataset.vista;
    document.querySelectorAll("#partidosVistaPills .pill").forEach((b) => b.classList.toggle("active", b === btn));
    renderPartidosAdmin(ultimosPartidosGestion, ultimasCanchasTorneoGestion);
  });
});
document.getElementById("partidosCategoriaFiltro").addEventListener("change", (e) => {
  partidosCategoriaFiltro = e.target.value;
  renderPartidosAdmin(ultimosPartidosGestion, ultimasCanchasTorneoGestion);
});
document.getElementById("partidosBusqueda").addEventListener("input", (e) => {
  partidosBusquedaFiltro = e.target.value;
  renderPartidosAdmin(ultimosPartidosGestion, ultimasCanchasTorneoGestion);
});

// resultado por sets como grilla de casillas (una fila por pareja, una casilla por
// set) en vez de un "6-3, 6-4" suelto — la fila ganadora se resalta, igual que en
// la vista Llave, así se ve consistente en todos lados donde aparece un resultado
function setsGridHtml(sets, ganador) {
  if (!sets || sets.length === 0) return "";
  const fila = (lado) => `<div class="sets-grid-fila ${ganador === lado ? "gana" : ""}">${sets.map((s) => `<span class="sets-grid-box">${lado === 1 ? s.p1 : s.p2}</span>`).join("")}</div>`;
  return `<div class="sets-grid">${fila(1)}${fila(2)}</div>`;
}

// barra comparando el total de games ganados por cada pareja — se calcula sumando
// los sets que ya guarda el partido, no agrega ningún dato nuevo. Solo tiene sentido
// en el detalle (con más aire), no en las tarjetas compactas de la lista/calendario.
function gamesGanadosBarHtml(sets, ganador) {
  if (!sets || sets.length === 0) return "";
  const t1 = sets.reduce((acc, s) => acc + s.p1, 0);
  const t2 = sets.reduce((acc, s) => acc + s.p2, 0);
  const total = t1 + t2 || 1;
  const cls = (lado) => (ganador === lado ? "gana" : ganador ? "pierde" : "");
  return `<div class="games-bar">
    <div class="games-bar-label"><span>Games ganados</span></div>
    <div class="games-bar-track">
      <div class="games-bar-fill ${cls(1)}" style="width:${(t1 / total) * 100}%"></div>
      <div class="games-bar-fill ${cls(2)}" style="width:${(t2 / total) * 100}%"></div>
    </div>
    <div class="games-bar-nums"><span class="${cls(1)}">${t1}</span><span class="${cls(2)}">${t2}</span></div>
  </div>`;
}

// convierte un horario guardado (ISO, UTC) al formato que espera un input
// datetime-local (hora local, sin zona) para poder mostrarlo precargado
function toDatetimeLocalValue(horarioISO) {
  if (!horarioISO) return "";
  const d = new Date(horarioISO);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderPartidosLista(containerId, partidos, canchasTorneo, editable, parejasTorneo = []) {
  const cont = document.getElementById(containerId);
  cont.innerHTML = "";
  if (partidos.length === 0) {
    cont.innerHTML = '<p class="empty">Todavía no hay partidos armados.</p>';
    return;
  }
  partidos.forEach((p) => {
    const div = document.createElement("div");
    const ganador = p.ganador_pareja_id === p.pareja1_id ? 1 : p.ganador_pareja_id === p.pareja2_id ? 2 : null;
    // un "bye" (pasó de ronda sin rival) queda con estado='jugado' pero no
    // tiene ningún resultado real que proteger -- si el bye está mal (el
    // cruce en realidad tenía que jugarse contra alguien) el admin tiene que
    // poder arreglarlo con "Cambiar parejas" igual que un partido programado,
    // en vez de quedar trabado para siempre por figurar como "jugado".
    const esByeSinJugar = p.estado === "jugado" && !p.pareja2_id;
    div.className = "match-card" + (p.estado === "jugado" ? " match-card-jugado" : "") + (!editable ? " clickeable" : "");
    if (!editable) div.dataset.abrirPartido = p.id;
    const horario = p.horario ? new Date(p.horario).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) : "sin horario";
    div.innerHTML = `
      ${matchVsRowHtml(p, ganador)}
      <div class="match-meta">${iconoPin()} ${p.cancha_nombre || "sin cancha"} · ${iconoReloj()} ${horario} · <span class="badge">${p.estado}</span>${p.ronda && p.ronda !== "Fase de grupos" ? ` <span class="badge orange">${p.ronda}</span>` : (p.grupo ? ` <span class="badge orange">Grupo ${p.grupo}</span>` : "")}${!partidosCategoriaFiltro && p.categoria ? ` <span class="badge">${p.categoria}</span>` : ""}</div>
      ${p.estado === "jugado" ? setsGridHtml(p.sets, ganador) : ""}
      ${editable && p.estado === "jugado" && !esByeSinJugar ? `
      <div class="match-actions">
        <button type="button" class="secondary small btnTogglePartidoAdmin" data-p="${p.id}">✏️ Corregir resultado</button>
      </div>
      ${cargaResultadoPanelHtml(p, true)}` : ""}
      ${editable && (p.estado !== "jugado" || esByeSinJugar) ? `
      ${cargaResultadoPanelHtml(p)}
      <div class="match-admin-panel">
        <div class="match-actions">
          <select class="selectReasignar" data-p="${p.id}">
            ${[...canchasTorneo].sort((a, b) => compararCanchas(a.canchas, b.canchas)).map((c) => {
              // se antepone el predio (mismo formato "Predio · Cancha" que ya se usa
              // en el resto de la app) porque con varios predios usando nombres tipo
              // "Cancha 1" repetidos, mostrar solo el nombre de la cancha no alcanza
              // para saber cuál es cuál.
              const complejo = cacheComplejos.find((x) => x.id === c.canchas?.complejo_id);
              return `<option value="${c.canchas?.id}" ${c.canchas?.id === p.cancha_id ? "selected" : ""}>${complejo ? complejo.nombre + " · " : ""}${c.canchas?.nombre}</option>`;
            }).join("")}
          </select>
          <button class="secondary small btnReasignarCancha" data-p="${p.id}">Cambiar cancha</button>
        </div>
        <div class="match-actions">
          <input type="datetime-local" class="inputHorario" data-p="${p.id}" value="${toDatetimeLocalValue(p.horario)}" style="flex:1" />
          <button class="secondary small btnCambiarHorario" data-p="${p.id}">${p.horario ? "Cambiar horario" : "Asignar horario"}</button>
        </div>
        ${parejasTorneo.length ? `
        <div class="match-actions">
          <select class="selectCambiarPareja1" data-p="${p.id}">
            ${parejasTorneo.filter((pj) => pj.categoria === p.categoria).map((pj) => `<option value="${pj.id}" ${pj.id === p.pareja1_id ? "selected" : ""}>${escapeHtml(pj.jugador1_nombre)} / ${escapeHtml(pj.jugador2_nombre)}</option>`).join("")}
          </select>
          <select class="selectCambiarPareja2" data-p="${p.id}">
            ${parejasTorneo.filter((pj) => pj.categoria === p.categoria).map((pj) => `<option value="${pj.id}" ${pj.id === p.pareja2_id ? "selected" : ""}>${escapeHtml(pj.jugador1_nombre)} / ${escapeHtml(pj.jugador2_nombre)}</option>`).join("")}
          </select>
          <button class="secondary small btnCambiarParejas" data-p="${p.id}">Cambiar parejas</button>
        </div>` : ""}
      </div>` : ""}
    `;
    cont.appendChild(div);
  });

  if (!editable) {
    cont.querySelectorAll("[data-abrir-partido]").forEach((el) => {
      el.addEventListener("click", () => abrirDetallePartido(el.dataset.abrirPartido));
    });
    return;
  }

  wireAccionesPartidoAdmin(cont);
}

// Engancha TODAS las acciones de edición de un partido dentro de `cont`: cargar/
// corregir resultado (wireCargaResultado), reasignar cancha, cambiar horario y
// cambiar parejas. Vive aparte de renderPartidosLista para que la vista Tabla
// (renderPartidosTabla) pueda reusar exactamente el mismo comportamiento y
// validaciones en vez de duplicarlas — un solo lugar donde arreglar un bug o
// agregar una validación nueva. Todo acá adentro lee sus datos de ids en el DOM
// (data-p) y de los globales ya cargados (ultimosPartidosGestion, torneoGestionData,
// etc.), así que no hace falta pasarle más que el contenedor.
function wireAccionesPartidoAdmin(cont) {
  // sets-entry (Set 3 condicional) + guardado de resultado: lógica compartida
  // con la tarjeta pública de la vista Llave, ver wireCargaResultado.
  wireCargaResultado(cont);

  cont.querySelectorAll(".btnReasignarCancha").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
      const partidoId = btn.dataset.p;
      const nuevaCancha = cont.querySelector(`.selectReasignar[data-p="${partidoId}"]`).value;
      const partido = ultimosPartidosGestion.find((x) => x.id === partidoId);
      const bloqueosDeCancha = bloqueosPorCanchaMapa()[nuevaCancha] || [];
      const duracion = torneoGestionData?.duracion_minutos || 90;
      if (partido?.horario && hayConflictoCancha(ultimosPartidosGestion, partidoId, nuevaCancha, partido.horario, duracion, bloqueosDeCancha)) {
        toast("Esa cancha ya tiene otro partido a esa hora (o está bloqueada, o alguna pareja ya juega a esa hora) — elegí otra cancha o cambiá primero el horario");
        return;
      }
      const { error } = await sb.from("partidos").update({ cancha_id: nuevaCancha }).eq("id", partidoId);
      if (error) { toast("Error: " + error.message); return; }
      toast("Cancha reasignada");
      avisarActualizacionEnVivo();
      refrescarTrasAccionGestion();
      } finally {
        btn.disabled = false;
      }
    });
  });

  // mover un partido a otro horario (por ejemplo, si un equipo avisa que no llega
  // a la hora que tenía asignada, o para asignarle horario a uno que no tenía) —
  // reusa el mismo chequeo de choques de cancha, incluyendo bloqueos
  cont.querySelectorAll(".btnCambiarHorario").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
      const partidoId = btn.dataset.p;
      const valor = cont.querySelector(`.inputHorario[data-p="${partidoId}"]`).value;
      if (!valor) { toast("Elegí una fecha y hora"); return; }
      const nuevoHorarioISO = new Date(valor).toISOString();
      const partido = ultimosPartidosGestion.find((x) => x.id === partidoId);
      const canchaId = partido?.cancha_id || cont.querySelector(`.selectReasignar[data-p="${partidoId}"]`)?.value;
      const bloqueosDeCancha = canchaId ? (bloqueosPorCanchaMapa()[canchaId] || []) : [];
      const duracion = torneoGestionData?.duracion_minutos || 90;
      if (canchaId && hayConflictoCancha(ultimosPartidosGestion, partidoId, canchaId, nuevoHorarioISO, duracion, bloqueosDeCancha)) {
        toast("Esa cancha ya tiene otro partido a esa hora (o está bloqueada, o alguna pareja ya juega a esa hora) — elegí otro horario");
        return;
      }
      const cambios = { horario: nuevoHorarioISO };
      if (!partido?.cancha_id && canchaId) cambios.cancha_id = canchaId;
      const { error } = await sb.from("partidos").update(cambios).eq("id", partidoId);
      if (error) { toast("Error: " + error.message); return; }
      // si este partido no tenía horario todavía, es la primera vez que esta
      // categoría tiene algo calendarizado — marcarla acá también (no solo en
      // "Generar calendario") es necesario para que la categoría no quede
      // marcada "sin calendario" para siempre. Si ya estaba publicada, el
      // cambio se ve al toque; si no, entra como borrador (falta "Publicar
      // calendario") igual que el resto de los caminos que asignan horario.
      if (!partido?.horario && partido?.categoria) {
        const { data: catActual } = await sb.from("torneo_categorias").select("estado_fase").eq("torneo_id", torneoGestionId).eq("categoria", partido.categoria).maybeSingle();
        const yaPublicada = catActual && (catActual.estado_fase === "calendario_confirmado" || catActual.estado_fase === "finalizada");
        await sb.from("torneo_categorias").update({ estado_fase: yaPublicada ? "calendario_confirmado" : "calendario_borrador" }).eq("torneo_id", torneoGestionId).eq("categoria", partido.categoria);
        if (yaPublicada) await actualizarEstadoTorneoPorFases(torneoGestionId);
      }
      toast("Horario cambiado");
      avisarActualizacionEnVivo();
      refrescarTrasAccionGestion();
      } finally {
        btn.disabled = false;
      }
    });
  });

  // corrige quién juega un partido sin resultado todavía — para arreglar a
  // mano una zona/cruce del cuadro (o cualquier otro partido) sin tener que
  // borrarlo y armarlo de nuevo. Nunca toca partidos ya jugados (ahí hay que
  // usar la corrección de resultado, que sí revierte el ranking).
  cont.querySelectorAll(".btnCambiarParejas").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
      const partidoId = btn.dataset.p;
      const p1 = cont.querySelector(`.selectCambiarPareja1[data-p="${partidoId}"]`).value;
      const p2 = cont.querySelector(`.selectCambiarPareja2[data-p="${partidoId}"]`).value;
      if (!p1 || !p2 || p1 === p2) { toast("Elegí dos parejas distintas"); return; }
      const partido = ultimosPartidosGestion.find((x) => x.id === partidoId);
      const cambios = { pareja1_id: p1, pareja2_id: p2 };
      // si esto era un "bye" (pasaba de ronda sin rival) y ahora se le asigna
      // un rival real, deja de estar "jugado": vuelve a programado y se le
      // borra el resultado automático del bye para poder cargar el real
      if (partido?.estado === "jugado" && !partido?.pareja2_id) {
        cambios.estado = "programado"; cambios.ganador_pareja_id = null; cambios.sets = null;
      }
      const { error } = await sb.from("partidos").update(cambios).eq("id", partidoId);
      if (error) { toast("Error: " + error.message); return; }
      // si este cruce alimenta al cuadro de zonas, la corrección tiene que
      // poder llegar a las rondas siguientes ya armadas (misma lógica que al
      // cargar un resultado)
      if (partido?.slot_cuadro) {
        const { avisos } = await propagarCuadro(partido.categoria, torneoGestionId);
        avisos.forEach((a) => toast(a));
      }
      toast("Parejas actualizadas");
      avisarActualizacionEnVivo();
      refrescarTrasAccionGestion();
      } finally {
        btn.disabled = false;
      }
    });
  });

  // arma a mano, ya mismo, un cruce que la plantilla del cuadro todavía no
  // generó automáticamente (fila proyectada tipo "Ganador Z1 vs Perdedor Z7"
  // en la vista Tabla) — mismo inserte que hace generarSiguienteRondaCuadro
  // para una ronda entera, pero acá para un solo slot elegido a mano, así se
  // puede corregir un error o adelantar un cruce sin esperar a "Generar
  // siguiente fase". Solo aplica a slots que todavía no existen como partido
  // real (ver filaProyectadaHtml, en renderPartidosTabla).
  cont.querySelectorAll(".btnArmarCruceManual").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
      const slot = btn.dataset.slot;
      const nombreRonda = btn.dataset.ronda;
      const p1 = cont.querySelector(`.selectArmarCruce1[data-slot="${slot}"]`).value;
      const p2 = cont.querySelector(`.selectArmarCruce2[data-slot="${slot}"]`).value;
      if (!p1 || !p2 || p1 === p2) { toast("Elegí dos parejas distintas"); return; }
      const categoria = partidosCategoriaFiltro;
      const { error } = await sb.from("partidos").insert({
        torneo_id: torneoGestionId, categoria, ronda: RONDA_DISPLAY_CUADRO[nombreRonda] || nombreRonda,
        slot_cuadro: slot, pareja1_id: p1, pareja2_id: p2, estado: "programado"
      });
      if (error) { toast("Error: " + error.message); return; }
      // por si esta era la última pieza que faltaba de su ronda y otro cruce
      // de la misma ronda ya estaba armado con un rival provisorio distinto
      await propagarCuadro(categoria, torneoGestionId);
      toast("Cruce armado");
      avisarActualizacionEnVivo();
      refrescarTrasAccionGestion();
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// vista "tabla": el cuadro de zonas como planilla real — una fila por cruce
// (Z1, Z2, Octavos 1...) con pareja 1/2, resultado, ganadora, cancha/horario y
// un ✏️ que despliega debajo el mismo editor que ya usa la Lista (cargar
// resultado, reasignar cancha, cambiar horario, cambiar parejas — ver
// wireAccionesPartidoAdmin). No es un cuadro nuevo: son los mismos partidos de
// siempre mostrados como tabla en vez de tarjetas, así que cualquier cambio acá
// (incluida la propagación automática a la fase siguiente) es exactamente el
// mismo que ya corre en Lista/Llave — no hay una segunda fuente de verdad.
function renderPartidosTabla(containerId, partidos, canchasTorneo, parejasTorneo) {
  const cont = document.getElementById(containerId);
  if (partidos.length === 0) {
    cont.innerHTML = '<p class="empty">Todavía no hay partidos armados.</p>';
    return;
  }
  const ORDEN_FASES_TABLA = ["Zona", "Dieciseisavos", "Octavos", "Cuartos", "Semifinal", "Final"];
  const rondaDe = (p) => (p.ronda === "Fase de grupos" || !p.ronda ? "Zona" : p.ronda);
  const numeroDe = (p) => Number((p.slot_cuadro || "").slice(1)) || p.grupo || 0;
  const ordenados = [...partidos].sort((a, b) => {
    const ia = ORDEN_FASES_TABLA.indexOf(rondaDe(a)), ib = ORDEN_FASES_TABLA.indexOf(rondaDe(b));
    if (ia !== ib) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return numeroDe(a) - numeroDe(b);
  });

  const filaHtml = (p) => {
    const ganador = p.ganador_pareja_id === p.pareja1_id ? 1 : p.ganador_pareja_id === p.pareja2_id ? 2 : null;
    const sets = p.sets || [];
    const resultado = sets.length ? sets.map((s) => `${s.p1}-${s.p2}`).join(", ") : "—";
    const horario = p.horario ? new Date(p.horario).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "sin horario";
    const local = p.cancha_nombre ? `${p.complejo_nombre ? p.complejo_nombre + " · " : ""}${p.cancha_nombre}` : "sin cancha";
    const slot = p.slot_cuadro || (p.grupo ? `G${p.grupo}` : "—");
    const nombreGanadora = ganador === 1 ? p.pareja1_nombre : ganador === 2 ? p.pareja2_nombre : null;
    return `
      <tr class="tabla-cuadro-fila">
        <td class="tabla-cuadro-slot">${escapeHtml(slot)}</td>
        <td><span class="badge orange">${escapeHtml(rondaDe(p))}</span></td>
        <td class="${ganador === 1 ? "tabla-cuadro-ganadora" : ""}">${escapeHtml(p.pareja1_nombre || "—")}</td>
        <td class="${ganador === 2 ? "tabla-cuadro-ganadora" : ""}">${escapeHtml(p.pareja2_nombre || "—")}</td>
        <td>${escapeHtml(resultado)}</td>
        <td class="tabla-cuadro-ganadora">${nombreGanadora ? escapeHtml(nombreGanadora) : "—"}</td>
        <td class="tabla-cuadro-meta">${escapeHtml(local)} · ${escapeHtml(horario)}</td>
        <td><button type="button" class="tabla-cuadro-editbtn" data-toggle-fila="${p.id}" title="Editar" aria-label="Editar ${escapeHtml(slot)}">✏️</button></td>
      </tr>
      <tr class="tabla-cuadro-editrow" data-fila-edicion="${p.id}" style="display:none">
        <td colspan="8">
          ${cargaResultadoPanelHtml(p)}
          <div class="match-admin-panel" draggable="false">
            <div class="match-actions">
              <select class="selectReasignar" data-p="${p.id}">
                ${[...canchasTorneo].sort((a, b) => compararCanchas(a.canchas, b.canchas)).map((c) => {
                  const complejo = cacheComplejos.find((x) => x.id === c.canchas?.complejo_id);
                  return `<option value="${c.canchas?.id}" ${c.canchas?.id === p.cancha_id ? "selected" : ""}>${complejo ? complejo.nombre + " · " : ""}${c.canchas?.nombre}</option>`;
                }).join("")}
              </select>
              <button class="secondary small btnReasignarCancha" data-p="${p.id}">Cambiar cancha</button>
            </div>
            <div class="match-actions">
              <input type="datetime-local" class="inputHorario" data-p="${p.id}" value="${toDatetimeLocalValue(p.horario)}" style="flex:1" />
              <button class="secondary small btnCambiarHorario" data-p="${p.id}">${p.horario ? "Cambiar horario" : "Asignar horario"}</button>
            </div>
            ${parejasTorneo.length ? `
            <div class="match-actions">
              <select class="selectCambiarPareja1" data-p="${p.id}">
                ${parejasTorneo.filter((pj) => pj.categoria === p.categoria).map((pj) => `<option value="${pj.id}" ${pj.id === p.pareja1_id ? "selected" : ""}>${escapeHtml(pj.jugador1_nombre)} / ${escapeHtml(pj.jugador2_nombre)}</option>`).join("")}
              </select>
              <select class="selectCambiarPareja2" data-p="${p.id}">
                ${parejasTorneo.filter((pj) => pj.categoria === p.categoria).map((pj) => `<option value="${pj.id}" ${pj.id === p.pareja2_id ? "selected" : ""}>${escapeHtml(pj.jugador1_nombre)} / ${escapeHtml(pj.jugador2_nombre)}</option>`).join("")}
              </select>
              <button class="secondary small btnCambiarParejas" data-p="${p.id}">Cambiar parejas</button>
            </div>` : ""}
          </div>
        </td>
      </tr>`;
  };

  // Filas proyectadas: rondas del cuadro del club que todavía no se armaron
  // como partido real (falta que se jueguen las zonas u otras rondas previas)
  // pero que ya se sabe, por la plantilla, quién entraría a cada cruce — ej.
  // "Octavos 1: Ganador Z1 vs Perdedor Z7". Solo aplica al formato del club
  // (cuadro_zonas). El ✏️ deja armar el cruce YA, a mano, eligiendo las dos
  // parejas — para corregir un error o adelantarlo sin esperar a que
  // "Generar siguiente fase" lo resuelva solo (ver btnArmarCruceManual, en
  // wireAccionesPartidoAdmin).
  const nZonas = partidos.filter((p) => p.slot_cuadro && p.slot_cuadro[0] === "Z").length;
  const slotsYaArmados = new Set(partidos.map((p) => p.slot_cuadro).filter(Boolean));
  const proyectadas = nZonas
    ? proyeccionCuadroCompleto(nZonas).filter((f) => !slotsYaArmados.has(f.slot))
    : [];
  const categoriaTabla = partidos[0]?.categoria;
  const parejasCategoriaTabla = parejasTorneo.filter((pj) => pj.categoria === categoriaTabla);
  const filaProyectadaHtml = (f) => `
    <tr class="tabla-cuadro-fila tabla-cuadro-proyectada">
      <td class="tabla-cuadro-slot">${escapeHtml(f.slot)}</td>
      <td><span class="badge orange">${escapeHtml(RONDA_DISPLAY_CUADRO[f.ronda] || f.ronda)}</span></td>
      <td>${escapeHtml(refLabelCuadro(f.refA))}</td>
      <td>${escapeHtml(refLabelCuadro(f.refB))}</td>
      <td>—</td>
      <td>—</td>
      <td class="tabla-cuadro-meta">a definir</td>
      <td>${parejasCategoriaTabla.length ? `<button type="button" class="tabla-cuadro-editbtn" data-toggle-fila="${f.slot}" title="Armar a mano" aria-label="Armar ${escapeHtml(f.slot)} a mano">✏️</button>` : ""}</td>
    </tr>
    ${parejasCategoriaTabla.length ? `
    <tr class="tabla-cuadro-editrow" data-fila-edicion="${f.slot}" style="display:none">
      <td colspan="8">
        <p class="tabla-cuadro-proyectada-aviso">Todavía no se generó este cruce automáticamente (falta algún resultado anterior). Elegí las dos parejas para armarlo ya — por ejemplo, para corregir un error sin esperar a "Generar siguiente fase".</p>
        <div class="match-actions">
          <select class="selectArmarCruce1" data-slot="${f.slot}" data-ronda="${f.ronda}">
            <option value="">Pareja 1…</option>
            ${parejasCategoriaTabla.map((pj) => `<option value="${pj.id}">${escapeHtml(pj.jugador1_nombre)} / ${escapeHtml(pj.jugador2_nombre)}</option>`).join("")}
          </select>
          <select class="selectArmarCruce2" data-slot="${f.slot}" data-ronda="${f.ronda}">
            <option value="">Pareja 2…</option>
            ${parejasCategoriaTabla.map((pj) => `<option value="${pj.id}">${escapeHtml(pj.jugador1_nombre)} / ${escapeHtml(pj.jugador2_nombre)}</option>`).join("")}
          </select>
          <button class="secondary small btnArmarCruceManual" data-slot="${f.slot}" data-ronda="${f.ronda}">Armar cruce</button>
        </div>
      </td>
    </tr>` : ""}`;

  cont.innerHTML = `
    <div class="tabla-cuadro-scroll">
      <table class="tabla-cuadro">
        <thead><tr><th>Slot</th><th>Ronda</th><th>Pareja 1</th><th>Pareja 2</th><th>Resultado</th><th>Ganadora</th><th>Cancha · horario</th><th></th></tr></thead>
        <tbody>${ordenados.map(filaHtml).join("")}${proyectadas.map(filaProyectadaHtml).join("")}</tbody>
      </table>
    </div>`;

  // el ✏️ de esta vista despliega la fila entera de edición (no el mini-panel
  // interno de wireCargaResultado, que acá se muestra siempre abierto una vez
  // desplegada la fila) — por eso usa su propia clase y no .btnTogglePartidoAdmin.
  cont.querySelectorAll(".tabla-cuadro-editbtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const fila = cont.querySelector(`[data-fila-edicion="${btn.dataset.toggleFila}"]`);
      if (fila) fila.style.display = fila.style.display === "none" ? "table-row" : "none";
    });
  });
  wireAccionesPartidoAdmin(cont);
}

// ============================================================
// SPONSORS / PUBLICIDAD
// ============================================================
// JPG no tiene transparencia (siempre trae algún fondo propio, aunque sea blanco
// liso) — a esos no les agregamos la caja blanca de contraste, porque quedaría
// una caja adentro de otra. PNG (y el resto) sí suelen ser logos con fondo
// transparente y necesitan la caja blanca para leerse sobre el fondo oscuro.
function renderSponsorItem(s, caption) {
  const esJpg = /\.jpe?g(\?|#|$)/i.test(s.logo_url || "");
  // El nombre viaja dos veces adentro de este mismo atributo: primero como
  // literal de un string JS (adentro de comillas simples, dentro del
  // onerror="..."), después como valor de atributo HTML propiamente dicho.
  // Hace falta escapar las dos capas por separado y en este orden — si sólo
  // se escapara una, una comilla doble en el nombre rompe el atributo, o una
  // barra invertida rompe el escape de la comilla simple del string JS.
  const nombreJs = String(s.nombre ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const onerror = escapeHtml(`this.replaceWith(Object.assign(document.createElement('span'),{className:'sponsor-caption',textContent:'${nombreJs}'}))`);
  const contenido = `<img src="${s.logo_url}" alt="${escapeHtml(s.nombre)}" loading="lazy" onerror="${onerror}" />` +
    (caption ? `<span class="sponsor-caption">${escapeHtml(caption)}</span>` : "");
  const clase = "sponsor-item" + (esJpg ? " sponsor-sin-fondo" : "");
  return s.link_url
    ? `<a href="${s.link_url}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(s.nombre)}" class="${clase}">${contenido}</a>`
    : `<span class="${clase}" title="${escapeHtml(s.nombre)}">${contenido}</span>`;
}

async function cargarSponsors() {
  const { data } = await sb.from("sponsors").select("*").eq("activo", true).order("orden");
  const admin = document.getElementById("listaSponsors");
  const inlineCard = document.getElementById("sponsorsInlineCard");
  const inline = document.getElementById("sponsorsInline");
  const marqueeCard = document.getElementById("sponsorMarqueeMobile");
  const marqueeTrack = document.getElementById("sponsorMarqueeTrack");

  if (admin) {
    admin.innerHTML = (data && data.length > 0)
      ? data.map((s) => renderSponsorItem(s, s.torneo_id ? (cacheTorneos.find((t) => t.id === s.torneo_id)?.nombre || "torneo") : "General")).join("")
      : '<p class="empty">Todavía no cargaste auspiciantes.</p>';
  }

  const generales = (data || []).filter((s) => !s.torneo_id);
  if (generales.length > 0) {
    if (inline) inline.innerHTML = generales.map((s) => renderSponsorItem(s)).join("");
    if (inlineCard) inlineCard.style.display = "block";
    if (marqueeTrack) {
      const items = generales.map((s) => renderSponsorItem(s)).join("");
      marqueeTrack.innerHTML = items + items; // duplicado exacto x2: lo pide marquee-scroll para el loop sin corte
    }
    if (marqueeCard) marqueeCard.style.display = "block";
  } else {
    if (inlineCard) inlineCard.style.display = "none";
    if (marqueeCard) marqueeCard.style.display = "none";
  }
}

// ============================================================
// CARRUSEL DE HERO (Inicio, escritorio): slides 2 y 3 son fijas (Torneos,
// Ranking) con el mismo patrón .hero-club de siempre, cada una con su propia
// foto de fondo — antes la slide de Torneos mostraba el afiche del torneo
// destacado (#flyerDestacado) recortado a la fuerza en un rectángulo ancho,
// lo que lo deformaba/tapaba mal; ahora esa slide es genérica (habla de
// "torneos" en general, no de uno puntual) y el afiche real del próximo
// torneo se ve como siempre más abajo, en "Próximos torneos", en su
// proporción original. Los puntos se arman con JS chico + scroll-snap
// nativo, sin ninguna librería de carrusel.
// ============================================================
function moverFlyerDestacadoSegunAncho() {
  const slotTorneo = document.getElementById("heroSlideTorneo");
  const slotRanking = document.getElementById("heroSlideRanking");
  const dotsWrap = document.getElementById("heroCarouselDots");
  if (!slotTorneo || !dotsWrap) return;
  // en mobile el carrusel vuelve a ser una sola slide (el hero de siempre) —
  // las otras 2 (torneos, ranking) solo existen como slides en escritorio,
  // donde reemplazan a la columna lateral que ya no está.
  const esDesktop = window.matchMedia("(min-width: 960px)").matches;
  slotTorneo.hidden = !esDesktop;
  if (slotRanking) slotRanking.hidden = !esDesktop;
  dotsWrap.classList.toggle("visible", esDesktop);
  actualizarPuntosCarrusel("heroCarouselTrack", "heroCarouselDots");
  reiniciarAutoplayCarrusel("heroCarouselTrack");
}
window.matchMedia("(min-width: 960px)").addEventListener("change", moverFlyerDestacadoSegunAncho);

// Autoplay genérico de carrusel (lo usan el hero de Inicio y el de "Próximos
// partidos" en escritorio): pasa a la slide siguiente cada 6s, en loop. Se
// reinicia (en vez de seguir corriendo) cada vez que el usuario interactúa a
// mano (clic en un punto o touch/drag sobre el track) para no pelearle el
// gesto, y respeta prefers-reduced-motion (no forzar animación a quien la
// desactivó). El timer se guarda en el propio elemento del track para que
// cada carrusel tenga el suyo, sin pisarse entre sí.
function avanzarCarrusel(trackId) {
  const track = document.getElementById(trackId);
  if (!track) return;
  const visibles = Array.from(track.children).filter((el) => !el.hidden);
  if (visibles.length < 2) return;
  const actual = Math.round(track.scrollLeft / (track.clientWidth || 1));
  track.scrollTo({ left: track.clientWidth * ((actual + 1) % visibles.length), behavior: "smooth" });
}
function reiniciarAutoplayCarrusel(trackId) {
  const track = document.getElementById(trackId);
  if (!track) return;
  clearInterval(track._autoplayTimer);
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  track._autoplayTimer = setInterval(() => avanzarCarrusel(trackId), 6000);
}

// arma (una sola vez por cambio de cantidad) los puntos del carrusel indicado
// y resalta el que corresponde a la slide visible según el scroll del track.
// dotsSiempreVisibles=true es para carruseles que no tienen la lógica de
// mostrar/ocultar puntos según ancho (como el hero) -- simplemente cuentan
// las slides que haya en ese momento.
function actualizarPuntosCarrusel(trackId, dotsId, dotsSiempreVisibles) {
  const track = document.getElementById(trackId);
  const dotsWrap = document.getElementById(dotsId);
  if (!track || !dotsWrap) return;
  const cantidad = (dotsSiempreVisibles || dotsWrap.classList.contains("visible"))
    ? Array.from(track.children).filter((el) => !el.hidden).length
    : 0;
  if (dotsWrap.dataset.cantidad !== String(cantidad)) {
    dotsWrap.dataset.cantidad = String(cantidad);
    dotsWrap.innerHTML = Array.from({ length: cantidad }, (_, i) =>
      `<button type="button" class="hero-carousel-dot" data-slide="${i}" aria-label="Ir a la slide ${i + 1}"></button>`
    ).join("");
    dotsWrap.querySelectorAll(".hero-carousel-dot").forEach((dot) => {
      dot.addEventListener("click", () => {
        track.scrollTo({ left: track.clientWidth * Number(dot.dataset.slide), behavior: "smooth" });
        reiniciarAutoplayCarrusel(trackId);
      });
    });
  }
  const activo = cantidad ? Math.round(track.scrollLeft / (track.clientWidth || 1)) : -1;
  dotsWrap.querySelectorAll(".hero-carousel-dot").forEach((dot, i) => dot.classList.toggle("active", i === activo));
}
document.getElementById("heroCarouselTrack")?.addEventListener("pointerdown", () => reiniciarAutoplayCarrusel("heroCarouselTrack"));
document.getElementById("heroCarouselTrack")?.addEventListener("scroll", () => requestAnimationFrame(() => actualizarPuntosCarrusel("heroCarouselTrack", "heroCarouselDots")));
document.getElementById("destacadoCarouselTrack")?.addEventListener("pointerdown", () => reiniciarAutoplayCarrusel("destacadoCarouselTrack"));
document.getElementById("destacadoCarouselTrack")?.addEventListener("scroll", () => requestAnimationFrame(() => actualizarPuntosCarrusel("destacadoCarouselTrack", "destacadoCarouselDots", true)));

// Puntitos de scroll (distinto de actualizarPuntosCarrusel de arriba: ese es para
// carruseles de slides fijas de 100% de ancho -- acá el track tiene muchas
// tarjetas chicas seguidas, así que cada "punto" representa una pantalla completa
// de scroll, no una tarjeta) -- lo usa la tira de Campeones, para reemplazar la
// barra de scroll nativa por algo consistente con el resto de la app.
function actualizarPuntosScroll(trackId, dotsId) {
  const track = document.getElementById(trackId);
  const dotsWrap = document.getElementById(dotsId);
  if (!track || !dotsWrap) return;
  const paginas = Math.max(1, Math.ceil(track.scrollWidth / (track.clientWidth || 1)));
  dotsWrap.style.display = paginas <= 1 ? "none" : "";
  if (dotsWrap.dataset.cantidad !== String(paginas)) {
    dotsWrap.dataset.cantidad = String(paginas);
    dotsWrap.innerHTML = Array.from({ length: paginas }, (_, i) =>
      `<button type="button" class="hero-carousel-dot" data-pagina="${i}" aria-label="Ir a la página ${i + 1} de campeones"></button>`
    ).join("");
    dotsWrap.querySelectorAll(".hero-carousel-dot").forEach((dot) => {
      dot.addEventListener("click", () => {
        track.scrollTo({ left: track.clientWidth * Number(dot.dataset.pagina), behavior: "smooth" });
      });
    });
  }
  const maxScroll = track.scrollWidth - track.clientWidth;
  const activo = maxScroll > 0 ? Math.round((track.scrollLeft / maxScroll) * (paginas - 1)) : 0;
  dotsWrap.querySelectorAll(".hero-carousel-dot").forEach((dot, i) => dot.classList.toggle("active", i === activo));
}
document.getElementById("campeonesContenido")?.addEventListener("scroll", () => requestAnimationFrame(() => actualizarPuntosScroll("campeonesContenido", "campeonesDots")));
document.getElementById("mejoresCategoriaTrack")?.addEventListener("scroll", () => requestAnimationFrame(() => actualizarPuntosScroll("mejoresCategoriaTrack", "mejoresCategoriaDots")));
window.addEventListener("resize", () => requestAnimationFrame(() => {
  actualizarPuntosScroll("campeonesContenido", "campeonesDots");
  // acá se re-renderiza entero (no solo los puntos): a diferencia de Campeones,
  // la cantidad de tarjetas por página de "Mejores de cada categoría" depende
  // del ancho disponible (ver tarjetasPorPagina), así que un cambio de ancho
  // (rotar el celular, achicar la ventana) puede cambiar cuántas entran.
  renderMejoresPorCategoria();
}));

async function cargarSponsorsTorneo() {
  const cont = document.getElementById("dtSponsors");
  if (!cont || !torneoActualId) return;
  const { data } = await sb.from("sponsors").select("*").eq("activo", true)
    .or(`torneo_id.eq.${torneoActualId},torneo_id.is.null`).order("orden");
  if (data && data.length > 0) {
    cont.innerHTML = data.map((s) => renderSponsorItem(s)).join("");
    cont.style.display = "flex";
  } else {
    cont.innerHTML = "";
    cont.style.display = "none";
  }
}

document.getElementById("btnSubirSponsor").addEventListener("click", async () => {
  const btn = document.getElementById("btnSubirSponsor");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  const nombre = document.getElementById("spNombre").value.trim();
  const archivo = document.getElementById("spArchivo").files[0];
  if (!nombre || !archivo) { toast("Poné un nombre y elegí un logo"); return; }

  const path = `${Date.now()}-${archivo.name}`;
  const { error: upErr } = await sb.storage.from("sponsors").upload(path, archivo);
  if (upErr) { toast("Error subiendo logo: " + upErr.message); return; }

  const { data: pub } = sb.storage.from("sponsors").getPublicUrl(path);
  const linkUrl = document.getElementById("spLink").value.trim() || null;
  const torneoId = document.getElementById("spTorneo").value || null;
  const { error } = await sb.from("sponsors").insert({ nombre, logo_url: pub.publicUrl, link_url: linkUrl, torneo_id: torneoId });
  if (error) { toast("Error: " + error.message); return; }

  toast("Auspiciante agregado");
  document.getElementById("spNombre").value = "";
  document.getElementById("spLink").value = "";
  document.getElementById("spArchivo").value = "";
  document.getElementById("spTorneo").value = "";
  cargarSponsors();
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// FOTOS DEL TORNEO (galería pública, solo el admin sube/borra)
// ============================================================
// admin=true agrega el botón de borrar; reutiliza el mismo overlay/lightbox
// que ya usan las fotos de jugador (ver abrirFotoGrande más abajo).
function fotoTorneoItemHtml(foto, admin) {
  const borrar = admin ? `<button type="button" class="secondary small btnQuitarFoto" data-id="${foto.id}" aria-label="Borrar esta foto">✕</button>` : "";
  return `<div class="foto-item">
    <img src="${foto.url}" alt="Foto del torneo" loading="lazy" data-foto-grande="${foto.url}" tabindex="0" role="button" aria-label="Ver foto en grande" />
    ${borrar}
  </div>`;
}

async function cargarFotosTorneo() {
  const cont = document.getElementById("dtFotosGaleria");
  const vacio = document.getElementById("dtFotosVacio");
  if (!cont || !torneoActualId) return;
  const { data } = await sb.from("torneo_fotos").select("*").eq("torneo_id", torneoActualId).order("created_at", { ascending: false });
  const fotos = data || [];
  cont.innerHTML = fotos.map((f) => fotoTorneoItemHtml(f, false)).join("");
  if (vacio) vacio.style.display = fotos.length ? "none" : "block";
}

async function cargarFotosTorneoAdmin() {
  const cont = document.getElementById("admFotosLista");
  if (!cont || !torneoGestionId) return;
  const { data } = await sb.from("torneo_fotos").select("*").eq("torneo_id", torneoGestionId).order("created_at", { ascending: false });
  const fotos = data || [];
  cont.innerHTML = fotos.length
    ? fotos.map((f) => fotoTorneoItemHtml(f, true)).join("")
    : '<p class="empty">Todavía no subiste ninguna foto de este torneo.</p>';
  cont.querySelectorAll(".btnQuitarFoto").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const { error } = await sb.from("torneo_fotos").delete().eq("id", btn.dataset.id);
        if (error) { toast("Error: " + error.message); return; }
        toast("Foto eliminada");
        cargarFotosTorneoAdmin();
        if (torneoActualId === torneoGestionId) cargarFotosTorneo();
      } finally {
        btn.disabled = false;
      }
    });
  });
}

document.getElementById("btnSubirFotosTorneo").addEventListener("click", async () => {
  const btn = document.getElementById("btnSubirFotosTorneo");
  if (btn.disabled || !torneoGestionId) return;
  const input = document.getElementById("admFotosArchivos");
  const archivos = Array.from(input.files || []);
  if (!archivos.length) { toast("Elegí una o más fotos"); return; }
  btn.disabled = true;
  try {
    for (const archivo of archivos) {
      const path = `${torneoGestionId}/${Date.now()}-${archivo.name}`;
      const { error: upErr } = await sb.storage.from("fotos-torneos").upload(path, archivo);
      if (upErr) { toast("Error subiendo " + archivo.name + ": " + upErr.message); continue; }
      const { data: pub } = sb.storage.from("fotos-torneos").getPublicUrl(path);
      const { error } = await sb.from("torneo_fotos").insert({ torneo_id: torneoGestionId, url: pub.publicUrl });
      if (error) toast("Error guardando " + archivo.name + ": " + error.message);
    }
    toast("Fotos subidas");
    input.value = "";
    cargarFotosTorneoAdmin();
    if (torneoActualId === torneoGestionId) cargarFotosTorneo();
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// NOTICIAS (novedades del club en Inicio + botón a Instagram)
// ============================================================
function renderNoticiaCard(n) {
  const imagen = n.imagen_url ? `<img src="${n.imagen_url}" alt="${escapeHtml(n.titulo)}" loading="lazy" onerror="this.style.display='none'" />` : "";
  const contenido = `${imagen}<strong>${escapeHtml(n.titulo)}</strong>${n.texto ? `<p>${escapeHtml(n.texto)}</p>` : ""}` +
    (n.link ? `<a href="${n.link}" target="_blank" rel="noopener noreferrer" class="link-btn">Ver más →</a>` : "");
  return `<div class="noticia-card">${contenido}</div>`;
}

async function cargarNoticias() {
  const { data } = await sb.from("noticias").select("*").order("created_at", { ascending: false }).limit(10);

  const card = document.getElementById("noticiasCard");
  const ig = document.getElementById("noticiasInstagram");
  if (configApp.instagram_url) {
    ig.innerHTML = `<a href="${configApp.instagram_url}" target="_blank" rel="noopener noreferrer" class="secondary small">📸 Seguinos en Instagram</a>`;
  } else {
    ig.innerHTML = "";
  }
  const cont = document.getElementById("noticiasContenido");
  if (data && data.length > 0) {
    cont.innerHTML = data.map(renderNoticiaCard).join("");
    card.style.display = "block";
  } else if (configApp.instagram_url) {
    cont.innerHTML = "";
    card.style.display = "block";
  } else {
    card.style.display = "none";
  }

  const admin = document.getElementById("listaNoticiasAdmin");
  if (admin) {
    admin.innerHTML = (data && data.length > 0)
      ? data.map((n) => `<div class="match-card">${renderNoticiaCard(n)}<button type="button" class="secondary small danger btnBorrarNoticia" data-id="${n.id}" style="margin-top:8px">Borrar</button></div>`).join("")
      : '<p class="empty">Todavía no cargaste noticias.</p>';
    admin.querySelectorAll(".btnBorrarNoticia").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          await sb.from("noticias").delete().eq("id", btn.dataset.id);
          cargarNoticias();
        } finally {
          btn.disabled = false;
        }
      });
    });
  }
}

document.getElementById("btnSubirNoticia").addEventListener("click", async () => {
  const btn = document.getElementById("btnSubirNoticia");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
  const titulo = document.getElementById("ntTitulo").value.trim();
  if (!titulo) { toast("Poné un título"); return; }

  let imagenUrl = null;
  const archivo = document.getElementById("ntArchivo").files[0];
  if (archivo) {
    const path = `${Date.now()}-${archivo.name}`;
    const { error: upErr } = await sb.storage.from("noticias").upload(path, archivo);
    if (upErr) { toast("Error subiendo la imagen: " + upErr.message); return; }
    const { data: pub } = sb.storage.from("noticias").getPublicUrl(path);
    imagenUrl = pub.publicUrl;
  }

  const texto = document.getElementById("ntTexto").value.trim() || null;
  const link = document.getElementById("ntLink").value.trim() || null;
  const { error } = await sb.from("noticias").insert({ titulo, texto, imagen_url: imagenUrl, link });
  if (error) { toast("Error: " + error.message); return; }

  toast("Noticia agregada");
  document.getElementById("ntTitulo").value = "";
  document.getElementById("ntTexto").value = "";
  document.getElementById("ntLink").value = "";
  document.getElementById("ntArchivo").value = "";
  cargarNoticias();
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// NOTIFICACIONES
// ============================================================
async function pedirPermisoNotificaciones() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
}

function mostrarNotificacionLocal(mensaje) {
  toast("🔔 " + mensaje);
  if ("Notification" in window && Notification.permission === "granted") {
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then((reg) => reg.showNotification("Norte Padel", { body: mensaje, icon: "icon-192.png" }));
    } else {
      new Notification("Norte Padel", { body: mensaje });
    }
  }
}

async function actualizarContadorNotificaciones() {
  if (!miJugador) { document.getElementById("notifCount").textContent = ""; return; }
  const { count } = await sb.from("notificaciones").select("*", { count: "exact", head: true }).eq("jugador_id", miJugador.id).eq("leido", false);
  document.getElementById("notifCount").textContent = count ? `(${count})` : "";
}

// muestra nuevas e históricas juntas en una ventana, en vez de un toast fugaz
// que solo dejaba ver la más reciente
async function abrirNotificaciones() {
  if (!miJugador) { toast("Iniciá sesión para ver tus notificaciones"); cambiarVista("perfil"); return; }
  const { data } = await sb.from("notificaciones").select("*").eq("jugador_id", miJugador.id).order("created_at", { ascending: false }).limit(30);
  const lista = document.getElementById("listaNotificaciones");
  // si tiene torneo_id + pantalla, se puede tocar para ir directo a esa pantalla del
  // torneo (ej: "te cambiaron el horario" -> Calendario); si no, queda solo informativa
  lista.innerHTML = (data && data.length > 0)
    ? data.map((n) => {
        const puedeNavegar = n.torneo_id && n.pantalla;
        const tag = puedeNavegar ? "button" : "div";
        const atributos = puedeNavegar
          ? `type="button" class="match-card clickeable notif-item${n.leido ? "" : " match-card-jugado"}" data-torneo-id="${n.torneo_id}" data-pantalla="${n.pantalla}"`
          : `class="match-card${n.leido ? "" : " match-card-jugado"}"`;
        return `
      <${tag} ${atributos} style="margin-bottom:8px;text-align:left;width:100%">
        <div style="font-size:13px">${n.mensaje}</div>
        <div class="match-meta" style="margin-top:4px">${new Date(n.created_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}${!n.leido ? ' · <span class="badge orange">nueva</span>' : ""}${puedeNavegar ? " · Tocá para ver →" : ""}</div>
      </${tag}>`;
      }).join("")
    : '<p class="empty">No tenés notificaciones todavía.</p>';
  document.getElementById("notifOverlay").style.display = "flex";
  await sb.from("notificaciones").update({ leido: true }).eq("jugador_id", miJugador.id).eq("leido", false);
  actualizarContadorNotificaciones();
}
document.getElementById("btnNotif").addEventListener("click", async () => {
  const btn = document.getElementById("btnNotif");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await abrirNotificaciones();
  } finally {
    btn.disabled = false;
  }
});
document.getElementById("listaNotificaciones").addEventListener("click", (e) => {
  const item = e.target.closest(".notif-item");
  if (!item) return;
  document.getElementById("notifOverlay").style.display = "none";
  abrirTorneo(item.dataset.torneoId, item.dataset.pantalla);
});
document.getElementById("btnCerrarNotif").addEventListener("click", () => { document.getElementById("notifOverlay").style.display = "none"; });
document.getElementById("notifOverlay").addEventListener("click", (e) => {
  if (e.target.id === "notifOverlay") document.getElementById("notifOverlay").style.display = "none";
});

// ---------- Foto ampliada (lightbox): tocar la foto de un jugador para verla grande ----------
// listener delegado sobre document — cubre cualquier avatarHtml(..., true) presente o
// futuro en la página, sin tener que reengancharlo cada vez que se re-renderiza algo
function abrirFotoGrande(fotoUrl) {
  document.getElementById("fotoGrandeImg").src = fotoUrl;
  document.getElementById("fotoGrandeDescargar").href = fotoUrl;
  document.getElementById("fotoGrandeOverlay").style.display = "flex";
}
function cerrarFotoGrande() {
  document.getElementById("fotoGrandeOverlay").style.display = "none";
  document.getElementById("fotoGrandeImg").src = "";
  document.getElementById("fotoGrandeDescargar").href = "";
}
// La foto vive en Supabase Storage (otro origen), así que el atributo
// download del <a> no alcanza para forzar la descarga en la mayoría de los
// navegadores — bajan el archivo con fetch y lo disparan como blob local,
// todo con APIs nativas del navegador, sin librerías nuevas.
document.getElementById("fotoGrandeDescargar").addEventListener("click", async (e) => {
  e.preventDefault();
  const url = e.currentTarget.href;
  if (!url) return;
  const textoOriginal = e.currentTarget.textContent;
  e.currentTarget.textContent = "Descargando...";
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);
    const tmp = document.createElement("a");
    tmp.href = objUrl;
    tmp.download = url.split("/").pop().split("?")[0] || "foto.jpg";
    tmp.click();
    URL.revokeObjectURL(objUrl);
  } catch {
    window.open(url, "_blank");
  } finally {
    e.currentTarget.textContent = textoOriginal;
  }
});
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-foto-grande]");
  if (el) abrirFotoGrande(el.dataset.fotoGrande);
});
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-foto-grande]")) {
    e.preventDefault();
    abrirFotoGrande(e.target.dataset.fotoGrande);
  }
});
// Las tarjetas de partido (Planilla/Calendario y Llave) ya abren el detalle
// al hacer click (cada vista lo cablea por separado); acá se suma UNA sola
// vez el equivalente por teclado (Enter/Espacio), mismo patrón que
// data-foto-grande arriba, para que también se puedan abrir sin mouse.
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-abrir-partido]")) {
    e.preventDefault();
    abrirDetallePartido(e.target.dataset.abrirPartido);
  }
});
document.getElementById("btnCerrarFotoGrande").addEventListener("click", cerrarFotoGrande);
document.getElementById("fotoGrandeOverlay").addEventListener("click", (e) => {
  if (e.target.id === "fotoGrandeOverlay") cerrarFotoGrande();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("fotoGrandeOverlay").style.display !== "none") cerrarFotoGrande();
});

let canalNotificaciones = null;
function suscribirseANotificacionesRealtime() {
  if (canalNotificaciones) { sb.removeChannel(canalNotificaciones); canalNotificaciones = null; }
  if (!miJugador) return;
  canalNotificaciones = sb.channel("notificaciones-" + miJugador.id)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "notificaciones", filter: `jugador_id=eq.${miJugador.id}` }, (payload) => {
      mostrarNotificacionLocal(payload.new.mensaje);
      actualizarContadorNotificaciones();
    })
    .subscribe();
}

// Canal de "algo cambió" para que el ranking y el detalle del torneo se
// actualicen solos en las pantallas de otros usuarios (broadcast liviano,
// no depende de RLS por fila como los cambios de tabla directos).
const canalEnVivo = sb.channel("norte-padel-en-vivo");
canalEnVivo
  .on("broadcast", { event: "actualizado" }, () => {
    cargarRanking();
    calcularTorneoDestacado();
    if (torneoActualId) refrescarDetalleTorneo();
  })
  .subscribe();

function avisarActualizacionEnVivo() {
  canalEnVivo.send({ type: "broadcast", event: "actualizado", payload: {} });
}

// ============================================================
// PWA: service worker + instalación
// ============================================================
if ("serviceWorker" in navigator) {
  // updateViaCache: "none" fuerza a que el navegador siempre pida sw.js fresco a la red
  // al revisar si hay una versión nueva, sin importar el cache que use el hosting — así
  // el número de versión de más arriba (CACHE) siempre se nota apenas se sube.
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {}));
}

// ============================================================
// INIT
// ============================================================
// nota de velocidad: no hace falta pedir la sesión ni llamar a manejarCambioSesion()
// acá — sb.auth.onAuthStateChange() ya se dispara solo, una vez, apenas se suscribe
// (con la sesión que haya en ese momento), y manejarCambioSesion() ya llama a
// calcularTorneoDestacado(); pedirla de nuevo acá solo duplicaba esas llamadas en cada carga.
async function init() {
  await Promise.all([cargarCategorias(), cargarTorneos()]);
  await Promise.all([
    cargarComplejos(),
    cargarInicio(),
    cargarUltimosProximos(),
    cargarMejoresPorCategoria(),
    cargarCampeones(),
    cargarAscendidos(),
    cargarSponsors(),
    cargarRanking(),
    cargarConfig(),
    cargarNoticias()
  ]);
  // después del bloque de arriba, no adentro: necesita que cargarConfig() ya haya
  // llenado configApp (el link de YouTube vive ahí) antes de leerlo
  cargarEnVivo();
}
init();
