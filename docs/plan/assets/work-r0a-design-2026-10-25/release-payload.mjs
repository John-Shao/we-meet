// One reading of what `make-release.sh` puts in a release package, shared by the gates that reason
// about the payload. The packager has two mechanisms - a hand-written `cp "$ROOT/…" "$OUT/"` list
// and, since 2026-11-13 (batch B2), a closure loop that ships anything in deploy/ecs the list has
// not already placed. A gate that only sees the first mechanism reports closure-delivered files as
// missing, which is how the 2026-11-10 deployment ended up hand-copying them instead.
//
// Parsing lives here so release-assets.test.mjs and release-payload-closure.test.mjs cannot drift
// into disagreeing about what "shipped" means.
export function parsePackager(releaseText) {
  const codeLines = releaseText
    .split(/\r?\n/)
    .map((line, index) => [line, index + 1])
    .filter(([line]) => !/^\s*#/.test(line));

  const explicitNames = new Set(
    [...releaseText.matchAll(/^cp "\$(?:ROOT|ASSETS)\/([^"]+)" "\$OUT\/"/gm)].map((m) => m[1].split('/').pop()),
  );

  const suffixLine = codeLines.find(([line]) => /^\s*for suffix in (\.[A-Za-z.]+ )*\.[A-Za-z.]+; do$/.test(line));
  const closureSuffixes = suffixLine ? suffixLine[0].match(/\.[A-Za-z.]+/g) : [];
  const assetLoop = codeLines.filter(([line]) => /for asset in "\$ROOT"\/deploy\/ecs\/\*"\$suffix"; do/.test(line));
  const closureCp = codeLines.filter(([line]) => /^\s*cp "\$asset" "\$OUT\/"/.test(line));

  const skipReasons = Object.fromEntries(
    [...releaseText.matchAll(/\["([^"]+)"\]="([^"]*)"/g)].map((m) => [m[1], m[2]]),
  );

  const floorCheck = codeLines.find(([line]) => /\[\s*"\$closure_scanned" -lt (\d+)\s*\]/.test(line));
  const floor = floorCheck ? Number(/\[\s*"\$closure_scanned" -lt (\d+)/.exec(floorCheck[0])[1]) : 0;

  return {
    codeText: codeLines.map(([line]) => line).join('\n'),
    explicitNames,
    closureSuffixes,
    closureSuffixLine: suffixLine,
    assetLoop,
    closureCp,
    skipReasons,
    floor,
  };
}

// Names the packager delivers for a given inventory of deploy/ecs. Anything matched by the closure
// that the hand list already placed counts once; anything in the skip list counts never, which is
// the point of making that list carry a reason.
export function packagedNames(inventory, parsed) {
  const byClosure = inventory.filter(
    (name) => !parsed.explicitNames.has(name)
      && !Object.hasOwn(parsed.skipReasons, name)
      && parsed.closureSuffixes.some((suffix) => name.endsWith(suffix)),
  );
  return { packaged: new Set([...parsed.explicitNames, ...byClosure]), byClosure };
}
