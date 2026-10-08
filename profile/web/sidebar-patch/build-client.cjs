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

async function run() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src/client/index.tsx')],
    outfile: path.join(__dirname, 'lib/client.js'),
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
      js: '\nif (typeof apply !== "undefined") exports.apply = apply;\nif (typeof inject !== "undefined") exports.inject = inject;\nreturn module.exports;\n}});\n',
    },
    plugins: [cssPlugin],
  })
  console.log('Successfully bundled dsh-better-sidebar client with exports!');
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
