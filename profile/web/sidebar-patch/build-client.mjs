import { build } from 'esbuild'
import { transform } from 'lightningcss'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const id = 'dsh-better-sidebar'

const cssPlugin = {
  name: 'dsh-css-modules',
  setup(builder) {
    builder.onLoad({ filter: /\.css$/ }, async (args) => {
      const isModule = args.path.endsWith('.module.css')
      const source = await readFile(args.path)
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
      const tagId = `${id}/${args.path}`
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

async function run() {
  await build({
    entryPoints: [join(HERE, 'src/client/index.tsx')],
    outfile: join(HERE, 'lib/client.js'),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['es2022'],
    sourcemap: true,
    external: [
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
    ],
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env.MODE': '"production"',
      'import.meta.env': '{"MODE":"production"}',
    },
    banner: {
      js: 'window.__ModuleLoader__.load({ id: "dsh-better-sidebar", factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;\nvar React = require("react");\n',
    },
    footer: {
      js: '\nreturn module.exports;\n}});\n',
    },
    plugins: [cssPlugin],
  })
  console.log('Successfully bundled dsh-better-sidebar client!');
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
