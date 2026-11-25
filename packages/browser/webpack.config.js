const fs = require('fs')
const path = require('path')
const webpack = require('webpack')
const TerserPlugin = require('terser-webpack-plugin')
const CompressionPlugin = require('compression-webpack-plugin')
const BundleAnalyzerPlugin =
  require('webpack-bundle-analyzer').BundleAnalyzerPlugin
const CircularDependencyPlugin = require('circular-dependency-plugin')
const { PinnedBuildPlugin } = require('./scripts/pinned-build-plugin')
const { version } = require('./package.json')

const isProd = process.env.NODE_ENV === 'production'
const ASSET_PATH = isProd
  ? 'https://cdp.customer.io/v1/analytics-js/'
  : '/dist/umd/'

const webPushWorker = path.resolve(
  __dirname,
  'src/plugins/web-push-plugin/cio-webpush-sw.js'
)
// Sites host the first; the CDN serves the second, which hosted copies import
// to upgrade themselves. They are the same file (it detects being imported).
const webPushWorkerFiles = ['cio-webpush-sw.js', 'cio-webpush-sw-runtime.v1.js']

const plugins = [
  {
    apply(compiler) {
      compiler.hooks.thisCompilation.tap('WebPushWorker', (compilation) => {
        compilation.hooks.processAssets.tap(
          {
            name: 'WebPushWorker',
            stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
          },
          () => {
            for (const name of webPushWorkerFiles)
              compilation.emitAsset(
                `../${name}`,
                new webpack.sources.RawSource(fs.readFileSync(webPushWorker))
              )
          }
        )
      })
      // The worker's tests run on its source, so the shipped copies must be
      // that source byte for byte (no minifier or other transform).
      compiler.hooks.afterEmit.tap('WebPushWorker', (compilation) => {
        for (const name of webPushWorkerFiles) {
          const shipped = path.resolve(
            compilation.outputOptions.path,
            `../${name}`
          )
          if (
            !fs.readFileSync(shipped).equals(fs.readFileSync(webPushWorker))
          ) {
            compilation.errors.push(
              new webpack.WebpackError(
                `${shipped} differs from ${webPushWorker}; it must ship unchanged`
              )
            )
          }
        }
      })
    },
  },
  // Version-pinned SDK with SRI (PIN-1029): dist/pinned/<version>/.
  new PinnedBuildPlugin({
    version,
    enabled: isProd,
    outputDir: path.resolve(__dirname, 'dist/pinned', version),
    destinationsDir: path.resolve(__dirname, 'vendor/destinations'),
  }),
  new CompressionPlugin({ exclude: /cio-webpush-sw[\w.-]*\.js$/ }),
  new webpack.EnvironmentPlugin({
    ASSET_PATH,
  }),
  new CircularDependencyPlugin({
    failOnError: true,
    exclude: /customerio-gist-web/,
  }),
]

if (process.env.ANALYZE) {
  plugins.push(new BundleAnalyzerPlugin())
}

/** @type { import('webpack').Configuration } */
const config = {
  stats: process.env.WATCH === 'true' ? 'errors-warnings' : 'normal',
  node: {
    global: false, // do not polyfill global object, we can use getGlobal function if needed.
  },
  mode: process.env.NODE_ENV || 'development',
  entry: {
    'webPushPlugin.min': {
      import: path.resolve(__dirname, 'src/plugins/web-push-plugin/index.ts'),
      library: { name: 'CustomerIOWebPush', type: 'umd' },
    },
    index: {
      import: path.resolve(__dirname, 'src/browser/browser-umd.ts'),
      library: {
        name: 'AnalyticsNext',
        type: 'umd',
      },
    },
    standalone: {
      import: path.resolve(__dirname, 'src/browser/standalone.ts'),
      library: {
        name: 'AnalyticsNext',
        type: 'window',
      },
    },
  },
  output: {
    publicPath: '', // Hack - we're overriding publicPath but IE needs this set or it won't load.
    filename: '[name].js',
    path: path.resolve(__dirname, 'dist/umd'),
  },
  target: ['web', 'es5'],
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              configFile: 'tsconfig.build.json',
              transpileOnly: true,
            },
          },
        ],
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  devServer: {
    contentBase: path.resolve(__dirname, 'dist/umd'),
  },
  optimization: {
    moduleIds: 'deterministic',
    minimize: isProd,
    minimizer: [
      new TerserPlugin({
        exclude: /cio-webpush-sw[\w.-]*\.js$/,
        extractComments: false,
        terserOptions: {
          ecma: '2015',
          mangle: true,
          compress: true,
          output: {
            comments: false,
          },
        },
      }),
    ],
  },
  plugins,
}

module.exports = config
