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
let categoriaRankingActual = localStorage.getItem("np_categoria_ranking") || null;
let cacheComplejos = [];
let cacheCanchas = [];
let cacheJugadoresAdmin = [];
let cacheCategorias = [];
let cacheTorneos = [];
let torneoDestacadoId = null; // el torneo en curso o el próximo; a donde lleva la banda "Inscribite ya" de Inicio
let modoTorneoDetalle = "resultados"; // resultados | organizar — separa la vista pública de la gestión del torneo (solo admin)
let vistaPartidosActual = "lista"; // lista | calendario | llave
let ultimosPartidos = [];
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

function cambiarVista(nombre) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
  const view = document.getElementById("view-" + nombre);
  if (view) view.classList.add("active");
  const tab = document.querySelector(`.tab[data-view="${nombre}"]`);
  if (tab) tab.classList.add("active");
}
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => cambiarVista(btn.dataset.view));
});
document.getElementById("btnPerfil").addEventListener("click", () => cambiarVista("perfil"));
document.getElementById("btnHeroTorneos").addEventListener("click", () => cambiarVista("torneos"));
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

function renderDisponibilidadForm() {
  const cont = document.getElementById("disponibilidadForm");
  cont.innerHTML = "";
  DIAS.forEach((dia, idx) => {
    const row = document.createElement("div");
    row.className = "day-picker";
    row.innerHTML = `
      <label><input type="checkbox" data-dia="${idx}" class="chkDia" /> ${DIAS_CORTO[idx]}</label>
      <input type="time" class="horaDesde" data-dia="${idx}" value="19:00" />
      <span class="sep">a</span>
      <input type="time" class="horaHasta" data-dia="${idx}" value="23:00" />
    `;
    cont.appendChild(row);
  });
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

  renderDisponibilidadForm();
  const { data: disp } = await sb.from("disponibilidad").select("*").eq("jugador_id", j.id);
  (disp || []).forEach((d) => {
    const chk = document.querySelector(`.chkDia[data-dia="${d.dia_semana}"]`);
    const desde = document.querySelector(`.horaDesde[data-dia="${d.dia_semana}"]`);
    const hasta = document.querySelector(`.horaHasta[data-dia="${d.dia_semana}"]`);
    if (chk) chk.checked = true;
    if (desde) desde.value = String(d.hora_desde).slice(0, 5);
    if (hasta) hasta.value = String(d.hora_hasta).slice(0, 5);
  });
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
    const { data, error } = await sb.from("jugadores").insert(datos).select().single();
    if (error) { toast("Error: " + error.message); return; }
    jugadorId = data.id;
  }

  await sb.from("disponibilidad").delete().eq("jugador_id", jugadorId);
  const disponibilidades = [];
  document.querySelectorAll(".chkDia:checked").forEach((chk) => {
    const dia = chk.dataset.dia;
    const desde = document.querySelector(`.horaDesde[data-dia="${dia}"]`).value;
    const hasta = document.querySelector(`.horaHasta[data-dia="${dia}"]`).value;
    if (desde && hasta) disponibilidades.push({ jugador_id: jugadorId, dia_semana: Number(dia), hora_desde: desde, hora_hasta: hasta });
  });
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

  document.body.classList.toggle("is-admin", isAdmin);
  document.getElementById("btnAdminPanel").style.display = isAdmin ? "flex" : "none";
  document.getElementById("perfilNombreCorto").textContent = miJugador ? miJugador.nombre : "";

  renderVistaPerfil();
  suscribirseANotificacionesRealtime();
  actualizarContadorNotificaciones();
  if (isAdmin) { cargarJugadoresAdmin(); if (FEATURE_JUGAR_HABILITADA) cargarReservasPendientesAdmin(); }
  calcularTorneoDestacado();
  cargarHeroPosicion();
  if (torneoActualId) refrescarDetalleTorneo();
  if (FEATURE_JUGAR_HABILITADA) renderJugar();
}
sb.auth.onAuthStateChange((_event, session) => manejarCambioSesion(session));

// ============================================================
// RANKING (segmentado por categoría, vía función pública)
// ============================================================
let generoRankingActual = localStorage.getItem("np_genero_ranking") || null;
async function cargarRanking() {
  const { data } = await sb.rpc("jugadores_publicos");
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
    const clasificaMaster = posicion <= 10;
    const tr = document.createElement("tr");
    if (clasificaMaster) tr.className = "fila-master";
    const posClass = posicion <= 3 ? `pos-${posicion}` : "";
    const avatarClass = clasificaMaster ? "avatar-master" : "";
    tr.innerHTML = `<td class="${posClass}">${posicion}</td>
      <td><div style="display:flex;align-items:center;gap:8px">${avatarHtml(j.foto_url, clasificaMaster ? 72 : 30, avatarClass)}<span>${j.nombre} ${j.apellido}</span></div></td>
      <td><strong>${j.puntos_ranking}</strong></td>
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
  cambiarVista("perfil-jugador");

  const [{ data: jugadores }, { data: torneosGanados }, { data: finalesPerdidas }, { data: estadisticasRows }] = await Promise.all([
    sb.rpc("jugadores_publicos"),
    sb.rpc("torneos_ganados_publico", { p_jugador_id: jugadorId }),
    sb.rpc("finales_perdidas_publico", { p_jugador_id: jugadorId }),
    sb.rpc("estadisticas_jugador", { p_jugador_id: jugadorId })
  ]);
  const j = (jugadores || []).find((x) => x.id === jugadorId);
  if (!j) { toast("No se encontró el jugador"); cambiarVista(vistaAntesDePerfilJugador); return; }
  const est = (estadisticasRows || [])[0] || {};

  document.getElementById("pjFoto").innerHTML = avatarHtml(j.foto_url, 96);
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
        <div><strong>🏆 ${t.torneo_nombre}</strong><div class="match-meta">con ${t.companero_nombre} ${t.companero_apellido}${t.categoria ? " · " + t.categoria : ""}</div></div>
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
        <span>📅 ${primero.fecha_inicio}</span>
      </div>
    </div>`;
  destacado.querySelector(".flyer-destacado").addEventListener("click", () => abrirTorneo(primero.id));

  resto.forEach((t) => {
    const div = document.createElement("div");
    div.innerHTML = `<img src="${t.flyer_url}" alt="${t.nombre}" loading="lazy" style="cursor:pointer" /><div class="match-meta">${t.nombre}</div>`;
    div.querySelector("img").addEventListener("click", () => abrirTorneo(t.id));
    grid.appendChild(div);
  });
  if (sidebar) {
    const t = proximos[0];
    sidebar.innerHTML = `<img src="${t.flyer_url}" alt="${t.nombre}" style="width:100%;border-radius:10px;border:1px solid var(--border);cursor:pointer" /><div class="match-meta" style="margin-top:6px">${t.nombre}</div>`;
    sidebar.querySelector("img").addEventListener("click", () => abrirTorneo(t.id));
  }
}

