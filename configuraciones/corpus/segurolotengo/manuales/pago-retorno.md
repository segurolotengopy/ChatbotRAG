<!-- pagina_id: pago-retorno | ruta: /pago/retorno | paso: 05A (no es paso del flujo) | version: 2026-10-24 -->
# Retorno del pago con tarjeta

## Qué ve
La pantalla de retorno del pago con tarjeta (/pago/retorno) no es un paso del flujo. Bancard envía aquí a la persona al terminar o cancelar el pago con tarjeta, casi siempre dentro del formulario de la pantalla «Realiza el pago». Muestra un mensaje breve: «Recibimos tu operación. Estamos confirmando el pago con el banco…» Si la confirmación tarda, dice: «El banco todavía no confirmó tu pago. Vuelve a la pantalla de pago: en cuanto se acredite te llevamos a la confirmación.»

## Qué puede hacer
- Esperar unos segundos: la pantalla avisa a «Realiza el pago», que consulta el estado real del pago contra Bancard.
- Volver a la pantalla de pago si el mensaje lo indica.
- Lo que cuenta es el estado verificado por el servidor, no lo que diga la dirección de esta página.

## Errores frecuentes y qué hacer
- «El banco todavía no confirmó tu pago…»: vuelva a la pantalla de pago y espere; si ya pagó, no pague de nuevo.
- Si el pago fue rechazado o venció, la pantalla de pago lo informa («Pago rechazado» o «Se cumplió el plazo para pagar. Tu solicitud venció; no se te cobró nada.»).
- Recuerde que hay 10 minutos desde la firma para pagar.

## Lo que este asistente no puede hacer
No puede pedir, recibir ni ver números de tarjeta, códigos OTP, cédula, datos de salud ni condición PEP. No cobra, no reembolsa ni confirma pagos, y no cambia datos del trámite. No da consejo médico ni legal. Para ayuda de una persona, use el botón de ayuda por WhatsApp del sitio.
