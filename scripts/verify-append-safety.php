<?php
/**
 * Catch `.append(…, null)` before a user reads the word "null" on screen.
 *
 * The DOM's own append() stringifies anything that is not a Node, so passing
 * it a null inserts the four characters n-u-l-l as text. The el() and mount()
 * helpers in public/js/ui.js both filter null, undefined and false — which is
 * precisely why the idiom
 *
 *     el('div', {}, [maybe ? thing : null])     // fine, el() filters
 *     target.append(maybe ? thing : null)       // prints "null"
 *
 * looks identical at a glance and is not. Four call sites had it. The visible
 * symptom was the word "null" sitting above the Two-factor and Data retention
 * cards in Settings, and a dialog with no buttons printing it at the bottom.
 *
 * The fix is always the same: mount(target, …) instead of target.append(…).
 *
 * This only inspects arguments at the *top level* of the call. A null nested
 * inside el(...) or an array literal is already filtered and is not a finding.
 *
 * Usage: php scripts/verify-append-safety.php
 */

declare(strict_types=1);

$root  = dirname(__DIR__);
$files = [];

$iterator = new RecursiveIteratorIterator(
    new RecursiveDirectoryIterator($root . '/public/js', FilesystemIterator::SKIP_DOTS),
);

foreach ($iterator as $file) {
    if ($file->getExtension() === 'js') {
        $files[] = $file->getPathname();
    }
}

sort($files);

$findings = 0;

foreach ($files as $file) {
    $source   = (string) file_get_contents($file);
    $relative = substr($file, strlen($root) + 1);
    $offset   = 0;

    while (($at = strpos($source, '.append(', $offset)) !== false) {
        $start = $at + strlen('.append(');
        $depth = 1;
        $i     = $start;

        while ($i < strlen($source) && $depth > 0) {
            $char = $source[$i];
            if ($char === '(' || $char === '[' || $char === '{') {
                $depth++;
            } elseif ($char === ')' || $char === ']' || $char === '}') {
                $depth--;
            }
            $i++;
        }

        $arguments = substr($source, $start, $i - $start - 1);

        // Keep only the characters sitting at argument level: a null inside
        // el(...) or [...] has already been filtered by the helper.
        $topLevel = '';
        $nesting  = 0;

        foreach (str_split($arguments) as $char) {
            if ($char === '(' || $char === '[' || $char === '{') {
                $nesting++;
            } elseif ($char === ')' || $char === ']' || $char === '}') {
                $nesting--;
            } elseif ($nesting === 0) {
                $topLevel .= $char;
            }
        }

        if (preg_match('/\b(null|undefined|false)\b/', $topLevel, $match) === 1) {
            $line = substr_count(substr($source, 0, $at), "\n") + 1;
            fwrite(STDERR, sprintf(
                "  %s:%d passes %s straight to the DOM's append()\n",
                $relative,
                $line,
                $match[1],
            ));
            $findings++;
        }

        $offset = $i;
    }
}

echo "==> Checking for .append(null)\n\n";

if ($findings === 0) {
    printf("  Checked %d module(s). Nothing passes null to append().\n", count($files));
    exit(0);
}

fwrite(STDERR, sprintf(
    "\n%d call(s) would render the literal text \"null\" to the user.\n\n"
    . "Use mount(target, …) from public/js/ui.js instead of target.append(…).\n"
    . "It filters null, undefined and false, which is what el() already does\n"
    . "for its children — the two idioms look the same and are not.\n",
    $findings,
));

exit(1);
