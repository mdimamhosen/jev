#!/bin/sh
# JEV installer: curl -fsSL https://raw.githubusercontent.com/mdimamhosen/jev/main/install.sh | sh   (same as: npm install -g jevrouter)
set -e
command -v node >/dev/null 2>&1 || { echo "JEV needs Node.js 20.12+ — https://nodejs.org"; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=12)?0:1)' || { echo "JEV needs Node.js 20.12+ (found $(node -v))"; exit 1; }
npm install -g jevrouter@latest >/dev/null
echo "✓ JEV installed. Next:"
echo "    echo GEMINI_API_KEY=... >> ~/.jev/.env"
echo "    jev serve      # in one terminal"
echo "    jev setup      # in another"
