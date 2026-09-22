# Análisis visual — elnortepadel.com

Revisión en vivo (desktop, ~1920px) + revisión de código de Inicio, Torneos, Ranking, detalle de torneo (con y sin cuadro armado) y Config/admin. La emulación mobile no funcionó en este entorno (ni `resize_window` ni las devtools del navegador cambiaron el viewport real), así que lo mobile-específico queda basado en lectura de código, marcado como tal.

Ordenado de más a menos impacto en que la página "se vea profesional".

---

## 1. El flyer destacado de Inicio se ve gigante y desproporcionado (bug real, alto impacto)

En "Próximos torneos" (Inicio), el afiche del torneo destacado (`#flyerDestacado` → `.flyer-destacado`) no tiene un ancho máximo propio: toma el ancho completo del contenedor de la página. Medido en vivo con la consola: **1360px de ancho × 1700px de alto** (mantiene `aspect-ratio: 4/5`, pero aplicado a un ancho enorme). El resultado es una sola imagen promocional que ocupa casi dos pantallas completas de scroll, mucho más grande que cualquier otro elemento de la home — rompe la jerarquía visual y da sensación de página armada a los apurones.

- Archivo: `style.css`, regla `.flyer-destacado` (línea ~599).
- Arreglo mínimo: agregarle un `max-width` (algo como 380–460px) y `margin: 0 auto` si tiene que quedar centrado, para que se vea como una tarjeta destacada y no como un cartel a pantalla completa.

## 2. El texto propio del afiche se pisa con el texto de la tarjeta (bug real, alto impacto)

En "Torneos" (listado) y en la tarjeta grande de Inicio, los afiches usan `background-size: contain` para no recortar el diseño, pero el degradé oscuro que se pone encima (`linear-gradient(0deg, rgba(...,.92), rgba(...,.55) 65%)`) no alcanza a tapar del todo el texto denso que casi todos los afiches tienen en la franja inferior (sponsors, "suma puntaje doble", etc.). Ese texto queda visible por debajo del nombre del torneo, la sede y el badge de estado que pone la página, y ambos textos se superponen — se ve desprolijo y cuesta leer cualquiera de los dos.

- Archivo: `style.css`, reglas `.torneo-card-flyer` (línea ~1154) y `.flyer-destacado` (línea ~599).
- Arreglo sugerido: hacer el degradé más opaco y que cubra más alto (por ejemplo `rgba(...,.98)` sólido en el 40% inferior en vez de licuarse a partir del 65%), para que el pie del afiche quede completamente tapado donde va el texto de la tarjeta.

## 3. Badge "EN_CURSO" en vez de "En curso" (bug ya identificado, confirmado en vivo)

Se ve tal cual en Torneos y en el header de "Fecha Puntuable 7": el badge muestra el valor crudo de la base (`EN_CURSO`) en mayúsculas con guión bajo, en vez de un texto prolijo. Es lo primero que salta a la vista al entrar a un torneo activo.

- Archivo: `app.js`, función `badgeEstadoTorneo(t)` (línea ~2300) — falta el caso `"en_curso"`.
- Arreglo: agregar `if (t.estado === "en_curso") return '<span class="badge">En curso</span>';` (o el estilo de badge que corresponda).

## 4. El ancho de la vista de torneo sigue sin límite (bug ya identificado, sigue presente)

Confirmado en vivo con la consola en "Fecha Puntuable 8": `.app-body` tiene `max-width: none` y ocupa el 100% del viewport (2450px en la prueba). Es la regla:

```css
.app-body:has(#view-torneo-resultados.active) { max-width: none; }
```

En pantallas grandes esto no siempre se nota en el contenido central (que tiene su propio ancho máximo), pero sí estira de más las franjas que van a lo ancho de `.app-body` (el héroe, la banda de sponsors, etc.), dando esa sensación de "todo muy ancho" que reportaste con la captura. La intención original era que sólo el cuadro de eliminación (`.llave-scroll`) necesitara ancho libre para poder scrollear horizontalmente — pero la regla se aplicó a toda la vista.

