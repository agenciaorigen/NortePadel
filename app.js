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
let ultimosPartidos = [];
// true si alguna categoría del torneo abierto ya tiene calendario (cancha+horario
// asignados) o terminó — fuente de verdad para mostrar Calendario/Resultados
// (ver renderTorneoSubnav), en vez de "hay partidos" que también es cierto para
// un fixture recién armado y todavía sin horario.
let hayCalendarioTorneoActual = false;
let ultimasCanchasTorneo = [];
let partidosCategoriaFiltro = ""; // "" = todas las categorías del torneo
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
// mapea ruta -> vista para estas 8 pantallas, así abrirTorneo y el mini-nav
// del torneo nunca se desincronizan entre sí.
const PANTALLAS_TORNEO = {
  "": { view: "torneo-inicio", label: "Inicio" },
  categorias: { view: "torneo-categorias", label: "Categorías" },
  jugadores: { view: "torneo-jugadores", label: "Jugadores" },
  calendario: { view: "torneo-calendario", label: "Calendario" },
  resultados: { view: "torneo-resultados", label: "Resultados" }
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
    document.getElementById("admSelectorTorneoCard").style.display = "block";
    mostrarConfigGeneral(true);
    document.getElementById("admBtnVolverConfigGeneral").style.display = "none";
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
  if (!btn.dataset.view) return; // "Más" navega a algo dinámico, tiene su propio listener (más abajo)
  btn.addEventListener("click", () => cambiarVista(btn.dataset.view));
});
document.getElementById("btnPerfil").addEventListener("click", () => cambiarVista("perfil"));
document.getElementById("btnHeroTorneos").addEventListener("click", () => cambiarVista("torneos"));
document.getElementById("marqueeBanda").addEventListener("click", () => {
  if (torneoDestacadoId) abrirTorneo(torneoDestacadoId);
  else cambiarVista("torneos");
});

// "Más": en mobile la tabbar solo trae Inicio/Torneos + esto — Ranking/
// Administración viven acá, un toque más adentro (ver style.css .tab-mobile-only)
document.getElementById("tabMas").addEventListener("click", () => { document.getElementById("masOverlay").style.display = "flex"; });
document.getElementById("btnCerrarMas").addEventListener("click", () => { document.getElementById("masOverlay").style.display = "none"; });
document.getElementById("masOverlay").addEventListener("click", (e) => {
  if (e.target.id === "masOverlay") document.getElementById("masOverlay").style.display = "none";
});
document.getElementById("masBtnAdmin").addEventListener("click", () => { document.getElementById("masOverlay").style.display = "none"; cambiarVista("admin"); });

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
  cargarJugadorDelMes();
  if (torneoActualId) renderInscribirme();
});

