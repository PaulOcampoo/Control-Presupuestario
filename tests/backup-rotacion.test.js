// Prueba la lógica de rotación de backups (prompt-ajuste-backup-diario.md)
// con fechas simuladas, sin tocar Vercel Blob real — cubre el checkpoint
// "Lógica de rotación probada con fechas simuladas, output literal
// mostrando qué se conserva/purga en un escenario de varios meses" y
// "Salvaguarda dura de abortar-si-no-hay-certeza sigue intacta y probada".
// clasificarBackups() es una función pura (sin I/O) exportada justo para
// poder testear esto sin mockear @vercel/blob.
import { describe, it, expect } from 'vitest';
import { clasificarBackups, RETENCION_DIARIOS, RETENCION_MENSUALES } from '../scripts/backup-neon-to-blob.js';

function blob(fecha) {
  return { pathname: `backups/backup-${fecha}.sql.gz`, url: `https://blob.example/backups/backup-${fecha}.sql.gz`, uploadedAt: `${fecha}T09:00:00.000Z` };
}

describe('clasificarBackups — retención diaria (30 días)', () => {
  it('conserva todo lo que cae dentro de los últimos 30 días', () => {
    const hoy = '2026-09-01';
    const blobs = [blob('2026-09-01'), blob('2026-08-15'), blob('2026-08-03')]; // 0, 17, 29 días atrás
    const { aConservar, aBorrar } = clasificarBackups(blobs, hoy);
    expect(aConservar.map((b) => b.fecha)).toEqual(['2026-09-01', '2026-08-15', '2026-08-03']);
    expect(aBorrar).toEqual([]);
  });

  it('el backup justo en el borde de 30 días (día 29 atrás) se conserva; 30 atrás ya no (salvo que sea representante mensual)', () => {
    const hoy = '2026-09-30';
    const dia29 = blob('2026-09-01'); // 29 días atrás -> dentro de la ventana (< 30)
    const dia30 = blob('2026-08-31'); // 30 días atrás -> fuera de la ventana, y no es el más antiguo de agosto
    const dia31MasAntiguoAgosto = blob('2026-08-01'); // representante mensual de agosto
    const { aConservar, aBorrar } = clasificarBackups([dia29, dia30, dia31MasAntiguoAgosto], hoy);
    expect(aConservar.map((b) => b.fecha).sort()).toEqual(['2026-08-01', '2026-09-01']);
    expect(aBorrar.map((b) => b.fecha)).toEqual(['2026-08-31']);
  });
});

