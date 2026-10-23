#!/bin/sh
PKG_VERSION=$(node --eval="process.stdout.write(require('./package.json').version)")

cat <<EOF >src/generated/version.ts
// This file is generated.
export const version = '$PKG_VERSION'
EOF

# The web push worker compares its version with the CDN runtime's.
node --eval="
const fs = require('fs')
const file = 'src/plugins/web-push-plugin/cio-webpush-sw.js'
const source = fs.readFileSync(file, 'utf8')
const next = source.replace(/const version = '[^']*'/, \"const version = '$PKG_VERSION'\")
if (next === source && !source.includes(\"const version = '$PKG_VERSION'\")) {
  throw new Error(file + ': version line not found')
}
fs.writeFileSync(file, next)
"
