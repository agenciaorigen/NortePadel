// ============================================================
// MOTOR DE ARMADO AUTOMÁTICO — partidos, horarios y canchas
// Heurística simple basada en los horarios BLOQUEADOS que declaró cada
// jugador (no en los disponibles: quien no cargó nada se asume libre todo
// el día), sin librerías externas. Las parejas las arman los propios
// jugadores al anotarse (o el admin a mano) — este motor solo cruza las
// parejas ya armadas entre sí y les busca horario y cancha.
// ============================================================

// Convierte "HH:MM:SS" o "HH:MM" a minutos desde las 00:00
function horaAMinutos(hora) {
  const [h, m] = hora.split(":").map(Number);
  return h * 60 + m;
}

// Intersección de dos rangos horarios [desde,hasta] en minutos (o null si no se solapan)
function interseccion(a, b) {
  const desde = Math.max(a.desde, b.desde);
  const hasta = Math.min(a.hasta, b.hasta);
  return desde < hasta ? { desde, hasta } : null;
}

// Resta un conjunto de franjas bloqueadas (pueden solaparse entre sí, en
// cualquier orden) de una franja base, y devuelve la lista de franjas libres
// resultantes (puede quedar más de un tramo suelto, o ninguno si todo el
// día está bloqueado).
function restarFranjas(base, bloqueadas) {
  const ordenadas = bloqueadas
    .map((b) => ({ desde: Math.max(b.desde, base.desde), hasta: Math.min(b.hasta, base.hasta) }))
    .filter((b) => b.desde < b.hasta)
    .sort((a, b) => a.desde - b.desde);
  const libres = [];
  let cursor = base.desde;
  ordenadas.forEach((b) => {
    if (b.desde > cursor) libres.push({ desde: cursor, hasta: b.desde });
    cursor = Math.max(cursor, b.hasta);
  });
  if (cursor < base.hasta) libres.push({ desde: cursor, hasta: base.hasta });
  return libres;
}

// Intersección de dos CONJUNTOS de franjas (no de una sola franja cada uno)
// — se usa para ir cruzando la disponibilidad libre de varios jugadores.
function intersectarConjuntos(conjA, conjB) {
  const resultado = [];
  conjA.forEach((fa) => {
    conjB.forEach((fb) => {
      const i = interseccion(fa, fb);
      if (i) resultado.push(i);
    });
  });
  return resultado;
}

// Franja "de club" que se usa como base de cada día antes de restarle los
// bloqueos de cada jugador (y la ventana horaria del torneo, si el admin
// cargó una) — el horario habitual en el que el club funciona.
const FRANJA_DEFAULT_DIA = { desde: horaAMinutos("08:00"), hasta: horaAMinutos("23:00") };

