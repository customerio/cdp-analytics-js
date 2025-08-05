#!/bin/bash

# Activate mise environment and use correct Node version
eval "$(mise env --shell=bash)"
mise use node@14.21.3

# Save the current directory
ORIGINAL_DIR=$(pwd)

echo "📦 Installing dependencies..."
yarn install

echo "🏗️   Building project..."
yarn build

# Check if build succeeded
if [ $? -ne 0 ]; then
  echo "❌ Build failed, aborting."
  exit 1
fi

echo "📁 Moving to asset_util directory..."
cd ~/code/cdp/cmds/asset_util

echo "🚚 Copying UMD assets to edge API assets folder..."
go run main.go \
  --source ~/code/cdp-analytics-js/packages/browser/dist/umd \
  --destination ~/code/cdp/edge/api/endpoints/assets

echo "⚙️  Running mage manifest..."
cd ~/code/cdp
mage manifest

# Return to original directory
cd "$ORIGINAL_DIR"
echo "✅ Done! Returned to $ORIGINAL_DIR"
