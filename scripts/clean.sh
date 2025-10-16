#!/bin/sh
# Clear build artifacts and build cache

find . \( -name ".turbo" -o -name "dist" -o -name ".next" -o -name "tsconfig.tsbuildinfo" \) ! -path "*/node_modules/*" -print0 | xargs -0 rm -rf
rm -rf node_modules/.cache

rm -f package.tgz
for dir in core browser node; do
    rm -f packages/$dir/package.tgz
done

echo "Build files and cache deleted."
