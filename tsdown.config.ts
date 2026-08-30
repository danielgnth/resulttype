import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'resulttype/index': 'src/resulttype/index.ts',
    'errors/index': 'src/errors/index.ts',
    'catalogue/index': 'src/catalogue/index.ts',
    'interop/otel': 'src/interop/otel.ts',
  },
})
