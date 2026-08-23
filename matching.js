// ============================================================
// MOTOR DE ARMADO AUTOMÁTICO — partidos, horarios y canchas
// Heurística simple basada en disponibilidad horaria declarada por
// cada jugador, sin librerías externas. Las parejas las arman los
// propios jugadores al anotarse (o el admin a mano) — este motor solo
// cruza las parejas ya armadas entre sí y les busca horario y cancha.
// ============================================================

// Convierte "HH:MM:SS" o "HH:MM" a minutos desde las 00:00
function horaAMinutos(hora) {
  const [h, m] = hora.split(":").map(Number);
  return h * 60 + m;
}

// Intersección de dos rangos horarios [desde,hasta] en minutos
function interseccion(a, b) {
  const desde = Math.max(a.desde, b.desde);
  const hasta = Math.min(a.hasta, b.hasta);
  return desde < hasta ? { desde, hasta } : null;
}

// Dado un array de disponibilidades (una por jugador, ya filtradas por día),
// devuelve la franja común a todos, o null si no hay superposición.
function franjaComunDia(disponibilidadesDelDia) {
  if (disponibilidadesDelDia.length === 0) return null;
  let comun = disponibilidadesDelDia[0];
  for (let i = 1; i < disponibilidadesDelDia.length; i++) {
    comun = interseccion(comun, disponibilidadesDelDia[i]);
    if (!comun) return null;
  }
  return comun;
}

// Arma los partidos de un torneo: empareja parejas entre sí (round-robin
// simple, cada pareja juega contra la siguiente disponible), busca un
// horario común entre los 4 jugadores y asigna una cancha libre en ese
// horario, evitando cruces de jugador o de cancha.
//
// Parámetros:
//  parejas: [{id, jugador1_id, jugador2_id}]
//  disponibilidadPorJugador: { jugador_id: [{dia_semana, desde, hasta}] }
//  fechasDisponibles: [Date] días del torneo a considerar
//  canchas: [{id, nombre}]
//  duracionMinutos: duración estimada de cada partido
function armarPartidosAutomatico({ parejas, disponibilidadPorJugador, fechasDisponibles, canchas, duracionMinutos = 90 }) {
  const partidosGenerados = [];
  const sinHorario = [];
  const ocupacionCancha = {}; // cancha_id -> [{desde:Date, hasta:Date}]
  const ocupacionJugador = {}; // jugador_id -> [{desde:Date, hasta:Date}]

  canchas.forEach((c) => (ocupacionCancha[c.id] = []));

  function libre(lista, desde, hasta) {
    return !lista.some((o) => desde < o.hasta && hasta > o.desde);
  }

  function buscarSlot(jugadoresIds) {
    for (const fecha of fechasDisponibles) {
      const diaSemana = fecha.getDay();
      const disponibilidades = jugadoresIds.map((jid) => {
        const franjas = (disponibilidadPorJugador[jid] || []).filter((f) => f.dia_semana === diaSemana);
        if (franjas.length === 0) return null;
        // tomamos la franja más amplia del día para ese jugador
        return franjas.reduce((max, f) => {
          const desde = horaAMinutos(f.hora_desde);
          const hasta = horaAMinutos(f.hora_hasta);
          return hasta - desde > max.hasta - max.desde ? { desde, hasta } : max;
        }, { desde: 0, hasta: 0 });
      });
      if (disponibilidades.some((d) => !d)) continue;
      const comun = franjaComunDia(disponibilidades);
      if (!comun || comun.hasta - comun.desde < duracionMinutos) continue;

      // probamos slots de `duracionMinutos` dentro de la franja común,
      // en pasos de 30 min, buscando cancha y jugadores libres
      for (let inicio = comun.desde; inicio + duracionMinutos <= comun.hasta; inicio += 30) {
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
    return null;
  }

  // Round-robin simple: cada pareja contra la siguiente en la lista
  const disponibles = [...parejas];
  for (let i = 0; i < disponibles.length - 1; i += 2) {
    const pareja1 = disponibles[i];
    const pareja2 = disponibles[i + 1];
    const jugadoresIds = [pareja1.jugador1_id, pareja1.jugador2_id, pareja2.jugador1_id, pareja2.jugador2_id];

    const slot = buscarSlot(jugadoresIds);
    if (!slot) {
      sinHorario.push({ pareja1, pareja2 });
      continue;
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
      horario: slot.horario.toISOString()
    });
  }

  return { partidosGenerados, sinHorario };
}

// Reasigna un partido ya cargado a otra cancha (o complejo) por clima u
// otro motivo, evitando pisar otro partido que ya esté en esa cancha y
// horario.
function hayConflictoCancha(partidosDelTorneo, partidoId, canchaId, horarioISO, duracionMinutos = 90) {
  const desde = new Date(horarioISO);
  const hasta = new Date(desde.getTime() + duracionMinutos * 60000);
  return partidosDelTorneo.some((p) => {
    if (p.id === partidoId || p.cancha_id !== canchaId || !p.horario) return false;
    const pDesde = new Date(p.horario);
    const pHasta = new Date(pDesde.getTime() + duracionMinutos * 60000);
    return desde < pHasta && hasta > pDesde;
  });
}