function avatarHtml(fotoUrl, size, extraClass) {
  const s = size || 44;
  const cls = extraClass ? ` ${extraClass}` : "";
  return fotoUrl
    ? `<img class="avatar${cls}" src="${fotoUrl}" alt="" loading="lazy" style="width:${s}px;height:${s}px" onerror="this.style.display='none'" />`
    : `<div class="avatar avatar-placeholder${cls}" style="width:${s}px;height:${s}px">🎾</div>`;
}

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
  const { data } = await sb.rpc("jugadores_publicos");
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
      <div class="campeon-torneo">🏆 ${c.torneo_nombre}</div>
    </div>
  `).join("");

  document.querySelectorAll("#campeonesContenido .campeon-nombre-link").forEach((el) => {
    el.addEventListener("click", () => abrirPerfilJugador(el.dataset.jugadorId));
  });
}

// ============================================================
// EN VIVO: torneo actual (o el próximo) + mi partido asignado
// ============================================================
// fila de partido tipo "order of play": equipo · V · equipo, sobre fondo de color
// (se reutiliza acá y en la lista de partidos del detalle del torneo)
// ganador (opcional): 1 o 2 si ya se sabe quién ganó — resalta a esa pareja
// en vez de mostrar los dos nombres igual, para que un partido jugado se vea
// distinto (más "resultado") que uno todavía por jugar
function matchVsRowHtml(nombre1, nombre2, ganador) {
  const cls1 = ganador === 1 ? "ganador" : ganador === 2 ? "perdedor" : "";
  const cls2 = ganador === 2 ? "ganador" : ganador === 1 ? "perdedor" : "";
  return `<div class="match-vs-row ${ganador ? "jugado" : ""}">
    <span class="match-vs-team ${cls1}">${ganador === 1 ? "🏆 " : ""}${nombre1}</span>
    <span class="match-vs-divider">V</span>
    <span class="match-vs-team derecha ${cls2}">${nombre2}${ganador === 2 ? " 🏆" : ""}</span>
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
  const { data } = await sb.from("jugadores").select("*").eq("activo", true).order("apellido");
  cacheJugadoresAdmin = data || [];
  renderListaJugadoresAdmin();
  llenarSelect(document.getElementById("dtSelectJugador1"), cacheJugadoresAdmin, (j) => `${j.nombre} ${j.apellido}`);
  llenarSelect(document.getElementById("dtSelectJugador2"), cacheJugadoresAdmin, (j) => `${j.nombre} ${j.apellido}`);
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
    div.innerHTML = `
      <div class="row">
        <input type="text" class="jaNombre" value="${j.nombre}" placeholder="Nombre" />
        <input type="text" class="jaApellido" value="${j.apellido}" placeholder="Apellido" />
      </div>
      <div class="row" style="margin-top:8px">
        <select class="jaCategoria">${opcionesCategoria}</select>
        <input type="number" class="jaPuntos" value="${j.puntos_ranking}" placeholder="Puntos" style="max-width:100px" />
      </div>
      <div class="match-meta">${j.email || ""} ${j.telefono || ""}</div>
      <div class="row" style="margin-top:8px;gap:8px">
        <button type="button" class="secondary small btnGuardarJugador">Guardar</button>
        <button type="button" class="secondary small danger btnEliminarJugador">Eliminar perfil</button>
      </div>
    `;
    div.querySelector(".btnGuardarJugador").addEventListener("click", async () => {
      const nombre = div.querySelector(".jaNombre").value.trim();
      const apellido = div.querySelector(".jaApellido").value.trim();
      const categoria = div.querySelector(".jaCategoria").value;
      const puntos_ranking = Number(div.querySelector(".jaPuntos").value);
      if (!nombre || !apellido) { toast("Nombre y apellido no pueden quedar vacíos"); return; }
      if (!Number.isFinite(puntos_ranking) || puntos_ranking < 0) { toast("Los puntos tienen que ser un número positivo"); return; }
      const { error } = await sb.from("jugadores").update({ nombre, apellido, categoria, puntos_ranking }).eq("id", j.id);
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

  if (!data || data.length === 0) {
    cont.innerHTML = `<p class="empty">Todavía no hay torneos creados.</p>`;
    return;
  }
  data.forEach((t) => {
    const div = document.createElement("div");
    div.className = "match-card torneo-card-poster";
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
        📍 <span>${t.complejos?.nombre || "sin complejo"}</span>
        ${maps ? `<a href="${maps}" target="_blank" rel="noopener" class="torneo-maps-link">Ver ubicación ↗</a>` : ""}
      </div>
      <div class="match-meta">${categorias} · desde ${t.fecha_inicio}</div>
    `;
    div.addEventListener("click", () => abrirTorneo(t.id));
    const linkMaps = div.querySelector(".torneo-maps-link");
    if (linkMaps) linkMaps.addEventListener("click", (e) => e.stopPropagation());
    cont.appendChild(div);
  });
}

// el form de crear torneo queda escondido por defecto (puede haber muchos torneos
// en la lista) y solo se muestra cuando el admin lo pide
document.getElementById("btnMostrarCrearTorneo").addEventListener("click", () => {
  const card = document.getElementById("crearTorneoCard");
  card.style.display = "block";
  card.scrollIntoView({ behavior: "smooth", block: "start" });
});
document.getElementById("btnCancelarCrearTorneo").addEventListener("click", () => {
  document.getElementById("crearTorneoCard").style.display = "none";
});

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

async function abrirTorneo(id) {
  torneoActualId = id;
  // al entrar a un torneo siempre se arranca en Resultados, incluso para un admin —
  // Organizar es un modo al que se entra a propósito, no el default
  cambiarModoTorneoDetalle("resultados");
  cambiarVista("torneo-detalle");
  await refrescarDetalleTorneo();
}
document.getElementById("btnVolverTorneos").addEventListener("click", () => cambiarVista("torneos"));

// ---------- Resultados vs Organizar (torneo-detalle) ----------
function cambiarModoTorneoDetalle(modo) {
  modoTorneoDetalle = modo;
  document.body.classList.toggle("modo-organizar", modo === "organizar");
  document.querySelectorAll("#torneoModoPills .pill").forEach((b) => b.classList.toggle("active", b.dataset.modo === modo));
  // el botón de abrir/cerrar inscripción y el panel de carga de resultado/cancha/horario
  // de cada partido dependen del modo actual — se refresca todo el detalle del torneo
  if (torneoActualId) refrescarDetalleTorneo();
}
document.querySelectorAll("#torneoModoPills .pill").forEach((btn) => {
  btn.addEventListener("click", () => cambiarModoTorneoDetalle(btn.dataset.modo));
});

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

async function renderInscribirme() {
  const estado = document.getElementById("inscripcionEstado");
  const btn = document.getElementById("btnInscribirme");
  const buscarWrap = document.getElementById("buscarParejaWrap");
  document.getElementById("confirmarInscripcionWrap").style.display = "none";

  if (!currentUser) {
    estado.textContent = "Iniciá sesión para poder inscribirte.";
    buscarWrap.style.display = "none";
    btn.style.display = "block";
    btn.textContent = "Iniciar sesión";
    btn.disabled = false;
    btn.onclick = () => cambiarVista("perfil");
    return;
  }
  if (!miJugador) {
    estado.textContent = "Completá tu perfil de jugador antes de inscribirte.";
    buscarWrap.style.display = "none";
    btn.style.display = "block";
    btn.textContent = "Completar perfil";
    btn.disabled = false;
    btn.onclick = () => cambiarVista("perfil");
    return;
  }

  const { data: jp } = await sb.rpc("jugadores_publicos");
  jugadoresParaBuscar = jp || [];

  const selCat = document.getElementById("anotarmeCategoria");
  selCat.innerHTML = `<option value="">Elegí la categoría</option>` +
    categoriasTorneoActual.map((c) => `<option value="${c}">${c}</option>`).join("");

  const { data } = await sb.from("inscripciones").select("id").eq("torneo_id", torneoActualId).eq("jugador_id", miJugador.id).maybeSingle();
  if (data) {
    estado.textContent = "✅ Ya estás inscripto en este torneo.";
    buscarWrap.style.display = "none";
    btn.style.display = "none";
  } else if (torneoActualData && torneoActualData.estado !== "inscripcion") {
    estado.textContent = "🔒 La inscripción para este torneo está cerrada.";
    buscarWrap.style.display = "none";
    btn.style.display = "none";
  } else {
    estado.textContent = "";
    buscarWrap.style.display = "block";
    btn.style.display = "block";
    btn.onclick = () => mostrarConfirmarInscripcion();
    actualizarBotonInscribirme();
  }
}

// paso 2: confirmación antes de anotar de verdad (acá se va a sumar el pago más adelante)
function mostrarConfirmarInscripcion() {
  const categoria = document.getElementById("anotarmeCategoria").value;
  if (!parejaSeleccionada) { toast("Elegí primero con quién vas a jugar"); return; }
  if (!categoria) { toast("Elegí en qué categoría van a jugar"); return; }
  const t = cacheTorneos.find((x) => x.id === torneoActualId);
  const costoTxt = t?.costo ? ` · Costo: $${t.costo}` : "";
  document.getElementById("confirmarInscripcionResumen").textContent =
    `¿Anotamos a vos y a ${parejaSeleccionada.nombre} ${parejaSeleccionada.apellido} en "${t?.nombre || "este torneo"}", categoría ${categoria}?${costoTxt} Un admin va a confirmar la inscripción cuando verifique el pago.`;
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
  renderInscribirme();
  refrescarDetalleTorneo();
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

async function refrescarDetalleTorneo() {
  if (!torneoActualId) return;
  const { data: t } = await sb.from("torneos").select("*, complejos(nombre), torneo_categorias(categoria)").eq("id", torneoActualId).single();
  if (!t) return;
  torneoActualData = t;

  document.getElementById("dtNombre").textContent = t.nombre;
  document.getElementById("dtEstado").innerHTML = badgeEstadoTorneo(t);
  const btnToggleInsc = document.getElementById("btnToggleInscripcion");
  if (isAdmin && modoTorneoDetalle === "organizar" && (t.estado === "inscripcion" || t.estado === "inscripcion_cerrada")) {
    btnToggleInsc.style.display = "inline-block";
    btnToggleInsc.textContent = t.estado === "inscripcion" ? "🔒 Cerrar inscripción" : "🔓 Reabrir inscripción";
    btnToggleInsc.onclick = async () => {
      const nuevoEstado = t.estado === "inscripcion" ? "inscripcion_cerrada" : "inscripcion";
      const { error } = await sb.from("torneos").update({ estado: nuevoEstado }).eq("id", torneoActualId);
      if (error) { toast("Error: " + error.message); return; }
      toast(nuevoEstado === "inscripcion_cerrada" ? "Inscripción cerrada" : "Inscripción reabierta");
      refrescarDetalleTorneo();
    };
  } else {
    btnToggleInsc.style.display = "none";
  }
  categoriasTorneoActual = (t.torneo_categorias || []).map((c) => c.categoria);
  const categorias = categoriasTorneoActual.join(", ") || "todas las categorías";
  document.getElementById("dtInfo").textContent = `${t.complejos?.nombre || "sin complejo"} · ${categorias} · ${t.fecha_inicio} a ${t.fecha_fin}`;
  const selCatInscribir = document.getElementById("dtSelectCategoriaInscribir");
  selCatInscribir.innerHTML = `<option value="">Elegí la categoría</option>` +
    categoriasTorneoActual.map((c) => `<option value="${c}">${c}</option>`).join("");
  const selCatPartidos = document.getElementById("partidosCategoriaFiltro");
  if (!categoriasTorneoActual.includes(partidosCategoriaFiltro)) partidosCategoriaFiltro = "";
  selCatPartidos.innerHTML = `<option value="">Todas</option>` +
    categoriasTorneoActual.map((c) => `<option value="${c}" ${c === partidosCategoriaFiltro ? "selected" : ""}>${c}</option>`).join("");

  const contCosto = document.getElementById("dtCosto");
  if (t.costo && Number(t.costo) > 0) {
    contCosto.style.display = "block";
    contCosto.innerHTML = `<span class="badge solid">💰 Costo: $${t.costo}</span>` +
      (configApp.whatsapp_numero ? `<button type="button" class="secondary small" id="btnPagarWhatsapp" style="margin-left:8px">💬 Coordinar pago por WhatsApp</button>` : "");
    const btnWsp = document.getElementById("btnPagarWhatsapp");
    if (btnWsp) {
      btnWsp.addEventListener("click", () => {
        const quien = miJugador ? `Soy ${miJugador.nombre} ${miJugador.apellido} y ` : "";
        const mensaje = `Hola! ${quien}quiero coordinar el pago de mi inscripción a "${t.nombre}" ($${t.costo}).`;
        window.open(`https://wa.me/${configApp.whatsapp_numero}?text=${encodeURIComponent(mensaje)}`, "_blank", "noopener,noreferrer");
      });
    }
  } else {
    contCosto.style.display = "none";
    contCosto.innerHTML = "";
  }

  const flyerImg = document.getElementById("dtFlyer");
  if (t.flyer_url) { flyerImg.src = t.flyer_url; flyerImg.style.display = "block"; }
  else flyerImg.style.display = "none";

  await renderInscribirme();
  await cargarSponsorsTorneo();

  const { data: tc } = await sb.from("torneo_canchas").select("*, canchas(id, nombre, complejo_id)").eq("torneo_id", torneoActualId);
  document.getElementById("dtCanchas").innerHTML = (tc || []).map((c) =>
    `<span class="badge orange" style="margin-right:6px">${c.canchas?.nombre || "?"}</span>`
  ).join("") || '<p class="empty">Sin canchas asignadas todavía.</p>';
  llenarSelect(document.getElementById("dtSelectCancha"), cacheCanchas, (c) => {
    const complejo = cacheComplejos.find((x) => x.id === c.complejo_id);
    return `${c.nombre} (${complejo ? complejo.nombre : "?"})`;
  });

  // "Quiénes se anotaron" se muestra siempre como parejas (nunca una lista de nombres
  // sueltos repetida aparte) — a quien todavía no tiene con quién jugar se lo agrupa
  // en un cartel aparte, en vez de mezclarlo con las parejas ya armadas.
  const [{ data: insc }, { data: parejas }] = await Promise.all([
    sb.rpc("inscriptos_publicos", { p_torneo_id: torneoActualId }),
    sb.rpc("parejas_publicas", { p_torneo_id: torneoActualId })
  ]);
  const enPareja = new Set((parejas || []).flatMap((p) => [p.jugador1_id, p.jugador2_id]));
  const sinPareja = (insc || []).filter((i) => !enPareja.has(i.jugador_id));

  const contParejas = document.getElementById("dtParejas");
  contParejas.innerHTML = (parejas || []).map((p) => {
    const catBadge = p.categoria ? `<span class="badge">${p.categoria}</span>` : "";
    const estadoBadge = p.estado === "confirmada"
      ? `<span class="badge solid">Confirmada</span>`
      : `<span class="badge orange">Pendiente de confirmar</span>`;
    return `<div class="pareja-row">
      <span>🎾 ${p.jugador1_nombre} / ${p.jugador2_nombre} ${catBadge} ${estadoBadge}</span>
      <span style="display:flex;gap:6px;align-items:center;flex-shrink:0">
        ${isAdmin && modoTorneoDetalle === "organizar" && p.estado !== "confirmada" ? `<button type="button" class="secondary small btnConfirmarPareja" data-j1="${p.jugador1_id}" data-j2="${p.jugador2_id}">Confirmar</button>` : ""}
        ${isAdmin && modoTorneoDetalle === "organizar" ? `<button type="button" class="danger btnBorrarPareja" data-id="${p.id}" data-nombre="${p.jugador1_nombre} / ${p.jugador2_nombre}" data-j1="${p.jugador1_id}" data-j2="${p.jugador2_id}" aria-label="Sacar del torneo a la pareja ${p.jugador1_nombre} / ${p.jugador2_nombre}">×</button>` : ""}
      </span>
    </div>`;
  }).join("") || '<p class="empty">Todavía no hay parejas anotadas.</p>';
  contParejas.querySelectorAll(".btnBorrarPareja").forEach((btn) => {
    btn.addEventListener("click", async () => await borrarPareja(btn.dataset.id, btn.dataset.nombre, btn.dataset.j1, btn.dataset.j2));
  });
  contParejas.querySelectorAll(".btnConfirmarPareja").forEach((btn) => {
    btn.addEventListener("click", async () => await confirmarPareja(btn.dataset.j1, btn.dataset.j2));
  });

  const contSinPareja = document.getElementById("dtSinPareja");
  contSinPareja.innerHTML = sinPareja.length === 0 ? "" : `
    <p class="match-meta" style="margin:12px 0 6px">Todavía sin pareja:</p>
    ${sinPareja.map((i) =>
      `<span class="pill removable" style="display:inline-flex;margin:0 6px 6px 0">${i.nombre} ${i.apellido}${i.categoria_torneo ? ` · ${i.categoria_torneo}` : ""}${i.estado && i.estado !== "confirmada" ? " · pendiente" : ""}${isAdmin && modoTorneoDetalle === "organizar" ? `<button type="button" class="btnBorrarInscripto" data-id="${i.jugador_id}" data-nombre="${i.nombre} ${i.apellido}" aria-label="Sacar a ${i.nombre} del torneo">×</button>` : ""}</span>`
    ).join("")}`;
  contSinPareja.querySelectorAll(".btnBorrarInscripto").forEach((btn) => {
    btn.addEventListener("click", async () => await borrarInscripcion(btn.dataset.id, btn.dataset.nombre));
  });

  const { data: partidos } = await sb.rpc("partidos_publicos", { p_torneo_id: torneoActualId });
  renderPartidos(partidos || [], tc || []);

  if (isAdmin && cacheJugadoresAdmin.length === 0) cargarJugadoresAdmin();
}