// Arma los partidos de un torneo: empareja parejas entre sí (round-robin
// simple, cada pareja juega contra la siguiente disponible), busca un
// horario común entre los 4 jugadores y asigna una cancha libre en ese
// horario, evitando cruces de jugador o de cancha.
//
// Parámetros:
//  parejas: [{id, jugador1_id, jugador2_id}]
//  disponibilidadPorJugador: { jugador_id: [{dia_semana, hora_desde, hora_hasta}] } —
//    HORARIOS BLOQUEADOS (no disponibles) de cada jugador, generales + los puntuales
//    de este torneo ya combinados por quien llama. Un jugador sin filas para un día
//    se asume libre todo ese día.
//  fechasDisponibles: [Date] días del torneo a considerar
//  canchas: [{id, nombre}]
//  duracionMinutos: duración estimada de cada partido
//  ventana: {desde, hasta} en minutos — horario del día que puso el admin
//    para el torneo (ej: 16:00 a 22:00). Si viene, se usa como base del día
//    en vez de FRANJA_DEFAULT_DIA, para no proponer horarios fuera del
//    horario en que el club/torneo funciona.
//  partidosYaProgramados: [{cancha_id, horario}] partidos que ya están
//    ocupando cancha y horario (de otras categorías del mismo torneo, por
//    ejemplo) para no proponerles la misma cancha a la misma hora.
//  grupos: [[pareja,...], ...] — si viene, se ignora `parejas` y se arma en
//    modo "fase de grupos": cada grupo juega TODOS contra todos (nadie queda
//    eliminado en esta etapa). Si no viene, se usa `parejas` en modo
//    eliminación directa: cada pareja contra la siguiente de la lista.
//  bloqueosPorCancha: { cancha_id: [{desde:Date, hasta:Date}] } — bloqueos de
//    cancha cargados por el admin (mantenimiento, lluvia, otro evento). Es un
//    concepto DISTINTO de la disponibilidad de un jugador: acá la cancha
//    entera queda inutilizable para todos, no solo para un jugador puntual.
//    Se suma directo a la ocupación de cancha antes de buscar horario, sin
//    tocar el resto del algoritmo.
function armarPartidosAutomatico({ parejas, grupos, disponibilidadPorJugador, fechasDisponibles, canchas, duracionMinutos = 90, ventana = null, partidosYaProgramados = [], bloqueosPorCancha = {} }) {
  const partidosGenerados = [];
  const sinHorario = [];
  const ocupacionCancha = {}; // cancha_id -> [{desde:Date, hasta:Date}]
  const ocupacionJugador = {}; // jugador_id -> [{desde:Date, hasta:Date}]

  canchas.forEach((c) => (ocupacionCancha[c.id] = [...(bloqueosPorCancha[c.id] || [])]));
  partidosYaProgramados.forEach((p) => {
    if (!p.horario || !p.cancha_id || !ocupacionCancha[p.cancha_id]) return;
    const desde = new Date(p.horario);
    const hasta = new Date(desde.getTime() + duracionMinutos * 60000);
    ocupacionCancha[p.cancha_id].push({ desde, hasta });
  });

  function libre(lista, desde, hasta) {
    return !lista.some((o) => desde < o.hasta && hasta > o.desde);
  }

  function buscarSlot(jugadoresIds) {
    for (const fecha of fechasDisponibles) {
      const diaSemana = fecha.getDay();
      const baseDia = ventana || FRANJA_DEFAULT_DIA;

      // arranca con toda la franja base libre, y le va restando a cada
      // jugador sus bloqueos de ese día — lo que sobra al final es el
      // hueco en el que los 4 (o los que sean) coinciden en estar libres
      let franjasLibresComunes = [baseDia];
      for (const jid of jugadoresIds) {
        const bloqueosDelDia = (disponibilidadPorJugador[jid] || [])
          .filter((f) => f.dia_semana === diaSemana)
          .map((f) => ({ desde: horaAMinutos(f.hora_desde), hasta: horaAMinutos(f.hora_hasta) }));
        const libresDeEsteJugador = restarFranjas(baseDia, bloqueosDelDia);
        franjasLibresComunes = intersectarConjuntos(franjasLibresComunes, libresDeEsteJugador);
        if (franjasLibresComunes.length === 0) break;
      }
      if (franjasLibresComunes.length === 0) continue;

      // probamos slots de `duracionMinutos` dentro de cada hueco libre común,
      // en pasos de 30 min, buscando cancha y jugadores libres
      for (const hueco of franjasLibresComunes) {
        if (hueco.hasta - hueco.desde < duracionMinutos) continue;
        for (let inicio = hueco.desde; inicio + duracionMinutos <= hueco.hasta; inicio += 30) {
          const desdeDate = new Date(fecha);
          desdeDate.setHours(0, inicio, 0, 0);
          const hastaDate = new Date(desdeDate.getTime() + duracionMinutos * 60000);

          const jugadoresLibres = jugadoresIds.every((jid) =>
            libre(ocupacionJugador[jid] || [], desdeDate, hastaDate)
          );
          if (!jugadoresLibres) continue;

          const canchaLibre = canchas.find((c) => libre(ocupacionCancha[c.id], desdeDate, hastaDate));
          if (!canchaLibre) continue;

          return { horario: desdeDate, hastaDate, cancha: canchaLibre };
        }
      }
    }
    return null;
  }

  // arma la lista de cruces (pares de parejas) según el modo
  const cruces = [];
  if (grupos) {
    grupos.forEach((grupo, idx) => {
      for (let a = 0; a < grupo.length; a++) {
        for (let b = a + 1; b < grupo.length; b++) cruces.push({ pareja1: grupo[a], pareja2: grupo[b], grupo: idx + 1 });
      }
    });
  } else {
    for (let i = 0; i < parejas.length - 1; i += 2) cruces.push({ pareja1: parejas[i], pareja2: parejas[i + 1], grupo: null });
  }

  cruces.forEach(({ pareja1, pareja2, grupo }) => {
    const jugadoresIds = [pareja1.jugador1_id, pareja1.jugador2_id, pareja2.jugador1_id, pareja2.jugador2_id];

    const slot = buscarSlot(jugadoresIds);
    if (!slot) {
      sinHorario.push({ pareja1, pareja2 });
      return;
    }

    jugadoresIds.forEach((jid) => {
      if (!ocupacionJugador[jid]) ocupacionJugador[jid] = [];
      ocupacionJugador[jid].push({ desde: slot.horario, hasta: slot.hastaDate });
    });
    ocupacionCancha[slot.cancha.id].push({ desde: slot.horario, hasta: slot.hastaDate });

    partidosGenerados.push({
      pareja1_id: pareja1.id,
      pareja2_id: pareja2.id,
      cancha_id: slot.cancha.id,
      horario: slot.horario.toISOString(),
      grupo
    });
  });

  return { partidosGenerados, sinHorario };
}

// Reasigna un partido ya cargado a otra cancha (o complejo) por clima u
// otro motivo, evitando pisar otro partido que ya esté en esa cancha y
// horario. `bloqueosDeCancha` (opcional) es la lista de bloqueos ([{desde,
// hasta}], objetos Date) de ESA cancha puntual — si viene, también cuenta
// como conflicto reasignar un partido a un horario bloqueado.
function hayConflictoCancha(partidosDelTorneo, partidoId, canchaId, horarioISO, duracionMinutos = 90, bloqueosDeCancha = []) {
  const desde = new Date(horarioISO);
  const hasta = new Date(desde.getTime() + duracionMinutos * 60000);
  const chocaConPartido = partidosDelTorneo.some((p) => {
    if (p.id === partidoId || p.cancha_id !== canchaId || !p.horario) return false;
    const pDesde = new Date(p.horario);
    const pHasta = new Date(pDesde.getTime() + duracionMinutos * 60000);
    return desde < pHasta && hasta > pDesde;
  });
  if (chocaConPartido) return true;
  return bloqueosDeCancha.some((b) => desde < b.hasta && hasta > b.desde);
}
