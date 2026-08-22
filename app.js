// ============================================================
// NORTE PADEL — lógica de la app (vanilla JS, sin frameworks)
// ============================================================

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const DIAS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const DIAS_CORTO = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

// ---------- estado local ----------
let torneoActualId = null;
let cacheComplejos = [];
let cacheJugadores = [];
let cacheCanchas = [];

// ---------- identidad simple del jugador en este dispositivo ----------
function miJugadorId() { return localStorage.getItem("np_jugador_id") || null; }
function setMiJugador(id, nombre) {
  localStorage.setItem("np_jugador_id", id);
  localStorage.setItem("np_jugador_nombre", nombre);
}

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

// ============================================================
// RANKING (segmentado por categoría)
// ============================================================
let categoriaRankingActual = localStorage.getItem("np_categoria_ranking") || null;

async function cargarCategoriasDisponibles() {
  const { data } = await sb.from("jugadores").select("categoria").eq("activo", true);
  const categorias = [...new Set((data || []).map((j) => j.categoria).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "es", { numeric: true }));
  return categorias;
}

async function cargarRanking() {
  const categorias = await cargarCategoriasDisponibles();
  const cont = document.getElementById("categoriaPills");

  if (categorias.length === 0) {
    cont.innerHTML = "";
    document.querySelector("#tablaRanking tbody").innerHTML = "";
    document.getElementById("rankingVacio").style.display = "block";
    return;
  }

  if (!categoriaRankingActual || !categorias.includes(categoriaRankingActual)) {
    categoriaRankingActual = categorias[0];
  }

  cont.innerHTML = categorias.map((c) =>
    `<button class="pill ${c === categoriaRankingActual ? "active" : ""}" data-categoria="${c}">${c}</button>`
  ).join("");
  cont.querySelectorAll(".pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      categoriaRankingActual = btn.dataset.categoria;
      localStorage.setItem("np_categoria_ranking", categoriaRankingActual);
      cargarRanking();
    });
  });

  const { data } = await sb.from("jugadores").select("*")
    .eq("activo", true).eq("categoria", categoriaRankingActual)
    .order("puntos_ranking", { ascending: false });

  const tbody = document.querySelector("#tablaRanking tbody");
  tbody.innerHTML = "";
  if (!data || data.length === 0) {
    document.getElementById("rankingVacio").style.display = "block";
    return;
  }
  document.getElementById("rankingVacio").style.display = "none";
  data.forEach((j, idx) => {
    const posicion = idx + 1;
    const tr = document.createElement("tr");
    const posClass = posicion <= 3 ? `pos-${posicion}` : "";
    tr.innerHTML = `<td class="${posClass}">${posicion}</td>
      <td>${j.nombre} ${j.apellido}</td>
      <td><strong>${j.puntos_ranking}</strong></td>
      <td>${j.partidos_jugados}</td>
      <td>${j.partidos_ganados}</td>`;
    tbody.appendChild(tr);
  });
}

// ============================================================
// JUGADORES + DISPONIBILIDAD
// ============================================================
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
renderDisponibilidadForm();

async function cargarJugadores() {
  const { data } = await sb.from("jugadores").select("*").eq("activo", true).order("apellido");
  cacheJugadores = data || [];
  const cont = document.getElementById("listaJugadores");
  cont.innerHTML = "";
  if (cacheJugadores.length === 0) {
    cont.innerHTML = `<p class="empty">Todavía no hay jugadores registrados.</p>`;
  }
  cacheJugadores.forEach((j) => {
    const div = document.createElement("div");
    div.className = "match-card";
    div.innerHTML = `<div class="match-teams">${j.nombre} ${j.apellido} <span class="badge">${j.categoria}</span></div>
      <div class="match-meta">${j.email || ""} ${j.telefono || ""} · ${j.puntos_ranking} pts</div>`;
    cont.appendChild(div);
  });
  llenarSelect(document.getElementById("dtSelectJugador"), cacheJugadores, (j) => `${j.nombre} ${j.apellido}`);

  const mi = miJugadorId();
  if (mi) {
    const yo = cacheJugadores.find((j) => j.id === mi);
    document.getElementById("miPerfilInfo").textContent = yo
      ? `Ya estás registrado como ${yo.nombre} ${yo.apellido}.`
      : "";
  }
}