// ---------- editar torneo (nombre, sede, categorías, fechas, costo, flyer) ----------
document.getElementById("btnMostrarEditarTorneo").addEventListener("click", async () => {
  if (!torneoActualData) return;
  const t = torneoActualData;
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
  document.getElementById("teFaseGruposFormato").value = t.fase_grupos_formato || "grupos";
  document.getElementById("teTamanoGrupo").value = t.tamano_grupo || 3;
  document.getElementById("teAvanzanPorGrupo").value = t.avanzan_por_grupo || 2;
  document.getElementById("teFlyerArchivo").value = "";
  const categoriasActuales = new Set(categoriasTorneoActual);
  document.querySelectorAll(".chkTorneoCategoriaEdit").forEach((chk) => (chk.checked = categoriasActuales.has(chk.value)));
  const card = document.getElementById("editarTorneoCard");
  card.style.display = "block";
  card.scrollIntoView({ behavior: "smooth", block: "start" });
});
document.getElementById("btnCancelarEditarTorneo").addEventListener("click", () => {
  document.getElementById("editarTorneoCard").style.display = "none";
});
document.getElementById("btnGuardarTorneo").addEventListener("click", async () => {
  if (!isAdmin || !torneoActualId) return;
  const nombre = document.getElementById("teNombre").value.trim();
  const complejoId = document.getElementById("teComplejo").value;
  const fechaInicio = document.getElementById("teFechaInicio").value;
  if (!nombre || !fechaInicio) { toast("Completá al menos nombre y fecha de inicio"); return; }

  const categoriasElegidas = Array.from(document.querySelectorAll(".chkTorneoCategoriaEdit:checked")).map((c) => c.value);
  if (categoriasElegidas.length === 0) { toast("Elegí al menos una categoría"); return; }

  let flyerUrl = torneoActualData?.flyer_url || null;
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
    fase_grupos_formato: document.getElementById("teFaseGruposFormato").value,
    tamano_grupo: Number(document.getElementById("teTamanoGrupo").value) || 3,
    avanzan_por_grupo: Number(document.getElementById("teAvanzanPorGrupo").value) || 2
  };
  const { error } = await sb.from("torneos").update(cambios).eq("id", torneoActualId);
  if (error) { toast("Error: " + error.message); return; }

  // reemplaza las categorías del torneo por las que quedaron tildadas
  await sb.from("torneo_categorias").delete().eq("torneo_id", torneoActualId);
  await sb.from("torneo_categorias").insert(categoriasElegidas.map((categoria) => ({ torneo_id: torneoActualId, categoria })));

  toast("Torneo actualizado");
  document.getElementById("editarTorneoCard").style.display = "none";
  cargarTorneos();
  cargarInicio();
  refrescarDetalleTorneo();
});