- Arreglo: sacar el `max-width: none` de `.app-body` y ponérselo sólo a `.llave-scroll` (o al contenedor del cuadro).

## 5. Paleta y estilo inconsistentes entre secciones de Inicio (más "pulido" que "bug")

El héroe usa una paleta fría (foto de cancha en tonos azul/teal, tipografía serif blanca elegante). Inmediatamente debajo, la banda con el ticker ("NORTE PADEL • RANKING EN VIVO • INSCRIBITE YA") y el panel "Mejores de cada categoría" cambian a un verde oliva / amarillento con textura de pelota de fondo. Es un quiebre de identidad visual bastante marcado apenas se empieza a scrollear — se sienten como dos diseños distintos pegados. Lo mismo pasa en el cuadro de eliminación, donde los títulos de ronda (OCTAVOS, CUARTOS...) usan un lila/violeta que no aparece en ningún otro lado del sitio.

Esto no es un bug de código, es una decisión de diseño para revisar: si el objetivo es que el sitio "se vea profesional full", lo que más va a ayudar es unificar la paleta (2–3 colores + 1 acento, consistente en héroe, bandas, botones y badges) en vez de sumar un tono nuevo por sección.

## 6. Segundo jugador con el mismo bug de datos (PG negativo) — hallazgo nuevo

Mirando "Ranking" en vivo, categoría 4ta Caballeros, aparece **"Cutu Gonzalez"** (puesto 12) con **PJ=0, PG=-1** — el mismo problema que ya arreglamos para Lucas Gautschi, pero en otro jugador. Esto quiere decir que el fix puntual que corrimos no cubre todos los casos. Para encontrarlos a todos de una, corré esto:

```sql
select j.nombre, j.apellido, rc.categoria, rc.puntos_ranking, rc.partidos_jugados, rc.partidos_ganados
from ranking_categoria rc
join jugadores j on j.id = rc.jugador_id
where rc.partidos_ganados < 0
   or rc.partidos_ganados > rc.partidos_jugados;
```

Pasame el resultado y de ahí armamos un único `update` que corrija todos los casos inválidos de una (mismo criterio que usamos antes: no puede haber más "ganados" que "jugados").

## 7. Tarjetas del cuadro y de "Campeones" muy planas, poco contraste

En el cuadro de eliminación y en la fila de "Campeones", las tarjetas usan un verde apenas distinto al fondo de la sección — cuesta distinguir dónde termina una tarjeta y empieza el fondo (no hay borde, sombra ni elevación). Funciona, pero se ve chato. Sumarles un borde sutil (`1px solid` con un verde más claro) o una sombra liviana les daría más profundidad sin cambiar la paleta.

## 8. Mobile — no pude probarlo en vivo esta vez

Intenté forzar un viewport angosto (400px) con `resize_window` y también abrir las devtools del navegador para emular un celular, y ninguna de las dos cambió el ancho real de renderizado (siguió reportando ~2450px de ancho). Es una limitación de esta sesión, no algo que se pueda arreglar desde acá. Si querés, mandame una captura de pantalla del celular real y reviso puntualmente esa vista, o probamos con el navegador de tu compu en modo responsive.

---

## Cómo seguimos

Los puntos 3 y 4 ya estaban identificados de la vez pasada y siguen pendientes de tu confirmación para aplicarlos — son chicos y no tocan la base de datos. Sumaría a esa tanda el punto 1 (ancho del flyer) y el punto 2 (texto superpuesto), que también son cambios acotados de CSS.

El punto 6 (segundo jugador con PG negativo) necesita que corras la consulta de arriba y me pases el resultado.

El punto 5 (paleta) y el punto 7 (tarjetas planas) son mejoras de diseño más grandes — si querés avanzar con eso conviene charlarlo aparte para definir la paleta final antes de tocar CSS en todos lados.
