'use strict';

// Catálogo de instituciones financieras mexicanas, clave CLABE de 3 dígitos
// -> nombre corto de la institución.
//
// FUENTE: Banco de México (Banxico), servicio CEP-SCL (Comprobante
// Electrónico de Pago, consulta por lotes) — listado oficial y en vivo de
// instituciones participantes.
//   https://www.banxico.org.mx/cep-scl/listaInstituciones.do
// Consultado: 2026-07-30.
//
// Esa página publica cada institución con una clave de 5 dígitos (ej. Banamex
// = 40002, HSBC = 40021, STP = 90646). La clave CLABE real de 3 dígitos que
// va en los primeros 3 dígitos de una CLABE de 18 dígitos son los ÚLTIMOS 3
// dígitos de esa clave de 5 (40002 -> 002, 90646 -> 646). Este patrón se
// verificó contra una segunda fuente oficial independiente — el catálogo
// histórico de bancos publicado en gob.mx
// (https://www.gob.mx/cms/uploads/attachment/file/151413/catalogo_bancos.pdf)
// — coincidiendo en más de 30 pares clave+nombre superpuestos entre ambas
// fuentes (ej. 002 Banamex, 012 BBVA, 014 Santander, 021 HSBC, 072 Banorte,
// 646 STP), sin una sola discrepancia.
//
// BANXICO (clave 2001 en CEP-SCL, 4 dígitos) se omitió deliberadamente: no
// encaja en el patrón de 5->3 dígitos y no es un banco comercial que reciba
// nómina, así que no hay fuente confiable para su clave CLABE de 3 dígitos
// sin inferirla — se prefirió omitirlo a inventarlo.
//
// Offline y estático a propósito (regla del proyecto: sin llamadas a APIs de
// terceros en runtime para esta detección).
const CATALOGO_BANCOS = {
  '002': 'BANAMEX',
  '006': 'BANCOMEXT',
  '009': 'BANOBRAS',
  '012': 'BBVA MEXICO',
  '014': 'SANTANDER',
  '019': 'BANJERCITO',
  '021': 'HSBC',
  '030': 'BAJIO',
  '036': 'INBURSA',
  '042': 'MIFEL',
  '044': 'SCOTIABANK',
  '058': 'BANREGIO',
  '059': 'INVEX',
  '060': 'BANSI',
  '062': 'AFIRME',
  '072': 'BANORTE',
  '106': 'BANK OF AMERICA',
  '108': 'MUFG',
  '110': 'JP MORGAN',
  '112': 'BMONEX',
  '113': 'VE POR MAS',
  '124': 'CITI MEXICO',
  '127': 'AZTECA',
  '128': 'KAPITAL',
  '129': 'BARCLAYS',
  '130': 'COMPARTAMOS',
  '132': 'MULTIVA BANCO',
  '133': 'ACTINVER',
  '135': 'NAFIN',
  '136': 'INTERCAM BANCO',
  '137': 'BANCOPPEL',
  '138': 'UALA',
  '140': 'CONSUBANCO',
  '141': 'VOLKSWAGEN',
  '145': 'BBASE',
  '147': 'BANKAOOL',
  '148': 'PAGATODO',
  '150': 'INMOBILIARIO',
  '151': 'DONDE',
  '152': 'BANCREA',
  '154': 'BANCO COVALTO',
  '155': 'ICBC',
  '156': 'SABADELL',
  '157': 'SHINHAN',
  '158': 'MIZUHO BANK',
  '159': 'BANK OF CHINA',
  '160': 'BANCO S3',
  '166': 'BaBien',
  '167': 'HEY BANCO',
  '168': 'HIPOTECARIA FED',
  '600': 'MONEXCB',
  '601': 'GBM',
  '602': 'MASARI',
  '605': 'VALUE',
  '616': 'FINAMEX',
  '617': 'VALMEX',
  '620': 'PROFUTURO',
  '631': 'CI BOLSA',
  '634': 'FINCOMUN',
  '638': 'NU MEXICO',
  '646': 'STP',
  '652': 'CREDICAPITAL',
  '653': 'KUSPIT',
  '656': 'UNAGRA',
  '659': 'ASP INTEGRA OPC',
  '661': 'KLAR',
  '670': 'LIBERTAD',
  '677': 'CAJA POP MEXICA',
  '680': 'CRISTOBAL COLON',
  '683': 'CAJA TELEFONIST',
  '684': 'TRANSFER',
  '685': 'FONDO (FIRA)',
  '688': 'CREDICLUB',
  '699': 'FONDEADORA',
  '703': 'TESORED',
  '706': 'ARCUS FI',
  '710': 'NVIO',
  '714': 'PPBALANCEMX',
  '715': 'CASHI CUENTA',
  '720': 'MexPago',
  '721': 'albo',
  '722': 'Mercado Pago W',
  '723': 'Cuenca',
  '725': 'COOPDESARROLLO',
  '727': 'TRANSFER DIRECT',
  '728': 'SPIN BY OXXO',
  '729': 'Dep y Pag Dig',
  '730': 'Clip',
  '732': 'Peibo',
  '734': 'FINCO PAY',
  '738': 'FINTOC',
  '901': 'CLS',
  '902': 'INDEVAL',
  '903': 'CoDi Valida',
};

// Pesos cíclicos 3,7,1 del algoritmo estándar de dígito verificador de CLABE
// (Banxico, "Estándar CLABE"), aplicados a los primeros 17 dígitos.
const PESOS_CLABE = [3, 7, 1];

function digitoVerificadorClabe(clabe17) {
  let suma = 0;
  for (let i = 0; i < 17; i++) {
    const digito = Number(clabe17[i]);
    const producto = (digito * PESOS_CLABE[i % 3]) % 10;
    suma += producto;
  }
  return (10 - (suma % 10)) % 10;
}

// Valida formato completo de una CLABE de 18 dígitos: longitud, solo
// numérico, clave de institución en catálogo, y dígito verificador correcto.
// No hace ninguna llamada de red — todo contra el catálogo local de arriba.
function validarClabe(clabe) {
  if (typeof clabe !== 'string' || !/^\d{18}$/.test(clabe)) {
    return { valida: false, motivo: 'longitud' };
  }
  const claveInstitucion = clabe.slice(0, 3);
  const nombreBanco = CATALOGO_BANCOS[claveInstitucion];
  if (!nombreBanco) {
    return { valida: false, motivo: 'clave_desconocida' };
  }
  const esperado = digitoVerificadorClabe(clabe.slice(0, 17));
  const real = Number(clabe[17]);
  if (esperado !== real) {
    return { valida: false, motivo: 'digito_verificador' };
  }
  return { valida: true, banco: nombreBanco, claveInstitucion };
}

module.exports = { CATALOGO_BANCOS, validarClabe, digitoVerificadorClabe };