document.getElementById("btnAgregarCanchaTorneo").addEventListener("click", async () => {
  const canchaId = document.getElementById("dtSelectCancha").value;
  if (!canchaId) return;
  const { error } = await sb.from("torneo_canchas").insert({ torneo_id: torneoActualId, cancha_id: canchaId });
  if (error) { toast("Esa cancha ya está asignada u ocurrió un error"); return; }
  toast("Cancha agregada al torneo");
  refrescarDetalleTorneo();
});

// Inscribe una pareja completa a mano (ej: dos amigos que se lo pidieron directo al club).
// Siempre entran los dos juntos, nunca un jugador suelto — así nunca queda nadie sin pareja.
document.getElementById("btnInscribir").addEventListener("click", async () => {
  const jugador1Id = document.getElementById("dtSelectJugador1").value;
  const jugador2Id = document.getElementById("dtSelectJugador2").value;
  const categoria = document.getElementById("dtSelectCategoriaInscribir").value;
  if (!jugador1Id || !jugador2Id) return;
  if (jugador1Id === jugador2Id) { toast("Elegí dos jugadores distintos"); return; }
  if (!categoria) { toast("Elegí en qué categoría los inscribís"); return; }
  // lo inscribe el admin a mano, así que queda confirmado directo (no hace falta el paso
  // de "pendiente" que sí aplica cuando se anotan ellos mismos desde la app)
  const { error: e1 } = await sb.from("inscripciones").insert({ torneo_id: torneoActualId, jugador_id: jugador1Id, categoria, estado: "confirmada" });
  const { error: e2 } = await sb.from("inscripciones").insert({ torneo_id: torneoActualId, jugador_id: jugador2Id, categoria, estado: "confirmada" });
  if (e1 || e2) { toast("Alguno de los dos ya está inscripto u ocurrió un error"); return; }
  const { error: e3 } = await sb.from("parejas").insert({ torneo_id: torneoActualId, jugador1_id: jugador1Id, jugador2_id: jugador2Id });
  if (e3) { toast("Se inscribieron pero no se pudo armar la pareja: " + e3.message); refrescarDetalleTorneo(); return; }
  toast("Pareja inscripta");
  avisarActualizacionEnVivo();
  refrescarDetalleTorneo();
});