document.getElementById("btnRegistrarJugador").addEventListener("click", async () => {
  const nombre = document.getElementById("jNombre").value.trim();
  const apellido = document.getElementById("jApellido").value.trim();
  const email = document.getElementById("jEmail").value.trim();
  if (!nombre || !apellido) { toast("Completá nombre y apellido"); return; }

  const jugador = {
    nombre, apellido,
    email: email || null,
    telefono: document.getElementById("jTelefono").value.trim() || null,
    nivel: document.getElementById("jNivel").value,
    categoria: document.getElementById("jCategoria").value.trim() || "6ta",
    lado_preferido: document.getElementById("jLado").value
  };

  const { data, error } = await sb.from("jugadores").insert(jugador).select().single();
  if (error) { toast("Error al registrar: " + error.message); return; }

  const disponibilidades = [];
  document.querySelectorAll(".chkDia:checked").forEach((chk) => {
    const dia = chk.dataset.dia;
    const desde = document.querySelector(`.horaDesde[data-dia="${dia}"]`).value;
    const hasta = document.querySelector(`.horaHasta[data-dia="${dia}"]`).value;
    if (desde && hasta) {
      disponibilidades.push({ jugador_id: data.id, dia_semana: Number(dia), hora_desde: desde, hora_hasta: hasta });
    }
  });
  if (disponibilidades.length > 0) {
    await sb.from("disponibilidad").insert(disponibilidades);
  }

  setMiJugador(data.id, `${data.nombre} ${data.apellido}`);
  toast("¡Registrado! Ya formás parte de Norte Padel 🎾");
  pedirPermisoNotificaciones();
  cargarJugadores();
  cargarRanking();
});

// ============================================================
// COMPLEJOS Y CANCHAS
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
        <input placeholder="Nombre de cancha (ej: Cancha 1)" class="inputCancha" data-complejo="${c.id}" />
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
  const { error } = await sb.from("complejos").insert({ nombre, direccion });
  if (error) { toast("Error: " + error.message); return; }
  document.getElementById("cNombre").value = "";
  document.getElementById("cDireccion").value = "";
  toast("Complejo creado");
  cargarComplejos();
});

function llenarSelect(select, items, labelFn) {
  if (!select) return;
  const valorPrevio = select.value;
  select.innerHTML = "";
  items.forEach((it) => {
    const opt = document.createElement("option");
    opt.value = it.id;
    opt.textContent = labelFn(it);
    select.appendChild(opt);
  });
  if (valorPrevio) select.value = valorPrevio;
}

// ============================================================
// TORNEOS
// ============================================================
async function cargarTorneos() {
  const { data } = await sb.from("torneos").select("*, complejos(nombre)").order("fecha_inicio", { ascending: false });
  const cont = document.getElementById("listaTorneos");
  cont.innerHTML = "";
  if (!data || data.length === 0) {
    cont.innerHTML = `<p class="empty">Todavía no hay torneos creados.</p>`;
    return;
  }
  data.forEach((t) => {
    const div = document.createElement("div");
    div.className = "match-card";
    div.style.cursor = "pointer";
    div.innerHTML = `
      <div class="match-teams">${t.nombre} <span class="badge">${t.estado}</span></div>
      <div class="match-meta">${t.complejos?.nombre || "sin complejo"} · ${t.categoria} · desde ${t.fecha_inicio}</div>
    `;
    div.addEventListener("click", () => abrirTorneo(t.id));
    cont.appendChild(div);
  });

  llenarSelect(document.getElementById("fTorneo"), data, (t) => t.nombre);
  const selFT = document.getElementById("fTorneo");
  const optNone = document.createElement("option");
  optNone.value = ""; optNone.textContent = "— Ninguno —";
  selFT.insertBefore(optNone, selFT.firstChild);
  selFT.value = "";
}

document.getElementById("btnCrearTorneo").addEventListener("click", async () => {
  const nombre = document.getElementById("tNombre").value.trim();
  const complejoId = document.getElementById("tComplejo").value;
  const fechaInicio = document.getElementById("tFechaInicio").value;
  if (!nombre || !fechaInicio) { toast("Completá al menos nombre y fecha de inicio"); return; }

  const torneo = {
    nombre,
    complejo_id: complejoId || null,
    categoria: document.getElementById("tCategoria").value.trim() || "abierta",
    fecha_inicio: fechaInicio,
    fecha_fin: document.getElementById("tFechaFin").value || fechaInicio,
    puntos_primero: Number(document.getElementById("tPuntos1").value) || 100,
    puntos_segundo: Number(document.getElementById("tPuntos2").value) || 60
  };
  const { data, error } = await sb.from("torneos").insert(torneo).select().single();
  if (error) { toast("Error: " + error.message); return; }

  // si el torneo tiene complejo, sus canchas quedan habilitadas por defecto
  if (complejoId) {
    const canchasDelComplejo = cacheCanchas.filter((c) => c.complejo_id === complejoId);
    if (canchasDelComplejo.length > 0) {
      await sb.from("torneo_canchas").insert(canchasDelComplejo.map((c) => ({ torneo_id: data.id, cancha_id: c.id })));
    }
  }

  toast("Torneo creado");
  document.getElementById("tNombre").value = "";
  cargarTorneos();
  abrirTorneo(data.id);
});

