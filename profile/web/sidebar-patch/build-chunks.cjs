// Build the lazy chunk bundles (client-editor.js / client-terminal.js /
// client-mermaid.js) from src/client/chunks/*.tsx, mirroring the tsdown
// chunkBundle contract: globalThis.__dshChunks__["<name>"] = (require) => {...}
// with the platform externals left for the chunk loader's require.
const esbuild = require('esbuild')
const { transform } = require('lightningcss')
const fs = require('node:fs')
const path = require('node:path')

const id = 'dsh-better-sidebar'

const cssPlugin = {
  name: 'dsh-css-modules',
  setup(builder) {
    builder.onLoad({ filter: /\.css$/ }, async (args) => {
      const isModule = args.path.endsWith('.module.css')
      const source = fs.readFileSync(args.path)
      const { code, exports: cssExports } = transform({
        filename: args.path,
        code: source,
        cssModules: isModule ? { pattern: '[hash]_[local]' } : false,
        minify: true,
      })
      const classMap = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) {
        classMap[local] = exp.name
      }
      const css = code.toString()
      const tagId = `${id}/${path.basename(args.path)}`
      const contents = [
        `const css = ${JSON.stringify(css)};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        `if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']')) {`,
        `  const tag = document.createElement('style');`,
        `  tag.dataset.plugin = ${JSON.stringify(id)};`,
        `  tag.dataset.pluginCss = tagId;`,
        `  tag.textContent = css;`,
        `  document.head.appendChild(tag);`,
        `}`,
        isModule ? `module.exports = ${JSON.stringify(classMap)};` : `module.exports = {};`,
      ].join('\n')
      return { contents, loader: 'js' }
    })
  },
}

const EXTERNALS = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-modules',
]

const CHUNKS = [
  { name: 'editor', entry: 'src/client/chunks/editor.tsx' },
  { name: 'terminal', entry: 'src/client/chunks/terminal.tsx' },
  { name: 'mermaid', entry: 'src/client/chunks/mermaid.tsx' },
]

async function run() {
  for (const chunk of CHUNKS) {
    await esbuild.build({
      entryPoints: [path.join(__dirname, chunk.entry)],
      outfile: path.join(__dirname, `lib/client-${chunk.name}.js`),
      bundle: true,
      format: 'cjs',
      platform: 'browser',
      target: ['es2022'],
      sourcemap: true,
      external: EXTERNALS,
      banner: {
        js: `globalThis.__dshChunks__ = globalThis.__dshChunks__ || {};\nglobalThis.__dshChunks__["${chunk.name}"] = (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;\nvar React = require("react");`,
      },
      footer: {
        js: '\nreturn module.exports;\n};',
      },
      plugins: [cssPlugin],
    })
    console.log(`chunk ${chunk.name} built`)
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})