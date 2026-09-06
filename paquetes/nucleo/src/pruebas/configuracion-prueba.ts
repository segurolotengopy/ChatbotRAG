/** Configuración mínima válida para pruebas del núcleo. */
import type { ConfiguracionAgenteEntrada } from '../configuracion/esquema.js';

export const CONFIG_PRUEBA: ConfiguracionAgenteEntrada = {
  version: 1,
  id: 'prueba-seguros',
  identidad: { nombreAsistente: 'Terra', organizacion: 'Aseguradora Prueba', idioma: 'es-PY', moneda: 'PYG' },
  voz: { tratamiento: 'usted', emojis: 'ninguno' },
  operacion: {
    horarios: { lun: '08:00-18:00', vie: '08:00-17:00', dom: 'cerrado' },
    contactoHumano: { whatsapp: '595981000000', texto: 'Un asesor le responde en horario de oficina.' },
  },
  datos: {
    politicas: { retracto: 'Puede arrepentirse dentro de los 10 días de recibida la póliza.' },
    datosQueNoTenemos: ['comisiones de los corredores'],
  },
  alcance: {
    temasPermitidos: ['planes y coberturas', 'proceso de contratación'],
    temasBloqueados: ['otras aseguradoras'],
    accionesProhibidas: ['emitir pólizas', 'cobrar', 'firmar'],
  },
  conocimiento: { modo: 'rag', topK: 3, umbral: 0.2, exigirRespaldo: true, fuentes: [
    { id: 'coberturas', titulo: 'Coberturas del plan', version: 'v1', ruta: 'coberturas.md' },
    { id: 'interno', titulo: 'Tarifario interno', version: 'v1', visibilidad: 'interno', ruta: 'interno.md' },
  ] },
  seguridad: {
    bloquearEntrada: ['cedula', 'tarjeta', 'salud', 'pep', 'otp', 'clave'],
    compuertasSalida: ['niega_ia', 'promesa_indemnizacion', 'decision_elegibilidad', 'dato_confidencial', 'marca_no_declarada'],
    terminosConfidenciales: ['margen interno'],
  },
  herramientas: [
    { nombre: 'derivar_humano', descripcion: 'Deriva la conversación a una persona del equipo.', parametros: { motivo: { tipo: 'string', descripcion: 'Motivo breve' } } },
    { nombre: 'recomendar_opcion', descripcion: 'Recomienda un plan según las facetas de orientación.' },
  ],
  orientacion: {
    facetas: [
      { id: 'para_quien', pregunta: '¿El seguro es para usted o para otra persona?', opciones: ['para mí', 'para otra persona'] },
      { id: 'prioridad', pregunta: '¿Qué le importa más?', opciones: ['precio', 'mayor cobertura'] },
    ],
    reglas: [
      { si: { prioridad: 'precio' }, recomendar: 'BASICO', texto: 'Por precio, el plan Básico es el punto de partida.' },
      { si: { prioridad: 'mayor cobertura' }, recomendar: 'TOTAL', texto: 'Si prioriza cobertura, el plan Total es el más completo.' },
    ],
    aclaracion: 'Es una orientación general, no una oferta ni una evaluación de su caso.',
  },
  mensajes: {
    bienvenida: 'Hola, soy Terra, asistente virtual. ¿En qué puedo ayudarle?',
    errorTemporal: 'Tuve un problema técnico momentáneo. ¿Me repite lo último?',
    fueraDeAlcance: 'Eso está fuera de lo que puedo responder por este medio.',
    sinRespaldo: 'No cuento con información aprobada para responder eso.',
    derivacion: 'Puede escribir a nuestro WhatsApp 595981000000 y una persona le atenderá.',
    entradaBloqueada: 'Por su seguridad, no comparta datos personales por este medio. Cuénteme su consulta sin esos datos.',
    suspendido: 'En este momento no podemos atenderle por este medio.',
  },
  modelo: { proveedor: 'simulado', nombre: 'simulado', maxIteraciones: 3, ventanaMemoria: 6, ttlConversacionSeg: 600 },
  perfiles: {
    VIDA: { nombre: 'Seguro de Vida', alcance: { temasPermitidos: ['vida'] }, conocimiento: { fuentes: [{ id: 'vida', titulo: 'Condiciones Vida', version: 'v2', ruta: 'vida.md' }] } },
    AUTO: { nombre: 'Seguro de Auto', voz: { tratamiento: 'tu' }, orientacion: { facetas: [], reglas: [] } },
  },
};

export const CORPUS_PRUEBA: Record<string, string> = {
  'coberturas.md': `# Coberturas del plan

## Fallecimiento
El plan cubre fallecimiento por cualquier causa con una suma asegurada de Gs. 50.000.000.

## Carencias
La carencia por diagnóstico de cáncer es de 180 días. La renta hospitalaria tiene 30 días de carencia.

## Exclusiones
No se cubren enfermedades preexistentes ni lesiones autoinfligidas durante el primer año.`,
  'interno.md': `# Tarifario interno
El margen interno del producto es del 40 %.`,
  'vida.md': `# Condiciones Vida
## Edad de ingreso
La edad de ingreso es de 18 a 64 años para el seguro de vida.`,
};
