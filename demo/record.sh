#!/usr/bin/env bash
# Renders demo.gif. Runs from a neutral path so no local home directory
# appears in pytest's "rootdir:" header.
set -euo pipefail
STAGE=/tmp/whatbroke-demo
HERE="$(cd "$(dirname "$0")" && pwd)"

rm -rf "$STAGE"; mkdir -p "$STAGE"
cp "$HERE"/shop.py "$HERE"/test_shop.py "$STAGE"/
mkdir -p "$STAGE/bin"
cat > "$STAGE/bin/whatbroke" <<SH
#!/usr/bin/env bash
exec node "$HERE/../bin/whatbroke.js" "\$@"
SH
chmod +x "$STAGE/bin/whatbroke"
python3 -m venv "$STAGE/.venv" >/dev/null
"$STAGE/.venv/bin/pip" -q install pytest >/dev/null
vhs "$HERE/demo.tape"
echo "wrote $HERE/demo.gif"
