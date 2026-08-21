# Norte Padel — App instalable (PWA)

App para tu organización de torneos: ranking automático, registro de jugadores con horarios, armado automático de partidos, carga de resultados en vivo, complejos/canchas reasignables y flyers de torneos.

Está hecha en HTML/CSS/JS puro (sin frameworks) + [Supabase](https://supabase.com) como base de datos en la nube. Así cualquier jugador que entra ve el mismo ranking y los mismos partidos en tiempo real, desde cualquier celular.

## 1. Crear el backend (10 minutos, gratis)

1. Andá a [supabase.com](https://supabase.com), creá una cuenta gratis y un proyecto nuevo (elegí una región cercana, ej: São Paulo).
2. Cuando el proyecto esté listo, andá a **SQL Editor > New query**, pegá **todo** el contenido del archivo `schema.sql` y ejecutalo. Esto crea todas las tablas, el ranking automático y el bucket de flyers.
3. Andá a **Project Settings > API** y copiá:
   - **Project URL**
   - **anon public key**
4. Abrí el archivo `config.js` y pegalos ahí:
   ```js
   const SUPABASE_URL = "https://xxxxx.supabase.co";
   const SUPABASE_ANON_KEY = "eyJhbGciOi...";
   ```

## 2. Publicar la web (para que sea instalable)

Un PWA necesita HTTPS para poder instalarse y funcionar offline. La forma más simple y gratis:

1. Subí la carpeta completa (`index.html`, `app.js`, `config.js`, `matching.js`, `style.css`, `sw.js`, `manifest.json`, `icons/`) a [Netlify Drop](https://app.netlify.com/drop) (arrastrás la carpeta y listo) o a Vercel/GitHub Pages.
2. Te da una URL tipo `https://norte-padel.netlify.app`. Compartísela a los jugadores.
3. Cualquiera que la abra desde el celular va a ver la opción **"Agregar a pantalla de inicio" / "Instalar app"** en el navegador (Chrome/Safari), y les queda como una app más.

## 3. Cómo se usa

- **Complejos**: cargá primero tus complejos y, dentro de cada uno, sus canchas.
- **Jugadores**: cada jugador se registra solo desde el celular (nombre, nivel, y en qué días/horarios puede jugar). Los datos quedan guardados en ese dispositivo para identificarlo (sin contraseña, pensado para un grupo cerrado de confianza).
- **Torneos**: creás el torneo, elegís el complejo sede (sus canchas quedan habilitadas automáticamente) e inscribís jugadores.
  - **"Armar parejas automáticamente"**: empareja jugadores por nivel de ranking.
  - **"Armar partidos automáticamente"**: cruza las parejas, busca un horario donde los 4 jugadores estén disponibles (según lo que cargaron) y asigna una cancha libre, evitando choques.
  - Si cambia el clima o hay que mover un partido, desde el detalle del torneo podés **agregar otra cancha** (de otro complejo incluso) y **reasignar** cualquier partido con dos clics.
- **Resultados en vivo**: durante el torneo, cargás el resultado (ej: `6-3,6-4`) y automáticamente:
  - se define el ganador,
  - se suman los puntos de ranking configurados para ese torneo,
  - el ranking general se actualiza al instante para todos los que tengan la app abierta.
- **Flyers**: subís la imagen del próximo torneo y aparece en la pestaña Flyers y en la portada del ranking.
- **Notificaciones**: al registrarte, la app pide permiso de notificaciones del navegador. Cuando te asignan un horario de partido o se carga un resultado en el que jugaste, te llega un aviso mientras tenés la app abierta o instalada (funciona incluso con la pantalla apagada en Android si la instalaste). Esto es notificación "en vivo" vía conexión en tiempo real con la base de datos.

## 4. Notificaciones push reales (opcional, paso extra)

Lo de arriba funciona apenas la app está instalada/abierta reciente. Si además querés que llegue la notificación **aunque el celular tenga la app cerrada hace rato** (push real, como WhatsApp), hace falta un paso más avanzado: generar claves VAPID y crear una Supabase Edge Function que dispare el push cuando se inserta una fila en `notificaciones`. Si querés, te lo puedo armar en una segunda vuelta — requiere que tengas el proyecto de Supabase ya funcionando.

## 5. Seguridad — importante

Para que el MVP funcione simple y rápido, la base de datos quedó con permisos abiertos de lectura/escritura (cualquiera con el link puede cargar datos), pensado para el grupo cerrado de tu organización. Si más adelante querés separar "jugador" de "organizador" (por ejemplo, que solo vos puedas crear torneos o mover partidos), se puede agregar login con contraseña de Supabase Auth y ajustar las políticas de seguridad (RLS) para que cada rol solo pueda hacer lo que corresponde. Avisame cuando lo necesites y lo sumamos.

## Estructura de archivos

```
norte-padel/
├── index.html      → estructura de la app
├── style.css        → estilos (tema oscuro, mobile-first)
├── app.js            → lógica: ranking, jugadores, torneos, partidos, flyers, notificaciones
├── matching.js       → algoritmo de armado automático de parejas/partidos/horarios
├── config.js         → tus claves de Supabase (completar)
├── manifest.json      → metadata de instalación como app
├── sw.js               → service worker (offline + push)
├── schema.sql          → script para crear toda la base de datos en Supabase
└── icons/               → íconos de la app
```