describe('clasificarBackups — promoción a representante mensual', () => {
  it('escenario de varios meses: conserva 30 diarios + el más antiguo de cada uno de los últimos 12 meses, purga el resto', () => {
    const hoy = '2026-09-15';
    const blobs = [
      // Septiembre 2026 (mes actual): todos dentro de los 30 días -> todos se conservan por regla diaria.
      blob('2026-09-15'), blob('2026-09-01'),
      // Agosto 2026: 08-20 sigue dentro de la ventana diaria de 30 días
      // (26 días atrás) y se conserva por esa regla, no por ser mensual.
      // 08-10 (36 días atrás) ya no califica por ninguna de las 2 reglas
      // (no es el más antiguo del mes) -> se purga. 08-01 SÍ es el más
      // antiguo de agosto -> representante mensual, sobrevive aunque ya
      // esté fuera de la ventana diaria.
      blob('2026-08-20'), blob('2026-08-10'), blob('2026-08-01'),
      // Enero 2026 (hace 8 meses, dentro de la ventana de 12 meses): solo sobrevive el más antiguo.
      blob('2026-01-20'), blob('2026-01-01'),
      // Enero 2025 (hace 20 meses, fuera de la ventana de 12 meses): no sobrevive ninguno.
      blob('2025-01-01'),
    ];
    const { aConservar, aBorrar, mensualesPromovidos } = clasificarBackups(blobs, hoy);

    const conservarFechas = aConservar.map((b) => b.fecha).sort();
    const borrarFechas = aBorrar.map((b) => b.fecha).sort();

    console.log('=== Escenario multi-mes (hoy = 2026-09-15) ===');
    console.log('CONSERVAR:', conservarFechas);
    console.log('BORRAR:', borrarFechas);
    console.log('Representantes mensuales promovidos:', [...mensualesPromovidos]);

    expect(conservarFechas).toEqual([
      '2026-01-01', // representante mensual de enero 2026
      '2026-08-01', // representante mensual de agosto 2026
      '2026-08-20', // dentro de la ventana diaria (26 días atrás), no por ser mensual
      '2026-09-01', '2026-09-15', // dentro de la ventana diaria
    ]);
    expect(borrarFechas).toEqual([
      '2025-01-01', // fuera de la ventana de 12 meses, ya no calza como mensual
      '2026-01-20', // no es el más antiguo de su mes, y fuera de ventana diaria
      '2026-08-10', // no es el más antiguo de agosto, y fuera de ventana diaria (36 días atrás)
    ]);
    expect(mensualesPromovidos.has('backups/backup-2026-08-01.sql.gz')).toBe(true);
    expect(mensualesPromovidos.has('backups/backup-2026-01-01.sql.gz')).toBe(true);
    expect(mensualesPromovidos.has('backups/backup-2025-01-01.sql.gz')).toBe(false); // fuera de los 12 meses
  });

  it('si el run del día 1 falló, el backup disponible más antiguo del mes se promueve en su lugar', () => {
    const hoy = '2026-09-15';
    // Agosto: faltan el día 1 y 2 (fallaron), el primero disponible es el 3.
    const blobs = [blob('2026-08-03'), blob('2026-08-10'), blob('2026-09-15')];
    const { mensualesPromovidos } = clasificarBackups(blobs, hoy);
    expect(mensualesPromovidos.has('backups/backup-2026-08-03.sql.gz')).toBe(true);
  });

  it('respeta exactamente la constante RETENCION_MENSUALES=12 (11 meses atrás, el más lejano dentro de la ventana de 12, sobrevive; 13 atrás no)', () => {
    const hoy = '2026-09-15';
    const dentroDeVentana = blob('2025-10-01'); // 11 meses atrás -> último mes dentro de la ventana de 12 (mes actual + 11 anteriores)
    const fueraDeVentana = blob('2025-08-01'); // 13 meses atrás -> fuera
    const { mensualesPromovidos } = clasificarBackups([dentroDeVentana, fueraDeVentana], hoy);
    expect(mensualesPromovidos.has('backups/backup-2025-10-01.sql.gz')).toBe(true);
    expect(mensualesPromovidos.has('backups/backup-2025-08-01.sql.gz')).toBe(false);
    expect(RETENCION_MENSUALES).toBe(12);
    expect(RETENCION_DIARIOS).toBe(30);
  });
});

describe('clasificarBackups — salvaguardas duras (nunca borrar sin certeza)', () => {
  it('identifica blobs con nombre que no calza con el patrón esperado, separados en sinFecha (el caller debe abortar el borrado completo)', () => {
    const hoy = '2026-09-15';
    const blobs = [blob('2026-09-15'), { pathname: 'backups/algo-raro.txt', url: 'x', uploadedAt: hoy }];
    const { sinFecha, aBorrar } = clasificarBackups(blobs, hoy);
    expect(sinFecha).toHaveLength(1);
    expect(sinFecha[0].pathname).toBe('backups/algo-raro.txt');
    // El blob sin fecha nunca aparece en aBorrar (solo se clasifican los que sí se pudieron parsear).
    expect(aBorrar.find((b) => b.pathname === 'backups/algo-raro.txt')).toBeUndefined();
  });

  it('el backup recién subido (fecha de hoy) siempre cae en aConservar, nunca en aBorrar', () => {
    const hoy = '2026-09-15';
    const blobs = [blob(hoy)];
    const { aConservar, aBorrar } = clasificarBackups(blobs, hoy);
    expect(aConservar).toHaveLength(1);
    expect(aBorrar).toHaveLength(0);
  });
});
