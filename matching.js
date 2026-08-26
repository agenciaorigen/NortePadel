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
//  partidosYaProgramados: [{cancha_id, horario, jugadores_ids}] partidos que
//    ya están ocupando cancha y horario (de esta misma categoría en una
//    ronda anterior, o de otra categoría del mismo torneo) para no proponer
//    ni la misma cancha ni el mismo jugador a la misma hora. `jugadores_ids`
//    es opcional (si no viene, ese partido solo bloquea la cancha, nunca al
//    jugador — mantiene compatibilidad con llamadas viejas).
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
//
// Fixture (armarCruces) y Calendario (asignarHorarios) son dos pasos separados
// a propósito: armar el fixture no debería obligar a resolver un horario en el
// mismo acto, y un cruce que hoy no encuentra hueco (sinHorario) tiene que
// poder quedar como partido real, reasignable después, en vez de perderse.

// Arma la lista de cruces (pares de parejas) según el modo: {grupos: [[...]]}
// para fase de grupos (todos contra todos dentro de cada grupo, nadie queda
// eliminado en esta etapa) o {parejas: [...]} para eliminación directa (cada
// pareja contra la siguiente de la lista). No toca horarios ni canchas.
function armarCruces({ parejas, grupos }) {
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
  return cruces;
}

// Busca horario y cancha para cruces ya armados (nuevos o ya existentes como
// partidos con horario en null). `cruces`: [{pareja1, pareja2, grupo}].
function asignarHorarios({ cruces, disponibilidadPorJugador, fechasDisponibles, canchas, duracionMinutos = 90, ventana = null, partidosYaProgramados = [], bloqueosPorCancha = {} }) {
  const partidosGenerados = [];
  const sinHorario = [];
  const ocupacionCancha = {}; // cancha_id -> [{desde:Date, hasta:Date}]
  const ocupacionJugador = {}; // jugador_id -> [{desde:Date, hasta:Date}]

  canchas.forEach((c) => (ocupacionCancha[c.id] = [...(bloqueosPorCancha[c.id] || [])]));
  partidosYaProgramados.forEach((p) => {
    if (!p.horario) return;
    const desde = new Date(p.horario);
    const hasta = new Date(desde.getTime() + duracionMinutos * 60000);
    if (p.cancha_id && ocupacionCancha[p.cancha_id]) ocupacionCancha[p.cancha_id].push({ desde, hasta });
    // clave del bug reportado: si no se registra acá que estos jugadores ya
    // están jugando en este horario, una ronda o categoría posterior puede
    // proponerles OTRO partido a la misma hora (la misma pareja terminaba con
    // dos partidos simultáneos en distinta cancha).
    (p.jugadores_ids || []).forEach((jid) => {
      if (!ocupacionJugador[jid]) ocupacionJugador[jid] = [];
      ocupacionJugador[jid].push({ desde, hasta });
    });
  });

  function libre(lista, desde, hasta) {
    return !lista.some((o) => desde < o.hasta && hasta > o.desde);
  }

  function buscarSlot(jugadoresIds) {
    for (const fecha of fechasDisponibles) {
      const diaSemana = fecha.getDay();
      // `ventana` puede ser una sola franja {desde,hasta} para todo el torneo (como
      // siempre) o un mapa {diaSemana: {desde,hasta}} cuando el torneo tiene horarios
      // distintos según el día (ver ventanaDelTorneo en app.js) — se distingue por si
      // tiene o no la clave "desde" directamente.
      const esMapaPorDia = ventana && typeof ventana === "object" && ventana.desde === undefined;
      const baseDia = (esMapaPorDia ? ventana[diaSemana] : ventana) || FRANJA_DEFAULT_DIA;

      // canchas de HOY: una cancha con dias_semana cargado (ver torneo_canchas)
      // solo está disponible esos días (ej: el club tiene menos canchas libres
      // jueves y viernes que sábado y domingo); sin dias_semana, disponible
      // todos los días del torneo, como siempre.
      const canchasDeHoy = canchas.filter((c) => !c.dias_semana || c.dias_semana.length === 0 || c.dias_semana.includes(diaSemana));
      if (canchasDeHoy.length === 0) continue;

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

          const canchaLibre = canchasDeHoy.find((c) => libre(ocupacionCancha[c.id], desdeDate, hastaDate));
          if (!canchaLibre) continue;

          return { horario: desdeDate, hastaDate, cancha: canchaLibre };
        }
      }
    }
    return null;
  }

  cruces.forEach(({ pareja1, pareja2, grupo }) => {
    const jugadoresIds = [pareja1.jugador1_id, pareja1.jugador2_id, pareja2.jugador1_id, pareja2.jugador2_id];

    const slot = buscarSlot(jugadoresIds);
    if (!slot) {
      sinHorario.push({ pareja1, pareja2, grupo });
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
      grupo,
      jugadores_ids: jugadoresIds
    });
  });

  return { partidosGenerados, sinHorario };
}

