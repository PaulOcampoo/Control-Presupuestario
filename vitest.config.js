import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup-env.js'],
    testTimeout: 20000,
    // .claude/worktrees/* son checkouts completos del repo (uno por rama en
    // desarrollo) que viven físicamente dentro de este directorio aunque
    // están gitignoreados — sin este exclude, vitest recogía también sus
    // copias de tests/*.test.js y las corría en paralelo contra la misma
    // base de datos real, causando colisiones falsas (ej. username
    // duplicado en tests/presupuestos-permisos.test.js).
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
