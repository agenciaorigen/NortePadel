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
let categoriaRankingActual = localStorage.getItem("np_categoria_ranking") || null;
let cacheComplejos = [];
let cacheCanchas = [];
let cacheJugadoresAdmin = [];
let cacheCategorias = [];
let cacheTorneos = [];
let vistaPartidosActual = "lista"; // lista | calendario | llave
let ultimosPartidos = [];
let ultimasCanchasTorneo = [];

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
document.getElementById("btnAdminPanel").addEventListener("click", () => cambiarVista("admin"));
document.getElementById("btnHeroTorneos").addEventListener("click", () => cambiarVista("torneos"));

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
  if (isAdmin) cargarJugadoresAdmin();
  cargarEnVivo();
  cargarHeroPosicion();
  if (torneoActualId) refrescarDetalleTorneo();
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
    const enTop5 = posicion <= 5;
    const tr = document.createElement("tr");
    const posClass = posicion <= 3 ? `pos-${posicion}` : "";
    tr.innerHTML = `<td class="${posClass}">${posicion}</td>
      <td><div style="display:flex;align-items:center;gap:8px">${avatarHtml(j.foto_url, enTop5 ? 44 : 30)}<span>${j.nombre} ${j.apellido}</span></div></td>
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

  const [{ data: jugadores }, { data: torneosGanados }] = await Promise.all([
    sb.rpc("jugadores_publicos"),
    sb.rpc("torneos_ganados_publico", { p_jugador_id: jugadorId })
  ]);
  const j = (jugadores || []).find((x) => x.id === jugadorId);
  if (!j) { toast("No se encontró el jugador"); cambiarVista(vistaAntesDePerfilJugador); return; }

  document.getElementById("pjFoto").innerHTML = avatarHtml(j.foto_url, 96);
  document.getElementById("pjNombre").textContent = `${j.nombre} ${j.apellido}`;
  document.getElementById("pjCategoria").textContent = j.categoria;
  document.getElementById("pjPuntos").textContent = j.puntos_ranking;
  document.getElementById("pjJugados").textContent = j.partidos_jugados;
  document.getElementById("pjGanados").textContent = j.partidos_ganados;
  document.getElementById("pjEfectividad").textContent =
    j.partidos_jugados > 0 ? Math.round((j.partidos_ganados / j.partidos_jugados) * 100) + "%" : "—";

  const cont = document.getElementById("pjTorneosGanados");
  cont.innerHTML = (torneosGanados || []).length > 0
    ? torneosGanados.map((t) => `
      <div class="pj-torneo-item">
        <div><strong>🏆 ${t.torneo_nombre}</strong><div class="match-meta">con ${t.companero_nombre} ${t.companero_apellido}${t.categoria ? " · " + t.categoria : ""}</div></div>
        <span class="match-meta">${t.fecha || ""}</span>
      </div>`).join("")
    : '<p class="empty">Todavía no ganó ningún torneo.</p>';
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

function avatarHtml(fotoUrl, size) {
  const s = size || 44;
  return fotoUrl
    ? `<img class="avatar" src="${fotoUrl}" alt="" loading="lazy" style="width:${s}px;height:${s}px" onerror="this.style.display='none'" />`
    : `<div class="avatar avatar-placeholder" style="width:${s}px;height:${s}px">🎾</div>`;
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
function matchVsRowHtml(nombre1, nombre2) {
  return `<div class="match-vs-row">
    <span class="match-vs-team">${nombre1}</span>
    <span class="match-vs-divider">V</span>
    <span class="match-vs-team derecha">${nombre2}</span>
  </div>`;
}

async function cargarEnVivo() {
  const hoy = new Date().toISOString().slice(0, 10);
  const { data: torneos } = await sb.from("torneos").select("*, complejos(nombre, direccion)").order("fecha_inicio");
  const enCurso = (torneos || []).find((t) => t.fecha_inicio <= hoy && (t.fecha_fin || t.fecha_inicio) >= hoy);
  const proximo = (torneos || []).filter((t) => t.fecha_inicio > hoy).sort((a, b) => a.fecha_inicio.localeCompare(b.fecha_inicio))[0];

  document.getElementById("enVivoDot").style.display = enCurso ? "block" : "none";
  const cont = document.getElementById("enVivoContenido");

  if (enCurso) {
    let miPartidoHtml = "";
    if (miJugador) {
      // ninguno de los dos depende del otro (los dos solo necesitan enCurso.id):
      // se piden juntos en vez de uno después del otro para no esperar el doble
      const [{ data: parejas }, { data: partidos }] = await Promise.all([
        sb.rpc("parejas_publicas", { p_torneo_id: enCurso.id }),
        sb.rpc("partidos_publicos", { p_torneo_id: enCurso.id })
      ]);
      const miPareja = (parejas || []).find((p) => p.jugador1_id === miJugador.id || p.jugador2_id === miJugador.id);
      if (miPareja) {
        const miPartido = (partidos || []).find((p) => p.pareja1_id === miPareja.id || p.pareja2_id === miPareja.id);
        if (miPartido) {
          const horario = miPartido.horario ? new Date(miPartido.horario).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) : "a definir";
          const esPareja1 = miPartido.pareja1_id === miPareja.id;
          const miEquipo = esPareja1 ? miPartido.pareja1_nombre : miPartido.pareja2_nombre;
          const rival = esPareja1 ? miPartido.pareja2_nombre : miPartido.pareja1_nombre;
          miPartidoHtml = `<div class="match-card" style="border-color:var(--accent);margin-top:14px">
            <h3 style="color:var(--accent);margin-bottom:2px">Tu partido</h3>
            ${matchVsRowHtml(miEquipo, rival)}
            <div class="match-meta">🕒 ${horario} · 📍 ${miPartido.cancha_nombre || "cancha a definir"}</div>
            <span class="badge" style="margin-top:6px;display:inline-block">${miPartido.estado}</span>
          </div>`;
        } else {
          miPartidoHtml = `<p class="match-meta" style="margin-top:12px">Todavía no tenés un horario asignado en este torneo.</p>`;
        }
      } else {
        miPartidoHtml = `<p class="match-meta" style="margin-top:12px">Todavía no estás anotado en este torneo. Andá a Torneos para inscribirte.</p>`;
      }
    }
    cont.innerHTML = `
      <div class="envivo-header">
        <span class="badge live"><span class="live-dot"></span>EN VIVO</span>
        <h2 class="envivo-titulo">${enCurso.nombre}</h2>
        <p class="envivo-sub">${enCurso.complejos?.nombre || "sin complejo"} · ${enCurso.fecha_inicio} al ${enCurso.fecha_fin}</p>
      </div>
      <div class="card">
        ${miPartidoHtml}
        <button class="gradient" id="btnVerTorneoEnVivo" style="margin-top:14px">Ver partidos y resultados</button>
      </div>
    `;
    document.getElementById("btnVerTorneoEnVivo").addEventListener("click", () => abrirTorneo(enCurso.id));
  } else if (proximo) {
    const direccion = proximo.complejos?.direccion ? ` (${proximo.complejos.direccion})` : "";
    cont.innerHTML = `
      <div class="envivo-header">
        <span class="envivo-sub">No hay ningún torneo en curso ahora mismo</span>
        <h2 class="envivo-titulo">Próximo: ${proximo.nombre}</h2>
        <p class="envivo-sub">📅 ${proximo.fecha_inicio} · 📍 ${proximo.complejos?.nombre || "a confirmar"}${direccion}</p>
      </div>
      <div class="card">
        <button class="secondary small" id="btnVerProximo">Ver torneo</button>
      </div>
    `;
    document.getElementById("btnVerProximo").addEventListener("click", () => abrirTorneo(proximo.id));
  } else {
    cont.innerHTML = '<div class="card"><p class="empty">Todavía no hay torneos programados.</p></div>';
  }
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
      <div style="margin-top:8px">${canchasDelComplejo.map((k) => `<span class="badge" style="margin-right:6px">${k.nombre}</span>`).join("") || '<span class="match-meta">Sin canchas cargadas</span>'}</div>
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

  llenarSelect(document.getElementById("tComplejo"), cacheComplejos, (c) => c.nombre);
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

  const formTorneo = document.getElementById("tCategoriasForm");
  if (formTorneo) {
    formTorneo.innerHTML = generosConDatos.map((g) => `
      <div class="categorias-genero-grupo">
        <h4>${g}</h4>
        <div class="check-grid">
          ${grupos[g].map((c) => `<label><input type="checkbox" class="chkTorneoCategoria" value="${c.nombre}" /> ${c.nombre}</label>`).join("")}
        </div>
      </div>
    `).join("");
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
// JUGADORES (listado admin, para inscribir manualmente y jugador del mes)
// ============================================================
async function cargarJugadoresAdmin() {
  if (!isAdmin) return;
  const { data } = await sb.from("jugadores").select("*").eq("activo", true).order("apellido");
  cacheJugadoresAdmin = data || [];
  const cont = document.getElementById("listaJugadoresAdmin");
  if (cont) {
    cont.innerHTML = "";
    if (cacheJugadoresAdmin.length === 0) cont.innerHTML = '<p class="empty">Todavía no hay jugadores registrados.</p>';
    cacheJugadoresAdmin.forEach((j) => {
      const div = document.createElement("div");
      div.className = "match-card";
      div.innerHTML = `<div class="match-teams">${j.nombre} ${j.apellido} <span class="badge">${j.categoria}</span></div>
        <div class="match-meta">${j.email || ""} ${j.telefono || ""} · ${j.puntos_ranking} pts</div>`;
      cont.appendChild(div);
    });
  }
  llenarSelect(document.getElementById("dtSelectJugador"), cacheJugadoresAdmin, (j) => `${j.nombre} ${j.apellido}`);
  llenarSelect(document.getElementById("jdmSelect"), cacheJugadoresAdmin, (j) => `${j.nombre} ${j.apellido} (${j.categoria})`);
  renderSolicitudesCategoria(cacheJugadoresAdmin);
}

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
    div.className = "match-card";
    div.style.cursor = "pointer";
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

  const torneo = {
    nombre,
    complejo_id: complejoId || null,
    fecha_inicio: fechaInicio,
    fecha_fin: document.getElementById("tFechaFin").value || fechaInicio,
    flyer_url: flyerUrl
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
  document.querySelectorAll(".chkTorneoCategoria:checked").forEach((c) => (c.checked = false));
  cargarTorneos();
  cargarInicio();
  abrirTorneo(data.id);
});

async function abrirTorneo(id) {
  torneoActualId = id;
  cambiarVista("torneo-detalle");
  await refrescarDetalleTorneo();
}
document.getElementById("btnVolverTorneos").addEventListener("click", () => cambiarVista("torneos"));

// ---------- buscador de pareja al inscribirse ----------
let parejaSeleccionada = null;
let jugadoresParaBuscar = [];

document.getElementById("buscarPareja").addEventListener("input", (e) => {
  parejaSeleccionada = null;
  document.getElementById("parejaSeleccionadaTxt").textContent = "";
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
    });
  });
});

async function renderInscribirme() {
  const estado = document.getElementById("inscripcionEstado");
  const btn = document.getElementById("btnInscribirme");
  const buscarWrap = document.getElementById("buscarParejaWrap");

  if (!currentUser) {
    estado.textContent = "Iniciá sesión para poder inscribirte.";
    buscarWrap.style.display = "none";
    btn.textContent = "Iniciar sesión";
    btn.disabled = false;
    btn.onclick = () => cambiarVista("perfil");
    return;
  }
  if (!miJugador) {
    estado.textContent = "Completá tu perfil de jugador antes de inscribirte.";
    buscarWrap.style.display = "none";
    btn.textContent = "Completar perfil";
    btn.disabled = false;
    btn.onclick = () => cambiarVista("perfil");
    return;
  }

  const { data: jp } = await sb.rpc("jugadores_publicos");
  jugadoresParaBuscar = jp || [];

  const { data } = await sb.from("inscripciones").select("id").eq("torneo_id", torneoActualId).eq("jugador_id", miJugador.id).maybeSingle();
  if (data) {
    estado.textContent = "✅ Ya estás inscripto en este torneo.";
    buscarWrap.style.display = "none";
    btn.textContent = "Ya estás anotado";
    btn.disabled = true;
    btn.onclick = null;
  } else {
    estado.textContent = "";
    buscarWrap.style.display = "block";
    btn.textContent = "Inscribirme";
    btn.disabled = false;
    btn.onclick = async () => {
      const { error } = await sb.rpc("inscribirse_con_pareja", {
        p_torneo_id: torneoActualId,
        p_pareja_jugador_id: parejaSeleccionada ? parejaSeleccionada.id : null
      });
      if (error) { toast("Error: " + error.message); return; }
      toast(parejaSeleccionada ? "¡Listo, se anotaron los dos! 🎾" : "¡Listo, quedaste inscripto! 🎾");
      parejaSeleccionada = null;
      document.getElementById("buscarPareja").value = "";
      document.getElementById("parejaSeleccionadaTxt").textContent = "";
      avisarActualizacionEnVivo();
      renderInscribirme();
      refrescarDetalleTorneo();
    };
  }
}

async function refrescarDetalleTorneo() {
  if (!torneoActualId) return;
  const { data: t } = await sb.from("torneos").select("*, complejos(nombre), torneo_categorias(categoria)").eq("id", torneoActualId).single();
  if (!t) return;

  document.getElementById("dtNombre").textContent = t.nombre;
  document.getElementById("dtEstado").textContent = t.estado;
  const categorias = (t.torneo_categorias || []).map((c) => c.categoria).join(", ") || "todas las categorías";
  document.getElementById("dtInfo").textContent = `${t.complejos?.nombre || "sin complejo"} · ${categorias} · ${t.fecha_inicio} a ${t.fecha_fin}`;
  const flyerImg = document.getElementById("dtFlyer");
  if (t.flyer_url) { flyerImg.src = t.flyer_url; flyerImg.style.display = "block"; }
  else flyerImg.style.display = "none";

  await renderInscribirme();
  await cargarSponsorsTorneo();

  const { data: tc } = await sb.from("torneo_canchas").select("*, canchas(nombre, complejo_id)").eq("torneo_id", torneoActualId);
  document.getElementById("dtCanchas").innerHTML = (tc || []).map((c) =>
    `<span class="badge orange" style="margin-right:6px">${c.canchas?.nombre || "?"}</span>`
  ).join("") || '<p class="empty">Sin canchas asignadas todavía.</p>';
  llenarSelect(document.getElementById("dtSelectCancha"), cacheCanchas, (c) => {
    const complejo = cacheComplejos.find((x) => x.id === c.complejo_id);
    return `${c.nombre} (${complejo ? complejo.nombre : "?"})`;
  });

  const { data: insc } = await sb.rpc("inscriptos_publicos", { p_torneo_id: torneoActualId });
  document.getElementById("dtInscriptos").innerHTML = (insc || []).map((i) =>
    `<span class="badge" style="margin-right:6px">${i.nombre} ${i.apellido}</span>`
  ).join("") || '<p class="empty">Sin inscriptos todavía.</p>';

  const { data: parejas } = await sb.rpc("parejas_publicas", { p_torneo_id: torneoActualId });
  document.getElementById("dtParejas").innerHTML = (parejas || []).map((p) =>
    `<div class="match-meta">🎾 ${p.jugador1_nombre} / ${p.jugador2_nombre}</div>`
  ).join("") || '<p class="empty">Todavía no hay parejas armadas.</p>';

  const { data: partidos } = await sb.rpc("partidos_publicos", { p_torneo_id: torneoActualId });
  renderPartidos(partidos || [], tc || []);

  if (isAdmin && cacheJugadoresAdmin.length === 0) cargarJugadoresAdmin();
}

document.getElementById("btnAgregarCanchaTorneo").addEventListener("click", async () => {
  const canchaId = document.getElementById("dtSelectCancha").value;
  if (!canchaId) return;
  const { error } = await sb.from("torneo_canchas").insert({ torneo_id: torneoActualId, cancha_id: canchaId });
  if (error) { toast("Esa cancha ya está asignada u ocurrió un error"); return; }
  toast("Cancha agregada al torneo");
  refrescarDetalleTorneo();
});

document.getElementById("btnInscribir").addEventListener("click", async () => {
  const jugadorId = document.getElementById("dtSelectJugador").value;
  if (!jugadorId) return;
  const { error } = await sb.from("inscripciones").insert({ torneo_id: torneoActualId, jugador_id: jugadorId });
  if (error) { toast("Ese jugador ya está inscripto u ocurrió un error"); return; }
  toast("Jugador inscripto");
  avisarActualizacionEnVivo();
  refrescarDetalleTorneo();
});

// ---------- armar parejas automático (solo con los que todavía no tienen pareja) ----------
document.getElementById("btnArmarParejas").addEventListener("click", async () => {
  const { data: insc } = await sb.from("inscripciones").select("jugadores(*)").eq("torneo_id", torneoActualId);
  const { data: parejasExistentes } = await sb.from("parejas").select("jugador1_id, jugador2_id").eq("torneo_id", torneoActualId);
  const yaEmparejados = new Set((parejasExistentes || []).flatMap((p) => [p.jugador1_id, p.jugador2_id]));
  const jugadoresInscritos = (insc || []).map((i) => i.jugadores).filter(Boolean).filter((j) => !yaEmparejados.has(j.id));
  if (jugadoresInscritos.length < 2) { toast("No quedan jugadores sin pareja para emparejar"); return; }

  const { parejas, sobrante } = armarParejasAutomatico(jugadoresInscritos);
  if (parejas.length === 0) { toast("No se pudieron armar parejas"); return; }

  const filas = parejas.map((p) => ({ torneo_id: torneoActualId, jugador1_id: p.jugador1.id, jugador2_id: p.jugador2.id }));
  const { error } = await sb.from("parejas").insert(filas);
  if (error) { toast("Error: " + error.message); return; }

  toast(`Se armaron ${parejas.length} parejas` + (sobrante ? ` (quedó ${sobrante.nombre} sin par)` : ""));
  avisarActualizacionEnVivo();
  refrescarDetalleTorneo();
});

// ---------- armar partidos automático ----------
document.getElementById("btnArmarPartidos").addEventListener("click", async () => {
  const { data: parejasDb } = await sb.from("parejas").select("*").eq("torneo_id", torneoActualId);
  if (!parejasDb || parejasDb.length < 2) { toast("Armá primero al menos 2 parejas"); return; }

  const { data: torneo } = await sb.from("torneos").select("*").eq("id", torneoActualId).single();
  const { data: tc } = await sb.from("torneo_canchas").select("canchas(*)").eq("torneo_id", torneoActualId);
  const canchas = (tc || []).map((c) => c.canchas).filter(Boolean);
  if (canchas.length === 0) { toast("Asigná al menos una cancha a este torneo"); return; }

  const jugadorIds = [...new Set(parejasDb.flatMap((p) => [p.jugador1_id, p.jugador2_id]))];
  const { data: dispRows } = await sb.from("disponibilidad").select("*").in("jugador_id", jugadorIds);
  const disponibilidadPorJugador = {};
  (dispRows || []).forEach((d) => {
    if (!disponibilidadPorJugador[d.jugador_id]) disponibilidadPorJugador[d.jugador_id] = [];
    disponibilidadPorJugador[d.jugador_id].push(d);
  });

  const fechasDisponibles = [];
  const inicio = new Date(torneo.fecha_inicio + "T00:00:00");
  const fin = new Date((torneo.fecha_fin || torneo.fecha_inicio) + "T00:00:00");
  for (let d = new Date(inicio); d <= fin; d.setDate(d.getDate() + 1)) fechasDisponibles.push(new Date(d));

  const { partidosGenerados, sinHorario } = armarPartidosAutomatico({
    parejas: parejasDb,
    disponibilidadPorJugador,
    fechasDisponibles,
    canchas,
    duracionMinutos: torneo.duracion_minutos || 90
  });

  if (partidosGenerados.length > 0) {
    const filas = partidosGenerados.map((p) => ({ torneo_id: torneoActualId, ...p, estado: "programado" }));
    const { error } = await sb.from("partidos").insert(filas);
    if (error) { toast("Error: " + error.message); return; }
  }

  toast(`Se programaron ${partidosGenerados.length} partidos` + (sinHorario.length ? `, ${sinHorario.length} quedaron sin horario común` : ""));
  avisarActualizacionEnVivo();
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

function renderPartidos(partidos, canchasTorneo) {
  ultimosPartidos = partidos;
  ultimasCanchasTorneo = canchasTorneo;
  if (vistaPartidosActual === "calendario") return renderPartidosCalendario(partidos, canchasTorneo);
  if (vistaPartidosActual === "llave") return renderPartidosLlave(partidos);
  return renderPartidosLista(partidos, canchasTorneo);
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
        ? `<div class="calendario-partido ${p.estado === "jugado" ? "jugado" : ""}">${p.pareja1_nombre}<br>vs<br>${p.pareja2_nombre}${p.ronda && p.ronda !== "Fase de grupos" ? `<br><span class="badge orange">${p.ronda}</span>` : ""}</div>`
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

// vista "llave": cuadro de eliminación directa, una columna por ronda de bracket
// (la fase de grupos no entra acá porque no es de eliminación directa)
function renderPartidosLlave(partidos) {
  const cont = document.getElementById("dtPartidos");
  const RONDAS = ["Dieciseisavos", "Octavos", "Cuartos", "Semifinal", "Final"];
  const columnas = RONDAS.map((r) => ({ ronda: r, partidos: partidos.filter((p) => p.ronda === r) }))
    .filter((col) => col.partidos.length > 0);

  if (columnas.length === 0) {
    cont.innerHTML = '<p class="empty">Todavía no hay partidos de eliminación directa. Asignales una ronda (Cuartos, Semifinal, etc.) al cargar el resultado.</p>';
    return;
  }

  cont.innerHTML = '<div class="llave-scroll"><div class="llave">' +
    columnas.map((col) => `
      <div class="llave-columna">
        <h3>${col.ronda}</h3>
        ${col.partidos.map((p) => `
          <div class="llave-partido">
            <div class="llave-equipo ${p.ganador_pareja_id === p.pareja1_id ? "ganador" : ""}">${p.pareja1_nombre}</div>
            <div class="llave-equipo ${p.ganador_pareja_id === p.pareja2_id ? "ganador" : ""}">${p.pareja2_nombre}</div>
            <div class="match-meta" style="text-align:center">${p.estado === "jugado" ? "✔️ jugado" : (p.cancha_nombre || "sin cancha")}</div>
          </div>
        `).join("")}
      </div>
    `).join("") + "</div></div>";
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
    div.className = "match-card";
    const horario = p.horario ? new Date(p.horario).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) : "sin horario";
    div.innerHTML = `
      ${matchVsRowHtml(p.pareja1_nombre, p.pareja2_nombre)}
      <div class="match-meta">📍 ${p.cancha_nombre || "sin cancha"} · 🕒 ${horario} · <span class="badge">${p.estado}</span>${p.ronda && p.ronda !== "Fase de grupos" ? ` <span class="badge orange">${p.ronda}</span>` : ""}</div>
      ${p.estado === "jugado" ? `<div class="match-meta">Sets: ${JSON.stringify(p.sets || [])}</div>` : ""}
      ${isAdmin && p.estado !== "jugado" ? `
      <div class="match-actions">
        <select class="selectRonda" data-p="${p.id}">
          ${["Fase de grupos", "Dieciseisavos", "Octavos", "Cuartos", "Semifinal", "Final"].map((r) =>
            `<option value="${r}" ${(p.ronda || "Fase de grupos") === r ? "selected" : ""}>${r}</option>`
          ).join("")}
        </select>
      </div>
      <div class="match-actions">
        <input class="setInput" data-p="${p.id}" placeholder="Ej: 6-3,6-4" style="flex:1" />
        <button class="secondary small btnCargarResultado" data-p="${p.id}" data-p1="${p.pareja1_id}" data-p2="${p.pareja2_id}">Cargar resultado</button>
      </div>
      <div class="match-actions">
        <select class="selectReasignar" data-p="${p.id}">
          ${canchasTorneo.map((c) => `<option value="${c.canchas?.id}" ${c.canchas?.id === p.cancha_id ? "selected" : ""}>${c.canchas?.nombre}</option>`).join("")}
        </select>
        <button class="secondary small btnReasignarCancha" data-p="${p.id}">Cambiar cancha</button>
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
      const ronda = document.querySelector(`.selectRonda[data-p="${partidoId}"]`).value;

      const { error } = await sb.from("partidos").update({
        sets, estado: "jugado", ganador_pareja_id: ganadorParejaId, ronda
      }).eq("id", partidoId);
      if (error) { toast("Error: " + error.message); return; }
      toast("Resultado cargado, ranking actualizado ✅");
      avisarActualizacionEnVivo();
      refrescarDetalleTorneo();
      cargarRanking();
      if (ronda === "Final") cargarCampeones();
    });
  });

  document.querySelectorAll(".btnReasignarCancha").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const partidoId = btn.dataset.p;
      const nuevaCancha = document.querySelector(`.selectReasignar[data-p="${partidoId}"]`).value;
      const { error } = await sb.from("partidos").update({ cancha_id: nuevaCancha }).eq("id", partidoId);
      if (error) { toast("Error: " + error.message); return; }
      toast("Cancha reasignada");
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

document.getElementById("btnNotif").addEventListener("click", async () => {
  if (!miJugador) { toast("Iniciá sesión para ver tus notificaciones"); cambiarVista("perfil"); return; }
  const { data } = await sb.from("notificaciones").select("*").eq("jugador_id", miJugador.id).order("created_at", { ascending: false }).limit(10);
  if (!data || data.length === 0) { toast("No tenés notificaciones"); return; }
  toast(data[0].mensaje);
  await sb.from("notificaciones").update({ leido: true }).eq("jugador_id", miJugador.id).eq("leido", false);
  actualizarContadorNotificaciones();
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
    cargarEnVivo();
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
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

// ============================================================
// INIT
// ============================================================
// nota de velocidad: no hace falta pedir la sesión ni llamar a manejarCambioSesion()
// acá — sb.auth.onAuthStateChange() ya se dispara solo, una vez, apenas se suscribe
// (con la sesión que haya en ese momento), y manejarCambioSesion() ya llama a
// cargarEnVivo(); pedirla de nuevo acá solo duplicaba esas llamadas en cada carga.
async function init() {
  await Promise.all([cargarCategorias(), cargarTorneos()]);
  await Promise.all([
    cargarComplejos(),
    cargarInicio(),
    cargarJugadorDelMes(),
    cargarCampeones(),
    cargarSponsors(),
    cargarRanking(),
    cargarPuntosRonda()
  ]);
}
init();
