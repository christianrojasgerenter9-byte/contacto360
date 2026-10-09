# Contacto360: CRM + marcador predictivo

Proyecto independiente de la app de notas. Usa su propio proyecto de Firebase.

## Puesta en marcha

1. **Crear el proyecto:** en https://console.firebase.google.com, “Agregar proyecto” (por ejemplo `contacto360`).
2. **Login:** Authentication → Comenzar → Método de acceso → activa **Correo electrónico/contraseña**.
3. **Base de datos:** Firestore Database → Crear base de datos → modo **producción**, región `nam5` o `us-central1`.
4. **Reglas:** Firestore → Reglas → pega el contenido de `firestore.rules` → Publicar.
5. **Configuración web:** ⚙️ Configuración del proyecto → Tus apps → icono `</>` → registra la app → copia el objeto `firebaseConfig` en `firebase-config.js`.
6. **Probar en local:** sirve esta carpeta con cualquier servidor estático, por ejemplo `python -m http.server 5173`, y abre http://localhost:5173.

## Primer uso

1. Crea una cuenta con rol **Supervisor**.
2. Pestaña Supervisor → **Cargar 80 de ejemplo** (o Importar CSV).
3. Elige **Agentes virtuales** si aún no hay agentes reales.
4. **Iniciar motor en esta pestaña** y deja esa pestaña abierta.
5. En otro navegador o equipo, crea cuentas con rol **Agente**, pulsa “Ponerme disponible” y recibe llamadas.

CSV: columnas `nombre, telefono, saldo, pago_minimo, dias_atraso` (las dos primeras son obligatorias).

## Publicarlo en internet (Firebase Hosting)

```
npm install -g firebase-tools
firebase login
firebase use --add      # elige el proyecto nuevo
firebase deploy         # sube la página y las reglas
```

## Pendiente antes de producción

- Hoy cualquiera que se registre puede elegir el rol Supervisor. Para producción, los roles los debe asignar un administrador.
- Las llamadas son simuladas. La telefonía real (Twilio o VICIdial) y un motor de marcación en servidor son la siguiente fase.