document.getElementById("btnGuardarClaveNueva").addEventListener("click", async () => {
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
  // se muestra — así nunca compite en especificidad con las reglas responsive que
  // lo esconden en mobile (ver comentario junto a #btnAdminPanel en style.css)
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
    const badgeMaster = clasificaMaster ? `<span class="badge master">Master</span>` : "";
    tr.innerHTML = `<td class="${posClass}">${posicion}</td>
      <td><div style="display:flex;align-items:center;gap:8px">${avatarHtml(j.foto_url, fotoGrande ? 72 : 30, avatarClass)}<span>${j.nombre} ${j.apellido} ${badgeMaster}</span></div></td>
      <td><strong class="num-score">${j.puntos_ranking}</strong></td>
      <td>${j.partidos_jugados}</td>
      <td>${j.partidos_ganados}</td>`;
    tr.style.cursor = "pointer";
    tr.addEventListener("click", () => abrirPerfilJugador(j.id));
    tbody.appendChild(tr);
  });
}

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
        <div><strong>${iconoTrofeo()} ${t.torneo_nombre}</strong><div class="match-meta">con ${t.companero_nombre} ${t.companero_apellido}${t.categoria ? " · " + t.categoria : ""}</div></div>
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
      <div><strong>🥈 ${t.torneo_nombre}</strong><div class="match-meta">con ${t.companero_nombre} ${t.companero_apellido}${t.categoria ? " · " + t.categoria : ""}</div></div>
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
  const sidebar = document.getElementById("sidebarFlyer");
  const vacio = document.getElementById("inicioSinTorneos");
  destacado.innerHTML = "";
  grid.innerHTML = "";

  if (proximos.length === 0) {
    vacio.style.display = "block";
    if (sidebar) sidebar.innerHTML = '<p class="empty" style="padding:0">Sin torneos próximos.</p>';
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
  if (sidebar) {
    const t = proximos[0];
    sidebar.innerHTML = `<img src="${t.flyer_url}" alt="${t.nombre}" style="width:100%;border-radius:var(--radius-sm);border:1px solid var(--border);cursor:pointer" /><div class="match-meta meta-caption" style="margin-top:6px">${t.nombre}</div>`;
    sidebar.querySelector("img").addEventListener("click", () => abrirTorneo(t.id));
  }
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

const TAG_DESTACADO = { Damas: "Jugadora del mes", Caballeros: "Jugador del mes" };
async function cargarJugadorDelMes() {
  const { data } = await sb.rpc("jugador_del_mes_publico");
  const porGenero = { Damas: null, Caballeros: null };
  (data || []).forEach((row) => { if (row.genero in porGenero) porGenero[row.genero] = row; });

  document.getElementById("jugadorDelMesContenido").innerHTML = ["Damas", "Caballeros"].map((genero) => {
    const row = porGenero[genero];
    if (!row) {
      return `
        <div class="destacado-card vacio">
          <div class="destacado-icono">🎾</div>
          <div class="destacado-info">
            <strong>${TAG_DESTACADO[genero]}</strong>
            <span>Aún sin asignar</span>
          </div>
        </div>`;
    }
    const fondo = row.foto_url ? `style="background-image:url('${row.foto_url}');cursor:pointer"` : `style="cursor:pointer"`;
    return `
      <div class="destacado-card" data-jugador-id="${row.jugador_id}" ${fondo}>
        <div class="destacado-tag">⭐ ${TAG_DESTACADO[genero]}</div>
        <div class="destacado-stat">
          <strong>${row.puntos_ranking}</strong>
          <span>puntos</span>
        </div>
        <div class="destacado-info">
          <strong>${row.nombre} ${row.apellido}</strong>
          <span>${row.categoria}${row.motivo ? " · " + row.motivo : ""}</span>
        </div>
      </div>`;
  }).join("");

  document.querySelectorAll("#jugadorDelMesContenido .destacado-card[data-jugador-id]").forEach((card) => {
    card.addEventListener("click", () => abrirPerfilJugador(card.dataset.jugadorId));
  });
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
      <strong>${a.nombre} ${a.apellido}</strong>
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
        <span class="campeon-nombre-link" data-jugador-id="${c.jugador1_id}">${c.jugador1_nombre} ${c.jugador1_apellido}</span> /
        <span class="campeon-nombre-link" data-jugador-id="${c.jugador2_id}">${c.jugador2_nombre} ${c.jugador2_apellido}</span>
      </div>
      <div class="campeon-torneo">${iconoTrofeo()} ${c.torneo_nombre}</div>
    </div>
  `).join("");

  document.querySelectorAll("#campeonesContenido .campeon-nombre-link").forEach((el) => {
    el.addEventListener("click", () => abrirPerfilJugador(el.dataset.jugadorId));
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
      ${avatarHtml(foto, 34)}
      <span class="match-pair-nombre">${[nombre, apellido].filter(Boolean).join(" ") || "?"}</span>
    </div>`;
  return `<div class="match-pair ${ganador ? "jugado" : ""}">
    <div class="match-pair-lado ${cls1}">
      ${jugadorHtml(p.j1a_nombre, p.j1a_apellido, p.j1a_foto)}
      ${jugadorHtml(p.j1b_nombre, p.j1b_apellido, p.j1b_foto)}
    </div>
    <span class="match-pair-vs">V</span>
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
}

document.getElementById("btnDestacarJugador").addEventListener("click", async () => {
  const jugadorId = document.getElementById("jdmSelect").value;
  if (!jugadorId) { toast("Elegí un jugador"); return; }
  const motivo = document.getElementById("jdmMotivo").value.trim() || null;
  const { error } = await sb.from("jugador_del_mes").insert({ jugador_id: jugadorId, motivo });
  if (error) { toast("Error: " + error.message); return; }
  toast("Jugador del mes actualizado");
  document.getElementById("jdmMotivo").value = "";
  cargarJugadorDelMes();
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
      const complejoId = btn.dataset.complejo;
      const input = document.querySelector(`.inputCancha[data-complejo="${complejoId}"]`);
      const nombre = input.value.trim();
      if (!nombre) { toast("Poné un nombre para la cancha"); return; }
      const { error } = await sb.from("canchas").insert({ complejo_id: complejoId, nombre });
      if (error) { toast("Error: " + error.message); return; }
      input.value = "";
      cargarComplejos();
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
        const { error } = await sb.from("categorias").delete().eq("id", btn.dataset.id);
        if (error) { toast("Error: " + error.message); return; }
        cargarCategorias();
      });
    });
    listaAdmin.querySelectorAll(".btnEditarCategoria").forEach((btn) => {
      btn.addEventListener("click", async () => {
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
      });
    });
  }
}

document.getElementById("btnAgregarCategoria").addEventListener("click", async () => {
  const input = document.getElementById("catNueva");
  const nombre = input.value.trim();
  if (!nombre) { toast("Poné un nombre de categoría"); return; }
  const { error } = await sb.from("categorias").insert({ nombre, orden: cacheCategorias.length + 1 });
  if (error) { toast("Error: " + error.message); return; }
  input.value = "";
  toast("Categoría agregada");
  cargarCategorias();
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
      const { error } = await sb.from("etiquetas_jugador").delete().eq("id", btn.dataset.id);
      if (error) { toast("Error: " + error.message); return; }
      toast("Etiqueta borrada");
      cargarEtiquetas();
      cargarJugadoresAdmin();
    });
  });
}

document.getElementById("btnAgregarEtiqueta")?.addEventListener("click", async () => {
  const input = document.getElementById("etqNueva");
  const nombre = input.value.trim();
  const color = document.getElementById("etqColorNueva").value;
  if (!nombre) { toast("Poné un nombre de etiqueta"); return; }
  const { error } = await sb.from("etiquetas_jugador").insert({ nombre, color, orden: cacheEtiquetas.length + 1 });
  if (error) { toast("Error: " + error.message); return; }
  input.value = "";
  toast("Etiqueta agregada");
  cargarEtiquetas();
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
function parejaRowHtml(p, editable) {
  const catBadge = p.categoria ? `<span class="badge">${p.categoria}</span>` : "";
  const estadoBadge = p.estado === "confirmada" ? `<span class="badge solid">Confirmada</span>`
    : p.estado === "rechazada" ? `<span class="badge danger" title="${p.motivo_rechazo || ""}">Rechazada</span>`
    : `<span class="badge orange">Pendiente de confirmar</span>`;
  const etiquetas = editable ? etiquetaDotHtml(p.jugador1_id) + etiquetaDotHtml(p.jugador2_id) : "";
  const pendiente = editable && p.estado !== "confirmada" && p.estado !== "rechazada";
  return `<div class="pareja-row">
    <span>${etiquetas}🎾 ${p.jugador1_nombre} / ${p.jugador2_nombre} ${catBadge} ${estadoBadge}</span>
    <span style="display:flex;gap:6px;align-items:center;flex-shrink:0">
      ${pendiente ? `<button type="button" class="secondary small btnConfirmarPareja" data-j1="${p.jugador1_id}" data-j2="${p.jugador2_id}">Confirmar</button>` : ""}
      ${pendiente ? `<button type="button" class="secondary small btnRechazarPareja" data-j1="${p.jugador1_id}" data-j2="${p.jugador2_id}">Rechazar</button>` : ""}
      ${editable ? `<button type="button" class="danger btnBorrarPareja" data-id="${p.id}" data-nombre="${p.jugador1_nombre} / ${p.jugador2_nombre}" data-j1="${p.jugador1_id}" data-j2="${p.jugador2_id}" aria-label="Sacar del torneo a la pareja ${p.jugador1_nombre} / ${p.jugador2_nombre}">×</button>` : ""}
    </span>
  </div>`;
}
function sinParejaChipHtml(i, editable) {
  const sufijoEstado = i.estado && i.estado !== "confirmada" ? ` · ${i.estado === "pendiente" ? "pendiente" : i.estado}` : "";
  return `<span class="pill removable" style="display:inline-flex;margin:0 6px 6px 0">${editable ? etiquetaDotHtml(i.jugador_id) : ""}${i.nombre} ${i.apellido}${i.categoria_torneo ? ` · ${i.categoria_torneo}` : ""}${sufijoEstado}${editable ? `<button type="button" class="btnBorrarInscripto" data-id="${i.jugador_id}" data-nombre="${i.nombre} ${i.apellido}" aria-label="Sacar a ${i.nombre} del torneo">×</button>` : ""}</span>`;
}
function renderParejasEn(contParejasId, contSinParejaId, insc, parejas, editable) {
  // al público no se le muestran parejas rechazadas ni inscripciones
  // canceladas/rechazadas — son historial para el admin, no algo vigente
  const inscBase = editable ? (insc || []) : (insc || []).filter((i) => i.estado !== "cancelada" && i.estado !== "rechazada");
  const parejasBase = editable ? (parejas || []) : (parejas || []).filter((p) => p.estado !== "rechazada");
  const enPareja = new Set(parejasBase.flatMap((p) => [p.jugador1_id, p.jugador2_id]));
  const sinPareja = inscBase.filter((i) => !enPareja.has(i.jugador_id));

  const contParejas = document.getElementById(contParejasId);
  contParejas.innerHTML = parejasBase.map((p) => parejaRowHtml(p, editable)).join("") || '<p class="empty">Todavía no hay parejas anotadas.</p>';
  if (editable) {
    contParejas.querySelectorAll(".btnBorrarPareja").forEach((btn) => {
      btn.addEventListener("click", async () => await borrarPareja(btn.dataset.id, btn.dataset.nombre, btn.dataset.j1, btn.dataset.j2));
    });
    contParejas.querySelectorAll(".btnConfirmarPareja").forEach((btn) => {
      btn.addEventListener("click", async () => await confirmarPareja(btn.dataset.j1, btn.dataset.j2));
    });
    contParejas.querySelectorAll(".btnRechazarPareja").forEach((btn) => {
      btn.addEventListener("click", async () => await rechazarPareja(btn.dataset.j1, btn.dataset.j2));
    });
  }

  const contSinPareja = document.getElementById(contSinParejaId);
  contSinPareja.innerHTML = sinPareja.length === 0 ? "" : `
    <p class="match-meta" style="margin:12px 0 6px">Todavía sin pareja:</p>
    ${sinPareja.map((i) => sinParejaChipHtml(i, editable)).join("")}`;
  if (editable) {
    contSinPareja.querySelectorAll(".btnBorrarInscripto").forEach((btn) => {
      btn.addEventListener("click", async () => await borrarInscripcion(btn.dataset.id, btn.dataset.nombre));
    });
  }
}

// ============================================================
// PUNTOS POR RONDA (ranking por eliminación directa)
// ============================================================
const RONDAS_INPUT = {
  "Campeón": "prCampeon", "Sub": "prSub", "Semifinal": "prSemifinal",
  "Cuartos": "prCuartos", "Octavos": "prOctavos", "Dieciseisavos": "prDieciseisavos"
};

async function cargarPuntosRonda() {
  const { data } = await sb.from("puntos_ronda").select("*");
  (data || []).forEach((r) => {
    const input = document.getElementById(RONDAS_INPUT[r.ronda]);
    if (input) input.value = r.puntos;
  });
}

document.getElementById("btnGuardarPuntosRonda").addEventListener("click", async () => {
  const filas = Object.entries(RONDAS_INPUT).map(([ronda, inputId]) => ({
    ronda, puntos: Number(document.getElementById(inputId).value) || 0
  }));
  const { error } = await sb.from("puntos_ronda").upsert(filas, { onConflict: "ronda" });
  if (error) { toast("Error: " + error.message); return; }
  toast("Puntos guardados");
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
  if (inputWsp) inputWsp.value = configApp.whatsapp_numero || "";
  if (inputIg) inputIg.value = configApp.instagram_url || "";
}

document.getElementById("btnGuardarConfig").addEventListener("click", async () => {
  const whatsapp = document.getElementById("cfgWhatsapp").value.trim().replace(/\D/g, "");
  const instagram = document.getElementById("cfgInstagram").value.trim();
  const { error } = await sb.from("config").upsert([
    { clave: "whatsapp_numero", valor: whatsapp || null },
    { clave: "instagram_url", valor: instagram || null }
  ], { onConflict: "clave" });
  if (error) { toast("Error: " + error.message); return; }
  toast("Configuración guardada");
  await cargarConfig();
  cargarNoticias();
  if (torneoActualId) refrescarDetalleTorneo();
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
  const labelJugadorBuscable = (j) => `${j.apellido}, ${j.nombre} — ${j.categoria || "sin categoría"}`;
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
      <div class="row">
        <input type="text" class="jaNombre" value="${j.nombre}" placeholder="Nombre" />
        <input type="text" class="jaApellido" value="${j.apellido}" placeholder="Apellido" />
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
        fila.querySelector(".btnQuitarCategoriaRanking").addEventListener("click", async () => {
          if (!confirm(`¿Sacar a ${j.nombre} ${j.apellido} del ranking de ${categoria}?`)) return;
          const { error } = await sb.from("ranking_categoria").delete().eq("jugador_id", j.id).eq("categoria", categoria);
          if (error) { toast("Error: " + error.message); return; }
          toast("Categoría quitada del ranking");
          await cargarJugadoresAdmin();
          cargarRanking();
        });
      });
      div.querySelector(".btnAgregarCategoriaRanking").addEventListener("click", async () => {
        const categoria = selNueva.value;
        if (!categoria) { toast("No quedan categorías para agregar"); return; }
        const { error } = await sb.from("ranking_categoria").insert({ jugador_id: j.id, categoria, puntos_ranking: 0 });
        if (error) { toast("Error: " + error.message); return; }
        toast(`${j.nombre} ${j.apellido} ahora también rankea en ${categoria}`);
        await cargarJugadoresAdmin();
        cargarRanking();
      });
    };
    renderRankingExtra();
    div.insertAdjacentHTML("beforeend", `
      <div class="row" style="margin-top:8px;gap:8px">
        <button type="button" class="secondary small btnGuardarJugador">Guardar</button>
        <button type="button" class="secondary small danger btnEliminarJugador">Eliminar perfil</button>
      </div>
    `);
    div.querySelector(".btnGuardarJugador").addEventListener("click", async () => {
      const nombre = div.querySelector(".jaNombre").value.trim();
      const apellido = div.querySelector(".jaApellido").value.trim();
      const categoria = div.querySelector(".jaCategoria").value;
      const puntos_ranking = Number(div.querySelector(".jaPuntos").value);
      const etiqueta_id = div.querySelector(".jaEtiqueta").value || null;
      if (!nombre || !apellido) { toast("Nombre y apellido no pueden quedar vacíos"); return; }
      if (!Number.isFinite(puntos_ranking) || puntos_ranking < 0) { toast("Los puntos tienen que ser un número positivo"); return; }
      const { error } = await sb.from("jugadores").update({ nombre, apellido, categoria, puntos_ranking, etiqueta_id }).eq("id", j.id);
      if (error) { toast("Error: " + error.message); return; }
      toast("Jugador actualizado");
      cargarJugadoresAdmin();
      cargarRanking();
    });
    div.querySelector(".btnEliminarJugador").addEventListener("click", async () => {
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
    div.innerHTML = `<div class="match-teams">${j.nombre} ${j.apellido} <span class="badge">${j.categoria} → ${j.categoria_pendiente}</span></div>
      <div class="match-meta" style="display:flex;gap:8px;margin-top:8px">
        <button class="secondary small btnAprobarCategoria">Aprobar</button>
        <button class="secondary small danger btnRechazarCategoria">Rechazar</button>
      </div>`;
    div.querySelector(".btnAprobarCategoria").addEventListener("click", async () => {
      const { error } = await sb.from("jugadores").update({ categoria: j.categoria_pendiente, categoria_pendiente: null }).eq("id", j.id);
      if (error) { toast("Error: " + error.message); return; }
      // queda registrado para poder mostrar "ascendieron este mes" en Inicio
      await sb.from("historial_categoria").insert({ jugador_id: j.id, categoria_anterior: j.categoria, categoria_nueva: j.categoria_pendiente });
      toast("Categoría aprobada");
      cargarJugadoresAdmin();
      cargarRanking();
    });
    div.querySelector(".btnRechazarCategoria").addEventListener("click", async () => {
      const { error } = await sb.from("jugadores").update({ categoria_pendiente: null }).eq("id", j.id);
      if (error) { toast("Error: " + error.message); return; }
      toast("Solicitud rechazada");
      cargarJugadoresAdmin();
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
      div.style.backgroundImage = `linear-gradient(0deg, rgba(5,7,10,.92), rgba(5,7,10,.55) 65%), radial-gradient(120% 100% at 85% -10%, rgba(15,158,150,.28), transparent 55%), url('${t.flyer_url}')`;
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
document.getElementById("tFaseGruposFormato").addEventListener("change", () => toggleGrupoConfigRow("tFaseGruposFormato", "tGrupoConfigRow"));
document.getElementById("teFaseGruposFormato").addEventListener("change", () => toggleGrupoConfigRow("teFaseGruposFormato", "teGrupoConfigRow"));
toggleGrupoConfigRow("tFaseGruposFormato", "tGrupoConfigRow");

document.getElementById("btnCrearTorneo").addEventListener("click", async () => {
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
    fase_grupos_formato: document.getElementById("tFaseGruposFormato").value,
    tamano_grupo: Number(document.getElementById("tTamanoGrupo").value) || 3,
    avanzan_por_grupo: Number(document.getElementById("tAvanzanPorGrupo").value) || 2
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
  if (id !== torneoActualId) calFiltroFechaAutoAplicada = false; // torneo distinto: elegir la fecha del calendario de nuevo sola
  torneoActualId = id;
  await refrescarDetalleTorneo();
  if (miToken !== tokenNavegacionTorneo) return; // ya hay una navegación más nueva en curso
  // sin pantalla explícita (entrar desde la lista de torneos, o un link
  // directo a /torneo/:id): mientras se puede anotar gente se sigue mostrando
  // Inicio primero, pero una vez que el torneo pasó a "en curso" (o ya
  // terminó) hay que ir directo a Calendario — no tiene sentido aterrizar en
  // inscriptos/categorías cuando lo que se está jugando es lo que importa. Se
  // mira torneo.estado (no hayCalendarioTorneoActual) porque ese es a nivel
  // de TODO el torneo, no de una sola categoría que ya tenga fixture armado.
  const torneoEnCursoOTerminado = torneoActualData && (torneoActualData.estado === "en_curso" || torneoActualData.estado === "finalizado");
  if (!pantalla && torneoEnCursoOTerminado && hayCalendarioTorneoActual) pantalla = "calendario";
  mostrarPantallaTorneo(pantalla);
}
document.getElementById("btnVolverTorneos").addEventListener("click", () => cambiarVista("torneos"));

function mostrarPantallaTorneo(pantalla) {
  // si ya está anotado, un link directo o "Atrás" del navegador a /inscripcion
  // nunca debe volver a mostrar el wizard — se redirige a "Mi inscripción"
  if (pantalla === "inscripcion" && yaInscriptoEnTorneoActual) pantalla = "mi-inscripcion";
  const clave = pantalla || "";
  const info = PANTALLAS_TORNEO[clave];
  const view = info ? info.view : (PANTALLAS_TORNEO_EXTRA[clave] || "torneo-inicio");
  cambiarVista(view, `/torneo/${torneoActualId}${clave ? "/" + clave : ""}`);
  renderTorneoSubnav(clave);
  if (clave === "inscripcion") prepararFormularioInscripcion();
  if (clave === "mi-inscripcion") cargarMiInscripcion();
  if (clave === "mi-disponibilidad") cargarYMostrarDispTorneo();
}

// mini-nav del torneo (Inicio/Categorías/Jugadores/Calendario/Resultados) —
// un solo lugar que arma los pills, así nunca queda desalineado con
// PANTALLAS_TORNEO ni con la pantalla realmente activa. Mientras se está
// anotando gente (todavía no hay partidos armados) Calendario y Resultados
// ni siquiera aparecen como pestaña — recién se muestran una vez que se
// cerró la inscripción y el fixture está armado, tal cual se pidió desde el
// arranque: en etapa de inscripción, solo la información del torneo.
function renderTorneoSubnav(claveActiva) {
  const cont = document.getElementById("torneoSubnav");
  cont.innerHTML = Object.entries(PANTALLAS_TORNEO)
    .filter(([key]) => hayCalendarioTorneoActual || (key !== "calendario" && key !== "resultados"))
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
    ? candidatos.map((j) => `<button type="button" class="suggest-item" data-id="${j.id}">${j.nombre} ${j.apellido} <span class="badge" style="margin-left:6px">${j.categoria}</span></button>`).join("")
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
  document.getElementById("buscarParejaWrap").style.display = "block";
  parejaSeleccionada = null;
  document.getElementById("buscarPareja").value = "";
  document.getElementById("parejaSeleccionadaTxt").textContent = "";
  document.getElementById("anotarmeCategoria").value = "";
  const btn = document.getElementById("btnInscribirme");
  btn.style.display = "block";
  btn.onclick = () => mostrarConfirmarInscripcion();
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
  const miPareja = (parejas || []).find((p) => p.jugador1_id === miJugador.id || p.jugador2_id === miJugador.id);
  const companero = miPareja ? (miPareja.jugador1_id === miJugador.id ? miPareja.jugador2_nombre : miPareja.jugador1_nombre) : null;
  contResumen.textContent = companero
    ? `Jugás con ${companero}, categoría ${insc.categoria}.`
    : `Categoría ${insc.categoria} · todavía sin pareja confirmada.`;
}
document.getElementById("miInscBtnDisponibilidad").addEventListener("click", () => mostrarPantallaTorneo("mi-disponibilidad"));
document.getElementById("miInscBtnMisPartidos").addEventListener("click", () => mostrarPantallaTorneo("calendario"));
document.getElementById("miInscBtnCancelar").addEventListener("click", async () => {
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
  if (!miJugador || !torneoActualId) return;
  await sb.from("disponibilidad").delete().eq("jugador_id", miJugador.id).eq("torneo_id", torneoActualId);
  const disponibilidades = leerRestriccionesDeForm("torneoDispBloqueadaForm").map((r) => ({ jugador_id: miJugador.id, torneo_id: torneoActualId, ...r }));
  if (disponibilidades.length > 0) await sb.from("disponibilidad").insert(disponibilidades);
  toast("¡Guardado! 🎾");
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
    <span class="badge">${j.nombre} ${j.apellido} <button type="button" class="btnQuitarInvitado" data-id="${j.id}" style="border:none;background:none;color:inherit;cursor:pointer;margin-left:4px">×</button></span>
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
    ? candidatos.map((j) => `<button type="button" class="suggest-item" data-id="${j.id}">${j.nombre} ${j.apellido}</button>`).join("")
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
      ${r.invitados ? `<div class="match-meta">Con: ${r.invitados}</div>` : ""}
      ${r.soy_organizador && (r.estado === "pendiente" || r.estado === "confirmada") ? '<button class="secondary small danger btnCancelarReserva" style="margin-top:8px">Cancelar reserva</button>' : ""}
    `;
    if (r.soy_organizador) {
      const btnCancelar = div.querySelector(".btnCancelarReserva");
      if (btnCancelar) btnCancelar.addEventListener("click", async () => {
        const { error } = await sb.from("reservas").update({ estado: "cancelada" }).eq("id", r.id);
        if (error) { toast("Error: " + error.message); return; }
        toast("Reserva cancelada");
        cargarMisReservas();
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
      <div class="match-meta">Organiza: ${r.organizador_nombre}${r.organizador_telefono ? " · " + r.organizador_telefono : ""}${r.invitados ? " · Con: " + r.invitados : ""}</div>
      <div class="match-meta" style="display:flex;gap:8px;margin-top:8px">
        <button class="secondary small btnConfirmarReserva">Confirmar</button>
        <button class="secondary small danger btnRechazarReserva">Rechazar</button>
      </div>
    `;
    div.querySelector(".btnConfirmarReserva").addEventListener("click", async () => {
      const { error } = await sb.from("reservas").update({ estado: "confirmada" }).eq("id", r.id);
      if (error) { toast("Error: " + error.message); return; }
      toast("Reserva confirmada");
      cargarReservasPendientesAdmin();
    });
    div.querySelector(".btnRechazarReserva").addEventListener("click", async () => {
      const { error } = await sb.from("reservas").update({ estado: "rechazada" }).eq("id", r.id);
      if (error) { toast("Error: " + error.message); return; }
      toast("Reserva rechazada");
      cargarReservasPendientesAdmin();
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

  const { data: tc } = await sb.from("torneo_canchas").select("*, canchas(id, nombre, complejo_id)").eq("torneo_id", torneoActualId);
  ultimasCanchasTorneo = tc || [];
  document.getElementById("dtCanchas").innerHTML = (tc || []).map((c) =>
    `<span class="badge orange" style="margin-right:6px">${c.canchas?.nombre || "?"}</span>`
  ).join("") || '<p class="empty">Sin canchas asignadas todavía.</p>';

  const [{ data: insc }, { data: parejas }, { data: partidos }] = await Promise.all([
    sb.rpc("inscriptos_publicos", { p_torneo_id: torneoActualId }),
    sb.rpc("parejas_publicas", { p_torneo_id: torneoActualId }),
    sb.rpc("partidos_publicos", { p_torneo_id: torneoActualId })
  ]);
  ultimosPartidos = partidos || [];
  // el flag de arriba se basa en torneo_categorias.estado_fase, que puede quedar
  // desactualizado si un horario se asignó a mano partido por partido (o
  // arrastrando en la planilla) en vez de con "Generar calendario" — bug real
  // detectado: quedaban partidos con horario pero la pestaña de Calendario
  // seguía oculta para todo el mundo salvo el admin. Se refuerza mirando los
  // partidos reales: si ya hay alguno con horario o jugado, el calendario
  // existe para el público aunque ese flag no se haya actualizado.
  if (!hayCalendarioTorneoActual) {
    hayCalendarioTorneoActual = ultimosPartidos.some((p) => p.horario || p.estado === "jugado");
  }

  // Calendario/Resultados (pestañas de torneoSubnav) solo aparecen una vez que
  // alguna categoría tiene calendario confirmado — mientras se está anotando
  // gente, o mientras solo existe el fixture (cruces sin horario todavía), Inicio
  // muestra solo información, sin mezclar partidos que el público todavía no
  // puede ubicar en el tiempo (ver también renderTorneoSubnav).
  document.getElementById("dtProximosPartidosCard").style.display = hayCalendarioTorneoActual ? "block" : "none";

  renderParejasEn("dtParejas", "dtSinPareja", insc || [], parejas || [], false);
  cargarCategoriasTorneo(parejas || []);
  renderProximosPartidos(ultimosPartidos);
  renderStatsInicioTorneo(parejas || [], tc || [], ultimosPartidos);

  await cargarBloqueosCancha();
  renderCalendarioPublico();
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

// ---------- Próximos partidos (Inicio del torneo) ----------
function renderProximosPartidos(partidos) {
  const cont = document.getElementById("dtProximosPartidos");
  if (!cont) return;
  const ahora = new Date();
  const proximos = (partidos || [])
    .filter((p) => p.horario && new Date(p.horario) >= ahora && p.estado !== "jugado")
    .sort((a, b) => new Date(a.horario) - new Date(b.horario))
    .slice(0, 3);
  cont.innerHTML = proximos.length === 0 ? '<p class="empty">Todavía no hay partidos programados.</p>' :
    proximos.map((p) => {
      const horario = new Date(p.horario).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
      return `<div class="match-card">${matchVsRowHtml(p, null)}<div class="match-meta">${iconoPin()} ${p.cancha_nombre || "sin cancha"} · ${iconoReloj()} ${horario}${p.categoria ? ` · <span class="badge">${p.categoria}</span>` : ""}</div></div>`;
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
        <span>${vigente ? "🔴" : "⚪"} ${b.canchas?.nombre || "?"} — ${desde} a ${hasta}${b.motivo ? ` (${b.motivo})` : ""}</span>
        <button class="secondary small btnQuitarBloqueo" data-id="${b.id}">Quitar</button>
      </div>`;
    }).join("");

  llenarSelect(document.getElementById("admBloqueoCancha"), cacheCanchas, (c) => {
    const complejo = cacheComplejos.find((x) => x.id === c.complejo_id);
    return `${c.nombre} (${complejo ? complejo.nombre : "?"})`;
  });

  cont.querySelectorAll(".btnQuitarBloqueo").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const { error } = await sb.from("canchas_bloqueos").delete().eq("id", btn.dataset.id);
      if (error) { toast("Error: " + error.message); return; }
      toast("Bloqueo eliminado");
      avisarActualizacionEnVivo();
      refrescarTrasAccionGestion();
    });
  });
}

