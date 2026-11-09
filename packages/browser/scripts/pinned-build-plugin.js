// Builds the version-pinned SDK (PIN-1029): dist/pinned/<version>/, laid out
// exactly as the edge serves it under /v1/analytics-js/v/<version>/.
//
// 1. Adds integrity + crossorigin to webpack's chunk loader, read from
//    __webpack_require__.cioIntegrity, which src/browser/standalone.ts sets
//    only in pinned mode. Unpinned chunk loads are unchanged.
// 2. After minification, hashes every file the standalone entry can load (its
//    async chunks, webPushPlugin.min.js and the vendored destination bundles)
//    and writes that table into standalone.js in place of the token in
//    src/lib/pinned.ts. Chunks never contain the table, so their hashes do not
//    depend on it.
// 3. After emit, copies the final files into dist/pinned/<version>/, checks
//    each against the compiled table, and writes integrity.json (hashes of the
//    final bytes, including analytics.min.js) and gzip siblings.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const webpack = require('webpack')

const TOKEN = '__CIO_PINNED_INTEGRITY_TABLE__'
const NAME = 'PinnedBuildPlugin'

function sri(buffer) {
  return 'sha384-' + crypto.createHash('sha384').update(buffer).digest('base64')
}

function countOf(haystack, needle) {
  return haystack.split(needle).length - 1
}

class PinnedBuildPlugin {
  /**
   * @param {{ version: string, outputDir: string, destinationsDir: string, enabled: boolean }} options
   */
  constructor(options) {
    this.options = options
  }

  apply(compiler) {
    const { RuntimeGlobals, Template } = webpack
    const { version, outputDir, destinationsDir, enabled } = this.options

    compiler.hooks.thisCompilation.tap(NAME, (compilation) => {
      webpack.runtime.LoadScriptRuntimeModule.getCompilationHooks(
        compilation
      ).createScript.tap(NAME, (source) =>
        Template.asString([
          source,
          `if (typeof ${RuntimeGlobals.require}.cioIntegrity === "function") {`,
          Template.indent([
            `var cioIntegrity = ${RuntimeGlobals.require}.cioIntegrity(url);`,
            'if (cioIntegrity) {',
            Template.indent([
              'script.setAttribute("integrity", cioIntegrity);',
              'script.setAttribute("crossorigin", "anonymous");',
            ]),
            '}',
          ]),
          '}',
        ])
      )

      if (!enabled) return

      compilation.hooks.processAssets.tap(
        {
          name: NAME,
          // After TerserPlugin (OPTIMIZE_SIZE), before CompressionPlugin
          // (OPTIMIZE_TRANSFER): the hashes are of the minified bytes and
          // standalone.js.gz holds the table.
          stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_HASH,
        },
        () => {
          const fail = (message) =>
            compilation.errors.push(
              new webpack.WebpackError(`${NAME}: ${message}`)
            )
          const standalone = compilation.entrypoints.get('standalone')
          const webPush = compilation.entrypoints.get('webPushPlugin.min')
          if (!standalone || !webPush) return fail('missing entrypoints')

          /** pinned path -> source: { asset } or { file } */
          const sources = new Map()
          const standaloneFile = [...standalone.getEntrypointChunk().files][0]
          for (const chunk of standalone
            .getEntrypointChunk()
            .getAllAsyncChunks()) {
            for (const file of chunk.files) {
              if (file.endsWith('.js')) sources.set(file, { asset: file })
            }
          }
          for (const file of webPush.getEntrypointChunk().files) {
            if (file.endsWith('.js')) sources.set(file, { asset: file })
          }
          for (const file of fs.readdirSync(destinationsDir).sort()) {
            if (file.endsWith('.js'))
              sources.set(`actions/${file}`, {
                file: path.join(destinationsDir, file),
              })
          }

          const table = {}
          for (const [pinnedPath, from] of sources) {
            if (from.asset) {
              const asset = compilation.getAsset(from.asset)
              if (!asset) return fail(`no asset ${from.asset}`)
              const bytes = asset.source.buffer()
              if (bytes.includes(TOKEN))
                return fail(
                  `${from.asset} contains the integrity table token; the table must only be in ${standaloneFile}`
                )
              table[pinnedPath] = sri(bytes)
            } else {
              table[pinnedPath] = sri(fs.readFileSync(from.file))
            }
          }
          // "<path> <hash>" pairs: no quotes or backslashes, so the token can
          // be replaced inside a string literal of either quote style.
          const encoded = Object.keys(table)
            .sort()
            .map((key) => `${key} ${table[key]}`)
            .join(',')
          if (/["'\\\s,]/.test(Object.keys(table).join('')))
            return fail('a pinned path has a character the table cannot hold')

          const entry = compilation.getAsset(standaloneFile)
          const code = entry.source.source().toString()
          if (countOf(code, TOKEN) !== 1)
            return fail(
              `expected the token once in ${standaloneFile}, found ${countOf(
                code,
                TOKEN
              )}`
            )
          compilation.updateAsset(
            standaloneFile,
            new webpack.sources.RawSource(code.replace(TOKEN, encoded))
          )
          this.pinned = { standaloneFile, sources, table, encoded }
        }
      )
    })

    if (!enabled) return

    compiler.hooks.afterEmit.tap(NAME, (compilation) => {
      if (!this.pinned) return
      const fail = (message) =>
        compilation.errors.push(new webpack.WebpackError(`${NAME}: ${message}`))
      const { standaloneFile, sources, table, encoded } = this.pinned
      const emitted = compilation.outputOptions.path
      const files = new Map()
      const analytics = fs.readFileSync(path.join(emitted, standaloneFile))
      if (!analytics.includes(encoded))
        return fail(
          `${standaloneFile} on disk does not hold the integrity table`
        )
      files.set('analytics.min.js', analytics)
      for (const [pinnedPath, from] of sources) {
        const bytes = fs.readFileSync(
          from.asset ? path.join(emitted, from.asset) : from.file
        )
        if (sri(bytes) !== table[pinnedPath])
          return fail(`${pinnedPath} on disk does not match its compiled hash`)
        files.set(pinnedPath, bytes)
      }

      fs.rmSync(outputDir, { recursive: true, force: true })
      const integrity = { version, files: {} }
      for (const pinnedPath of [...files.keys()].sort()) {
        const bytes = files.get(pinnedPath)
        const target = path.join(outputDir, pinnedPath)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, bytes)
        fs.writeFileSync(`${target}.gz`, zlib.gzipSync(bytes, { level: 9 }))
        integrity.files[pinnedPath] = sri(fs.readFileSync(target))
      }
      fs.writeFileSync(
        path.join(outputDir, 'integrity.json'),
        JSON.stringify(integrity, null, 2) + '\n'
      )
    })
  }
}

module.exports = { PinnedBuildPlugin, TOKEN }