// Reasigna un partido ya cargado a otra cancha (o complejo) por clima u
// otro motivo, evitando pisar otro partido que ya esté en esa cancha y
// horario, O que ponga a la MISMA pareja a jugar otro partido a la misma
// hora (aunque sea en otra cancha) — este segundo chequeo es el que faltaba
// y permitía, al reasignar a mano en la planilla, dejar a una pareja con dos
// partidos simultáneos. `bloqueosDeCancha` (opcional) es la lista de
// bloqueos ([{desde, hasta}], objetos Date) de ESA cancha puntual — si
// viene, también cuenta como conflicto reasignar un partido a un horario
// bloqueado.
function hayConflictoCancha(partidosDelTorneo, partidoId, canchaId, horarioISO, duracionMinutos = 90, bloqueosDeCancha = []) {
  const desde = new Date(horarioISO);
  const hasta = new Date(desde.getTime() + duracionMinutos * 60000);
  const partidoActual = partidosDelTorneo.find((p) => p.id === partidoId);
  const parejasActual = partidoActual ? [partidoActual.pareja1_id, partidoActual.pareja2_id].filter(Boolean) : [];
  const chocaConPartido = partidosDelTorneo.some((p) => {
    if (p.id === partidoId || !p.horario) return false;
    const pDesde = new Date(p.horario);
    const pHasta = new Date(pDesde.getTime() + duracionMinutos * 60000);
    if (!(desde < pHasta && hasta > pDesde)) return false;
    if (p.cancha_id === canchaId) return true;
    return parejasActual.includes(p.pareja1_id) || parejasActual.includes(p.pareja2_id);
  });
  if (chocaConPartido) return true;
  return bloqueosDeCancha.some((b) => desde < b.hasta && hasta > b.desde);
}

// ============================================================
// CUADRO DE ZONAS DE 2 — formato propio del club (torneos.fase_grupos_formato
// = 'cuadro_zonas'). Cada zona es UN partido (no todos contra todos); a partir
// de ahí el ganador y el perdedor de cada zona alimentan una ronda de
// "segunda chance" cruzada, y de ahí en más es eliminación directa hasta la
// final. Las tablas de abajo son una transcripción exacta del Excel con el
// que el club arma sus cuadros a mano hoy (una plantilla por cantidad de
// zonas, de 3 a 14 zonas = 5 a 28 parejas): los cruces tienen asimetrías a
// propósito (las zonas de número más bajo, que quedan con las parejas mejor
// rankeadas, entran más tarde al cuadro — les cuesta menos llegar lejos), así
// que en vez de intentar derivar una fórmula general se guarda la tabla tal
// cual la usa el club. Cada referencia es "G"/"P" (ganador/perdedor) + el id
// del cruce que la produce: "Z3" = partido de la zona 3, "O2" = octavos
// partido 2, "D5" = dieciseisavos partido 5, etc.
// ============================================================

const CUARTOS_ESTANDAR = [["GO1", "GO2"], ["GO3", "GO4"], ["GO5", "GO6"], ["GO7", "GO8"]];
const SEMI_FINAL_ESTANDAR = { SEMIFINAL: [["GC1", "GC2"], ["GC3", "GC4"]], FINAL: [["GS1", "GS2"]] };