// ---------- sacar a alguien del torneo (ej: no pagó) — solo admin ----------
// se usa solo con gente sin pareja todavía (a quien ya tiene pareja primero hay
// que separarlo con borrarPareja, así nunca se borra a alguien "de arrastre")
async function borrarInscripcion(jugadorId, nombreJugador) {
  const { error } = await sb.from("inscripciones").delete().eq("torneo_id", torneoActualId).eq("jugador_id", jugadorId);
  if (error) { toast("Error: " + error.message); return; }
  toast(`Se sacó a ${nombreJugador} del torneo`);
  avisarActualizacionEnVivo();
  refrescarDetalleTorneo();
}

// ---------- admin confirma que la pareja pagó y que la categoría es correcta ----------
// (recién ahí la inscripción de los dos pasa de "pendiente" a "confirmada")
async function confirmarPareja(jugador1Id, jugador2Id) {
  const { error: e1 } = await sb.from("inscripciones").update({ estado: "confirmada" }).eq("torneo_id", torneoActualId).eq("jugador_id", jugador1Id);
  const { error: e2 } = await sb.from("inscripciones").update({ estado: "confirmada" }).eq("torneo_id", torneoActualId).eq("jugador_id", jugador2Id);
  if (e1 || e2) { toast("Error: " + (e1 || e2).message); return; }
  toast("Inscripción confirmada");
  avisarActualizacionEnVivo();
  refrescarDetalleTorneo();
}