async function abrirTorneo(id) {
  torneoActualId = id;
  cambiarVista("torneo-detalle");
  await refrescarDetalleTorneo();
}
document.getElementById("btnVolverTorneos").addEventListener("click", () => cambiarVista("torneos"));

async function refrescarDetalleTorneo() {
  if (!torneoActualId) return;
  const { data: t } = await sb.from("torneos").select("*, complejos(nombre)").eq("id", torneoActualId).single();
  if (!t) return;

  document.getElementById("dtNombre").textContent = t.nombre;
  document.getElementById("dtEstado").textContent = t.estado;
  document.getElementById("dtInfo").textContent = `${t.complejos?.nombre || "sin complejo"} · ${t.categoria} · ${t.fecha_inicio} a ${t.fecha_fin}`;

  // canchas del torneo
  const { data: tc } = await sb.from("torneo_canchas").select("*, canchas(nombre, complejo_id)").eq("torneo_id", torneoActualId);
  document.getElementById("dtCanchas").innerHTML = (tc || []).map((c) =>
    `<span class="badge orange" style="margin-right:6px">${c.canchas?.nombre || "?"}</span>`
  ).join("") || '<p class="empty">Sin canchas asignadas todavía.</p>';
  llenarSelect(document.getElementById("dtSelectCancha"), cacheCanchas, (c) => {
    const complejo = cacheComplejos.find((x) => x.id === c.complejo_id);
    return `${c.nombre} (${complejo ? complejo.nombre : "?"})`;
  });

  // inscriptos
  const { data: insc } = await sb.from("inscripciones").select("*, jugadores(nombre, apellido, puntos_ranking)").eq("torneo_id", torneoActualId);
  document.getElementById("dtInscriptos").innerHTML = (insc || []).map((i) =>
    `<span class="badge" style="margin-right:6px">${i.jugadores?.nombre} ${i.jugadores?.apellido}</span>`
  ).join("") || '<p class="empty">Sin inscriptos todavía.</p>';

  // parejas
  const { data: parejas } = await sb.from("parejas").select("*, j1:jugador1_id(nombre,apellido), j2:jugador2_id(nombre,apellido)").eq("torneo_id", torneoActualId);
  document.getElementById("dtParejas").innerHTML = (parejas || []).map((p) =>
    `<div class="match-meta">🎾 ${p.j1?.nombre} ${p.j1?.apellido} / ${p.j2?.nombre} ${p.j2?.apellido}</div>`
  ).join("") || '<p class="empty">Todavía no hay parejas armadas.</p>';

  // partidos
  const { data: partidos } = await sb.from("partidos")
    .select("*, pareja1:pareja1_id(id,jugador1_id,jugador2_id,j1:jugador1_id(nombre,apellido),j2:jugador2_id(nombre,apellido)), pareja2:pareja2_id(id,jugador1_id,jugador2_id,j1:jugador1_id(nombre,apellido),j2:jugador2_id(nombre,apellido)), canchas(nombre)")
    .eq("torneo_id", torneoActualId)
    .order("horario");
  renderPartidos(partidos || [], tc || []);
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
  refrescarDetalleTorneo();
});

// ---------- armar parejas automático ----------
document.getElementById("btnArmarParejas").addEventListener("click", async () => {
  const { data: insc } = await sb.from("inscripciones").select("jugadores(*)").eq("torneo_id", torneoActualId);
  const jugadoresInscritos = (insc || []).map((i) => i.jugadores).filter(Boolean);
  if (jugadoresInscritos.length < 2) { toast("Necesitás al menos 2 jugadores inscriptos"); return; }

  const { parejas, sobrante } = armarParejasAutomatico(jugadoresInscritos);
  if (parejas.length === 0) { toast("No se pudieron armar parejas"); return; }

  const filas = parejas.map((p) => ({ torneo_id: torneoActualId, jugador1_id: p.jugador1.id, jugador2_id: p.jugador2.id }));
  const { error } = await sb.from("parejas").insert(filas);
  if (error) { toast("Error: " + error.message); return; }

  toast(`Se armaron ${parejas.length} parejas` + (sobrante ? ` (quedó ${sobrante.nombre} sin par)` : ""));
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
  refrescarDetalleTorneo();
});