const PLANTILLAS_CUADRO = {
  3: {
    CUARTOS: [["PZ2", "PZ3"], ["GZ3", "PZ1"]],
    SEMIFINAL: [["GZ1", "GC1"], ["GZ2", "GC2"]],
    FINAL: [["GS1", "GS2"]]
  },
  4: {
    CUARTOS: [["GZ1", "PZ3"], ["GZ4", "PZ2"], ["GZ2", "PZ4"], ["GZ3", "PZ1"]],
    ...SEMI_FINAL_ESTANDAR
  },
  5: {
    OCTAVOS: [["PZ5", "PZ2"], ["PZ1", "PZ4"]],
    CUARTOS: [["GZ1", "PZ3"], ["GZ4", "GO1"], ["GO2", "GZ3"], ["GZ5", "GZ2"]],
    ...SEMI_FINAL_ESTANDAR
  },
  6: {
    OCTAVOS: [["PZ3", "PZ6"], ["GZ5", "PZ2"], ["PZ4", "PZ5"], ["GZ6", "PZ1"]],
    CUARTOS: [["GZ1", "GO1"], ["GZ4", "GO2"], ["GZ2", "GO3"], ["GZ3", "GO4"]],
    ...SEMI_FINAL_ESTANDAR
  },
  7: {
    OCTAVOS: [["PZ3", "PZ7"], ["GZ4", "PZ6"], ["GZ5", "PZ2"], ["GZ7", "PZ4"], ["GZ3", "PZ5"], ["GZ6", "PZ1"]],
    CUARTOS: [["GZ1", "GO1"], ["GO2", "GO3"], ["GZ2", "GO4"], ["GO5", "GO6"]],
    ...SEMI_FINAL_ESTANDAR
  },
  8: {
    OCTAVOS: [["GZ1", "PZ7"], ["GZ8", "PZ6"], ["GZ4", "PZ3"], ["GZ5", "PZ2"], ["GZ2", "PZ8"], ["GZ7", "PZ5"], ["GZ3", "PZ4"], ["GZ6", "PZ1"]],
    CUARTOS: CUARTOS_ESTANDAR,
    ...SEMI_FINAL_ESTANDAR
  },
  9: {
    DIECISEISAVOS: [["PZ6", "PZ7"], ["PZ8", "PZ9"]],
    OCTAVOS: [["GZ1", "GD1"], ["GZ8", "GZ9"], ["GZ4", "PZ3"], ["GZ5", "PZ2"], ["GZ2", "GD2"], ["GZ7", "PZ4"], ["GZ3", "PZ5"], ["GZ6", "PZ1"]],
    CUARTOS: CUARTOS_ESTANDAR,
    ...SEMI_FINAL_ESTANDAR
  },
  10: {
    DIECISEISAVOS: [["PZ6", "PZ7"], ["PZ3", "PZ10"], ["PZ5", "PZ8"], ["PZ4", "PZ9"]],
    OCTAVOS: [["GZ1", "GD1"], ["GZ8", "GZ9"], ["GZ4", "GD2"], ["GZ5", "PZ2"], ["GZ2", "GD3"], ["GZ7", "GZ10"], ["GZ3", "GD4"], ["GZ6", "PZ1"]],
    CUARTOS: CUARTOS_ESTANDAR,
    ...SEMI_FINAL_ESTANDAR
  },
  11: {
    DIECISEISAVOS: [["PZ6", "PZ7"], ["PZ3", "PZ10"], ["PZ2", "PZ11"], ["PZ5", "PZ8"], ["PZ4", "PZ9"], ["GZ11", "PZ1"]],
    OCTAVOS: [["GZ1", "GD1"], ["GZ8", "GZ9"], ["GZ4", "GD2"], ["GZ5", "GD3"], ["GZ2", "GD4"], ["GZ7", "GZ10"], ["GZ3", "GD5"], ["GZ6", "GD6"]],
    CUARTOS: CUARTOS_ESTANDAR,
    ...SEMI_FINAL_ESTANDAR
  },
  12: {
    DIECISEISAVOS: [["PZ7", "PZ10"], ["GZ9", "PZ6"], ["PZ3", "PZ11"], ["GZ12", "PZ2"], ["PZ8", "PZ9"], ["GZ10", "PZ4"], ["PZ5", "PZ12"], ["GZ11", "PZ1"]],
    OCTAVOS: [["GZ1", "GD1"], ["GZ8", "GD2"], ["GZ4", "GD3"], ["GZ5", "GD4"], ["GZ2", "GD5"], ["GZ7", "GD6"], ["GZ3", "GD7"], ["GZ6", "GD8"]],
    CUARTOS: CUARTOS_ESTANDAR,
    ...SEMI_FINAL_ESTANDAR
  },
  13: {
    DIECISEISAVOS: [["PZ10", "PZ11"], ["GZ8", "PZ6"], ["GZ9", "PZ3"], ["GZ13", "PZ7"], ["GZ12", "PZ2"], ["PZ8", "PZ12"], ["GZ7", "PZ5"], ["GZ10", "PZ4"], ["PZ9", "PZ13"], ["PZ1", "GZ11"]],
    OCTAVOS: [["GZ1", "GD1"], ["GD2", "GD3"], ["GZ4", "GD4"], ["GZ5", "GD5"], ["GZ2", "GD6"], ["GD7", "GD8"], ["GZ3", "GD9"], ["GZ6", "GD10"]],
    CUARTOS: CUARTOS_ESTANDAR,
    ...SEMI_FINAL_ESTANDAR
  },
  14: {
    DIECISEISAVOS: [["PZ10", "PZ11"], ["GZ8", "PZ7"], ["GZ9", "PZ3"], ["GZ13", "PZ6"], ["GZ5", "PZ14"], ["GZ12", "PZ2"], ["PZ12", "PZ13"], ["GZ7", "PZ8"], ["GZ10", "PZ4"], ["GZ14", "PZ5"], ["GZ6", "PZ9"], ["GZ11", "PZ1"]],
    OCTAVOS: [["GZ1", "GD1"], ["GD2", "GD3"], ["GZ4", "GD4"], ["GD5", "GD6"], ["GZ2", "GD7"], ["GD8", "GD9"], ["GZ3", "GD10"], ["GD11", "GD12"]],
    CUARTOS: CUARTOS_ESTANDAR,
    ...SEMI_FINAL_ESTANDAR
  }
};