// Borra la pareja completa del torneo: los dos jugadores quedan totalmente
// desinscriptos (no "sin pareja" sueltos) — para volver a anotarse tienen que
// hacerlo de nuevo, siempre de a dos.
async function borrarPareja(parejaId, nombrePareja, jugador1Id, jugador2Id) {
  const { data: jugado } = await sb.from("partidos").select("id")
    .eq("torneo_id", torneoActualId)
    .or(`pareja1_id.eq.${parejaId},pareja2_id.eq.${parejaId}`)
    .eq("estado", "jugado").maybeSingle();
  if (jugado) { toast(`${nombrePareja} ya jugó partidos en este torneo — sacale el resultado a mano primero`); return; }
  const { error } = await sb.from("parejas").delete().eq("id", parejaId); // borra también sus partidos pendientes (en cascada)
  if (error) { toast("Error: " + error.message); return; }
  await sb.from("inscripciones").delete().eq("torneo_id", torneoActualId).eq("jugador_id", jugador1Id);
  await sb.from("inscripciones").delete().eq("torneo_id", torneoActualId).eq("jugador_id", jugador2Id);
  toast(`Se sacó del torneo a la pareja ${nombrePareja}`);
  avisarActualizacionEnVivo();
  refrescarDetalleTorneo();
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

function ventanaDelTorneo(torneo) {
  return torneo.hora_desde && torneo.hora_hasta
    ? { desde: horaAMinutos(torneo.hora_desde), hasta: horaAMinutos(torneo.hora_hasta) }
    : null;
}

async function jugadoresDisponibilidad(jugadorIds) {
  const { data: dispRows } = await sb.from("disponibilidad").select("*").in("jugador_id", jugadorIds);
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

// Arma (e inserta) los partidos de UNA categoría, encadenando la ocupación
// de cancha/horario ya usada por otras categorías del mismo torneo para no
// proponerles la misma cancha a la misma hora. `entrada` es {parejas: [...]}
// para modo eliminación directa, o {grupos: [[...], ...]} para fase de grupos.
async function armarPartidosParaGrupo(entrada, categoria, ronda, torneo, canchas, ocupacionAcumulada) {
  const todasLasParejas = entrada.grupos ? entrada.grupos.flat() : entrada.parejas;
  if (todasLasParejas.length < 2) return { generados: 0, sinHorario: 0 };
  const jugadorIds = [...new Set(todasLasParejas.flatMap((p) => [p.jugador1_id, p.jugador2_id]))];
  const disponibilidadPorJugador = await jugadoresDisponibilidad(jugadorIds);

  const { partidosGenerados, sinHorario } = armarPartidosAutomatico({
    parejas: entrada.parejas,
    grupos: entrada.grupos,
    disponibilidadPorJugador,
    fechasDisponibles: fechasDelTorneo(torneo),
    canchas,
    duracionMinutos: torneo.duracion_minutos || 90,
    ventana: ventanaDelTorneo(torneo),
    partidosYaProgramados: ocupacionAcumulada
  });

  if (partidosGenerados.length > 0) {
    const filas = partidosGenerados.map((p) => ({ torneo_id: torneoActualId, ronda, categoria, ...p, estado: "programado" }));
    const { error } = await sb.from("partidos").insert(filas);
    if (error) { toast(`Error armando ${categoria}: ` + error.message); return { generados: 0, sinHorario: 0 }; }
    ocupacionAcumulada.push(...partidosGenerados);
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
  // propia fase de grupos por separado, nunca cruzadas entre sí.
  const { data: parejasDb } = await sb.rpc("parejas_publicas", { p_torneo_id: torneoActualId });
  if (!parejasDb || parejasDb.length < 2) { toast("Armá primero al menos 2 parejas"); return; }

  // evita duplicar partidos si se apreta el botón más de una vez: solo arma
  // fase de grupos para las parejas que todavía no tienen ningún partido
  const { data: partidosExistentes } = await sb.from("partidos").select("pareja1_id, pareja2_id, cancha_id, horario").eq("torneo_id", torneoActualId);
  const yaJuegan = new Set((partidosExistentes || []).flatMap((p) => [p.pareja1_id, p.pareja2_id]));
  const parejasSinPartido = parejasDb.filter((p) => !yaJuegan.has(p.id));
  if (parejasSinPartido.length < 2) { toast("Todas las parejas ya tienen un partido de fase de grupos asignado"); return; }

  const { data: torneo } = await sb.from("torneos").select("*").eq("id", torneoActualId).single();
  const { data: tc } = await sb.from("torneo_canchas").select("canchas(*)").eq("torneo_id", torneoActualId);
  const canchas = (tc || []).map((c) => c.canchas).filter(Boolean);
  if (canchas.length === 0) { toast("Asigná al menos una cancha a este torneo"); return; }
  if (canchas.length === 1) toast("Ojo: este torneo tiene una sola cancha cargada — todos los partidos van a ir ahí. Agregá más canchas abajo si querés repartirlos.");

  const ocupacionAcumulada = [...(partidosExistentes || [])];
  const grupos = agruparPorCategoria(parejasSinPartido);
  const formatoGrupos = torneo.fase_grupos_formato === "grupos";
  let totalGenerados = 0, totalSinHorario = 0;
  for (const categoria of Object.keys(grupos)) {
    const parejasCategoria = grupos[categoria];
    if (parejasCategoria.length < 2) continue; // una sola pareja suelta en esa categoría: no hay con quién cruzarla todavía
    const entrada = formatoGrupos
      ? { grupos: armarGruposDeParejas(parejasCategoria, torneo.tamano_grupo || 3) }
      : { parejas: parejasCategoria };
    const { generados, sinHorario } = await armarPartidosParaGrupo(entrada, categoria, "Fase de grupos", torneo, canchas, ocupacionAcumulada);
    totalGenerados += generados;
    totalSinHorario += sinHorario;
  }

  toast(`Se programaron ${totalGenerados} partidos` + (totalSinHorario ? `, ${totalSinHorario} quedaron sin horario común` : ""));
  avisarActualizacionEnVivo();
  refrescarDetalleTorneo();
});

// Por cada categoría del torneo, toma los ganadores de SU fase más avanzada
// ya jugada por completo y arma SU siguiente fase, nombrándola según cuántas
// parejas clasificaron (4 parejas -> Semifinal directo, sin pasar por
// Dieciseisavos/Octavos/Cuartos como si siempre hubiera un cuadro de 32), en
// vez de dejar que el admin elija la ronda de cada partido a mano. Categorías
// que van más atrasadas que otras (por ejemplo, todavía en fase de grupos
// mientras otra ya llegó a Cuartos) simplemente esperan su turno.
document.getElementById("btnGenerarSiguienteFase").addEventListener("click", async () => {
  const { data: partidos } = await sb.rpc("partidos_publicos", { p_torneo_id: torneoActualId });
  if (!partidos || partidos.length === 0) { toast("Todavía no armaste ningún partido"); return; }

  const { data: torneo } = await sb.from("torneos").select("*").eq("id", torneoActualId).single();
  const { data: tc } = await sb.from("torneo_canchas").select("canchas(*)").eq("torneo_id", torneoActualId);
  const canchas = (tc || []).map((c) => c.canchas).filter(Boolean);
  if (canchas.length === 0) { toast("Asigná al menos una cancha a este torneo"); return; }

  const ocupacionAcumulada = partidos.map((p) => ({ cancha_id: p.cancha_id, horario: p.horario }));
  const grupos = agruparPorCategoria(partidos);
  const mensajes = [];
  let totalGenerados = 0;

  for (const categoria of Object.keys(grupos)) {
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
    if (ganadoresIds.length < 2) { if (ganadoresIds.length === 1) mensajes.push(`${categoria}: ya tiene a su campeón, no hay más fases para armar`); continue; }
    if (ganadoresIds.length % 2 !== 0) { mensajes.push(`${categoria}: quedaron ${ganadoresIds.length} clasificados (número impar) — resolvé eso a mano`); continue; }

    const { data: parejasGanadoras } = await sb.from("parejas").select("*").in("id", ganadoresIds);
    const siguienteFase = nombreFasePorCantidadEquipos(ganadoresIds.length);
    const { generados } = await armarPartidosParaGrupo({ parejas: parejasGanadoras }, categoria, siguienteFase, torneo, canchas, ocupacionAcumulada);
    if (generados > 0) { totalGenerados += generados; mensajes.push(`${categoria}: se armó "${siguienteFase}" (${generados})`); }
  }

  toast(mensajes.length ? mensajes.join(" · ") : "Ninguna categoría está lista para avanzar todavía");
  if (totalGenerados > 0) avisarActualizacionEnVivo();
  refrescarDetalleTorneo();
});

// ---------- render de partidos + carga de resultados ----------
document.querySelectorAll("#partidosVistaPills .pill").forEach((btn) => {
  btn.addEventListener("click", () => {
    vistaPartidosActual = btn.dataset.vista;
    document.querySelectorAll("#partidosVistaPills .pill").forEach((b) => b.classList.toggle("active", b === btn));
    renderPartidos(ultimosPartidos, ultimasCanchasTorneo);
  });
});

document.getElementById("partidosCategoriaFiltro").addEventListener("change", (e) => {
  partidosCategoriaFiltro = e.target.value;
  renderPartidos(ultimosPartidos, ultimasCanchasTorneo);
});

// ultimosPartidos guarda SIEMPRE todos los partidos del torneo (todas las
// categorías) — hace falta así de completo para detectar choques de cancha
// entre categorías. El filtro de categoría solo afecta qué se muestra.
function renderPartidos(partidos, canchasTorneo) {
  ultimosPartidos = partidos;
  ultimasCanchasTorneo = canchasTorneo;
  const visibles = partidosCategoriaFiltro ? partidos.filter((p) => p.categoria === partidosCategoriaFiltro) : partidos;
  if (vistaPartidosActual === "calendario") return renderPartidosCalendario(visibles, canchasTorneo);
  if (vistaPartidosActual === "llave") return renderPartidosLlave(visibles);
  return renderPartidosLista(visibles, canchasTorneo);
}

// vista "tipo calendario": una tabla con las canchas del torneo como columnas
// y cada horario distinto en el que hay algún partido como fila.
function renderPartidosCalendario(partidos, canchasTorneo) {
  const cont = document.getElementById("dtPartidos");
  const canchas = canchasTorneo.map((c) => c.canchas).filter(Boolean);
  const conHorario = partidos.filter((p) => p.horario);
  const sinHorario = partidos.filter((p) => !p.horario);

  if (canchas.length === 0 || conHorario.length === 0) {
    cont.innerHTML = '<p class="empty">Todavía no hay partidos con cancha y horario asignados.</p>';
    return;
  }

  const horarios = [...new Set(conHorario.map((p) => p.horario))].sort();
  const celda = (horario, canchaId) => conHorario.find((p) => p.horario === horario && p.cancha_id === canchaId);

  let html = '<div style="overflow-x:auto"><table class="tabla-calendario"><thead><tr><th>Horario</th>' +
    canchas.map((c) => `<th>${c.nombre}</th>`).join("") + "</tr></thead><tbody>";
  horarios.forEach((h) => {
    const fecha = new Date(h).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
    html += `<tr><td class="calendario-hora">${fecha}</td>`;
    canchas.forEach((c) => {
      const p = celda(h, c.id);
      html += "<td>" + (p
        ? `<div class="calendario-partido ${p.estado === "jugado" ? "jugado" : ""}">
             <div class="calendario-equipo">${p.pareja1_nombre}</div>
             <div class="calendario-vs">V</div>
             <div class="calendario-equipo">${p.pareja2_nombre}</div>
             ${p.ronda && p.ronda !== "Fase de grupos" ? `<span class="badge orange" style="margin-top:4px">${p.ronda}</span>` : (p.grupo ? `<span class="badge orange" style="margin-top:4px">Grupo ${p.grupo}</span>` : "")}
             ${!partidosCategoriaFiltro && p.categoria ? `<span class="badge" style="margin-top:4px">${p.categoria}</span>` : ""}
           </div>`
        : "") + "</td>";
    });
    html += "</tr>";
  });
  html += "</tbody></table></div>";

  if (sinHorario.length > 0) {
    html += `<p class="match-meta" style="margin-top:10px">Sin horario asignado (${sinHorario.length}): ` +
      sinHorario.map((p) => `${p.pareja1_nombre} vs ${p.pareja2_nombre}`).join(" · ") + "</p>";
  }
  cont.innerHTML = html;
}

// tarjeta compacta de un partido para la vista Llave: nombres + resultado set por
// set en línea, fecha/hora y cancha — el ganador se resalta en violeta/lila.
function llavePartidoCardHtml(p) {
  const ganador = p.ganador_pareja_id === p.pareja1_id ? 1 : p.ganador_pareja_id === p.pareja2_id ? 2 : null;
  const sets = p.sets || [];
  const setsHtml = (lado) => sets.map((s) => `<span class="llave-set">${lado === 1 ? s.p1 : s.p2}</span>`).join("");
  const horario = p.horario
    ? new Date(p.horario).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "horario a definir";
  return `
    <div class="llave-partido">
      <div class="llave-fila ${ganador === 1 ? "ganador" : ""}">
        <span class="llave-nombre">${p.pareja1_nombre}</span>
        <span class="llave-sets">${setsHtml(1)}</span>
      </div>
      <div class="llave-fila ${ganador === 2 ? "ganador" : ""}">
        <span class="llave-nombre">${p.pareja2_nombre}</span>
        <span class="llave-sets">${setsHtml(2)}</span>
      </div>
      <div class="match-meta llave-meta">🕒 ${horario} · 📍 Local: ${p.cancha_nombre || "a definir"}</div>
    </div>`;
}

// vista "llave": columnas de Zona (fase de grupos, una por número de grupo) seguidas
// de las columnas de eliminación directa (una por ronda de bracket), lado a lado como
// en un cuadro de torneo — reutiliza el mismo formato de tarjeta en ambos bloques.
function renderPartidosLlave(partidos) {
  const cont = document.getElementById("dtPartidos");

  const grupales = partidos.filter((p) => p.grupo != null);
  const gruposOrdenados = [...new Set(grupales.map((p) => p.grupo))].sort((a, b) => a - b);
  const columnasZona = gruposOrdenados.map((g) => ({
    titulo: `Zona ${g}`, zona: true,
    partidos: grupales.filter((p) => p.grupo === g)
  }));

  // las columnas de eliminación se arman con los nombres de ronda que realmente existen,
  // en el orden en que se generaron (no una lista fija) — así sirve tanto para el cuadro
  // clásico de 16/8/4/2 como para un torneo chico que arranca directo en semifinal, o con
  // nombres genéricos ("Ronda de 6") si el cuadro es irregular
  const eliminacion = partidos.filter((p) => p.ronda && p.ronda !== "Fase de grupos" && p.grupo == null);
  const nombresOrdenados = [...new Set(
    [...eliminacion].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map((p) => p.ronda)
  )];
  const columnasRonda = nombresOrdenados.map((r) => ({
    titulo: r, zona: false,
    partidos: eliminacion.filter((p) => p.ronda === r)
  }));

  const columnas = [...columnasZona, ...columnasRonda];

  if (columnas.length === 0) {
    cont.innerHTML = '<p class="empty">Todavía no hay partidos armados.</p>';
    return;
  }

  cont.innerHTML = '<div class="llave-scroll"><div class="llave">' +
    columnas.map((col, i) => {
      // separador visual entre el bloque de zonas y el de eliminación directa
      const esPrimeraDeEliminacion = !col.zona && columnasZona.length > 0 && i === columnasZona.length;
      const clases = ["llave-columna"];
      if (col.zona) clases.push("llave-zona");
      if (esPrimeraDeEliminacion) clases.push("llave-separador");
      return `
      <div class="${clases.join(" ")}">
        <h3>${col.titulo}</h3>
        ${col.partidos.map((p) => llavePartidoCardHtml(p)).join("")}
      </div>`;
    }).join("") + "</div></div>";
}

// convierte los sets guardados ([{p1,p2}, ...]) a texto legible "6-3, 6-4"
// en vez de mostrar el JSON crudo
function formatearSets(sets) {
  return (sets || []).map((s) => `${s.p1}-${s.p2}`).join(", ") || "sin datos";
}

// convierte un horario guardado (ISO, UTC) al formato que espera un input
// datetime-local (hora local, sin zona) para poder mostrarlo precargado
function toDatetimeLocalValue(horarioISO) {
  if (!horarioISO) return "";
  const d = new Date(horarioISO);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderPartidosLista(partidos, canchasTorneo) {
  const cont = document.getElementById("dtPartidos");
  cont.innerHTML = "";
  if (partidos.length === 0) {
    cont.innerHTML = '<p class="empty">Todavía no hay partidos armados.</p>';
    return;
  }
  partidos.forEach((p) => {
    const div = document.createElement("div");
    const ganador = p.ganador_pareja_id === p.pareja1_id ? 1 : p.ganador_pareja_id === p.pareja2_id ? 2 : null;
    div.className = "match-card" + (p.estado === "jugado" ? " match-card-jugado" : "");
    const horario = p.horario ? new Date(p.horario).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) : "sin horario";
    div.innerHTML = `
      ${matchVsRowHtml(p.pareja1_nombre, p.pareja2_nombre, ganador)}
      <div class="match-meta">📍 ${p.cancha_nombre || "sin cancha"} · 🕒 ${horario} · <span class="badge">${p.estado}</span>${p.ronda && p.ronda !== "Fase de grupos" ? ` <span class="badge orange">${p.ronda}</span>` : (p.grupo ? ` <span class="badge orange">Grupo ${p.grupo}</span>` : "")}${!partidosCategoriaFiltro && p.categoria ? ` <span class="badge">${p.categoria}</span>` : ""}</div>
      ${p.estado === "jugado" ? `<div class="sets-row">${(p.sets || []).map((s) => `<span class="set-chip ${s.p1 > s.p2 ? "gano-p1" : s.p2 > s.p1 ? "gano-p2" : ""}">${s.p1}-${s.p2}</span>`).join("") || formatearSets(p.sets)}</div>` : ""}
      ${isAdmin && modoTorneoDetalle === "organizar" && p.estado !== "jugado" ? `
      <div class="match-admin-panel">
        <p class="match-admin-label">Cargar resultado (modo Organizar) — ${p.ronda || "Fase de grupos"}</p>
        <div class="match-actions">
          <input class="setInput" data-p="${p.id}" placeholder="Ej: 6-3,6-4" style="flex:1" />
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
          <button class="secondary small btnCambiarHorario" data-p="${p.id}">Cambiar horario</button>
        </div>
      </div>` : ""}
    `;
    cont.appendChild(div);
  });

  document.querySelectorAll(".btnCargarResultado").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const partidoId = btn.dataset.p;
      const input = document.querySelector(`.setInput[data-p="${partidoId}"]`);
      const texto = input.value.trim();
      if (!texto) { toast("Cargá el resultado, ej: 6-3,6-4"); return; }
      // valida el formato antes de mandarlo: si alguien tipea algo raro (ej "6:3" o
      // deja una coma de más) no queremos guardar un resultado inventado sin darnos cuenta
      if (!/^\d+-\d+(,\d+-\d+)*$/.test(texto)) {
        toast("Formato de resultado inválido. Ejemplo: 6-3,6-4"); return;
      }
      const sets = texto.split(",").map((s) => {
        const [a, b] = s.trim().split("-").map(Number);
        return { p1: a, p2: b };
      });
      const setsGanadosP1 = sets.filter((s) => s.p1 > s.p2).length;
      const setsGanadosP2 = sets.filter((s) => s.p2 > s.p1).length;
      if (setsGanadosP1 === setsGanadosP2) {
        toast("El resultado tiene que tener un ganador (no puede empatar en sets)"); return;
      }
      const ganadorParejaId = setsGanadosP1 > setsGanadosP2 ? btn.dataset.p1 : btn.dataset.p2;

      const { error } = await sb.from("partidos").update({
        sets, estado: "jugado", ganador_pareja_id: ganadorParejaId
      }).eq("id", partidoId);
      if (error) { toast("Error: " + error.message); return; }
      toast("Resultado cargado, ranking actualizado ✅");
      avisarActualizacionEnVivo();
      refrescarDetalleTorneo();
      cargarRanking();
      if (btn.dataset.ronda === "Final") cargarCampeones();
    });
  });

  document.querySelectorAll(".btnReasignarCancha").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const partidoId = btn.dataset.p;
      const nuevaCancha = document.querySelector(`.selectReasignar[data-p="${partidoId}"]`).value;
      const partido = ultimosPartidos.find((x) => x.id === partidoId);
      if (partido?.horario && hayConflictoCancha(ultimosPartidos, partidoId, nuevaCancha, partido.horario)) {
        toast("Esa cancha ya tiene otro partido a esa hora — elegí otra cancha o cambiá primero el horario");
        return;
      }
      const { error } = await sb.from("partidos").update({ cancha_id: nuevaCancha }).eq("id", partidoId);
      if (error) { toast("Error: " + error.message); return; }
      toast("Cancha reasignada");
      avisarActualizacionEnVivo();
      refrescarDetalleTorneo();
    });
  });

  // mover un partido a otro horario (por ejemplo, si un equipo avisa que no llega
  // a la hora que tenía asignada) — reusa el mismo chequeo de choques de cancha
  document.querySelectorAll(".btnCambiarHorario").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const partidoId = btn.dataset.p;
      const valor = document.querySelector(`.inputHorario[data-p="${partidoId}"]`).value;
      if (!valor) { toast("Elegí una fecha y hora"); return; }
      const nuevoHorarioISO = new Date(valor).toISOString();
      const partido = ultimosPartidos.find((x) => x.id === partidoId);
      if (partido?.cancha_id && hayConflictoCancha(ultimosPartidos, partidoId, partido.cancha_id, nuevoHorarioISO)) {
        toast("Esa cancha ya tiene otro partido a esa hora — elegí otro horario");
        return;
      }
      const { error } = await sb.from("partidos").update({ horario: nuevoHorarioISO }).eq("id", partidoId);
      if (error) { toast("Error: " + error.message); return; }
      toast("Horario cambiado");
      avisarActualizacionEnVivo();
      refrescarDetalleTorneo();
    });
  });
}

