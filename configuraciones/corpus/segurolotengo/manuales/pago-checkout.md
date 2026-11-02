<!-- pagina_id: pago-checkout | ruta: /pago/checkout | paso: 05A (no es paso del flujo) | version: 2026-10-24 -->
# Pago con tarjeta (formulario seguro de Bancard)

## Qué ve
La pantalla «Pago con tarjeta» (/pago/checkout) no es un paso del flujo ni tiene stepper. Se abre dentro de la pantalla «Realiza el pago» cuando se elige tarjeta de débito o crédito con el pago real. Aloja el formulario seguro de Bancard. Los datos de la tarjeta se escriben dentro del formulario de Bancard; SeguroLoTengo no los recibe ni los guarda. Con el pago simulado de la demostración no hay formulario real: se muestra «El pago con tarjeta no está habilitado en este ambiente.» o una ventana «Ventana de Bancard (simulada)».

## Qué puede hacer
- Completar el pago en el formulario de Bancard. El plazo corre desde la firma: son 10 minutos para pagar.
- Cerrar o volver a la pantalla de pago. Si Bancard no puede confirmar la operación, la ventana ofrece «VOLVER».
- Esperar: la pantalla de pago dice «Esperando la confirmación de Bancard…» y se actualiza sola.

## Errores frecuentes y qué hacer
- «No pudimos abrir el formulario de pago. Vuelve a la pantalla de pago y elige tu tarjeta de nuevo.»
- «El pago con tarjeta no está disponible en este momento. Prueba con el QR o intenta más tarde.» (si el QR no está habilitado: «…Intenta más tarde.»)
- Si el pago es rechazado, la pantalla de pago muestra «Pago rechazado… No se realizó ningún cobro.»
- No pague dos veces: si ya pagó y la confirmación tarda, espere en la pantalla de pago.

## Lo que este asistente no puede hacer
No puede pedir, recibir ni ver números de tarjeta, códigos OTP, cédula, datos de salud ni condición PEP. No cobra, no reembolsa ni verifica si un pago entró, y no cambia datos del trámite. No da consejo médico ni legal. Para ayuda de una persona, use el botón de ayuda por WhatsApp del sitio.
