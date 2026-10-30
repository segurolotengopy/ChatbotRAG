/**
 * NORMALIZACIÓN LOCAL DE LA ENTRADA DE KUAA
 *
 * Porqué: las compuertas de entrada comparan texto «tal cual» tras NFKC. Un carácter invisible
 * (un espacio de ancho cero dentro de «tengo cáncer»), un guion blando o una letra cirílica que se ve igual a una latina (la «і» cirílica de «іgnora»)
 * las evaden, y el texto evadido llegaba al proveedor de LLM y a la memoria. Acá, solo para Kuaa (las
 * compuertas compartidas no se tocan), se normaliza ANTES de evaluar y de enviar: NFKC, se quitan los
 * caracteres de formato (\p{Cf}), las marcas combinantes (\p{Mn}, \p{Me}) y los rellenos que se ven
 * en blanco, y se pliegan a latino los homóglifos cirílicos y griegos más frecuentes. El modelo recibe el
 * texto normalizado, no el original.
 *
 * Qué NO garantiza: la lista de homóglifos es una muestra, no todo Unicode; no entiende paráfrasis
 * («olvidá lo anterior», «SYSTEM:», «repetí tus instrucciones» siguen pasando: sin cambiar el
 * vocabulario de las compuertas compartidas no hay cómo detectarlas); y quitar marcas combinantes
 * también quita tildes de letras sin forma precompuesta.
 */
const RE_INVISIBLES = /[\p{Cf}\p{Mn}\p{Me}ᅟᅠㅤﾠ⠀]/gu;

const HOMOGLIFOS: Readonly<Record<string, string>> = {
  // Cirílico minúscula
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', һ: 'h', ԁ: 'd', ӏ: 'l', ԛ: 'q', ԝ: 'w',
  // Cirílico mayúscula
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', І: 'I', Ј: 'J', Ѕ: 'S', У: 'Y',
  // Griego minúscula
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', μ: 'u', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', γ: 'y', ω: 'w',
  // Griego mayúscula
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
};

export function normalizarEntradaKuaa(texto: string): string {
  const base = texto.normalize('NFKC').replace(RE_INVISIBLES, '');
  let salida = '';
  for (const c of base) salida += HOMOGLIFOS[c] ?? c;
  return salida;
}