// ============================================================
// SPONSORS / PUBLICIDAD
// ============================================================
function renderSponsorItem(s, caption) {
  const contenido = `<img src="${s.logo_url}" alt="${s.nombre}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'sponsor-caption',textContent:'${s.nombre.replace(/'/g, "\\'")}'}))" />` +
    (caption ? `<span class="sponsor-caption">${caption}</span>` : "");
  return s.link_url
    ? `<a href="${s.link_url}" target="_blank" rel="noopener noreferrer" title="${s.nombre}">${contenido}</a>`
    : `<span class="sponsor-item" title="${s.nombre}">${contenido}</span>`;
}

async function cargarSponsors() {
  const { data } = await sb.from("sponsors").select("*").eq("activo", true).order("orden");
  const admin = document.getElementById("listaSponsors");
  const inlineCard = document.getElementById("sponsorsInlineCard");
  const inline = document.getElementById("sponsorsInline");
  const sidebarCard = document.getElementById("sidebarSponsorsCard");
  const sidebar = document.getElementById("sidebarSponsors");

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
  } else {
    if (inlineCard) inlineCard.style.display = "none";
    if (sidebarCard) sidebarCard.style.display = "none";
  }
}

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
  lista.innerHTML = (data && data.length > 0)
    ? data.map((n) => `
      <div class="match-card${n.leido ? "" : " match-card-jugado"}" style="margin-bottom:8px">
        <div style="font-size:13px">${n.mensaje}</div>
        <div class="match-meta" style="margin-top:4px">${new Date(n.created_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}${!n.leido ? ' · <span class="badge orange">nueva</span>' : ""}</div>
      </div>`).join("")
    : '<p class="empty">No tenés notificaciones todavía.</p>';
  document.getElementById("notifOverlay").style.display = "flex";
  await sb.from("notificaciones").update({ leido: true }).eq("jugador_id", miJugador.id).eq("leido", false);
  actualizarContadorNotificaciones();
}
document.getElementById("btnNotif").addEventListener("click", abrirNotificaciones);
document.getElementById("btnCerrarNotif").addEventListener("click", () => { document.getElementById("notifOverlay").style.display = "none"; });
document.getElementById("notifOverlay").addEventListener("click", (e) => {
  if (e.target.id === "notifOverlay") document.getElementById("notifOverlay").style.display = "none";
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