document.getElementById("admBtnBloquearCancha").addEventListener("click", async () => {
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
let seccionGestionActiva = "inscripciones";
const SECCIONES_GESTION = {
  inscripciones: { id: "admSeccionInscripciones", label: "Inscripciones" },
  canchas: { id: "admSeccionCanchas", label: "Canchas" },
  bloqueos: { id: "admSeccionBloqueos", label: "Bloqueos" },
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
  document.getElementById("admGestionNombre").textContent = t.nombre;
  document.getElementById("admGestionEstado").innerHTML = badgeEstadoTorneo(t);
  renderAdminGestionSubnav();

  const btnToggleInsc = document.getElementById("btnToggleInscripcion");
  if (t.estado === "inscripcion" || t.estado === "inscripcion_cerrada") {
    btnToggleInsc.style.display = "inline-block";
    btnToggleInsc.textContent = t.estado === "inscripcion" ? "🔒 Cerrar inscripción" : "🔓 Reabrir inscripción";
    btnToggleInsc.onclick = async () => {
      const nuevoEstado = t.estado === "inscripcion" ? "inscripcion_cerrada" : "inscripcion";
      const { error } = await sb.from("torneos").update({ estado: nuevoEstado }).eq("id", torneoGestionId);
      if (error) { toast("Error: " + error.message); return; }
      toast(nuevoEstado === "inscripcion_cerrada" ? "Inscripción cerrada" : "Inscripción reabierta");
      refrescarTrasAccionGestion();
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

  const { data: tc } = await sb.from("torneo_canchas").select("*, canchas(id, nombre, complejo_id)").eq("torneo_id", id);
  document.getElementById("admCanchas").innerHTML = (tc || []).map((c) =>
    `<span class="badge orange" style="margin-right:6px">${c.canchas?.nombre || "?"}${c.dias_semana && c.dias_semana.length ? ` (${c.dias_semana.map((d) => DIAS_CORTO[d]).join(",")})` : ""} <a href="#" class="btnQuitarCanchaTorneo" data-tc="${c.id}" title="Quitar">✕</a></span>`
  ).join("") || '<p class="empty">Sin canchas asignadas todavía.</p>';
  document.querySelectorAll(".btnQuitarCanchaTorneo").forEach((a) => a.addEventListener("click", async (ev) => {
    ev.preventDefault();
    await sb.from("torneo_canchas").delete().eq("id", a.dataset.tc);
    toast("Cancha quitada del torneo");
    refrescarTrasAccionGestion();
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
  renderParejasEn("admParejas", "admSinPareja", insc || [], parejas || [], true);

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
  if (parejasSinPartido.length) filas.push(`⚠️ ${parejasSinPartido.length} pareja${parejasSinPartido.length === 1 ? "" : "s"} sin ningún partido asignado: ${parejasSinPartido.map((p) => `${p.jugador1_nombre} / ${p.jugador2_nombre} (${p.categoria || "sin categoría"})`).join(", ")} — generá el fixture de esa categoría.`);
  if (inscSinPareja.length) filas.push(`⚠️ ${inscSinPareja.length} anotado${inscSinPareja.length === 1 ? "" : "s"} sin pareja todavía: ${inscSinPareja.map((i) => `${i.nombre} ${i.apellido}`).join(", ")} — no puede jugar hasta que tenga con quién.`);
  if (parejasPendientes.length) filas.push(`⚠️ ${parejasPendientes.length} pareja${parejasPendientes.length === 1 ? "" : "s"} pendiente${parejasPendientes.length === 1 ? "" : "s"} de confirmar (todavía no revisaste el pago): ${parejasPendientes.map((p) => `${p.jugador1_nombre} / ${p.jugador2_nombre}`).join(", ")}.`);
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
  torneoGestionId = null;
  torneoGestionData = null;
  document.getElementById("admGestionTorneoWrap").style.display = "none";
  document.getElementById("admSelectTorneoGestion").value = "";
  document.getElementById("admSelectorTorneoCard").style.display = "block";
  await cargarTorneos();
  avisarActualizacionEnVivo();
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

  // una vez que alguna categoría ya tiene calendario armado, tocar fecha/horario/
  // formato/categorías puede desincronizar los partidos ya programados con lo
  // que el torneo dice — se bloquean esos campos (nombre/sede/costo siguen libres).
  const hayCalendarioArmado = (t.torneo_categorias || []).some((c) => c.estado_fase === "calendario_confirmado" || c.estado_fase === "finalizada");
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
});

document.getElementById("btnAgregarCanchaTorneo").addEventListener("click", async () => {
  const canchaId = document.getElementById("dtSelectCancha").value;
  if (!canchaId || !torneoGestionId) return;
  const diasElegidos = Array.from(document.querySelectorAll(".chkDiaCanchaNueva:checked")).map((c) => Number(c.value));
  const { error } = await sb.from("torneo_canchas").insert({ torneo_id: torneoGestionId, cancha_id: canchaId, dias_semana: diasElegidos.length ? diasElegidos : null });
  if (error) { toast("Esa cancha ya está asignada u ocurrió un error"); return; }
  toast("Cancha agregada al torneo");
  document.querySelectorAll(".chkDiaCanchaNueva").forEach((c) => (c.checked = false));
  refrescarTrasAccionGestion();
});

// Inscribe una pareja completa a mano (ej: dos amigos que se lo pidieron directo al club).
// Siempre entran los dos juntos, nunca un jugador suelto — así nunca queda nadie sin pareja.
document.getElementById("btnInscribir").addEventListener("click", async () => {
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
  const { error: e3 } = await sb.from("parejas").insert({ torneo_id: torneoGestionId, jugador1_id: jugador1Id, jugador2_id: jugador2Id });
  if (e3) { toast("Se inscribieron pero no se pudo armar la pareja: " + e3.message); refrescarTrasAccionGestion(); return; }
  toast("Pareja inscripta");
  in1.value = "";
  in2.value = "";
  avisarActualizacionEnVivo();
  refrescarTrasAccionGestion();
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

// Trae los horarios BLOQUEADOS de cada jugador para un torneo: los generales
// de su perfil (torneo_id null, aplican siempre) más los puntuales que haya
// cargado para ESTE torneo puntualmente — combinados, ya que ambos restan
// disponibilidad por igual a la hora de buscar un horario común.
async function jugadoresDisponibilidad(jugadorIds, torneoId) {
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
    await sb.from("torneo_categorias").update({ estado_fase: "calendario_confirmado" }).eq("torneo_id", torneoId).eq("categoria", categoria);
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

  const { data: torneo } = await sb.from("torneos").select("*").eq("id", torneoGestionId).single();
  const grupos = agruparPorCategoria(parejasSinPartido);
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

  toast(`Se armó el fixture: ${totalGenerados} partidos (todavía sin cancha ni horario). Ahora usá "Generar calendario".`);
  avisarActualizacionEnVivo();
  refrescarTrasAccionGestion();
});

document.getElementById("btnGenerarCalendario").addEventListener("click", async () => {
  // Toma los partidos que ya tienen fixture (pareja1/pareja2 definidos) pero
  // todavía no cancha/horario, y les busca un hueco — separado de "Armar
  // fixture" para que armar quién juega contra quién nunca pierda cruces por
  // no encontrarles horario en el mismo acto.
  if (!torneoGestionId) { toast("Elegí primero un torneo en gestión"); return; }
  const { data: torneo } = await sb.from("torneos").select("*").eq("id", torneoGestionId).single();
  const { data: tc } = await sb.from("torneo_canchas").select("dias_semana, canchas(*)").eq("torneo_id", torneoGestionId);
  const canchas = (tc || []).filter((c) => c.canchas).map((c) => ({ ...c.canchas, dias_semana: c.dias_semana }));
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
  toast(`Se asignó horario a ${totalGenerados} partidos` + (totalSinHorario ? `, ${totalSinHorario} quedaron sin horario común` : ""));
  avisarActualizacionEnVivo();
  refrescarTrasAccionGestion();
});

// Por cada categoría del torneo, toma los ganadores de SU fase más avanzada
// ya jugada por completo y arma SU siguiente fase, nombrándola según cuántas
// parejas clasificaron (4 parejas -> Semifinal directo, sin pasar por
// Dieciseisavos/Octavos/Cuartos como si siempre hubiera un cuadro de 32), en
// vez de dejar que el admin elija la ronda de cada partido a mano. Categorías
// que van más atrasadas que otras (por ejemplo, todavía en fase de grupos
// mientras otra ya llegó a Cuartos) simplemente esperan su turno.
document.getElementById("btnGenerarSiguienteFase").addEventListener("click", async () => {
  if (!torneoGestionId) { toast("Elegí primero un torneo en gestión"); return; }
  const { data: partidos } = await sb.rpc("partidos_publicos", { p_torneo_id: torneoGestionId });
  if (!partidos || partidos.length === 0) { toast("Todavía no armaste ningún partido"); return; }

  const { data: torneo } = await sb.from("torneos").select("*").eq("id", torneoGestionId).single();
  const grupos = agruparPorCategoria(partidos);
  const mensajes = [];
  let totalGenerados = 0;

  for (const categoria of Object.keys(grupos)) {
    if (torneo.fase_grupos_formato === "cuadro_zonas") {
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
});

// ============================================================
// SLOT (fecha + hora + cancha) — valor DERIVADO, no se guarda en ninguna
// tabla nueva: se calcula a partir de los partidos ya cargados, los
// bloqueos de cancha vigentes, y —si sintetizarVacios viene true (la
// planilla editable de Administración)— también los huecos libres de la
// ventana horaria del torneo, para poder asignarles un partido sin horario.
// ============================================================
function calcularSlots(partidos, canchas, torneo, sintetizarVacios) {
  const conHorario = partidos.filter((p) => p.horario);
  const filaPorMinuto = new Map(); // timestamp -> horario ISO de esa fila
  conHorario.forEach((p) => filaPorMinuto.set(new Date(p.horario).getTime(), p.horario));
  if (sintetizarVacios && torneo) {
    const duracion = torneo.duracion_minutos || 90;
    const ventana = ventanaDelTorneo(torneo);
    const esMapaPorDia = ventana && typeof ventana === "object" && ventana.desde === undefined;
    fechasDelTorneo(torneo).forEach((fecha) => {
      const baseDia = (esMapaPorDia ? ventana[fecha.getDay()] : ventana) || FRANJA_DEFAULT_DIA;
      for (let m = baseDia.desde; m + duracion <= baseDia.hasta; m += duracion) {
        const d = new Date(fecha);
        d.setHours(0, m, 0, 0);
        if (!filaPorMinuto.has(d.getTime())) filaPorMinuto.set(d.getTime(), d.toISOString());
      }
    });
  }
  const duracionMin = (torneo && torneo.duracion_minutos) || 90;
  const bloqueos = bloqueosPorCanchaMapa();
  const horarios = [...filaPorMinuto.entries()].sort((a, b) => a[0] - b[0]).map(([, iso]) => iso);
  const filas = horarios.map((horarioISO) => {
    const desde = new Date(horarioISO);
    const hasta = new Date(desde.getTime() + duracionMin * 60000);
    const celdas = canchas.map((c) => {
      const partido = conHorario.find((p) => p.horario === horarioISO && p.cancha_id === c.id);
      if (partido) return { cancha: c, estado: "ocupado", partido };
      const bloqueo = (bloqueos[c.id] || []).find((b) => desde < b.hasta && hasta > b.desde);
      if (bloqueo) return { cancha: c, estado: "bloqueado", bloqueo };
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

// Planilla de Administración (editable=true siempre, ver más abajo la vista
// pública): grilla en PC que se reacomoda al ancho disponible (nunca se corta
// con scroll horizontal, tenga 2 canchas o 8) y agenda vertical
// fecha->hora->cancha en mobile. Agrega los huecos libres del torneo y cada
// partido se puede arrastrar a otra celda (drag-and-drop nativo, solo
// desktop — en mobile cada partido ya tiene sus propios inputs de
// cancha/horario en la vista Lista, ver renderPartidosLista). El público/
// jugador ya no ve esta grilla — ve el "orden de juego" (renderOrdenDeJuego).
function renderPartidosCalendario(containerId, partidos, canchasTorneo, editable) {
  const cont = document.getElementById(containerId);
  const canchas = canchasTorneo.map((c) => c.canchas).filter(Boolean);
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

  const tarjetaHtml = (p, extraClase = "") => `
    <div class="calendario-partido ${p.estado === "jugado" ? "jugado" : ""} ${extraClase}" ${editable ? `draggable="true" data-partido="${p.id}"` : `data-abrir-partido="${p.id}"`}>
      <div class="calendario-equipo">${p.pareja1_nombre}</div>
      <div class="calendario-vs">V</div>
      <div class="calendario-equipo">${p.pareja2_nombre}</div>
      ${p.ronda && p.ronda !== "Fase de grupos" ? `<span class="badge orange" style="margin-top:4px">${p.ronda}</span>` : (p.grupo ? `<span class="badge orange" style="margin-top:4px">Grupo ${p.grupo}</span>` : "")}
      ${p.categoria ? `<span class="badge" style="margin-top:4px">${p.categoria}</span>` : ""}
    </div>`;
  const bloqueadaHtml = (celda) => `<div class="calendario-bloqueada" title="${celda.bloqueo.motivo || "Cancha bloqueada"}">🚫 Bloqueada${celda.bloqueo.motivo ? `<br>${celda.bloqueo.motivo}` : ""}</div>`;
  const vaciaHtml = (fila, celda) => `<div class="calendario-vacia" ${editable ? `data-horario="${fila.horarioISO}" data-cancha="${celda.cancha.id}"` : ""}></div>`;

  let html = "";
  if (editable && sinHorario.length > 0) {
    html += `<p class="match-meta" style="margin-bottom:6px">Arrastrá un partido sin horario a un hueco libre (en el celular, asignalo desde su tarjeta en la vista Lista):</p>
      <div class="planilla-bandeja" id="planillaBandeja">${sinHorario.map((p) => tarjetaHtml(p, "pendiente")).join("")}</div>`;
  }

  const esMobile = window.matchMedia("(max-width:767px)").matches;
  if (esMobile) {
    // agenda vertical: fecha -> hora -> cancha — nunca scroll horizontal como solución
    let fechaAnterior = null;
    filas.forEach((fila) => {
      const d = new Date(fila.horarioISO);
      const fechaTxt = d.toLocaleDateString("es-AR", { weekday: "long", day: "2-digit", month: "2-digit" });
      if (fechaTxt !== fechaAnterior) { html += `<div class="calendario-agenda-fecha">${fechaTxt}</div>`; fechaAnterior = fechaTxt; }
      html += `<div class="calendario-agenda-hora">${iconoReloj()} ${d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}</div>`;
      fila.celdas.forEach((celda) => {
        if (celda.estado === "disponible" && !editable) return; // en la agenda pública no hace falta mostrar huecos vacíos
        html += `<div class="calendario-agenda-item"><p class="match-meta meta-caption" style="margin-bottom:2px">${celda.cancha.nombre}</p>`;
        if (celda.estado === "ocupado") html += tarjetaHtml(celda.partido);
        else if (celda.estado === "bloqueado") html += bloqueadaHtml(celda);
        else html += vaciaHtml(fila, celda);
        html += `</div>`;
      });
    });
  } else {
    // grilla de escritorio: auto-fit/minmax se reacomoda al ancho disponible, nunca se corta
    html += `<div class="calendario-grid-scroll"><div class="calendario-grid" style="--calendario-cols:${canchas.length}">`;
    html += `<div></div>` + canchas.map((c) => `<div class="calendario-grid-cabecera">${c.nombre}</div>`).join("");
    filas.forEach((fila) => {
      const fecha = new Date(fila.horarioISO).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
      html += `<div class="calendario-hora">${fecha}</div>`;
      fila.celdas.forEach((celda) => {
        if (celda.estado === "ocupado") html += tarjetaHtml(celda.partido);
        else if (celda.estado === "bloqueado") html += bloqueadaHtml(celda);
        else html += vaciaHtml(fila, celda);
      });
    });
    html += `</div></div>`;
  }

  if (!editable && sinHorario.length > 0) {
    html += `<p class="match-meta" style="margin-top:10px">Sin horario asignado (${sinHorario.length}): ` +
      sinHorario.map((p) => `${p.pareja1_nombre} vs ${p.pareja2_nombre}`).join(" · ") + "</p>";
  }
  cont.innerHTML = html;

  if (editable) wirePlanillaDragAndDrop(containerId);
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
      const partidoId = arrastrando;
      if (!partidoId) return;
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
      // y ahora se le asignó arrastrándolo, esta categoría ya tiene calendario
      // para mostrarle al público, aunque no se haya usado "Generar calendario".
      if (nuevoHorario && !partido?.horario && partido?.categoria) {
        await sb.from("torneo_categorias").update({ estado_fase: "calendario_confirmado" }).eq("torneo_id", torneoGestionId).eq("categoria", partido.categoria);
        await actualizarEstadoTorneoPorFases(torneoGestionId);
      }
      toast(nuevoHorario ? "Partido reubicado ✅" : "Partido movido a \"sin horario\"");
      avisarActualizacionEnVivo();
      refrescarTrasAccionGestion();
    });
  });
}

// tarjeta compacta de un partido para la vista Llave: nombres + resultado set por
// set en línea, fecha/hora y cancha — el ganador se resalta en violeta/lila.
// bloque de un jugador dentro de la tarjeta: avatar (foto si tiene, si no el ícono
// de pelota) + apellido en negrita arriba, nombre chico y gris debajo — si no
// vinieron nombre/apellido separados (jugador borrado, etc.) cae a un "?" como antes
function jugadorBlockHtml(nombre, apellido, foto) {
  if (!nombre && !apellido) return `<div class="llave-jugador">${avatarHtml(foto, 24)}<div><strong>?</strong></div></div>`;
  return `<div class="llave-jugador">${avatarHtml(foto, 24)}<div><strong>${apellido || ""}</strong><span>${nombre || ""}</span></div></div>`;
}

function llavePartidoCardHtml(p) {
  const ganador = p.ganador_pareja_id === p.pareja1_id ? 1 : p.ganador_pareja_id === p.pareja2_id ? 2 : null;
  const sets = p.sets || [];
  const setsHtml = (lado) => sets.map((s) => `<span class="llave-set">${lado === 1 ? s.p1 : s.p2}</span>`).join("");
  const horario = p.horario
    ? new Date(p.horario).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "horario a definir";
  const local = p.cancha_nombre ? `${p.complejo_nombre ? p.complejo_nombre + " " : ""}${p.cancha_nombre}` : "a definir";
  return `
    <div class="llave-partido" data-abrir-partido="${p.id}" style="cursor:pointer">
      <div class="match-meta llave-meta llave-fecha">${iconoReloj()} ${horario}</div>
      <div class="llave-fila ${ganador === 1 ? "ganador" : ""}">
        <div class="llave-jugadores">${jugadorBlockHtml(p.j1a_nombre, p.j1a_apellido, p.j1a_foto)}${jugadorBlockHtml(p.j1b_nombre, p.j1b_apellido, p.j1b_foto)}</div>
        <span class="llave-sets">${setsHtml(1)}</span>
      </div>
      <div class="llave-fila ${ganador === 2 ? "ganador" : ""}">
        <div class="llave-jugadores">${jugadorBlockHtml(p.j2a_nombre, p.j2a_apellido, p.j2a_foto)}${jugadorBlockHtml(p.j2b_nombre, p.j2b_apellido, p.j2b_foto)}</div>
        <span class="llave-sets">${setsHtml(2)}</span>
      </div>
      <div class="match-meta llave-meta">${iconoPin()} Local: ${local}</div>
    </div>`;
}

// vista "llave": columnas de Zona (fase de grupos, una por número de grupo) seguidas
// de las columnas de eliminación directa (una por ronda de bracket), lado a lado como
// en un cuadro de torneo — reutiliza el mismo formato de tarjeta en ambos bloques.
function renderPartidosLlave(containerId, partidos) {
  const cont = document.getElementById(containerId);

  const grupales = partidos.filter((p) => p.grupo != null);
  const gruposOrdenados = [...new Set(grupales.map((p) => p.grupo))].sort((a, b) => a - b);
  const columnasZona = gruposOrdenados.map((g) => ({
    titulo: `Zona ${g}`, zona: true,
    partidos: grupales.filter((p) => p.grupo === g)
  }));

  // cuadro de zonas del club (fase_grupos_formato "cuadro_zonas"): cada zona
  // es un solo partido con slot_cuadro "Z1"/"Z2"/... y ronda "Zona" (no usa
  // `grupo`, que es del formato "Grupos" de todos-contra-todos) — se arma una
  // columna por número de zona igual que arriba, para que también se vea
  // organizado en la Llave y no todo junto bajo un único cartel "Zona".
  const zonasCuadro = partidos.filter((p) => p.ronda === "Zona" && p.slot_cuadro);
  const numsZonaCuadro = [...new Set(zonasCuadro.map((p) => Number(p.slot_cuadro.slice(1))))].sort((a, b) => a - b);
  const columnasZonaCuadro = numsZonaCuadro.map((n) => ({
    titulo: `Zona ${n}`, zona: true,
    partidos: zonasCuadro.filter((p) => Number(p.slot_cuadro.slice(1)) === n)
  }));

  // las columnas de eliminación se arman con los nombres de ronda que realmente existen,
  // en el orden en que se generaron (no una lista fija) — así sirve tanto para el cuadro
  // clásico de 16/8/4/2 como para un torneo chico que arranca directo en semifinal, o con
  // nombres genéricos ("Ronda de 6") si el cuadro es irregular
  const eliminacion = partidos.filter((p) => p.ronda && p.ronda !== "Fase de grupos" && p.grupo == null && !(p.ronda === "Zona" && p.slot_cuadro));
  const nombresOrdenados = [...new Set(
    [...eliminacion].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map((p) => p.ronda)
  )];
  const columnasRonda = nombresOrdenados.map((r) => ({
    titulo: r, zona: false,
    partidos: eliminacion.filter((p) => p.ronda === r)
  }));

  const columnas = [...columnasZona, ...columnasZonaCuadro, ...columnasRonda];

  if (columnas.length === 0) {
    cont.innerHTML = '<p class="empty">Todavía no hay partidos armados.</p>';
    return;
  }

  // arranca mostrando la última columna generada (la ronda más avanzada, la
  // que de verdad importa mientras el torneo está en curso) en vez de la
  // primera -- antes había que ir tocando ronda por ronda para llegar hasta
  // ahí. Además, esa última columna de eliminación (la Final, si el cuadro
  // llegó hasta ahí) se destaca con su propio estilo -- ver .llave-final en
  // style.css -- para reconocerla de un vistazo sin tener que leer el título.
  const ultimaColumna = columnas.length - 1;

  // botones "Octavos / Cuartos / Semis / Final" (o "Zona 1 / Zona 2 / ...")
  // para saltar de ronda en un toque en mobile — ver comentario en style.css.
  // Con una sola columna no aportan nada, así que no se muestran.
  const navRondas = columnas.length > 1
    ? '<div class="pill-row llave-rondas-nav">' +
      columnas.map((col, i) => `<button type="button" class="pill ${i === ultimaColumna ? "active" : ""}" data-llave-col="${i}">${col.titulo}</button>`).join("") +
      "</div>"
    : "";

  cont.innerHTML = navRondas + '<div class="llave-scroll"><div class="llave">' +
    columnas.map((col, i) => {
      // separador visual entre el bloque de zonas y el de eliminación directa
      const esPrimeraDeEliminacion = !col.zona && columnasZona.length > 0 && i === columnasZona.length;
      const esFinal = !col.zona && i === ultimaColumna;
      const clases = ["llave-columna"];
      if (col.zona) clases.push("llave-zona");
      if (esPrimeraDeEliminacion) clases.push("llave-separador");
      if (esFinal) clases.push("llave-final");
      return `
      <div class="${clases.join(" ")}" data-col-index="${i}">
        <h3>${col.titulo}</h3>
        ${col.partidos.map((p) => llavePartidoCardHtml(p)).join("")}
      </div>`;
    }).join("") + "</div></div>";

  cont.querySelectorAll("[data-abrir-partido]").forEach((el) => {
    el.addEventListener("click", () => abrirDetallePartido(el.dataset.abrirPartido));
  });
  cont.querySelectorAll("[data-llave-col]").forEach((btn) => {
    btn.addEventListener("click", () => {
      cont.querySelectorAll("[data-llave-col]").forEach((b) => b.classList.toggle("active", b === btn));
      const columna = cont.querySelector(`[data-col-index="${btn.dataset.llaveCol}"]`);
      // scrollIntoView mueve tanto el scroll horizontal de .llave-scroll como
      // el scroll vertical de la página, en un solo llamado nativo — soluciona
      // de una vez el "hay que bajar Y deslizar" que confundía en mobile.
      if (columna) columna.scrollIntoView({ behavior: "smooth", inline: "start", block: "start" });
    });
  });
  if (columnas.length > 1) {
    const inicial = cont.querySelector(`[data-col-index="${ultimaColumna}"]`);
    if (inicial) inicial.scrollIntoView({ behavior: "auto", inline: "start", block: "nearest" });
  }
}

// ---------- Calendario público/jugador: "orden de juego" ----------
// Un póster por cancha (foto + degradé), pensado para que sirva tal cual
// como imagen para compartir en redes — no solo para mirar en la app. Usa
// los mismos partidos ya filtrados por renderCalendarioPublico (categoría/
// cancha/fecha); reutiliza avatarHtml para las fotos (o el ícono de pelota
// si el jugador no cargó una) y matchVsRowHtml/llavePartidoCardHtml ya
// resolvían este mismo patrón de "2 jugadores por lado", solo que acá con
// estilo de póster en vez de tarjeta de app.
function renderOrdenDeJuego(containerId, partidos, canchasTorneo) {
  const cont = document.getElementById(containerId);
  const canchas = canchasTorneo.map((c) => c.canchas).filter(Boolean);
  const conHorario = [...partidos].filter((p) => p.horario).sort((a, b) => new Date(a.horario) - new Date(b.horario));
  const sinHorario = partidos.filter((p) => !p.horario);

  if (conHorario.length === 0) {
    cont.innerHTML = '<p class="empty">Todavía no hay partidos con cancha y horario asignados.</p>';
    return;
  }

  const jugadorHtml = (nombre, apellido, foto) => `
    <div class="orden-jugador">
      ${avatarHtml(foto, 56)}
      <div class="orden-nombre"><strong>${nombre || "?"}</strong>${apellido ? `<span>${apellido}</span>` : ""}</div>
    </div>`;

  const posterHtml = (cancha, partidosCancha) => {
    if (partidosCancha.length === 0) return "";
    const interior = partidosCancha.map((p, i) => {
      const ganador = p.ganador_pareja_id === p.pareja1_id ? 1 : p.ganador_pareja_id === p.pareja2_id ? 2 : null;
      const cls1 = ganador === 1 ? "ganador" : ganador === 2 ? "perdedor" : "";
      const cls2 = ganador === 2 ? "ganador" : ganador === 1 ? "perdedor" : "";
      const hora = new Date(p.horario).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
      const jugado = p.estado === "jugado";
      // el resultado ya cargado se lee ahí mismo, en el círculo VS -- el
      // póster de calendario sirve entonces también para compartir el
      // resultado, sin mandar a otra pantalla a buscarlo.
      const sets = p.sets || [];
      const scoreTxt = sets.map((s) => `${s.p1}-${s.p2}`).join(" ");
      const vsHtml = jugado && sets.length
        ? `<span class="orden-vs-wrap"><span class="orden-vs">${sets[sets.length - 1].p1}-${sets[sets.length - 1].p2}</span>${sets.length > 1 ? `<span class="orden-score">${scoreTxt}</span>` : ""}</span>`
        : `<span class="orden-vs">VS</span>`;
      return `<div class="orden-sep">${i === 0 ? `Empieza a las ${hora}` : `Seguido por · ${hora}`}</div>
        <div class="orden-match ${jugado ? "jugado" : ""}" data-abrir-partido="${p.id}">
          <div class="orden-lado ${cls1}">${jugadorHtml(p.j1a_nombre, p.j1a_apellido, p.j1a_foto)}${jugadorHtml(p.j1b_nombre, p.j1b_apellido, p.j1b_foto)}</div>
          ${vsHtml}
          <div class="orden-lado der ${cls2}">${jugadorHtml(p.j2a_nombre, p.j2a_apellido, p.j2a_foto)}${jugadorHtml(p.j2b_nombre, p.j2b_apellido, p.j2b_foto)}</div>
        </div>`;
    }).join("");
    const fecha = new Date(partidosCancha[0].horario)
      .toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" })
      .toUpperCase();
    return `<div class="orden-poster">
      <div class="orden-eyebrow">${torneoActualData?.nombre || ""}</div>
      <div class="orden-cancha">${cancha.nombre}</div>
      ${interior}
      <div class="orden-footer"><span>${torneoActualData?.complejos?.nombre || ""}</span><b>${fecha}</b></div>
    </div>`;
  };

  const posters = canchas.map((c) => posterHtml(c, conHorario.filter((p) => p.cancha_id === c.id))).filter(Boolean).join("");
  const notaSinHorario = sinHorario.length > 0
    ? `<p class="match-meta" style="margin-top:12px">Sin horario asignado (${sinHorario.length}): ` +
      sinHorario.map((p) => `${p.pareja1_nombre} vs ${p.pareja2_nombre}`).join(" · ") + "</p>"
    : "";

  cont.innerHTML = `<div class="orden-grid">${posters}</div>${notaSinHorario}`;
  cont.querySelectorAll("[data-abrir-partido]").forEach((el) => {
    el.addEventListener("click", () => abrirDetallePartido(el.dataset.abrirPartido));
  });
}

// ---------- Calendario y Resultados públicos (mismo componente para
// Público y Jugador — el jugador ve exactamente lo mismo) ----------
// true una vez que se eligió sola la fecha del calendario (o el usuario tocó
// el selector a mano) para ESTE torneo — evita que cada re-render en vivo
// vuelva a pisar la elección. Se resetea al entrar a otro torneo (abrirTorneo).
let calFiltroFechaAutoAplicada = false;
function renderCalendarioPublico() {
  const selCat = document.getElementById("calFiltroCategoria");
  if (!categoriasTorneoActual.includes(selCat.value)) selCat.value = "";
  selCat.innerHTML = `<option value="">Todas las categorías</option>` +
    categoriasTorneoActual.map((c) => `<option value="${c}" ${c === selCat.value ? "selected" : ""}>${c}</option>`).join("");

  // solo se pueden elegir las fechas en las que el torneo realmente juega (las de
  // sus partidos ya programados) — antes era un <input type="date"> libre, que
  // dejaba elegir cualquier día del calendario y mostraba la pantalla vacía.
  const selFecha = document.getElementById("calFiltroFecha");
  const fechasConPartidos = [...new Set(ultimosPartidos.filter((p) => p.horario).map((p) => p.horario.slice(0, 10)))].sort();
  // ojo con el orden acá: el <select> todavía tiene las <option> de la vuelta
  // anterior en este punto, así que asignarle selFecha.value ahora (antes de
  // reconstruir el innerHTML de abajo) no sirve de nada si la fecha elegida
  // todavía no existe como opción — por eso se arma en una variable aparte
  // (fechaFiltro) y recién se vuelca como "selected" al armar las <option>.
  let fechaFiltro = fechasConPartidos.includes(selFecha.value) ? selFecha.value : "";
  // a medida que el torneo avanza no tiene sentido arrancar viendo TODOS los
  // partidos desde el primer día — se elige sola la fecha más relevante: la
  // de hoy si hoy se juega, si no la próxima que viene, y si el torneo ya
  // terminó, la última jugada. Solo pasa la primera vez que se ve el
  // calendario de este torneo — tocar el selector a mano (aunque sea para
  // volver a "Todas las fechas") lo deja fijo en lo que se haya elegido.
  if (!calFiltroFechaAutoAplicada && !fechaFiltro && fechasConPartidos.length) {
    const hoy = new Date().toISOString().slice(0, 10);
    fechaFiltro = fechasConPartidos.find((f) => f === hoy) || fechasConPartidos.find((f) => f > hoy) || fechasConPartidos[fechasConPartidos.length - 1];
    calFiltroFechaAutoAplicada = true;
  }
  selFecha.innerHTML = `<option value="">Todas las fechas</option>` +
    fechasConPartidos.map((f) => {
      const label = new Date(f + "T00:00:00").toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "short" });
      return `<option value="${f}" ${f === fechaFiltro ? "selected" : ""}>${label}</option>`;
    }).join("");

  const canchas = ultimasCanchasTorneo.map((c) => c.canchas).filter(Boolean);
  const pills = document.getElementById("calFiltroCanchaPills");
  const canchaPrevia = pills.querySelector(".pill.active")?.dataset.cancha || "";
  pills.innerHTML = `<button type="button" class="pill ${!canchaPrevia ? "active" : ""}" data-cancha="">TODAS</button>` +
    canchas.map((c) => `<button type="button" class="pill ${c.id === canchaPrevia ? "active" : ""}" data-cancha="${c.id}">${c.nombre}</button>`).join("");
  pills.querySelectorAll(".pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      pills.querySelectorAll(".pill").forEach((b) => b.classList.toggle("active", b === btn));
      renderCalendarioPublico();
    });
  });

  let visibles = ultimosPartidos;
  if (selCat.value) visibles = visibles.filter((p) => p.categoria === selCat.value);
  const fecha = document.getElementById("calFiltroFecha").value;
  if (fecha) visibles = visibles.filter((p) => p.horario && p.horario.slice(0, 10) === fecha);
  const canchaSel = pills.querySelector(".pill.active")?.dataset.cancha || "";
  let canchasVisibles = ultimasCanchasTorneo;
  if (canchaSel) {
    canchasVisibles = ultimasCanchasTorneo.filter((c) => c.canchas?.id === canchaSel);
    visibles = visibles.filter((p) => p.cancha_id === canchaSel);
  }
  renderOrdenDeJuego("pubCalendario", visibles, canchasVisibles);
}
document.getElementById("calFiltroCategoria").addEventListener("change", renderCalendarioPublico);
document.getElementById("calFiltroFecha").addEventListener("change", () => { calFiltroFechaAutoAplicada = true; renderCalendarioPublico(); });
// los accesos directos a Calendario/Resultados desde Inicio del torneo se sacaron:
// duplicaban las mismas dos pestañas que ya están arriba, en torneoSubnav.

// Entra a Administración ya con ESTE torneo en gestión (reemplaza el selector
// suelto #admSelectTorneoGestion como único punto de entrada: ahora también se
// llega desde dentro del propio torneo, que es donde tiene sentido "administrar
// esto" — ver Fase 4 de la reorganización club/torneo).
document.getElementById("btnAdministrarEsteTorneo").addEventListener("click", async () => {
  if (!torneoActualId) return;
  adminFocoTorneoActivo = true;
  cambiarVista("admin", "/admin");
  await cargarGestionTorneo(torneoActualId);
  // pantalla enfocada SOLO en este torneo: se oculta el selector suelto y toda la
  // configuración general del club (canchas, categorías, jugadores, etc. — eso vive
  // aparte, en Administración general) para que "Administrar este torneo" no se
  // sienta como "me manda a la configuración general".
  document.getElementById("admSelectorTorneoCard").style.display = "none";
  mostrarConfigGeneral(false);
  document.getElementById("admBtnVolverConfigGeneral").style.display = "inline-block";
  document.getElementById("admGestionTorneoWrap").scrollIntoView({ behavior: "smooth", block: "start" });
});
document.getElementById("admBtnVolverConfigGeneral").addEventListener("click", () => {
  adminFocoTorneoActivo = false;
  document.getElementById("admSelectorTorneoCard").style.display = "block";
  mostrarConfigGeneral(true);
  document.getElementById("admBtnVolverConfigGeneral").style.display = "none";
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

function renderResultadosPublico() {
  const sel = document.getElementById("resFiltroCategoria");
  if (!categoriasTorneoActual.includes(sel.value)) sel.value = "";
  sel.innerHTML = `<option value="">Todas</option>` +
    categoriasTorneoActual.map((c) => `<option value="${c}" ${c === sel.value ? "selected" : ""}>${c}</option>`).join("");
  const visibles = sel.value ? ultimosPartidos.filter((p) => p.categoria === sel.value) : ultimosPartidos;
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
  const visibles = partidosCategoriaFiltro ? partidos.filter((p) => p.categoria === partidosCategoriaFiltro) : partidos;
  if (vistaPartidosAdmin === "planilla") renderPartidosCalendario("admPartidosLista", visibles, canchasTorneo, true);
  else renderPartidosLista("admPartidosLista", visibles, canchasTorneo, true, ultimasParejasGestion);
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
    div.className = "match-card" + (p.estado === "jugado" ? " match-card-jugado" : "") + (!editable ? " clickeable" : "");
    if (!editable) div.dataset.abrirPartido = p.id;
    const horario = p.horario ? new Date(p.horario).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) : "sin horario";
    div.innerHTML = `
      ${matchVsRowHtml(p, ganador)}
      <div class="match-meta">${iconoPin()} ${p.cancha_nombre || "sin cancha"} · ${iconoReloj()} ${horario} · <span class="badge">${p.estado}</span>${p.ronda && p.ronda !== "Fase de grupos" ? ` <span class="badge orange">${p.ronda}</span>` : (p.grupo ? ` <span class="badge orange">Grupo ${p.grupo}</span>` : "")}${!partidosCategoriaFiltro && p.categoria ? ` <span class="badge">${p.categoria}</span>` : ""}</div>
      ${p.estado === "jugado" ? setsGridHtml(p.sets, ganador) : ""}
      ${editable && p.estado !== "jugado" ? `
      <div class="match-admin-panel">
        <p class="match-admin-label">Cargar resultado — ${p.ronda || "Fase de grupos"}</p>
        <div class="sets-entry" data-p="${p.id}">
          <div class="sets-entry-heads"><span></span><span>Set 1</span><span>Set 2</span><span class="setHead3" style="display:none">Set 3</span></div>
          <div class="sets-entry-row">
            <span class="sets-entry-label" title="${p.pareja1_nombre}">${p.pareja1_nombre}</span>
            <input type="number" min="0" max="7" class="setCell" data-p="${p.id}" data-lado="1" data-set="1" />
            <input type="number" min="0" max="7" class="setCell" data-p="${p.id}" data-lado="1" data-set="2" />
            <input type="number" min="0" max="7" class="setCell setCell3" data-p="${p.id}" data-lado="1" data-set="3" style="display:none" />
          </div>
          <div class="sets-entry-row">
            <span class="sets-entry-label" title="${p.pareja2_nombre}">${p.pareja2_nombre}</span>
            <input type="number" min="0" max="7" class="setCell" data-p="${p.id}" data-lado="2" data-set="1" />
            <input type="number" min="0" max="7" class="setCell" data-p="${p.id}" data-lado="2" data-set="2" />
            <input type="number" min="0" max="7" class="setCell setCell3" data-p="${p.id}" data-lado="2" data-set="3" style="display:none" />
          </div>
        </div>
        <div class="match-actions">
          <button class="secondary small btnCargarResultado" data-p="${p.id}" data-p1="${p.pareja1_id}" data-p2="${p.pareja2_id}" data-ronda="${p.ronda || "Fase de grupos"}">Cargar resultado</button>
        </div>
        <div class="match-actions">
          <select class="selectReasignar" data-p="${p.id}">
            ${canchasTorneo.map((c) => `<option value="${c.canchas?.id}" ${c.canchas?.id === p.cancha_id ? "selected" : ""}>${c.canchas?.nombre}</option>`).join("")}
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
            ${parejasTorneo.filter((pj) => pj.categoria === p.categoria).map((pj) => `<option value="${pj.id}" ${pj.id === p.pareja1_id ? "selected" : ""}>${pj.jugador1_nombre} / ${pj.jugador2_nombre}</option>`).join("")}
          </select>
          <select class="selectCambiarPareja2" data-p="${p.id}">
            ${parejasTorneo.filter((pj) => pj.categoria === p.categoria).map((pj) => `<option value="${pj.id}" ${pj.id === p.pareja2_id ? "selected" : ""}>${pj.jugador1_nombre} / ${pj.jugador2_nombre}</option>`).join("")}
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

  // Set 3 solo aparece si hace falta: mejor de 3 — si una pareja ya ganó los dos
  // primeros sets no hay tercero; si quedó 1 a 1, se revela para completarlo.
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

      const { error } = await sb.from("partidos").update({
        sets, estado: "jugado", ganador_pareja_id: ganadorParejaId
      }).eq("id", partidoId);
      if (error) { toast("Error: " + error.message); return; }
      toast("Resultado cargado, ranking actualizado ✅");
      avisarActualizacionEnVivo();
      refrescarTrasAccionGestion();
      cargarRanking();
      if (btn.dataset.ronda === "Final") cargarCampeones();
    });
  });

  cont.querySelectorAll(".btnReasignarCancha").forEach((btn) => {
    btn.addEventListener("click", async () => {
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
    });
  });

  // mover un partido a otro horario (por ejemplo, si un equipo avisa que no llega
  // a la hora que tenía asignada, o para asignarle horario a uno que no tenía) —
  // reusa el mismo chequeo de choques de cancha, incluyendo bloqueos
  cont.querySelectorAll(".btnCambiarHorario").forEach((btn) => {
    btn.addEventListener("click", async () => {
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
      // "Generar calendario") es lo que hace que Calendario/Resultados se le
      // muestren al público: antes, asignar el horario a mano dejaba el dato
      // bien cargado pero la categoría seguía marcada "sin calendario".
      if (!partido?.horario && partido?.categoria) {
        await sb.from("torneo_categorias").update({ estado_fase: "calendario_confirmado" }).eq("torneo_id", torneoGestionId).eq("categoria", partido.categoria);
        await actualizarEstadoTorneoPorFases(torneoGestionId);
      }
      toast("Horario cambiado");
      avisarActualizacionEnVivo();
      refrescarTrasAccionGestion();
    });
  });

  // corrige quién juega un partido sin resultado todavía — para arreglar a
  // mano una zona/cruce del cuadro (o cualquier otro partido) sin tener que
  // borrarlo y armarlo de nuevo. Nunca toca partidos ya jugados (ahí hay que
  // usar la corrección de resultado, que sí revierte el ranking).
  cont.querySelectorAll(".btnCambiarParejas").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const partidoId = btn.dataset.p;
      const p1 = cont.querySelector(`.selectCambiarPareja1[data-p="${partidoId}"]`).value;
      const p2 = cont.querySelector(`.selectCambiarPareja2[data-p="${partidoId}"]`).value;
      if (!p1 || !p2 || p1 === p2) { toast("Elegí dos parejas distintas"); return; }
      const { error } = await sb.from("partidos").update({ pareja1_id: p1, pareja2_id: p2 }).eq("id", partidoId);
      if (error) { toast("Error: " + error.message); return; }
      toast("Parejas actualizadas");
      avisarActualizacionEnVivo();
      refrescarTrasAccionGestion();
    });
  });
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
  const contenido = `<img src="${s.logo_url}" alt="${s.nombre}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'sponsor-caption',textContent:'${s.nombre.replace(/'/g, "\\'")}'}))" />` +
    (caption ? `<span class="sponsor-caption">${caption}</span>` : "");
  const clase = "sponsor-item" + (esJpg ? " sponsor-sin-fondo" : "");
  return s.link_url
    ? `<a href="${s.link_url}" target="_blank" rel="noopener noreferrer" title="${s.nombre}" class="${clase}">${contenido}</a>`
    : `<span class="${clase}" title="${s.nombre}">${contenido}</span>`;
}

