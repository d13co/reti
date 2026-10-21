/// <reference types="vitest" />
import { TanStackRouterVite } from '@tanstack/router-vite-plugin'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { version } from './package.json'

/**
 * This plugin replaces the `__APP_VERSION__` placeholder in the `public/version.json` file
 */
const replaceVersionPlugin = () => {
  let outDir
  return {
    name: 'replace-version-in-json',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      outDir = config.build.outDir
    },
    generateBundle() {
      try {
        const filePath = path.resolve(__dirname, 'public/version.json')
        if (!fs.existsSync(filePath)) {
          throw new Error(`version.json not found at ${filePath}`)
        }
        const content = fs.readFileSync(filePath, 'utf-8')
        const updatedContent = content.replace('__APP_VERSION__', version)
        const newFilePath = path.resolve(outDir, 'version.json')
        fs.writeFileSync(newFilePath, updatedContent, 'utf-8')
      } catch (error) {
        console.error('Failed to replace version in version.json file:', error)
      }
    },
  }
}

/**
 * Strips the base64 TEAL `source` member from ARC-56 `APP_SPEC` literals in the generated
 * clients (ours, reti-ghost-sdk and xgov). Runtime needs only `byteCode` and `sourceInfo`;
 * `source` is used by algokit-utils for template compiles (never done here) and TEAL context
 * in LogicError messages. Fails the build if a spec still has a `source` it can't strip, so
 * a generator change can't silently undo it.
 */
const SPEC_MODULE =
  /(src[\\/]contracts[\\/][^\\/]+Client\.ts|reti-ghost-sdk[\\/]dist[\\/].*\.js|xgov-clients[\\/]dist[\\/].*\.js)$/
const HAS_SOURCE = /"source"\s*:\s*\{\s*"approval"/
const SOURCE_MEMBER =
  /"source"\s*:\s*\{\s*"approval"\s*:\s*"[A-Za-z0-9+/=]*"\s*,\s*"clear"\s*:\s*"[A-Za-z0-9+/=]*"\s*\}\s*,?/g

export const stripAppSpecSource = () => ({
  name: 'strip-app-spec-source',
  apply: 'build',
  enforce: 'pre',
  transform(code, id) {
    if (!SPEC_MODULE.test(id.split('?')[0]) || !HAS_SOURCE.test(code)) return null
    const stripped = code.replace(SOURCE_MEMBER, '')
    if (HAS_SOURCE.test(stripped)) {
      this.error(`strip-app-spec-source: APP_SPEC source in ${id} has an unexpected shape`)
    }
    return { code: stripped, map: null }
  },
})

/**
 * Preconnects to the node every protocol read goes through (the dtalgorand node, else the regular
 * algod; see `getReadAlgodConfigFromViteEnvironment`), so the first read doesn't also pay for DNS,
 * TCP and TLS. `crossorigin`, because algod requests are CORS requests.
 */
const readNodePreconnect = () => {
  let env = {}
  return {
    name: 'read-node-preconnect',
    configResolved(config) {
      env = config.env
    },
    transformIndexHtml() {
      const server = env.VITE_DT_ALGOD_SERVER || env.VITE_ALGOD_SERVER
      const port = env.VITE_DT_ALGOD_SERVER ? env.VITE_DT_ALGOD_PORT : env.VITE_ALGOD_PORT
      if (!server) return []
      try {
        const url = new URL(server)
        if (port) url.port = String(port)
        return [
          {
            tag: 'link',
            attrs: { rel: 'preconnect', href: url.origin, crossorigin: '' },
            injectTo: 'head-prepend',
          },
        ]
      } catch {
        return []
      }
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    replaceVersionPlugin(),
    stripAppSpecSource(),
    readNodePreconnect(),
    TanStackRouterVite(),
    nodePolyfills({
      include: ['path', 'stream', 'util'],
      exclude: ['http'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      overrides: {
        fs: 'memfs',
      },
      protocolImports: true,
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  test: {
    name: 'reti-ui',
    dir: './src',
    watch: false,
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          algorand: ['algosdk', '@algorandfoundation/algokit-utils'],
          retiGhost: ['reti-ghost-sdk'],
          icons: ['lucide-react', '@radix-ui/react-icons'],
          tremor: ['@tremor/react'],
          useWallet: ['@txnlab/use-wallet-react'],
        },
      },
    },
  },
})
