const fs = require('fs')
const path = require('path')
const webpack = require('webpack')
const TerserPlugin = require('terser-webpack-plugin')
const CompressionPlugin = require('compression-webpack-plugin')
const BundleAnalyzerPlugin =
  require('webpack-bundle-analyzer').BundleAnalyzerPlugin
const CircularDependencyPlugin = require('circular-dependency-plugin')

const isProd = process.env.NODE_ENV === 'production'
const ASSET_PATH = isProd
  ? 'https://cdp.customer.io/v1/analytics-js/'
  : '/dist/umd/'

const webPushWorker = path.resolve(
  __dirname,
  'src/plugins/web-push-plugin/cio-webpush-sw.js'
)

const plugins = [
  {
    apply(compiler) {
      compiler.hooks.thisCompilation.tap('WebPushWorker', (compilation) => {
        compilation.hooks.processAssets.tap(
          {
            name: 'WebPushWorker',
            stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
          },
          () =>
            compilation.emitAsset(
              '../cio-webpush-sw.js',
              new webpack.sources.RawSource(fs.readFileSync(webPushWorker))
            )
        )
      })
      // The worker's tests run on its source, so the shipped copy must be
      // that source byte for byte (no minifier or other transform).
      compiler.hooks.afterEmit.tap('WebPushWorker', (compilation) => {
        const shipped = path.resolve(
          compilation.outputOptions.path,
          '../cio-webpush-sw.js'
        )
        if (!fs.readFileSync(shipped).equals(fs.readFileSync(webPushWorker))) {
          compilation.errors.push(
            new webpack.WebpackError(
              `${shipped} differs from ${webPushWorker}; it must ship unchanged`
            )
          )
        }
      })
    },
  },
  new CompressionPlugin({ exclude: /cio-webpush-sw\.js$/ }),
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
        exclude: /cio-webpush-sw\.js$/,
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