async function cargarSponsors() {
  const { data } = await sb.from("sponsors").select("*").eq("activo", true).order("orden");
  const admin = document.getElementById("listaSponsors");
  const inlineCard = document.getElementById("sponsorsInlineCard");
  const inline = document.getElementById("sponsorsInline");
  const sidebarCard = document.getElementById("sidebarSponsorsCard");
  const sidebar = document.getElementById("sidebarSponsors");
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
    if (sidebar) sidebar.innerHTML = generales.map((s) => renderSponsorItem(s)).join("");
    if (sidebarCard) sidebarCard.style.display = "flex";
    if (marqueeTrack) {
      const items = generales.map((s) => renderSponsorItem(s)).join("");
      marqueeTrack.innerHTML = items + items; // duplicado exacto x2: lo pide marquee-scroll para el loop sin corte
    }
    if (marqueeCard) marqueeCard.style.display = "block";
  } else {
    if (inlineCard) inlineCard.style.display = "none";
    if (sidebarCard) sidebarCard.style.display = "none";
    if (marqueeCard) marqueeCard.style.display = "none";
  }
}

// La banda "En noviembre vamos a Brasil / Padel Tour 2026" es un único elemento
// del DOM que se reubica según el ancho (mismo breakpoint que #sidebarAds,
// 960px): en mobile va arriba de Noticias (su lugar de origen en el HTML),
// en desktop se muda al costado de los auspiciantes en la columna lateral.
// Reubicar en vez de duplicar markup/CSS evita mantener dos copias.
const bannerEnergiaHomeMobile = document.getElementById("energiaBanda")?.parentElement || null;
const bannerEnergiaHomeMobileSiguiente = document.getElementById("noticiasCard");
function moverBannerEnergiaSegunAncho() {
  const banner = document.getElementById("energiaBanda");
  const slotDesktop = document.getElementById("sidebarEnergiaSlot");
  if (!banner || !slotDesktop || !bannerEnergiaHomeMobile) return;
  const esDesktop = window.matchMedia("(min-width: 960px)").matches;
  if (esDesktop) {
    if (banner.parentElement !== slotDesktop) slotDesktop.appendChild(banner);
  } else if (banner.parentElement !== bannerEnergiaHomeMobile) {
    bannerEnergiaHomeMobile.insertBefore(banner, bannerEnergiaHomeMobileSiguiente);
  }
}
window.matchMedia("(min-width: 960px)").addEventListener("change", moverBannerEnergiaSegunAncho);
moverBannerEnergiaSegunAncho();

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
});

// ============================================================
// NOTICIAS (novedades del club en Inicio + botón a Instagram)
// ============================================================
function renderNoticiaCard(n) {
  const imagen = n.imagen_url ? `<img src="${n.imagen_url}" alt="${n.titulo}" loading="lazy" onerror="this.style.display='none'" />` : "";
  const contenido = `${imagen}<strong>${n.titulo}</strong>${n.texto ? `<p>${n.texto}</p>` : ""}` +
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
        await sb.from("noticias").delete().eq("id", btn.dataset.id);
        cargarNoticias();
      });
    });
  }
}

document.getElementById("btnSubirNoticia").addEventListener("click", async () => {
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
document.getElementById("btnNotif").addEventListener("click", abrirNotificaciones);
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
  document.getElementById("fotoGrandeOverlay").style.display = "flex";
}
function cerrarFotoGrande() {
  document.getElementById("fotoGrandeOverlay").style.display = "none";
  document.getElementById("fotoGrandeImg").src = "";
}
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
    cargarJugadorDelMes(),
    cargarCampeones(),
    cargarAscendidos(),
    cargarSponsors(),
    cargarRanking(),
    cargarPuntosRonda(),
    cargarConfig(),
    cargarNoticias()
  ]);
}
init();
