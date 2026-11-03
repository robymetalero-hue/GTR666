# Plan de Equilibrio: Cero Caché en Celulares + Cero Doble Registro + 45s Sin Bloqueo en Microcortes

## 1. Principios de Diseño (El Equilibrio Exacto)
1. **CERO Caché en la Aplicación Web / Celulares:**
   - **No se guarda ninguna venta ni ajuste en caché local (`localStorage` / `IndexedDB`)**. Las colas offline en celulares quedan permanentemente purgadas y deshabilitadas para que ningún teléfono pueda jamás enviar datos viejos ni desajustar el inventario.
2. **CERO Bloqueo de Pantalla en Pequeñas Desconexiones (Ventana de 45 Segundos):**
   - Si ocurre una pequeña desconexión de internet (menor a **45 segundos**), la aplicación **no se bloquea**: puedes seguir buscando productos, armando el carrito, cambiando cantidades y trabajando con normalidad.
   - Al cumplirse los 45 segundos (o antes, en cuanto regrese la señal), el sistema sincroniza automáticamente el catálogo en vivo con el servidor principal.
3. **CERO Doble Registro (Espera Activa en Vivo con `clientOperationId` Único):**
   - Si tocas **"Confirmar Venta"** justo cuando hay una pequeña desconexión de internet, **no se guarda en caché ni falla al instante**: la ventana de cobro mantiene la petición en espera activa reintentando en vivo contra el servidor cada **2 segundos** (hasta por **45 segundos**) usando **la misma llave única `clientOperationId` (`op_...`)**.
   - Si la señal vuelve en cualquier momento dentro de esos 45 segundos, la venta se registra en vivo en el servidor, el servidor valida `clientOperationId` en `processed_operations` (**haciendo 100% imposible que se duplique la venta**) y actualiza inmediatamente el stock real desde la base de datos principal.
   - Si pasan los 45 segundos y el internet sigue totalmente apagado, se cancela el envío sin guardar nada en caché, el carrito sigue intacto en pantalla y se muestra el aviso de reconexión hasta que vuelva la señal.

---

## 2. Cambios Quirúrgicos a Aplicar (Sin Alterar Cálculos ni Funcionalidades)

1. **`src/context/AppContext.tsx` (Modo de Gracia de 45s + Sincronización Automática al Reconectar + Optimización de Consumo):**
   - Mantener `purgeStaleOfflineQueuesAndCaches()` activo para garantizar **0% caché residual en celulares**.
   - Durante los 45 segundos de tolerancia ante un microcorte, realizar pings ligeros a `/api/health` (`0` lecturas a Firestore) y, en cuanto responda o al cumplirse el ciclo de reconexión, sincronizar automáticamente el stock real (`fetchProducts`) verificando primero `/api/catalog/version` en memoria.
   - Pausar los chequeos cuando la pantalla del celular está apagada (`document.visibilityState === 'hidden'`) y usar intervalo de `30s` cuando está estable en línea (**$0.00 de costo adicional** en Google AI Studio y mínimo tráfico).

2. **`src/views/POS.tsx` (Espera Activa en Vivo de hasta 45s al Cobrar sin Caché y sin Duplicados):**
   - En `executeCheckout`: eliminar cualquier guardado en caché offline y configurar el envío en vivo a `POST /api/sales` para que, si detecta un microcorte de red al momento de cobrar, reintente en vivo cada **2 segundos** (hasta completar la ventana de gracia de 45s) usando siempre el mismo `clientOperationId`.
   - En cuanto el intento conecte con el servidor, completa la venta, descarga el recibo PDF y refresca el stock desde el servidor principal (`fetchProducts(undefined, true)`).