// ---------- render de partidos + carga de resultados ----------
function nombresPareja(p) {
  if (!p) return "?";
  return `${p.j1?.nombre || ""} ${p.j1?.apellido || ""} / ${p.j2?.nombre || ""} ${p.j2?.apellido || ""}`;
}

function renderPartidos(partidos, canchasTorneo) {
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
      <div class="match-teams">${nombresPareja(p.pareja1)}</div>
      <div class="match-meta" style="text-align:center">vs</div>
      <div class="match-teams">${nombresPareja(p.pareja2)}</div>
      <div class="match-meta">📍 ${p.canchas?.nombre || "sin cancha"} · 🕒 ${horario} · <span class="badge">${p.estado}</span></div>
      ${p.estado === "jugado" ? `<div class="match-meta">Sets: ${JSON.stringify(p.sets || [])}</div>` : `
      <div class="match-actions">
        <input class="setInput" data-p="${p.id}" placeholder="Ej: 6-3,6-4" style="flex:1" />
        <button class="secondary small btnCargarResultado" data-p="${p.id}" data-p1="${p.pareja1_id}" data-p2="${p.pareja2_id}">Cargar resultado</button>
      </div>
      <div class="match-actions">
        <select class="selectReasignar" data-p="${p.id}">
          ${canchasTorneo.map((c) => `<option value="${c.canchas?.id}" ${c.canchas?.id === p.cancha_id ? "selected" : ""}>${c.canchas?.nombre}</option>`).join("")}
        </select>
        <button class="secondary small btnReasignarCancha" data-p="${p.id}">Cambiar cancha</button>
      </div>`}
    `;
    cont.appendChild(div);
  });

  document.querySelectorAll(".btnCargarResultado").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const partidoId = btn.dataset.p;
      const input = document.querySelector(`.setInput[data-p="${partidoId}"]`);
      const texto = input.value.trim();
      if (!texto) { toast("Cargá el resultado, ej: 6-3,6-4"); return; }
      const sets = texto.split(",").map((s) => {
        const [a, b] = s.trim().split("-").map(Number);
        return { p1: a, p2: b };
      });
      const setsGanadosP1 = sets.filter((s) => s.p1 > s.p2).length;
      const setsGanadosP2 = sets.filter((s) => s.p2 > s.p1).length;
      const ganadorParejaId = setsGanadosP1 > setsGanadosP2 ? btn.dataset.p1 : btn.dataset.p2;

      const { error } = await sb.from("partidos").update({
        sets, estado: "jugado", ganador_pareja_id: ganadorParejaId
      }).eq("id", partidoId);
      if (error) { toast("Error: " + error.message); return; }
      toast("Resultado cargado, ranking actualizado ✅");
      refrescarDetalleTorneo();
      cargarRanking();
    });
  });

  document.querySelectorAll(".btnReasignarCancha").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const partidoId = btn.dataset.p;
      const nuevaCancha = document.querySelector(`.selectReasignar[data-p="${partidoId}"]`).value;
      const { error } = await sb.from("partidos").update({ cancha_id: nuevaCancha }).eq("id", partidoId);
      if (error) { toast("Error: " + error.message); return; }
      toast("Cancha reasignada");
      refrescarDetalleTorneo();
    });
  });
}

// ============================================================
// FLYERS
// ============================================================
async function cargarFlyers() {
  const { data } = await sb.from("flyers").select("*").order("created_at", { ascending: false }).limit(20);
  const grid = document.getElementById("listaFlyers");
  const mini = document.getElementById("flyerMini");
  const sidebar = document.getElementById("sidebarFlyer");
  grid.innerHTML = "";
  mini.innerHTML = "";
  if (!data || data.length === 0) {
    grid.innerHTML = '<p class="empty">Todavía no hay flyers subidos.</p>';
    if (sidebar) sidebar.innerHTML = '<p class="empty" style="padding:0">Sin torneos próximos.</p>';
    return;
  }
  data.forEach((f) => {
    const img = `<div><img src="${f.url}" alt="${f.titulo}" /><div class="match-meta">${f.titulo}</div></div>`;
    grid.innerHTML += img;
    if (mini.children.length < 4) mini.innerHTML += img;
  });
  if (sidebar) {
    const ultimo = data[0];
    sidebar.innerHTML = `<img src="${ultimo.url}" alt="${ultimo.titulo}" style="width:100%;border-radius:10px;border:1px solid var(--border)" /><div class="match-meta" style="margin-top:6px">${ultimo.titulo}</div>`;
  }
}

document.getElementById("btnSubirFlyer").addEventListener("click", async () => {
  const titulo = document.getElementById("fTitulo").value.trim();
  const archivo = document.getElementById("fArchivo").files[0];
  if (!titulo || !archivo) { toast("Poné un título y elegí una imagen"); return; }

  const path = `${Date.now()}-${archivo.name}`;
  const { error: upErr } = await sb.storage.from("flyers").upload(path, archivo);
  if (upErr) { toast("Error subiendo imagen: " + upErr.message); return; }

  const { data: pub } = sb.storage.from("flyers").getPublicUrl(path);
  const torneoId = document.getElementById("fTorneo").value || null;
  const { error } = await sb.from("flyers").insert({ titulo, url: pub.publicUrl, torneo_id: torneoId });
  if (error) { toast("Error: " + error.message); return; }

  toast("Flyer subido");
  document.getElementById("fTitulo").value = "";
  document.getElementById("fArchivo").value = "";
  cargarFlyers();
});

// ============================================================
// SPONSORS / PUBLICIDAD
// ============================================================
function renderSponsorItem(s) {
  const contenido = `<img src="${s.logo_url}" alt="${s.nombre}" />`;
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

  if (admin) admin.innerHTML = (data && data.length > 0) ? data.map(renderSponsorItem).join("") : '<p class="empty">Todavía no cargaste auspiciantes.</p>';

  if (data && data.length > 0) {
    if (inline) inline.innerHTML = data.map(renderSponsorItem).join("");
    if (inlineCard) inlineCard.style.display = "block";
    if (sidebar) sidebar.innerHTML = data.map(renderSponsorItem).join("");
    if (sidebarCard) sidebarCard.style.display = "block";
  } else {
    if (inlineCard) inlineCard.style.display = "none";
    if (sidebarCard) sidebarCard.style.display = "none";
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
  const { error } = await sb.from("sponsors").insert({ nombre, logo_url: pub.publicUrl, link_url: linkUrl });
  if (error) { toast("Error: " + error.message); return; }

  toast("Auspiciante agregado");
  document.getElementById("spNombre").value = "";
  document.getElementById("spLink").value = "";
  document.getElementById("spArchivo").value = "";
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
      navigator.serviceWorker.ready.then((reg) => reg.showNotification("Norte Padel", { body: mensaje, icon: "icons/icon-192.png" }));
    } else {
      new Notification("Norte Padel", { body: mensaje });
    }
  }
}

async function actualizarContadorNotificaciones() {
  const mi = miJugadorId();
  if (!mi) return;
  const { count } = await sb.from("notificaciones").select("*", { count: "exact", head: true }).eq("jugador_id", mi).eq("leido", false);
  document.getElementById("notifCount").textContent = count ? `(${count})` : "";
}

document.getElementById("btnNotif").addEventListener("click", async () => {
  const mi = miJugadorId();
  if (!mi) { toast("Registrate primero como jugador para recibir notificaciones"); cambiarVista("jugadores"); return; }
  const { data } = await sb.from("notificaciones").select("*").eq("jugador_id", mi).order("created_at", { ascending: false }).limit(10);
  if (!data || data.length === 0) { toast("No tenés notificaciones"); return; }
  toast(data[0].mensaje);
  await sb.from("notificaciones").update({ leido: true }).eq("jugador_id", mi).eq("leido", false);
  actualizarContadorNotificaciones();
});

function suscribirseANotificacionesRealtime() {
  const mi = miJugadorId();
  if (!mi) return;
  sb.channel("notificaciones-" + mi)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "notificaciones", filter: `jugador_id=eq.${mi}` }, (payload) => {
      mostrarNotificacionLocal(payload.new.mensaje);
      actualizarContadorNotificaciones();
    })
    .subscribe();
}

// ranking en vivo: cualquier cambio en jugadores refresca la tabla
function suscribirseARankingRealtime() {
  sb.channel("ranking-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "jugadores" }, () => cargarRanking())
    .on("postgres_changes", { event: "*", schema: "public", table: "partidos" }, () => {
      if (torneoActualId) refrescarDetalleTorneo();
    })
    .subscribe();
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
async function init() {
  await Promise.all([cargarComplejos(), cargarJugadores(), cargarTorneos(), cargarFlyers(), cargarSponsors(), cargarRanking()]);
  suscribirseARankingRealtime();
  suscribirseANotificacionesRealtime();
  actualizarContadorNotificaciones();
}
init();