// Arma las zonas (de a 2 parejas) según el ranking: la pareja mejor rankeada
// va como cabeza de serie de la zona 1, la segunda mejor de la zona 2, etc.
// (la "ventaja" que pidió el club de estar en una zona de número bajo), y a
// cada cabeza de serie se le cruza, a propósito, la pareja MENOS rankeada
// disponible ("contra los que juega no tienen que tener puntos"). Si el total
// de parejas es impar, la última zona (la del cabeza de serie más débil)
// queda con una sola pareja: pasa de ronda sin jugar su partido de zona (bye).
// `parejasConPuntos`: [{...pareja, puntos:number}] — puntos = suma del
// ranking de ambos jugadores de la pareja en la categoría de este torneo.
function armarZonasPorRanking(parejasConPuntos) {
  const ordenadas = [...parejasConPuntos].sort((a, b) => b.puntos - a.puntos);
  const n = Math.ceil(ordenadas.length / 2);
  const cabezas = ordenadas.slice(0, n);
  const resto = ordenadas.slice(n).sort((a, b) => a.puntos - b.puntos); // de menor a mayor puntaje
  return cabezas.map((cabeza, i) => (resto[i] ? [cabeza, resto[i]] : [cabeza]));
}

// Resuelve una referencia de plantilla ("GZ3", "PO2", ...) contra el mapa de
// resultados ya conocidos. Devuelve undefined si el cruce que la produce
// todavía no tiene resultado cargado, o null si ese cruce fue un bye (no hay
// perdedor porque no se jugó).
function resolverRefCuadro(ref, mapaSlots) {
  const entrada = mapaSlots[ref.slice(1)];
  if (!entrada) return undefined;
  return ref[0] === "G" ? entrada.ganador : entrada.perdedor;
}

// Resuelve los cruces de UNA ronda de la plantilla contra los resultados ya
// conocidos (mapaSlots: { "Z3": {ganador, perdedor}, ... }). Devuelve null si
// falta algún resultado previo (todavía no se puede armar esta ronda). Un
// cruce con un solo lado resuelto (el otro viene de un bye en cadena) se
// devuelve como `walkover: true`: no se juega, pasa directo el lado que sí
// existe.
function resolverRondaCuadro(matchesPlantilla, prefijo, mapaSlots) {
  const partidos = [];
  for (let i = 0; i < matchesPlantilla.length; i++) {
    const [refHome, refAway] = matchesPlantilla[i];
    const home = resolverRefCuadro(refHome, mapaSlots);
    const away = resolverRefCuadro(refAway, mapaSlots);
    if (home === undefined || away === undefined) return null;
    const slot = prefijo + (i + 1);
    if (!home || !away) {
      const ganadorWalkover = home || away || null;
      if (ganadorWalkover) partidos.push({ slot, pareja1_id: ganadorWalkover, pareja2_id: null, walkover: true });
    } else {
      partidos.push({ slot, pareja1_id: home, pareja2_id: away, walkover: false });
    }
  }
  return partidos;
}
